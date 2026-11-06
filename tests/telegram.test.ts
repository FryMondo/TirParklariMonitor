import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot, GrammyError } from 'grammy';
import { parseResponse } from '../src/model.js';
import { HttpError, type fetchDate } from '../src/http.js';
import { Repository, type Delivery } from '../src/telegram/database.js';
import { Logger } from '../src/telegram/log.js';
import { eligible, expired, formatAvailability, SharedMonitor } from '../src/telegram/monitor.js';
import { Notifications } from '../src/telegram/notifications.js';
import { makeBot } from '../src/telegram/bot.js';
import { parsePeriod } from '../src/view.js';

const dirs:string[]=[];
function setup() {
  const dir=mkdtempSync(join(tmpdir(),'telegram-monitor-'));dirs.push(dir);
  const repo=new Repository(join(dir,'test.db')),logger=new Logger(30,join(dir,'logs'));
  const clock={value:new Date('2026-11-02T09:00:00Z')};
  return {dir,repo,logger,clock,now:()=>clock.value};
}
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const source=JSON.parse(readFileSync(new URL('./fixtures/2026-11-04.json',import.meta.url),'utf8'));
const response=(count:number)=>{const raw=structuredClone(source);raw.dilimler=raw.dilimler.filter((s:{baslangic:string})=>s.baslangic==='15:00');raw.dilimler[0].kalan=count;raw.dilimler[0].acik=count>0;return parseResponse(raw,'2026-11-04');};
function addUser(repo:Repository,id:number){repo.register(id,id,0);return repo.userId(id)!;}
const cfg={interval:60000,timeout:1000,delay:0,cacheMs:0};
const queued=(repo:Repository)=>repo.db.prepare('SELECT * FROM deliveries ORDER BY id').all() as Delivery[];

