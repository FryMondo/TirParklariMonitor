import { describe, expect, it } from 'vitest';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, parseResponse } from '../src/model.js';
import { fallbackDates, istanbulDate, update, type State } from '../src/core.js';
import { fetchDate, HttpError, retryAfter } from '../src/http.js';
import { loadState, saveState } from '../src/storage.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/2026-11-04.json',import.meta.url),'utf8'));
const data = parseResponse(fixture,'2026-11-04');
const free = data.dilimler.find(s=>classify(s)==='AVAILABLE')!;
const busy = {...free,kalan:0,acik:false};
const empty = (): State => ({version:1,slots:{}});
const noop = () => {};
describe('Валідація та переходи',()=>{
  it('читає справжній приклад: 48 інтервалів, 16 вільних, 34 місця, 24:00',()=>{
    const slots=data.dilimler.filter(s=>classify(s)==='AVAILABLE');
    expect(data.dilimler).toHaveLength(48); expect(slots).toHaveLength(16); expect(slots.reduce((n,s)=>n+s.kalan,0)).toBe(34);
    expect(data.dilimler.at(-1)?.bitis).toBe('24:00');
  });
  it('зайнятий день і невідомі комбінації',()=>{
    expect(data.dilimler.map(()=>busy).every(s=>classify(s)==='OCCUPIED')).toBe(true);
    expect(classify({...free,kapali:true})).toBe('UNKNOWN'); expect(classify({...busy,acik:true})).toBe('UNKNOWN');
  });
  it('виявляє появу, незмінність, зміну кількості, зникнення й повернення',()=>{
    const state=empty(), messages:string[]=[]; const run=(s:typeof free)=>update(state,'hamzabeyli','2026-11-04',[s],m=>messages.push(m))[0]?.type;
    expect(run(free)).toBe('AVAILABLE_NEW'); expect(run(free)).toBe('AVAILABLE_UNCHANGED');
    expect(run({...free,kalan:2})).toBe('AVAILABLE_UNCHANGED'); expect(messages).toHaveLength(1);
    expect(run(busy)).toBe('AVAILABLE_GONE'); expect(run(free)).toBe('AVAILABLE_RETURNED');
  });
  it('невідомий стан та відсутня дата зберігають попередній стан',()=>{
    const state=empty(); update(state,'hamzabeyli','2026-11-04',[free],noop);
    update(state,'hamzabeyli','2026-11-04',[{...free,kapali:true}],noop);
    update(state,'hamzabeyli','2026-11-05',[busy],noop);
    expect(update(state,'hamzabeyli','2026-11-04',[free],noop)[0].type).toBe('AVAILABLE_UNCHANGED');
  });
  it('відхиляє неправильні дати, час та дублікати',()=>{
    expect(()=>parseResponse(fixture,'2026-11-05')).toThrow();
    expect(()=>parseResponse({...fixture,dilimler:[free,free]},'2026-11-04')).toThrow();
    expect(()=>parseResponse({...fixture,dilimler:[{...free,bitis:'25:00'}]},'2026-11-04')).toThrow();
  });
  it('оновлює дати опівночі у Стамбулі',()=>{
    expect(istanbulDate(new Date('2026-11-02T20:59:59Z'))).toBe('2026-11-02');
    expect(fallbackDates(2,[],new Date('2026-11-02T21:00:00Z'))).toEqual(['2026-11-03','2026-11-04']);
    expect(fallbackDates(4,['2026-11-07','2026-11-08'])).toEqual(['2026-11-07','2026-11-08']);
  });
  it('відновлює стан після перезапуску і не перезаписує пошкоджений',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'tir-monitor-')); const path=join(dir,'state.json');
    try { const state=empty(); update(state,'hamzabeyli','2026-11-04',[free],noop); await saveState(state,path);
      expect(update(await loadState(path),'hamzabeyli','2026-11-04',[free],noop)[0].type).toBe('AVAILABLE_UNCHANGED');
      const {writeFile}=await import('node:fs/promises'); await writeFile(path,'broken'); await expect(loadState(path)).rejects.toThrow('пошкоджений'); expect(await readFile(path,'utf8')).toBe('broken');
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
});
describe('HTTP без мережі',()=>{
  const signal = new AbortController().signal;
  const mock=(body:string,status=200,headers:Record<string,string>={'content-type':'application/json'}) => (async()=>new Response(body,{status,headers})) as typeof fetch;
  it('приймає JSON і відхиляє некоректний JSON',async()=>{
    expect((await fetchDate('2026-11-04',1000,signal,mock(JSON.stringify(fixture)))).gun).toBe('2026-11-04');
    await expect(fetchDate('2026-11-04',1000,signal,mock('{'))).rejects.toThrow('Некоректний JSON');
  });
  it('передає 429 і Retry-After без повторного запиту',async()=>{
    let count=0; const client=(async()=>{count++;return new Response('',{status:429,headers:{'Retry-After':'120'}})}) as typeof fetch;
    try { await fetchDate('2026-11-04',1000,signal,client); throw new Error('очікувалася помилка'); } catch(e) { expect(e).toBeInstanceOf(HttpError); expect((e as HttpError).retryAfterMs).toBe(120000); }
    expect(count).toBe(1); expect(retryAfter('Wed, 21 Oct 2015 07:28:00 GMT',Date.parse('2015-10-21T07:27:00Z'))).toBe(60000);
  });
  it('показує код причини мережевої помилки',async()=>{
    const client=(async()=>{throw new TypeError('fetch failed',{cause:Object.assign(new Error('certificate'),{code:'UNABLE_TO_VERIFY_LEAF_SIGNATURE'})})}) as typeof fetch;
    await expect(fetchDate('2026-11-04',1000,signal,client)).rejects.toThrow('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
  });
});
