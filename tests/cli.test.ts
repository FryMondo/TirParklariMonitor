import { it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

it('запускає цикл із mock API, показує збільшення і зберігає стан при Ctrl+C',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'tir-cli-'));
  try {
    const require=createRequire(import.meta.url);
    const loader=pathToFileURL(require.resolve('tsx')).href;
    const mock=pathToFileURL(resolve('tests/fixtures/mock-monitor.mjs')).href;
    const result=await new Promise<{out:string; code:number|null}>((resolveResult,reject)=>{
      const child=spawn(process.execPath,['--import',loader,'--import',mock,resolve('src/index.ts')],{cwd:dir,env:{...process.env,PARK:'hamzabeyli',FALLBACK_DAYS:'1',POLL_INTERVAL_SECONDS:'1',REQUEST_DELAY_MS:'0',NODE_OPTIONS:''}});
      let out=''; child.stdout.on('data',chunk=>out+=chunk); child.stderr.on('data',chunk=>out+=chunk);
      child.on('error',reject); child.on('close',code=>resolveResult({out,code}));
    });
    expect(result.code).toBe(0); expect(result.out).toContain('17:00–17:30'); expect(result.out).toContain('ДОДАТКОВІ МІСЦЯ'); expect(result.out).toContain('Моніторинг зупинено');
    const history=await readFile(join(dir,'data/available_slots.txt'),'utf8');
    expect(history.match(/AVAILABLE_NEW/g)).toHaveLength(1); expect(history.match(/AVAILABLE_INCREASE/g)).toHaveLength(1);
    expect(JSON.parse(await readFile(join(dir,'data/state.json'),'utf8')).slots['hamzabeyli|2026-11-04|17:00|17:30'].count).toBe(4);
  } finally { await rm(dir,{recursive:true,force:true}); }
},15000);

it('показує помилку сертифіката відразу і не повторює запити для інших дат',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'tir-tls-'));
  try {
    const require=createRequire(import.meta.url), loader=pathToFileURL(require.resolve('tsx')).href;
    const mock=pathToFileURL(resolve('tests/fixtures/mock-tls-error.mjs')).href;
    const result=await new Promise<{out:string;code:number|null}>((done,reject)=>{
      const child=spawn(process.execPath,['--use-system-ca','--import',loader,'--import',mock,resolve('src/index.ts'),'--once'],{cwd:dir,env:{...process.env,PARK:'hamzabeyli',FALLBACK_DAYS:'4',NODE_OPTIONS:''}});
      let out=''; child.stdout.on('data',chunk=>out+=chunk); child.stderr.on('data',chunk=>out+=chunk);
      child.on('error',reject); child.on('close',code=>done({out,code}));
    });
    expect(result.code).toBe(1); expect(result.out).toContain('Перевіряємо доступність');
    expect(result.out).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE'); expect(result.out).toContain('перевірка неповна');
    const log=await readFile(join(dir,'logs/monitor.log'),'utf8');
    expect(log).not.toContain('повтор 1/2'); expect(log).not.toContain('Неочікуваний повторний запит');
  } finally { await rm(dir,{recursive:true,force:true}); }
},10000);

it('інтерактивно перевіряє дату й моніторить лише обраний період',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'tir-period-'));
  try {
    const require=createRequire(import.meta.url), loader=pathToFileURL(require.resolve('tsx')).href;
    const mock=pathToFileURL(resolve('tests/fixtures/mock-monitor.mjs')).href;
    const result=await new Promise<{out:string;code:number|null}>((resolveResult,reject)=>{
      const child=spawn(process.execPath,['--import',loader,'--import',mock,resolve('src/index.ts'),'--period'],{cwd:dir,env:{...process.env,PARK:'hamzabeyli',FALLBACK_DAYS:'4',POLL_INTERVAL_SECONDS:'1',REQUEST_DELAY_MS:'0',NODE_OPTIONS:''}});
      let out='', step=0;
      child.stdout.on('data',chunk=>{
        out+=chunk;
        if(step===0 && out.includes('Введіть дату')) { step=1; child.stdin.write('08.11.2026\n'); }
        else if(step===1 && out.includes('Дата поза доступним діапазоном')) { step=2; child.stdin.write('04.11.2026\n'); }
        else if(step===2 && out.includes('Введіть період')) { step=3; child.stdin.write('17:01-17:02\n'); }
      });
      child.stderr.on('data',chunk=>out+=chunk); child.on('error',reject); child.on('close',code=>resolveResult({out,code}));
    });
    expect(result.code).toBe(0); expect(result.out).toContain('Дата поза доступним діапазоном');
    expect(result.out).toContain('Моніторинг: 04.11.2026, 17:01–17:02'); expect(result.out).toContain('17:00–17:30'); expect(result.out).toContain('ДОДАТКОВІ МІСЦЯ');
  } finally { await rm(dir,{recursive:true,force:true}); }
},15000);

it('пояснює проблему з .env, не розкриваючи вміст токена',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'tir-config-'));
  try {
    const loader=pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
    const run=()=>new Promise<{out:string;code:number|null}>((done,reject)=>{
      const child=spawn(process.execPath,['--use-system-ca','--import',loader,resolve('src/telegram/index.ts')],{cwd:dir,env:{...process.env,TELEGRAM_BOT_TOKEN:'',TELEGRAM_ENABLED:'true',NODE_OPTIONS:''}});
      let out='';child.stdout.on('data',data=>out+=data);child.stderr.on('data',data=>out+=data);
      child.on('error',reject);child.on('close',code=>done({out,code}));
    });
    const absent=await run();expect(absent.code).toBe(1);expect(absent.out).toContain('не знайдено');
    await writeFile(join(dir,'.env'),'123456:TEST_SECRET\n');
    const bare=await run();expect(bare.out).toContain('немає непорожнього TELEGRAM_BOT_TOKEN');expect(bare.out).not.toContain('TEST_SECRET');
    await writeFile(join(dir,'.env'),'TELEGRAM_BOT_TOKEN=123456:TEST_SECRET\n');
    const overridden=await run();expect(overridden.out).toContain('перекриває порожня змінна середовища');expect(overridden.out).not.toContain('TEST_SECRET');
  } finally {await rm(dir,{recursive:true,force:true});}
},15000);
