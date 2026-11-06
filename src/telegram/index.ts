import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseEnv } from 'dotenv';
import { Bot } from 'grammy';
import { Repository } from './database.js';
import { Logger } from './log.js';
import { SharedMonitor, trackingLabel } from './monitor.js';
import { Notifications } from './notifications.js';
import { makeBot } from './bot.js';

class ConfigError extends Error {}
function missingTokenMessage():string {
  const path=resolve('.env');
  if(!existsSync(path)) return `Файл ${path} не знайдено. Створіть його з .env.example та додайте рядок TELEGRAM_BOT_TOKEN=ваш_токен.`;
  let contents:Buffer;
  try {contents=readFileSync(path);} catch {return `Не вдалося прочитати ${path}. Перевірте права доступу до файлу.`;}
  if(contents.includes(0)) return `Файл ${path} має непідтримуване кодування. Збережіть його у форматі UTF-8.`;
  const value=parseEnv(contents).TELEGRAM_BOT_TOKEN;
  if(value?.trim()) return 'TELEGRAM_BOT_TOKEN у .env заданий, але його перекриває порожня змінна середовища. Закрийте термінал і відкрийте новий або видаліть порожню змінну середовища.';
  return `У ${path} немає непорожнього TELEGRAM_BOT_TOKEN. Додайте рядок TELEGRAM_BOT_TOKEN=ваш_токен.`;
}
function numeric(name:string,defaultValue:number,min:number,max:number):number {
  const raw=process.env[name], value=raw===undefined?defaultValue:Number(raw);
  if(raw===''||!Number.isInteger(value)||value<min||value>max) throw new ConfigError(`${name}: очікується ціле число ${min}–${max}`);
  return value;
}
function bool(name:string,defaultValue:boolean):boolean {
  const value=process.env[name];if(value===undefined)return defaultValue;
  if(!['true','false','1','0'].includes(value))throw new ConfigError(`${name}: очікується true або false`);
  return value==='true'||value==='1';
}
async function main():Promise<void> {
  if(!bool('TELEGRAM_ENABLED',true))throw new ConfigError('Telegram вимкнено (TELEGRAM_ENABLED=false).');
  const token=process.env.TELEGRAM_BOT_TOKEN?.trim();if(!token)throw new ConfigError(missingTokenMessage());
  if((process.env.PARK??'hamzabeyli')!=='hamzabeyli')throw new ConfigError('PARK підтримує лише hamzabeyli.');
  const interval=numeric('POLL_INTERVAL_SECONDS',60,1,86400)*1000,timeout=numeric('REQUEST_TIMEOUT_SECONDS',10,1,300)*1000,delay=numeric('REQUEST_DELAY_MS',1000,0,60000);
  const periodInterval=numeric('PERIOD_POLL_INTERVAL_SECONDS',1,1,86400)*1000;
  const retention=numeric('LOG_RETENTION_DAYS',30,1,3650),defaultUrgent=bool('DEFAULT_URGENT_NOTIFICATIONS',false);
  const dbPath=process.env.DATABASE_PATH??'./data/monitor.db';if(!dbPath.trim())throw new ConfigError('DATABASE_PATH не може бути порожнім.');
  const logger=new Logger(retention),repo=new Repository(dbPath),controller=new AbortController(),bot=new Bot(token);
  const notifications=new Notifications(repo,bot.api,logger);
  const monitor=new SharedMonitor(repo,logger,{interval,timeout,delay,cacheMs:Math.min(interval,30000),periodInterval},controller.signal,undefined,undefined,async t=>{
    await bot.api.sendMessage(t.chat_id,`⏱ ${trackingLabel(t)} завершено: вибраний період минув.`);
  });
  const tasks=new Set<Promise<unknown>>();
  const run=(fn:()=>Promise<unknown>)=>{const task=fn().catch(()=>{if(!controller.signal.aborted)logger.write('monitor','Помилка фонового завдання');}).finally(()=>tasks.delete(task));tasks.add(task);};
  makeBot(bot,repo,logger,monitor,notifications,defaultUrgent,undefined,run);
  logger.cleanup();logger.write('monitor','Telegram-бот запускається.');
  let pollBusy=false,sweepBusy=false,lastGeneralAt=0;
  const poll=()=>{if(pollBusy)return;pollBusy=true;run(async()=>{try{
    const generalDue=Date.now()-lastGeneralAt>=interval;
    await monitor.cycle(generalDue?'all':'period');
    if(generalDue)lastGeneralAt=Date.now();
    run(()=>notifications.flush());
  }finally{pollBusy=false;}});};
  const sweep=()=>{if(sweepBusy)return;sweepBusy=true;run(async()=>{try{await monitor.sweepExpired();await notifications.flush();}finally{sweepBusy=false;}});};
  const timers=[setInterval(poll,Math.min(interval,periodInterval)),setInterval(sweep,5000),setInterval(()=>run(async()=>logger.cleanup()),86400000)];
  const stop=()=>{controller.abort();for(const timer of timers)clearInterval(timer);void bot.stop().catch(()=>logger.write('monitor','Помилка зупинки Telegram polling'));};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  poll();
  try {await bot.start({onStart:()=>console.log('Telegram-бот запущено. Для зупинки натисніть Ctrl+C.')});}
  finally {
    controller.abort();for(const timer of timers)clearInterval(timer);
    await Promise.allSettled([...tasks]);
    logger.write('monitor','Telegram-бот зупинено.');repo.close();
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  }
}
main().catch(e=>{console.error(e instanceof ConfigError?e.message:'Не вдалося запустити Telegram-бота. Перевірте конфігурацію, токен і з’єднання.');process.exitCode=1;});
