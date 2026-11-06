import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Tracking = { id:number; user_id:number; chat_id:number; type:'GENERAL'|'PERIOD'; date:string|null; start:number|null; end:number|null; status:'ACTIVE'|'WAITING_FOR_DATE'; urgent:number; initialized:number };
export type StoredSlot = { date:string; start:string; end:string; count:number; comparable:number };
export type Delivery = { id:number; tracking_id:number; user_id:number; chat_id:number; kind:'INITIAL'|'CHANGE'|'URGENT'|'OPENED'; text:string; slot_key:string|null; created_at:number; attempts:number; next_at:number };

export class Repository {
  readonly db:DatabaseSync;
  constructor(path:string) {
    if(path!==':memory:') mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path); this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    const version=Number((this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);
    if(version>1) throw new Error('База має новішу версію схеми.');
    if(version===0) this.db.exec(`BEGIN;
      CREATE TABLE users (id INTEGER PRIMARY KEY, telegram_user_id INTEGER NOT NULL UNIQUE, chat_id INTEGER NOT NULL, created_at INTEGER NOT NULL, last_active INTEGER NOT NULL);
      CREATE TABLE trackings (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, type TEXT NOT NULL CHECK(type IN ('GENERAL','PERIOD')), date TEXT, start INTEGER, end INTEGER, status TEXT NOT NULL CHECK(status IN ('ACTIVE','WAITING_FOR_DATE')), urgent INTEGER NOT NULL DEFAULT 0, initialized INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX one_general ON trackings(user_id) WHERE type='GENERAL';
      CREATE INDEX tracking_user ON trackings(user_id); CREATE INDEX tracking_status_date ON trackings(status,date);
      CREATE TABLE slot_states (tracking_id INTEGER NOT NULL REFERENCES trackings(id) ON DELETE CASCADE, date TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, count INTEGER NOT NULL, comparable INTEGER NOT NULL, checked_at INTEGER NOT NULL, PRIMARY KEY(tracking_id,date,start,end));
      CREATE TABLE notification_messages (tracking_id INTEGER NOT NULL REFERENCES trackings(id) ON DELETE CASCADE, chat_id INTEGER NOT NULL, slot_key TEXT NOT NULL, message_id INTEGER NOT NULL, sent_at INTEGER NOT NULL, PRIMARY KEY(tracking_id,chat_id,slot_key));
      CREATE TABLE deliveries (id INTEGER PRIMARY KEY, tracking_id INTEGER NOT NULL REFERENCES trackings(id) ON DELETE CASCADE, kind TEXT NOT NULL, text TEXT NOT NULL, slot_key TEXT, created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'PENDING');
      CREATE INDEX delivery_pending ON deliveries(status,next_at,id);
      PRAGMA user_version=1; COMMIT;`);
    this.db.exec('CREATE TABLE IF NOT EXISTS service_state (key TEXT PRIMARY KEY,value INTEGER NOT NULL)');
    this.db.exec("INSERT OR IGNORE INTO service_state(key,value) SELECT 'tracking_next_id',COALESCE(MAX(id),0) FROM trackings");
    // A send interrupted by a crash may already have reached Telegram. Do not retry blindly.
    this.db.exec("UPDATE deliveries SET status='UNCERTAIN' WHERE status='SENDING'");
  }
  close(){this.db.close();}
  transaction<T>(fn:()=>T):T { this.db.exec('BEGIN IMMEDIATE'); try {const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;} }
  register(user:number,chat:number,now:number):boolean {
    const exists=!!this.db.prepare('SELECT id FROM users WHERE telegram_user_id=?').get(user);
    this.db.prepare('INSERT INTO users(telegram_user_id,chat_id,created_at,last_active) VALUES(?,?,?,?) ON CONFLICT(telegram_user_id) DO UPDATE SET chat_id=excluded.chat_id,last_active=excluded.last_active').run(user,chat,now,now);
    return !exists;
  }
  userId(telegramId:number):number|undefined { return (this.db.prepare('SELECT id FROM users WHERE telegram_user_id=?').get(telegramId) as {id:number}|undefined)?.id; }
  list(userId?:number):Tracking[] {
    const sql='SELECT t.*,u.chat_id FROM trackings t JOIN users u ON u.id=t.user_id';
    return (userId===undefined?this.db.prepare(sql+' ORDER BY t.id').all():this.db.prepare(sql+' WHERE t.user_id=? ORDER BY t.id').all(userId)) as Tracking[];
  }
  get(id:number,userId?:number):Tracking|undefined { return this.list(userId).find(t=>t.id===id); }
  create(userId:number,type:'GENERAL'|'PERIOD',date:string|null,start:number|null,end:number|null,status:'ACTIVE'|'WAITING_FOR_DATE',urgent:boolean,now:number):number {
    return this.transaction(()=>{
      const id=Number((this.db.prepare("UPDATE service_state SET value=value+1 WHERE key='tracking_next_id' RETURNING value").get() as {value:number}).value);
      this.db.prepare('INSERT INTO trackings(id,user_id,type,date,start,end,status,urgent,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,userId,type,date,start,end,status,Number(urgent),now,now);
      return id;
    });
  }
  remove(id:number,userId:number):boolean {return Number(this.db.prepare('DELETE FROM trackings WHERE id=? AND user_id=?').run(id,userId).changes)>0;}
  setUrgent(id:number,userId:number,flag:boolean):boolean {return Number(this.db.prepare("UPDATE trackings SET urgent=? WHERE id=? AND user_id=? AND type='PERIOD'").run(Number(flag),id,userId).changes)>0;}
  slots(id:number):StoredSlot[] {return this.db.prepare('SELECT date,start,end,count,comparable FROM slot_states WHERE tracking_id=?').all(id) as StoredSlot[];}
  setSlot(id:number,s:StoredSlot,now:number):void {this.db.prepare('INSERT INTO slot_states VALUES(?,?,?,?,?,?,?) ON CONFLICT(tracking_id,date,start,end) DO UPDATE SET count=excluded.count,comparable=excluded.comparable,checked_at=excluded.checked_at').run(id,s.date,s.start,s.end,s.count,s.comparable,now);}
  invalidate(id:number,date:string):void {this.db.prepare('UPDATE slot_states SET comparable=0 WHERE tracking_id=? AND date=?').run(id,date);}
  prune(id:number,dates:string[]):void {
    for(const row of this.slots(id)) if(!dates.includes(row.date)) this.db.prepare('DELETE FROM slot_states WHERE tracking_id=? AND date=?').run(id,row.date);
    for(const table of ['notification_messages','deliveries'] as const) {
      const keys=this.db.prepare(`SELECT DISTINCT slot_key FROM ${table} WHERE tracking_id=? AND slot_key IS NOT NULL`).all(id) as {slot_key:string}[];
      for(const {slot_key} of keys) if(!dates.includes(slot_key.slice(0,10))) this.db.prepare(`DELETE FROM ${table} WHERE tracking_id=? AND slot_key=?`).run(id,slot_key);
    }
  }
  initialized(id:number,now:number):void {this.db.prepare("UPDATE trackings SET initialized=1,status='ACTIVE',updated_at=? WHERE id=?").run(now,id);}
  enqueue(id:number,kind:Delivery['kind'],text:string,slotKey:string|null,now:number):void {this.db.prepare('INSERT INTO deliveries(tracking_id,kind,text,slot_key,created_at) VALUES(?,?,?,?,?)').run(id,kind,text,slotKey,now);}
  pending(now:number):Delivery[] {return this.db.prepare(`SELECT d.*,t.user_id,u.chat_id FROM deliveries d JOIN trackings t ON t.id=d.tracking_id JOIN users u ON u.id=t.user_id
    WHERE d.status='PENDING' AND d.next_at<=? AND NOT EXISTS (
      SELECT 1 FROM deliveries earlier WHERE earlier.tracking_id=d.tracking_id AND earlier.id<d.id
      AND (earlier.kind IN ('INITIAL','OPENED') OR (d.slot_key IS NOT NULL AND earlier.slot_key=d.slot_key))
    ) ORDER BY d.id`).all(now) as Delivery[];}
  rateLimitedUntil(now:number):number {
    const queued=Number((this.db.prepare("SELECT COALESCE(MAX(next_at),0) AS until FROM deliveries WHERE status='PENDING' AND attempts>0 AND next_at>?").get(now) as {until:number}).until);
    const global=Number((this.db.prepare("SELECT value FROM service_state WHERE key='telegram_retry_until'").get() as {value:number}|undefined)?.value??0);
    return Math.max(queued,global);
  }
  holdTelegram(until:number):void {this.db.prepare("INSERT INTO service_state VALUES('telegram_retry_until',?) ON CONFLICT(key) DO UPDATE SET value=MAX(value,excluded.value)").run(until);}
  claim(id:number):boolean {return Number(this.db.prepare("UPDATE deliveries SET status='SENDING' WHERE id=? AND status='PENDING'").run(id).changes)>0;}
  uncertainCount(userId:number):number {return Number((this.db.prepare("SELECT COUNT(*) AS count FROM deliveries d JOIN trackings t ON t.id=d.tracking_id WHERE t.user_id=? AND d.status='UNCERTAIN'").get(userId) as {count:number}).count);}
  retryUncertain(userId:number):number {return Number(this.db.prepare("UPDATE deliveries SET status='PENDING',next_at=0 WHERE status='UNCERTAIN' AND tracking_id IN (SELECT id FROM trackings WHERE user_id=?)").run(userId).changes);}
  lastMessage(id:number,chat:number,key:string):{message_id:number;sent_at:number}|undefined {return this.db.prepare('SELECT message_id,sent_at FROM notification_messages WHERE tracking_id=? AND chat_id=? AND slot_key=?').get(id,chat,key) as {message_id:number;sent_at:number}|undefined;}
  delivered(d:Delivery,messageId:number,now:number):void {this.transaction(()=>{if(d.kind==='CHANGE'&&d.slot_key)this.db.prepare('INSERT INTO notification_messages VALUES(?,?,?,?,?) ON CONFLICT(tracking_id,chat_id,slot_key) DO UPDATE SET message_id=excluded.message_id,sent_at=excluded.sent_at').run(d.tracking_id,d.chat_id,d.slot_key,messageId,now);this.db.prepare('DELETE FROM deliveries WHERE id=?').run(d.id);});}
  failure(id:number,delay:number,now:number,ambiguous=false):void {this.db.prepare("UPDATE deliveries SET attempts=attempts+1,next_at=?,status=? WHERE id=?").run(now+delay,ambiguous?'UNCERTAIN':'PENDING',id);}
}
