import 'dotenv/config';
import { setTimeout as sleep } from 'node:timers/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fallbackDates, update } from './core.js';
import { fetchDate, HttpError } from './http.js';
import { append, loadState, saveState } from './storage.js';
import { compare, dateLabel, inScope, markMissing, observations, parseDateInput, parsePeriod, periodExpired, render, type Period, type Snapshot } from './view.js';

function number(name:string, fallback:number, min:number, max:number):number {
  const raw=process.env[name], n=raw===undefined?fallback:Number(raw);
  if(!Number.isInteger(n)||n<min||n>max||raw==='') throw new Error(`${name}: очікується ціле число від ${min} до ${max}`);
  return n;
}
async function wait(ms:number, signal:AbortSignal):Promise<void> {
  // Node timers overflow above 2^31-1 ms; honor even very long Retry-After values.
  while(ms>0) { const part=Math.min(ms,2_147_483_647); await sleep(part,undefined,{signal}); ms-=part; }
}
function config() {
  const park=process.env.PARK??'hamzabeyli'; if(park!=='hamzabeyli') throw new Error('PARK підтримує лише hamzabeyli');
  const verbose=process.env.VERBOSE??'false'; if(!['true','false','1','0'].includes(verbose)) throw new Error('VERBOSE: true, false, 1 або 0');
  return {park,verbose:verbose==='true'||verbose==='1',days:number('FALLBACK_DAYS',4,1,366),interval:number('POLL_INTERVAL_SECONDS',60,1,86400)*1000,timeout:number('REQUEST_TIMEOUT_SECONDS',10,1,300)*1000,delay:number('REQUEST_DELAY_MS',1000,0,60000)};
}
function timestamp(now=new Date()):string {
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Istanbul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const p=(name:string)=>parts.find(x=>x.type===name)!.value;
  return `${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}:${p('second')}+03:00`;
}
async function selectPeriod(days:number, signal:AbortSignal):Promise<Period> {
  const rl=createInterface({input:stdin,output:stdout});
  try {
    let date='';
    while(!signal.aborted) {
      try {
        date=parseDateInput(await rl.question('Введіть дату (DD.MM.YYYY): ',{signal}));
        const dates=fallbackDates(days,[]);
        if(!dates.includes(date)) { console.log(`Дата поза доступним діапазоном: ${dateLabel(dates[0])}–${dateLabel(dates.at(-1)!)}.`); continue; }
        break;
      } catch(e) { if(signal.aborted) throw e; console.log(String(e instanceof Error?e.message:e)); }
    }
    while(!signal.aborted) {
      try {
        const period=parsePeriod(date,await rl.question('Введіть період (HH:mm-HH:mm): ',{signal}));
        if(periodExpired(period,days,new Date())) { console.log('Дата або вибраний період уже неактуальні.'); continue; }
        return period;
      } catch(e) { if(signal.aborted) throw e; console.log(String(e instanceof Error?e.message:e)); }
    }
    throw new Error('Моніторинг зупинено.');
  } finally { rl.close(); }
}
async function main() {
  const c=config(), controller=new AbortController();
  const stop=()=>{ console.log('\nМоніторинг зупинено.'); controller.abort(); };
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
  let period:Period|undefined;
  try { if(process.argv.includes('--period')) period=await selectPeriod(c.days,controller.signal); }
  catch(e) { if(controller.signal.aborted) return; throw e; }
  const state=await loadState();
  async function log(message:string) { const line=`[${timestamp()}] ${message}`; await append('logs/monitor.log',line); if(c.verbose) console.log(line); }
  await log('Монітор запущено.');
  if(process.env.FALLBACK_DATES) await log('FALLBACK_DATES більше не використовується: дати обчислюються від поточної дати Туреччини.');
  let failures=0, previous:Snapshot|undefined;
  console.log('Перевіряємо доступність Hamzabeyli...');
  try {
    do {
      if(period && periodExpired(period,c.days,new Date())) { console.log('Обрана дата або період уже минули. Моніторинг завершено.'); break; }
      const dates=period?[period.date]:fallbackDates(c.days,[]), snapshot:Snapshot={dates,observations:[],incomplete:false,failed:[]};
      let retryDelay=0, halted=false, stoppedByProtection=false;
      await log(`Початок перевірки: ${dates.join(', ')}.`);
      for(let i=0;i<dates.length && !controller.signal.aborted;i++) {
        if(period && periodExpired(period,c.days,new Date())) break;
        const date=dates[i]; let data:Awaited<ReturnType<typeof fetchDate>>|undefined;
        try {
          for(let attempt=0;attempt<3;attempt++) {
            try { data=await fetchDate(date,c.timeout,controller.signal); break; }
            catch(e) { if(!(e instanceof HttpError)||!e.temporary||attempt===2) throw e; await log(`${date}: ${e.message}; повтор ${attempt+1}/2`); await sleep(2000*2**attempt,undefined,{signal:controller.signal}); }
          }
          if(!data) throw new Error('Немає відповіді');
        } catch(e) {
          if(controller.signal.aborted) break;
          snapshot.incomplete=true; snapshot.failed.push(date); await log(`${date}: помилка перевірки: ${String(e)}`);
          if(e instanceof HttpError && e.certificateError) {
            stoppedByProtection=true;
            console.error(`Не вдалося перевірити TLS-сертифікат: ${e.message}. Перевірте дату й час комп’ютера та довірені сертифікати; подробиці — у logs/monitor.log.`);
            snapshot.failed.push(...dates.slice(i+1)); break;
          }
          if(e instanceof HttpError && [429,401,403].includes(e.status)) {
            halted=true; retryDelay=Math.max(e.retryAfterMs,300000); stoppedByProtection=e.status!==429;
            await log(e.status===429?`Обмеження запитів: пауза щонайменше ${retryDelay/1000} с.`:'Захисна перешкода: моніторинг зупинено.');
            snapshot.failed.push(...dates.slice(i+1)); break;
          }
        }
        if(data) {
          const checkedAt=new Date(), current=observations(date,data.dilimler,checkedAt,period);
          const daySnapshot:Snapshot={dates:[date],observations:[...current],failed:[],incomplete:current.some(o=>o.count===null)};
          for(const old of markMissing(previous,daySnapshot,checkedAt,period)) await log(`${old.date} ${old.slot.baslangic}–${old.slot.bitis}: інтервал відсутній у відповіді; стан невідомий.`);
          snapshot.observations.push(...daySnapshot.observations);
          if(daySnapshot.incomplete) snapshot.incomplete=true;
          const messages:string[]=[];
          // Unknown slots are passed for diagnostics; only in-scope slots update persistent history.
          const events=update(state,c.park,date,current.map(o=>o.slot),m=>messages.push(m));
          for(const message of messages) await log(message);
          await saveState(state);
          for(const event of events) {
            if(event.type==='AVAILABLE_NEW'||event.type==='AVAILABLE_RETURNED') {
              const wasObserved=previous?.observations.some(o=>o.date===date && o.slot.baslangic===event.slot.baslangic && o.slot.bitis===event.slot.bitis && o.count!==null);
              const uncertain=previous && previous.dates.includes(date) && (!wasObserved || previous.failed.includes(date) || previous.observations.some(o=>o.date===date && o.count===null) || daySnapshot.incomplete);
              if(uncertain) { await log(`${date} ${event.slot.baslangic}: зміна після неповних даних не підтверджена.`); continue; }
              const s=event.slot, line=`${timestamp()} | Hamzabeyli | ${date} | ${s.baslangic}–${s.bitis} | available=${s.kalan} | ${event.type}`;
              await append('data/available_slots.txt',line); await log(line);
            } else if(event.type==='AVAILABLE_GONE') {
              const comparable=!previous || (previous.observations.some(o=>o.date===date && o.slot.baslangic===event.slot.baslangic && o.slot.bitis===event.slot.bitis && o.count!==null) && !previous.observations.some(o=>o.date===date && o.count===null) && !daySnapshot.incomplete);
              if(comparable) await log(`${date} ${event.slot.baslangic}–${event.slot.bitis}: AVAILABLE_GONE`);
            }
          }
        }
        if(i<dates.length-1 && c.delay) await sleep(c.delay,undefined,{signal:controller.signal});
      }
      if(controller.signal.aborted) break;
      if(period && periodExpired(period,c.days,new Date())) { console.log('Обрана дата або період уже минули. Моніторинг завершено.'); break; }
      const finishedAt=new Date();
      if(!period && dates.join(',')!==fallbackDates(c.days,[],finishedAt).join(',')) {
        await log('Дата в Туреччині змінилася під час перевірки; починаємо новий цикл.');
        continue;
      }
      snapshot.observations=snapshot.observations.filter(o=>inScope(o.date,o.slot,finishedAt,period));
      // An interval that disappears from an otherwise successful response is unknown,
      // not evidence that availability vanished. Expired intervals are excluded.
      for(const old of markMissing(previous,snapshot,finishedAt,period)) await log(`${old.date} ${old.slot.baslangic}–${old.slot.bitis}: інтервал відсутній у відповіді; стан невідомий.`);
      const {changed,changes}=compare(previous,snapshot);
      for(const change of changes.filter(x=>x.before>0 && x.after>x.before)) {
        const line=`${timestamp()} | Hamzabeyli | ${change.date} | ${change.slot.baslangic}–${change.slot.bitis} | ${change.before} -> ${change.after} | AVAILABLE_INCREASE`;
        await append('data/available_slots.txt',line); await log(line);
      }
      if(changed) console.log(render(snapshot,new Date(),!previous,period,changes));
      await log(`Завершено: ${dates.length-snapshot.failed.length}/${dates.length} дат; ${snapshot.incomplete?'часткова перевірка':'перевірка повна'}.`);
      previous=snapshot; failures=snapshot.failed.length?Math.min(failures+1,6):0;
      if(process.argv.includes('--once')||stoppedByProtection) { if(snapshot.failed.length) process.exitCode=1; break; }
      let delay=Math.max(retryDelay,c.interval*2**failures);
      if(period) {
        const midnight=Date.parse(`${period.date}T00:00:00+03:00`);
        delay=Math.min(delay,Math.max(0,midnight+period.end*60000-Date.now()));
      }
      if(halted) await log(`Наступна перевірка не раніше ніж через ${Math.ceil(delay/1000)} с.`);
      await wait(delay,controller.signal);
    } while(!controller.signal.aborted);
  } catch(e) { if(!controller.signal.aborted) throw e; }
  finally { await log('Монітор зупинено.'); }
}
main().catch(e=>{console.error(`Критична помилка: ${String(e)}`);process.exitCode=1;});
