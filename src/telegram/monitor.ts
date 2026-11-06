import { setTimeout as sleep } from 'node:timers/promises';
import { classify, type Slot } from '../model.js';
import { fallbackDates, istanbulDate } from '../core.js';
import { fetchDate, HttpError } from '../http.js';
import { clockMinutes, dateLabel, inScope, placeWord } from '../view.js';
import { Repository, type Tracking, type StoredSlot } from './database.js';
import { Logger } from './log.js';

type Data=Awaited<ReturnType<typeof fetchDate>>;
export type Result={data?:Data; error?:string};
export type MonitorConfig={interval:number;timeout:number;delay:number;cacheMs:number;periodInterval?:number};
function formatTime(minutes:number):string {return minutes===1440?'24:00':`${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`;}
export function trackingLabel(t:Tracking):string {
  return t.type==='GENERAL'?'Загальне відстеження':`Відстеження: ${dateLabel(t.date!)} ${formatTime(t.start!)}–${formatTime(t.end!)}`;
}
export function eligible(t:Tracking,date:string,slot:Slot,now:Date):boolean {
  if(!inScope(date,slot,now)) return false;
  if(t.type==='GENERAL') return true;
  const end=slot.bitis==='24:00'?1440:Number(slot.bitis.slice(0,2))*60+Number(slot.bitis.slice(3));
  return date===t.date && slot.baslangicDakika>=t.start! && end<=t.end!;
}
export function expired(t:Tracking,now:Date):boolean {
  if(t.type==='GENERAL') return false;
  const today=istanbulDate(now); return t.date!<today || (t.date===today && clockMinutes(now)>=t.end!);
}
export function formatAvailability(results:Map<string,Result>, now:Date, t?:Tracking):string {
  const lines:string[]=[], unknown:string[]=[];
  for(const [date,result] of [...results].sort(([a],[b])=>a.localeCompare(b))) {
    if(!result.data){unknown.push(date);continue;}
    const relevant=result.data.dilimler.filter(s=>t?eligible(t,date,s,now):inScope(date,s,now));
    if(relevant.some(s=>classify(s)==='UNKNOWN')) unknown.push(date);
    const available=relevant.filter(s=>classify(s)==='AVAILABLE').sort((a,b)=>a.baslangicDakika-b.baslangicDakika);
    if(available.length) {
      const sum=available.reduce((n,s)=>n+s.kalan,0); lines.push(`📅 ${dateLabel(date)} — ${sum} ${placeWord(sum)}`);
      for(const s of available) lines.push(`${s.baslangic}–${s.bitis} — ${s.kalan} ${placeWord(s.kalan)}`);
    }
  }
  if(!lines.length && !unknown.length) lines.push('Вільних місць наразі немає.');
  if(unknown.length) lines.push('⚠️ Перевірка неповна: частина даних невідома або недоступна.');
  const time=new Intl.DateTimeFormat('uk-UA',{timeZone:'Europe/Istanbul',dateStyle:'short',timeStyle:'short'}).format(now);
  return `${lines.join('\n')}\n\nОновлено: ${time} (TR)`;
}
export function chunks(text:string,max=3900):string[] {
  const result:string[]=[]; let part='';
  for(const line of text.split('\n')) {
    let rest=line;
    while(rest.length>max) {if(part){result.push(part);part='';}result.push(rest.slice(0,max));rest=rest.slice(max);}
    if(part && part.length+rest.length+1>max){result.push(part);part='';}
    part+=`${part?'\n':''}${rest}`;
  }
  if(part) result.push(part); return result;
}
export class SharedMonitor {
  private cache=new Map<string,{at:number;result:Result}>();
  private queue:Promise<void>=Promise.resolve();
  private cyclePromise?:Promise<void>;
  private runningMode?:'all'|'period';
  private blockedUntil=0;
  private failures=new Map<string,{attempts:number;retryAt:number}>();
  constructor(private repo:Repository,private logger:Logger,private config:MonitorConfig,private signal:AbortSignal,private client:typeof fetchDate=fetchDate,private now:()=>Date=()=>new Date(),private onExpire:(t:Tracking)=>Promise<void>=async()=>{}){}
  async getDates(dates:string[],maxAge=this.config.cacheMs):Promise<Map<string,Result>> {
    let resolveTurn!:()=>void; const previous=this.queue; this.queue=new Promise<void>(r=>resolveTurn=r);
    await previous;
    try {
      const output=new Map<string,Result>(); let requested=false;
      for(const date of [...new Set(dates)].sort()) {
        const cached=this.cache.get(date), ms=this.now().valueOf();
        const failure=this.failures.get(date);
        if(failure && cached && ms<failure.retryAt){output.set(date,cached.result);continue;}
        if(cached && ms-cached.at<maxAge){output.set(date,cached.result);continue;}
        if(this.signal.aborted) throw new Error('Моніторинг зупинено');
        if(ms<this.blockedUntil){output.set(date,{error:'Очікування після обмеження запитів'});continue;}
        if(requested && this.config.delay) await sleep(this.config.delay,undefined,{signal:this.signal}); requested=true;
        let result:Result={error:'Немає відповіді'};
        for(let attempt=0;attempt<3;attempt++) {
          try {this.logger.write('monitor',`Запит API date=${date}`);result={data:await this.client(date,this.config.timeout,this.signal)};break;}
          catch(e) {
            if(this.signal.aborted) throw e;
            result={error:e instanceof Error?e.message:'Помилка API'};
            this.logger.write('monitor',`Помилка API date=${date} ${result.error}`);
            if(e instanceof HttpError && e.status===429){this.blockedUntil=this.now().valueOf()+Math.max(300000,e.retryAfterMs);break;}
            if(e instanceof HttpError && (e.status===401||e.status===403||e.certificateError)){this.blockedUntil=this.now().valueOf()+300000;break;}
            if(!(e instanceof HttpError) || !e.temporary || attempt===2) break;
            await sleep(2000*2**attempt,undefined,{signal:this.signal});
          }
        }
        const completedAt=this.now().valueOf();
        if(result.error){const attempts=(failure?.attempts??0)+1;this.failures.set(date,{attempts,retryAt:completedAt+Math.min(300000,2000*2**Math.min(attempts-1,8))});}
        else this.failures.delete(date);
        this.cache.set(date,{at:completedAt,result});output.set(date,result);
      }
      return output;
    } finally {resolveTurn();}
  }
  cycle(mode:'all'|'period'='all'):Promise<void> {
    if(this.cyclePromise && mode==='all' && this.runningMode==='period') return this.cyclePromise.then(()=>this.cycle('all'));
    if(!this.cyclePromise) {
      this.runningMode=mode;
      this.cyclePromise=this.performCycle(mode).finally(()=>{this.cyclePromise=undefined;this.runningMode=undefined;});
    }
    return this.cyclePromise;
  }
  async sweepExpired():Promise<void> {
    for(const t of this.repo.list().filter(t=>expired(t,this.now()))) {
      // Expired records and pending notifications are removed together by foreign keys.
      if(!this.repo.remove(t.id,t.user_id))continue;
      try {await this.onExpire(t);} catch {this.logger.write('users',`user=${t.user_id} tracking=${t.id} action=expiry_notification_failed`);}
      this.logger.write('users',`user=${t.user_id} tracking=${t.id} action=tracking_expired`);
    }
  }
  private async performCycle(mode:'all'|'period'):Promise<void> {
    await this.sweepExpired();
    const now=this.now(), window=fallbackDates(4,[],now);
    const active=this.repo.list().filter(t=>mode==='all'||t.type==='PERIOD'), dates=new Set<string>();
    for(const t of active) {if(t.type==='GENERAL') window.forEach(d=>dates.add(d)); else if(window.includes(t.date!)) dates.add(t.date!);}
    if(!dates.size)return;
    const hasPeriods=active.some(t=>t.type==='PERIOD' && window.includes(t.date!));
    const maxAge=hasPeriods?Math.min(this.config.cacheMs,this.config.periodInterval??1000):this.config.cacheMs;
    const results=await this.getDates([...dates],maxAge);
    for(const t of active) {
      if(!this.repo.get(t.id,t.user_id) || expired(t,this.now())) continue;
      const trackDates=t.type==='GENERAL'?window:window.includes(t.date!)?[t.date!]:[];
      if(!trackDates.length) continue;
      const subset=new Map(trackDates.map(date=>[date,results.get(date)??{error:'Дані недоступні'}]));
      const valid=[...subset.values()].some(r=>r.data);
      if(!valid){for(const d of trackDates)this.repo.invalidate(t.id,d);continue;}
      if(t.status==='WAITING_FOR_DATE' && !subset.get(t.date!)?.data) continue;
      const nowMs=this.now().valueOf(), initial=!t.initialized, wasWaiting=t.status==='WAITING_FOR_DATE';
      this.repo.transaction(()=>{
        if(t.type==='GENERAL')this.repo.prune(t.id,window);
        if(initial) {
          const title=wasWaiting?'📅 Дата відкрита на TirParklari':'📅 Початковий стан';
          for(const text of chunks(`${title}\n${trackingLabel(t)}\n\n${formatAvailability(subset,this.now(),t)}`)) this.repo.enqueue(t.id,wasWaiting?'OPENED':'INITIAL',text,null,nowMs);
          this.repo.initialized(t.id,nowMs);
        }
        const old=new Map(this.repo.slots(t.id).map(s=>[`${s.date}|${s.start}|${s.end}`,s]));
        const urgent:string[]=[];
        for(const [date,result] of subset) {
          if(!result.data){this.repo.invalidate(t.id,date);continue;}
          const seen=new Set<string>();
          for(const s of result.data.dilimler.filter(s=>eligible(t,date,s,this.now()))) {
            const key=`${date}|${s.baslangic}|${s.bitis}`;seen.add(key);
            const prior=old.get(key), state=classify(s);
            if(state==='UNKNOWN') {
              this.logger.write('monitor',`unknown tracking=${t.id} user=${t.user_id} date=${date} time=${s.baslangic}`);
              if(prior)this.repo.setSlot(t.id,{...prior,comparable:0},nowMs);continue;
            }
            const count=state==='AVAILABLE'?s.kalan:0;
            if(!initial && prior?.comparable && prior.count!==count) {
              const title=prior.count===0?'🟢 З’явилися вільні місця!':count===0?'🔴 Місця закінчилися.':count>prior.count?'🟢 З’явилися додаткові місця!':'🔄 Кількість місць зменшилася.';
              const text=`${title}\n${trackingLabel(t)}\n${dateLabel(date)} ${s.baslangic}–${s.bitis}: ${prior.count} → ${count}`;
              this.repo.enqueue(t.id,'CHANGE',text,key,nowMs);
              this.logger.write('monitor',`user=${t.user_id} tracking=${t.id} date=${date} time=${s.baslangic} ${prior.count}->${count}`);
              if(t.type==='PERIOD' && t.urgent && count>prior.count)urgent.push(`${dateLabel(date)} ${s.baslangic}–${s.bitis}: ${prior.count} → ${count}`);
            }
            const row:StoredSlot={date,start:s.baslangic,end:s.bitis,count,comparable:1};this.repo.setSlot(t.id,row,nowMs);
          }
          for(const [key,prior] of old) if(prior.date===date && !seen.has(key)) this.repo.setSlot(t.id,{...prior,comparable:0},nowMs);
        }
        if(urgent.length) for(const text of chunks(`🚨 УВАГА! З’ЯВИЛИСЯ ВІЛЬНІ МІСЦЯ!\n${trackingLabel(t)}\n${urgent.join('\n')}\nПеревірте доступність на TirParklari.`)) this.repo.enqueue(t.id,'URGENT',text,null,nowMs);
      });
      if(wasWaiting)this.logger.write('users',`user=${t.user_id} tracking=${t.id} action=tracking_activated`);
    }
    this.logger.write('monitor',`Спільна перевірка: dates=${[...dates].join(',')} trackings=${active.length}`);
  }
}