describe('SQLite та спільний монітор',()=>{
  it('перевіряє спільні періоди щосекунди, не опитуючи загальне відстеження кожну секунду',async()=>{
    const {repo,logger,clock,now}=setup(),u=addUser(repo,1),v=addUser(repo,2),g=addUser(repo,3);
    repo.create(u,'PERIOD','2026-11-04',0,1440,'ACTIVE',false,0);
    repo.create(v,'PERIOD','2026-11-04',0,1440,'ACTIVE',false,0);
    const general=repo.create(g,'GENERAL',null,null,null,'ACTIVE',false,0);
    const client=vi.fn(async(date:string)=>({...response(2),gun:date})) as unknown as typeof fetchDate;
    const monitor=new SharedMonitor(repo,logger,{...cfg,cacheMs:30000,periodInterval:1000},new AbortController().signal,client,now);
    await monitor.cycle('all');expect(client).toHaveBeenCalledTimes(4);
    clock.value=new Date(clock.value.valueOf()+999);await monitor.cycle('period');expect(client).toHaveBeenCalledTimes(4);
    clock.value=new Date(clock.value.valueOf()+1);await monitor.cycle('period');expect(client).toHaveBeenCalledTimes(5);
    expect(vi.mocked(client).mock.calls.at(-1)?.[0]).toBe('2026-11-04');
    expect(queued(repo).filter(d=>d.tracking_id===general && d.kind==='INITIAL')).toHaveLength(1);
    repo.close();
  });
  it('не пропускає загальний цикл, якщо він почався під час циклу періоду',async()=>{
    const {repo,logger,now}=setup(),u=addUser(repo,1);
    repo.create(u,'PERIOD','2026-11-04',0,1440,'ACTIVE',false,0);
    const general=repo.create(u,'GENERAL',null,null,null,'ACTIVE',false,0);
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
    let first=true;const client=vi.fn(async(date:string)=>{if(first){first=false;await gate;}return {...response(2),gun:date};}) as unknown as typeof fetchDate;
    const monitor=new SharedMonitor(repo,logger,{...cfg,cacheMs:30000,periodInterval:1000},new AbortController().signal,client,now);
    const period=monitor.cycle('period'), all=monitor.cycle('all');release();await Promise.all([period,all]);
    expect(repo.get(general)?.initialized).toBe(1);expect(client).toHaveBeenCalledTimes(4);repo.close();
  });
  it('сповільнює повторні перевірки дати після помилки',async()=>{
    const {repo,logger,clock,now}=setup(),u=addUser(repo,1);repo.create(u,'PERIOD','2026-11-04',0,1440,'ACTIVE',false,0);
    const client=vi.fn(async()=>{throw new HttpError('HTTP 400',400);}) as unknown as typeof fetchDate;
    const monitor=new SharedMonitor(repo,logger,{...cfg,cacheMs:30000,periodInterval:1000},new AbortController().signal,client,now);
    await monitor.cycle('period');clock.value=new Date(clock.value.valueOf()+1000);await monitor.cycle('period');expect(client).toHaveBeenCalledTimes(1);
    clock.value=new Date(clock.value.valueOf()+1000);await monitor.cycle('period');expect(client).toHaveBeenCalledTimes(2);repo.close();
  });
  it('зберігає користувачів, унікальне загальне відстеження і перевіряє власника',()=>{
    const {repo}=setup(),u=addUser(repo,101),other=addUser(repo,202);
    expect(repo.register(101,101,2)).toBe(false);
    const id=repo.create(u,'GENERAL',null,null,null,'ACTIVE',false,0);
    expect(()=>repo.create(u,'GENERAL',null,null,null,'ACTIVE',false,0)).toThrow();
    expect(repo.remove(id,other)).toBe(false);expect(repo.get(id,u)).toBeDefined();
    expect(repo.remove(id,u)).toBe(true);
    const next=repo.create(u,'GENERAL',null,null,null,'ACTIVE',false,0);expect(next).toBeGreaterThan(id);repo.close();
  });
  it('для двох користувачів запитує дату один раз, зберігає початковий стан і зміни',async()=>{
    const {repo,logger,clock,now}=setup(),u=addUser(repo,1),v=addUser(repo,2);
    const a=repo.create(u,'PERIOD','2026-11-04',0,1440,'ACTIVE',true,0);
    repo.create(v,'PERIOD','2026-11-04',0,1440,'ACTIVE',false,0);
    let count=2;const client=vi.fn(async()=>response(count)) as unknown as typeof fetchDate;
    const monitor=new SharedMonitor(repo,logger,cfg,new AbortController().signal,client,now);
    await Promise.all([monitor.cycle(),monitor.cycle()]);expect(client).toHaveBeenCalledTimes(1);
    expect(repo.pending(clock.value.valueOf()).filter(d=>d.kind==='INITIAL')).toHaveLength(2);
    await monitor.cycle();expect(queued(repo).filter(d=>d.kind==='CHANGE')).toHaveLength(0);
    count=4;await monitor.cycle();
    const pending=queued(repo);expect(pending.filter(d=>d.kind==='CHANGE')).toHaveLength(2);
    expect(pending.every(d=>!/відстеження\s*#\d+/iu.test(d.text))).toBe(true);
    expect(pending.filter(d=>d.kind==='URGENT')).toHaveLength(1);expect(pending.find(d=>d.kind==='URGENT')?.tracking_id).toBe(a);
    repo.close();
  });
  it('майбутня дата активується лише після успішної відповіді, а минула очищується',async()=>{
    const {repo,logger,clock,now}=setup(),u=addUser(repo,1);
    const id=repo.create(u,'PERIOD','2026-11-04',14*60,16*60,'WAITING_FOR_DATE',false,0);
    const client=vi.fn(async()=>response(1)) as unknown as typeof fetchDate;
    const monitor=new SharedMonitor(repo,logger,cfg,new AbortController().signal,client,now);
    clock.value=new Date('2026-10-30T09:00:00Z');await monitor.cycle();expect(client).not.toHaveBeenCalled();
    clock.value=new Date('2026-11-01T21:00:00Z');await monitor.cycle();expect(repo.get(id,u)?.status).toBe('ACTIVE');
    expect(repo.pending(clock.value.valueOf()).some(d=>d.kind==='OPENED')).toBe(true);
    clock.value=new Date('2026-11-04T13:00:00Z');expect(expired(repo.get(id,u)!,clock.value)).toBe(true);
    await monitor.sweepExpired();expect(repo.get(id,u)).toBeUndefined();expect(repo.pending(clock.value.valueOf())).toHaveLength(0);repo.close();
  });
  it('після помилки та невідомого стану не вигадує події',async()=>{
    const {repo,logger,now,clock}=setup(),u=addUser(repo,1),id=repo.create(u,'PERIOD','2026-11-04',0,1440,'ACTIVE',false,0);
    let mode='ok'; const client=vi.fn(async()=>{if(mode==='error')throw new HttpError('HTTP 400',400);if(mode==='unknown'){const r=response(2);r.dilimler[0].acik=false;return r;}return response(mode==='increase'?4:2);}) as unknown as typeof fetchDate;
    const monitor=new SharedMonitor(repo,logger,cfg,new AbortController().signal,client,now);
    await monitor.cycle();mode='error';await monitor.cycle();expect(repo.slots(id)[0].count).toBe(2);expect(repo.slots(id)[0].comparable).toBe(0);
    clock.value=new Date(clock.value.valueOf()+2000);mode='increase';await monitor.cycle();expect(queued(repo).filter(d=>d.kind==='CHANGE')).toHaveLength(0);
    mode='unknown';await monitor.cycle();expect(repo.slots(id)[0].count).toBe(4);expect(repo.slots(id)[0].comparable).toBe(0);repo.close();
  });
  it('записує появу, зменшення, зникнення та повернення без дублікатів',async()=>{
    const {repo,logger,now}=setup(),u=addUser(repo,1);repo.create(u,'PERIOD','2026-11-04',0,1440,'ACTIVE',true,0);
    let count=0; const client=vi.fn(async()=>response(count)) as unknown as typeof fetchDate;
    const monitor=new SharedMonitor(repo,logger,cfg,new AbortController().signal,client,now);
    for(const value of [0,3,3,2,0,1]) {count=value;await monitor.cycle();}
    const events=queued(repo), changes=events.filter(d=>d.kind==='CHANGE');
    expect(changes).toHaveLength(4);
    expect(changes.map(d=>d.text)).toEqual([expect.stringContaining('0 → 3'),expect.stringContaining('3 → 2'),expect.stringContaining('2 → 0'),expect.stringContaining('0 → 1')]);
    expect(events.filter(d=>d.kind==='URGENT')).toHaveLength(2);repo.close();
  });
  it('дотримується Retry-After для 429',async()=>{
    const {repo,logger,clock,now}=setup(),u=addUser(repo,1);repo.create(u,'PERIOD','2026-11-04',0,1440,'ACTIVE',false,0);
    const client=vi.fn(async()=>{throw new HttpError('HTTP 429',429,600000);}) as unknown as typeof fetchDate;
    const monitor=new SharedMonitor(repo,logger,cfg,new AbortController().signal,client,now);
    await monitor.cycle();await monitor.cycle();expect(client).toHaveBeenCalledTimes(1);
    clock.value=new Date(clock.value.valueOf()+600001);await monitor.cycle();expect(client).toHaveBeenCalledTimes(2);repo.close();
  });
  it('відновлює збережений стан після перезапуску без повторних подій',async()=>{
    const x=setup(),u=addUser(x.repo,1);x.repo.create(u,'PERIOD','2026-11-04',0,1440,'ACTIVE',false,0);
    const client=vi.fn(async()=>response(2)) as unknown as typeof fetchDate;
    await new SharedMonitor(x.repo,x.logger,cfg,new AbortController().signal,client,x.now).cycle();x.repo.close();
    const repo=new Repository(join(x.dir,'test.db'));await new SharedMonitor(repo,x.logger,cfg,new AbortController().signal,client,x.now).cycle();
    expect(repo.pending(x.now().valueOf()).filter(d=>d.kind==='INITIAL')).toHaveLength(1);
    expect(repo.pending(x.now().valueOf()).filter(d=>d.kind==='CHANGE')).toHaveLength(0);repo.close();
  });
  it('при турецькій півночі додає нову дату без подій про зникнення старої',async()=>{
    const {repo,logger,clock,now}=setup(),u=addUser(repo,1),id=repo.create(u,'GENERAL',null,null,null,'ACTIVE',false,0);
    clock.value=new Date('2026-11-02T20:59:00Z');
    const client=vi.fn(async(date:string)=>({...response(2),gun:date})) as unknown as typeof fetchDate;
    const monitor=new SharedMonitor(repo,logger,cfg,new AbortController().signal,client,now);
    await monitor.cycle();clock.value=new Date('2026-11-02T21:00:01Z');await monitor.cycle();
    expect(queued(repo).filter(d=>d.kind==='CHANGE')).toHaveLength(0);
    expect(repo.slots(id).some(s=>s.date==='2026-11-02')).toBe(false);
    expect(repo.slots(id).some(s=>s.date==='2026-11-06')).toBe(true);repo.close();
  });
  it('використовує повне входження для Telegram-періоду та 24:00',()=>{
    const {repo}=setup(),u=addUser(repo,1),id=repo.create(u,'PERIOD','2026-11-04',15*60+1,16*60,'ACTIVE',false,0),t=repo.get(id)!;
    expect(eligible(t,'2026-11-04',response(2).dilimler[0],new Date('2026-11-02T09:00Z'))).toBe(false);
    expect(parsePeriod('2026-11-04','23:00-24:00').end).toBe(1440);
    expect(formatAvailability(new Map([['2026-11-04',{error:'offline'}]]),new Date()).toLowerCase()).toContain('перевірка неповна');repo.close();
  });
});

describe('Доставка Telegram',()=>{
  it('прибирає номер зі старого повідомлення в черзі перед надсиланням',async()=>{
    const {repo,logger,now}=setup(),u=addUser(repo,1),id=repo.create(u,'GENERAL',null,null,null,'ACTIVE',false,0),ts=now().valueOf();
    const sender={sendMessage:vi.fn(async()=>({message_id:1})),deleteMessage:vi.fn(async()=>true)};
    repo.enqueue(id,'INITIAL','📅 Початковий стан — відстеження #123\nВільні місця',null,ts);
    await new Notifications(repo,sender,logger,()=>ts).flush();
    expect(sender.sendMessage).toHaveBeenCalledWith(1,'📅 Початковий стан — відстеження\nВільні місця');repo.close();
  });
  it('зберігає id нового повідомлення і видаляє лише попереднє того ж інтервалу',async()=>{
    const {repo,logger,now}=setup(),u=addUser(repo,1),id=repo.create(u,'GENERAL',null,null,null,'ACTIVE',false,0),ts=now().valueOf();
    let mid=0;const sender={sendMessage:vi.fn(async()=>({message_id:++mid})),deleteMessage:vi.fn(async()=>true)};
    const n=new Notifications(repo,sender,logger,()=>ts);
    repo.enqueue(id,'INITIAL','initial',null,ts);repo.enqueue(id,'CHANGE','first','a',ts);repo.enqueue(id,'CHANGE','other','b',ts);await n.flush();
    repo.enqueue(id,'CHANGE','second','a',ts);await n.flush();
    expect(sender.deleteMessage).toHaveBeenCalledTimes(1);expect(sender.deleteMessage).toHaveBeenCalledWith(1,2);
    expect(repo.lastMessage(id,1,'a')?.message_id).toBe(4);expect(repo.lastMessage(id,1,'b')?.message_id).toBe(3);repo.close();
  });
  it('не втрачає невизначене відправлення і не повторює його після перезапуску',async()=>{
    const x=setup(),u=addUser(x.repo,1),id=x.repo.create(u,'GENERAL',null,null,null,'ACTIVE',false,0),ts=x.now().valueOf();
    x.repo.enqueue(id,'CHANGE','change','a',ts);
    const sender={sendMessage:vi.fn(async()=>{throw new Error('network');}),deleteMessage:vi.fn(async()=>true)};
    await new Notifications(x.repo,sender,x.logger,()=>ts).flush();expect(x.repo.pending(ts)).toHaveLength(0);x.repo.close();
    const repo=new Repository(join(x.dir,'test.db'));await new Notifications(repo,sender,x.logger,()=>ts).flush();
    expect(sender.sendMessage).toHaveBeenCalledTimes(1);
    expect(repo.db.prepare('SELECT status FROM deliveries').get()?.status).toBe('UNCERTAIN');repo.close();
  });
  it('зберігає порядок змін одного інтервалу, коли попередня доставка невизначена',async()=>{
    const {repo,logger,now}=setup(),u=addUser(repo,1),id=repo.create(u,'GENERAL',null,null,null,'ACTIVE',false,0),ts=now().valueOf();
    const sender={sendMessage:vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue({message_id:10}),deleteMessage:vi.fn(async()=>true)};
    const n=new Notifications(repo,sender,logger,()=>ts);
    repo.enqueue(id,'CHANGE','first','a',ts);repo.enqueue(id,'CHANGE','second','a',ts);repo.enqueue(id,'CHANGE','other','b',ts);
    await n.flush();expect(sender.sendMessage.mock.calls.map(x=>x[1])).toEqual(['first','other']);
    expect(repo.uncertainCount(u)).toBe(1);repo.retryUncertain(u);await n.flush();
    expect(sender.sendMessage.mock.calls.map(x=>x[1])).toEqual(['first','other','first','second']);repo.close();
  });
  it('продовжує доставку, якщо видалення попереднього повідомлення не вдалося',async()=>{
    const {repo,logger,now}=setup(),u=addUser(repo,1),id=repo.create(u,'GENERAL',null,null,null,'ACTIVE',false,0),ts=now().valueOf();
    let count=0;const sender={sendMessage:vi.fn(async()=>({message_id:++count})),deleteMessage:vi.fn(async()=>{throw new Error('cannot delete');})};
    const n=new Notifications(repo,sender,logger,()=>ts);repo.enqueue(id,'CHANGE','old','a',ts);await n.flush();
    repo.enqueue(id,'CHANGE','new','a',ts);repo.enqueue(id,'CHANGE','other','b',ts);await n.flush();
    expect(repo.lastMessage(id,1,'a')?.message_id).toBe(2);expect(repo.lastMessage(id,1,'b')?.message_id).toBe(3);
    expect(repo.pending(ts)).toHaveLength(0);repo.close();
  });
  it('повторює явно відхилене 429 після retry_after',async()=>{
    const x=setup(),u=addUser(x.repo,1),id=x.repo.create(u,'GENERAL',null,null,null,'ACTIVE',false,0);let ts=x.now().valueOf();
    x.repo.enqueue(id,'CHANGE','change','a',ts);
    const error=new GrammyError('limited',{ok:false,error_code:429,description:'retry',parameters:{retry_after:20}},'sendMessage',{});
    const sender={sendMessage:vi.fn().mockRejectedValueOnce(error).mockResolvedValue({message_id:55}),deleteMessage:vi.fn(async()=>true)};
    const n=new Notifications(x.repo,sender,x.logger,()=>ts);await n.flush();x.repo.enqueue(id,'CHANGE','another','b',ts);await n.flush();expect(sender.sendMessage).toHaveBeenCalledTimes(1);
    ts+=20000;await n.flush();expect(sender.sendMessage).toHaveBeenCalledTimes(3);expect(x.repo.lastMessage(id,1,'a')?.message_id).toBe(55);x.repo.close();
  });
});

describe('Telegram UI через mock Bot API',()=>{
  it('реєструє один раз, скасовує введення, підтверджує майбутній період і захищає чужі дії',async()=>{
    const {repo,logger,now,clock}=setup();
    const bot=new Bot('123:fake',{botInfo:{id:123,is_bot:true,first_name:'Test',username:'test_bot',can_join_groups:true,can_read_all_group_messages:false,supports_inline_queries:false,can_connect_to_business:false,has_main_web_app:false,has_topics_enabled:false,allows_users_to_create_topics:false,can_manage_bots:false,supports_join_request_queries:false}});
    const sent:string[]=[], markups:unknown[]=[];
    bot.api.config.use(async (_prev,method,payload)=>{
      if(method==='sendMessage') {const p=payload as {chat_id:number;text:string;reply_markup?:unknown};sent.push(p.text);markups.push(p.reply_markup);return {ok:true,result:{message_id:sent.length,date:0,chat:{id:p.chat_id,type:'private'},text:p.text}} as never;}
      return {ok:true,result:true} as never;
    });
    const monitor=new SharedMonitor(repo,logger,cfg,new AbortController().signal,vi.fn() as unknown as typeof fetchDate,now);
    const notifications=new Notifications(repo,bot.api,logger,()=>now().valueOf());
    makeBot(bot,repo,logger,monitor,notifications,false,now,()=>{});
    let update=0;
    const msg=async(user:number,text:string,chatType='private')=>bot.handleUpdate({update_id:++update,message:{message_id:update,date:0,chat:{id:user,type:chatType},from:{id:user,is_bot:false,first_name:'User'},text,entities:text.startsWith('/')?[{type:'bot_command',offset:0,length:text.length}]:[]}} as never);
    const callback=async(user:number,data:string)=>bot.handleUpdate({update_id:++update,callback_query:{id:String(update),from:{id:user,is_bot:false,first_name:'User'},chat_instance:'test',data,message:{message_id:1,date:0,chat:{id:user,type:'private'}}}} as never);
    await msg(10,'/start');await msg(10,'/start');expect(repo.db.prepare('SELECT count(*) AS n FROM users').get()?.n).toBe(1);expect(sent).toContain('Оберіть дію:');
    expect(JSON.stringify(markups[0])).not.toContain('Налаштування');expect(JSON.stringify(markups[0])).not.toContain('Допомога');
    expect(JSON.stringify(markups[0])).toContain('Мої відстеження');
    await msg(99,'/start','group');expect(repo.userId(99)).toBeUndefined();
    clock.value=new Date('2026-11-02T20:59:59Z');await msg(10,'📅 Відстежувати період');expect(sent.at(-1)).toContain('наприклад 02.11.2026');
    clock.value=new Date('2026-11-02T21:00:00Z');await msg(10,'📅 Відстежувати період');expect(sent.at(-1)).toContain('наприклад 03.11.2026');
    clock.value=new Date('2026-11-02T09:00:00Z');await msg(10,'/cancel');await msg(10,'09.11.2026');expect(repo.list().length).toBe(0);
    await msg(10,'📅 Відстежувати період');await msg(10,'09.11.2026');await msg(10,'18:00-24:00');await callback(10,'create');
    const tracking=repo.list()[0];expect(tracking.status).toBe('WAITING_FOR_DATE');expect(tracking.urgent).toBe(0);
    repo.enqueue(tracking.id,'CHANGE','pending','test',now().valueOf());
    const delivery=repo.pending(now().valueOf())[0];repo.claim(delivery.id);repo.failure(delivery.id,0,now().valueOf(),true);
    await msg(10,'📋 Мої відстеження');expect(sent.some(s=>s.includes('непідтверджених повідомлень: 1'))).toBe(true);
    expect(markups.some(m=>JSON.stringify(m)?.includes('retry_alerts'))).toBe(true);
    await callback(10,'retry_alerts');expect(repo.uncertainCount(tracking.user_id)).toBe(0);
    await callback(10,'create');expect(repo.list()).toHaveLength(1);
    await msg(20,'/start');await callback(20,`yes:${tracking.id}`);expect(repo.get(tracking.id)).toBeDefined();
    await callback(10,`u:${tracking.id}`);expect(repo.get(tracking.id)?.urgent).toBe(1);
    await callback(10,`yes:${tracking.id}`);expect(repo.get(tracking.id)).toBeUndefined();
    expect(sent.every(text=>!/відстеження\s*#\d+/iu.test(text))).toBe(true);repo.close();
  });
});
