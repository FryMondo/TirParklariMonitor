import { describe, expect, it } from 'vitest';
import { fallbackDates, update, type State } from '../src/core.js';
import { compare, markMissing, observations, parseDateInput, parsePeriod, periodExpired, placeWord, render, type Snapshot } from '../src/view.js';
import type { Slot } from '../src/model.js';

const now=new Date('2026-11-02T18:00:00Z'); // 21:00 in Istanbul
const date='2026-11-05';
const slot=(start:string,end:string,count:number,acik=count>0):Slot=>({baslangicDakika:Number(start.slice(0,2))*60+Number(start.slice(3)),baslangic:start,bitis:end,kapasite:17,kalan:count,acik,kapali:false});
const a=slot('17:00','17:30',2), b=slot('23:30','24:00',3), busy=slot('18:00','18:30',0);
const snap=(slots:Slot[], dates=[date], failed:string[]=[]):Snapshot=>{const obs=observations(date,slots,now);return {dates,observations:obs,failed,incomplete:failed.length>0||obs.some(x=>x.count===null)};};

describe('Термінальний знімок',()=>{
  it('показує лише вільні дати, сортовані інтервали та суму місць',()=>{
    const result=render(snap([b,busy,a],['2026-11-04',date]),now,true);
    expect(result).toContain('05.11.2026 — є вільні місця (5)'); expect(result).not.toContain('04.11.2026'); expect(result).not.toContain('18:00–18:30');
    expect(result.indexOf('17:00–17:30')).toBeLessThan(result.indexOf('23:30–24:00'));
    expect([1,2,5,11,21,22,111].map(placeWord)).toEqual(['місце','місця','місць','місць','місце','місця','місць']);
  });
  it('виводить одне повідомлення при повній відсутності та попереджає про часткову',()=>{
    expect(render(snap([busy]),now,true)).toBe('Вільних місць немає.');
    const partial=render(snap([busy], [date], ['2026-11-04']),now,true);
    expect(partial).toContain('перевірка неповна'); expect(partial).not.toContain('Вільних місць немає.');
    expect(render(snap([{...a,acik:false}]),now,true)).toContain('перевірка неповна');
  });
  it('початковий вивід не залежить від старого стану, а однакові відповіді не друкуються повторно',()=>{
    const state:State={version:1,slots:{}};
    update(state,'hamzabeyli',date,[a],()=>{});
    expect(update(state,'hamzabeyli',date,[a],()=>{})[0].type).toBe('AVAILABLE_UNCHANGED');
    expect(compare(undefined,snap([a])).changed).toBe(true);
    expect(render(snap([a]),now,true)).toContain('17:00–17:30');
    expect(compare(snap([a]),snap([a])).changed).toBe(false);
  });
  it('розрізняє збільшення, зменшення, появу, зникнення та повернення',()=>{
    const cases=[[2,4],[4,2],[0,2],[2,0],[0,2]];
    for(const [before,after] of cases) {
      const old=snap([slot('17:00','17:30',before)]), current=snap([slot('17:00','17:30',after)]), result=compare(old,current);
      expect(result.changed).toBe(true); expect(result.changes[0]).toMatchObject({before,after});
      const text=render(current,now,false,undefined,result.changes);
      expect(text.includes('ДОДАТКОВІ МІСЦЯ')).toBe(before>0 && after>before);
    }
  });
  it('не робить висновок про зміну після помилки або невідомого стану',()=>{
    const failed:Snapshot={dates:[date],observations:[],failed:[date],incomplete:true};
    expect(compare(failed,snap([a])).changes).toEqual([]);
    expect(compare(snap([{...a,acik:false}]),snap([{...a,kalan:4}])).changes).toEqual([]);
    expect(compare(snap([a,{...b,acik:false}]),snap([{...a,kalan:4},b])).changes).toEqual([]);
  });
  it('вважає відсутній у відповіді інтервал невідомим, а не зайнятим',()=>{
    const before=snap([a]), after=snap([]);
    expect(markMissing(before,after,now)).toHaveLength(1); expect(after.incomplete).toBe(true);
    expect(compare(before,after).changes).toEqual([]); expect(render(after,now,false)).toContain('перевірка неповна');
  });
  it('оновлює вікно дат і не показує інтервал, що вже почався',()=>{
    expect(fallbackDates(4,[],new Date('2026-11-02T20:59:59Z'))).toEqual(['2026-11-02','2026-11-03','2026-11-04','2026-11-05']);
    expect(fallbackDates(4,[],new Date('2026-11-02T21:00:00Z'))).toEqual(['2026-11-03','2026-11-04','2026-11-05','2026-11-06']);
    expect(compare(snap([a],['2026-11-02',date]),snap([a],['2026-11-03',date])).changed).toBe(true);
    expect(observations('2026-11-02',[slot('20:30','21:30',2),slot('21:30','22:00',2)],now).map(o=>o.slot.baslangic)).toEqual(['21:30']);
  });
});
describe('Вибір періоду',()=>{
  it('перевіряє дату і час, включно з 24:00',()=>{
    expect(parseDateInput('05.11.2026')).toBe(date);
    for(const s of ['31.02.2026','5.11.2026','01.13.2026']) expect(()=>parseDateInput(s)).toThrow();
    expect(parsePeriod(date,'18:15-24:00').end).toBe(1440);
    for(const s of ['24:00-24:00','18:00-24:01','20:00-18:00','8:00-09:00','23:00-25:00']) expect(()=>parsePeriod(date,s)).toThrow();
  });
  it('включає інтервали, що перетинаються з періодом, та завершує після періоду чи виходу дати з вікна',()=>{
    const p=parsePeriod(date,'18:15-24:00');
    expect(observations(date,[slot('18:00','18:30',1),slot('18:30','19:00',1),b],now,p).map(o=>o.slot.baslangic)).toEqual(['18:00','18:30','23:30']);
    expect(periodExpired(p,4,now)).toBe(false);
    expect(periodExpired(p,4,new Date('2026-11-05T21:00:00Z'))).toBe(true);
    expect(periodExpired(parsePeriod('2026-11-02','18:00-20:00'),4,now)).toBe(true);
  });
  it('знаходить перетини для короткого та широкого періодів',()=>{
    const slots=[slot('13:30','14:00',1),slot('14:00','14:30',1),slot('20:00','20:30',2),slot('21:30','22:00',1),slot('22:00','22:30',1)];
    const find=(period:string)=>observations(date,slots,now,parsePeriod(date,period)).map(o=>`${o.slot.baslangic}–${o.slot.bitis}`);
    expect(find('20:01-20:02')).toEqual(['20:00–20:30']);
    expect(find('14:01-21:45')).toEqual(['14:00–14:30','20:00–20:30','21:30–22:00']);
    expect(find('14:00-14:30')).toEqual(['14:00–14:30']);
    expect(observations(date,[b],now,parsePeriod(date,'23:59-24:00'))).toHaveLength(1);
  });
});
