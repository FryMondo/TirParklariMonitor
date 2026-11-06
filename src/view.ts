import { classify, type Slot } from './model.js';
import { fallbackDates, istanbulDate, validDate } from './core.js';

export type Period = { date: string; start: number; end: number; label: string };
export type Observation = { date: string; slot: Slot; count: number | null };
export type Snapshot = { dates: string[]; observations: Observation[]; incomplete: boolean; failed: string[] };
export type Change = { date: string; slot: Slot; before: number; after: number };
export function clockMinutes(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Istanbul',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const n = (key:string) => Number(parts.find(x=>x.type===key)!.value);
  return n('hour')*60+n('minute')+n('second')/60+now.getUTCMilliseconds()/60000;
}
export function parseDateInput(value: string): string {
  const m=/^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value.trim());
  const date = m ? `${m[3]}-${m[2]}-${m[1]}` : '';
  if (!validDate(date)) throw new Error('Введіть дійсну дату у форматі DD.MM.YYYY.');
  return date;
}
export function parsePeriod(date:string, text:string): Period {
  const m=/^([0-2]\d:[0-5]\d)-([0-2]\d:[0-5]\d)$/.exec(text.trim());
  const value=(s:string, end:boolean) => { if (s==='24:00' && end) return 1440; const h=Number(s.slice(0,2)); if(h>23) throw new Error('Некоректний час.'); return h*60+Number(s.slice(3)); };
  if (!m) throw new Error('Введіть період у форматі HH:mm-HH:mm.');
  const start=value(m[1],false), end=value(m[2],true);
  if(start>=end) throw new Error('Початок періоду має бути раніше завершення.');
  return {date,start,end,label:`${m[1]}–${m[2]}`};
}
export function periodExpired(period:Period, days:number, now:Date):boolean {
  if(!fallbackDates(days,[],now).includes(period.date)) return true;
  return period.date===istanbulDate(now) && clockMinutes(now)>=period.end;
}
export function inScope(date:string, slot:Slot, now:Date, period?:Period):boolean {
  if (date < istanbulDate(now) || (date === istanbulDate(now) && slot.baslangicDakika <= clockMinutes(now))) return false;
  const end = slot.bitis==='24:00' ? 1440 : Number(slot.bitis.slice(0,2))*60+Number(slot.bitis.slice(3));
  return !period || (date===period.date && slot.baslangicDakika<period.end && end>period.start);
}
export function observations(date:string, slots:Slot[], now:Date, period?:Period):Observation[] {
  return slots.filter(s=>inScope(date,s,now,period)).map(slot=>({date,slot,count:classify(slot)==='UNKNOWN' ? null : classify(slot)==='AVAILABLE' ? slot.kalan : 0}));
}
const key=(o:Observation)=>`${o.date}|${o.slot.baslangic}|${o.slot.bitis}`;
export function markMissing(previous:Snapshot|undefined, current:Snapshot, now:Date, period?:Period):Observation[] {
  const missing:Observation[]=[];
  const present=new Set(current.observations.map(key));
  for(const old of previous?.observations??[]) {
    if(!current.dates.includes(old.date) || current.failed.includes(old.date) || !inScope(old.date,old.slot,now,period) || present.has(key(old))) continue;
    const unknown={...old,count:null}; current.observations.push(unknown); current.incomplete=true; missing.push(unknown);
  }
  return missing;
}
export function compare(previous:Snapshot|undefined, current:Snapshot): { changed:boolean; changes:Change[] } {
  if(!previous) return {changed:true,changes:[]};
  const old=new Map(previous.observations.map(o=>[key(o),o]));
  const changes:Change[]=[];
  const unreliable = new Set([...previous.failed,...current.failed,...previous.observations.filter(o=>o.count===null).map(o=>o.date),...current.observations.filter(o=>o.count===null).map(o=>o.date)]);
  for(const o of current.observations) {
    const before=old.get(key(o));
    if(!unreliable.has(o.date) && before && before.count!==null && o.count!==null && before.count!==o.count) changes.push({date:o.date,slot:o.slot,before:before.count,after:o.count});
  }
  const fingerprint=(s:Snapshot)=>JSON.stringify({ dates:s.dates, failed:s.failed, unknown:s.observations.filter(o=>o.count===null).map(key).sort(), free:s.observations.filter(o=>o.count!==null && o.count>0).map(o=>[key(o),o.count]).sort() });
  return {changed:fingerprint(previous)!==fingerprint(current),changes};
}
export function dateLabel(date:string):string { return `${date.slice(8,10)}.${date.slice(5,7)}.${date.slice(0,4)}`; }
export function placeWord(n:number):string { const a=n%100,b=n%10; return a>=11 && a<=14 ? 'місць' : b===1 ? 'місце' : b>=2 && b<=4 ? 'місця' : 'місць'; }
export function render(snapshot:Snapshot, now:Date, initial:boolean, period?:Period, changes:Change[]=[]):string {
  const free=snapshot.observations.filter(o=>o.count!==null && o.count>0).sort((a,b)=>key(a).localeCompare(key(b)));
  if(initial && !free.length && !snapshot.incomplete && !period) return 'Вільних місць немає.';
  const tr=new Intl.DateTimeFormat('uk-UA',{timeZone:'Europe/Istanbul',dateStyle:'short',timeStyle:'short'}).format(now);
  const time=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Istanbul',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(now);
  const lines=[initial ? `Hamzabeyli — доступні місця\nПеревірено: ${tr} (TR)` : `[${time}] ОНОВЛЕННЯ ДОСТУПНОСТІ`];
  if(period) lines.push(`Моніторинг: ${dateLabel(period.date)}, ${period.label}`);
  for(const date of [...new Set(free.map(o=>o.date))]) {
    const entries=free.filter(o=>o.date===date), sum=entries.reduce((a,o)=>a+o.count!,0);
    lines.push(`\n${dateLabel(date)} — є вільні місця (${sum}):`);
    for(const o of entries) lines.push(`  ${o.slot.baslangic}–${o.slot.bitis} — ${o.count} ${placeWord(o.count!)}`);
  }
  if(!free.length && !snapshot.incomplete) lines.push('\nВільних місць немає.');
  if(snapshot.incomplete) lines.push('\nУвага: перевірка неповна; деякі дані невідомі або недоступні.');
  if(changes.length) {
    lines.push('\nЗміни:');
    for(const c of changes) lines.push(`  ${dateLabel(c.date)} ${c.slot.baslangic}–${c.slot.bitis}: ${c.before} → ${c.after}${c.before===0?' (новий вільний інтервал)':c.after===0?' (місця закінчилися)':''}`);
    for(const c of changes.filter(c=>c.before>0 && c.after>c.before)) lines.push(`\nЗ'ЯВИЛИСЯ ДОДАТКОВІ МІСЦЯ! ${dateLabel(c.date)} ${c.slot.baslangic}–${c.slot.bitis}: було ${c.before}, стало ${c.after}, додалося ${c.after-c.before} ${placeWord(c.after-c.before)}.`);
  }
  return lines.join('\n');
}
