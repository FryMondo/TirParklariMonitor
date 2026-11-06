import { Bot, InlineKeyboard, Keyboard, type Context } from 'grammy';
import { fallbackDates, istanbulDate } from '../core.js';
import { clockMinutes, dateLabel, parseDateInput, parsePeriod, type Period } from '../view.js';
import { Repository, type Tracking } from './database.js';
import { Logger } from './log.js';
import { chunks, formatAvailability, SharedMonitor, trackingLabel } from './monitor.js';
import { Notifications } from './notifications.js';

type Draft={step:'DATE'|'PERIOD'|'CONFIRM';date?:string;period?:Period};
const keyboard=new Keyboard().text('🔍 Перевірити місця').text('🌍 Відстежувати всі дні').row().text('📅 Відстежувати період').text('📋 Мої відстеження').resized();
function describe(t:Tracking):string {return `${t.type==='GENERAL'?'🌍':'📅'} ${trackingLabel(t)}`;}
export function makeBot(bot:Bot,repo:Repository,logger:Logger,monitor:SharedMonitor,notifications:Notifications,defaultUrgent:boolean,now:()=>Date=()=>new Date(),schedule:(fn:()=>Promise<void>)=>void=fn=>{void fn().catch(()=>logger.write('monitor','Помилка циклу або доставки'));}):Bot {
  const drafts=new Map<number,Draft>();
  function user(ctx:Context):number {return repo.userId(ctx.from!.id)!;}
  async function sendLong(ctx:Context,text:string) {for(const part of chunks(text))await ctx.reply(part);}
  function kick() {schedule(async()=>{await monitor.cycle();await notifications.flush();});}
  async function menu(ctx:Context) {await ctx.reply('Оберіть дію:',{reply_markup:keyboard});}
  bot.use(async(ctx,next)=>{
    if(ctx.chat?.type!=='private'||!ctx.from)return;
    const created=repo.register(ctx.from!.id,ctx.chat.id,now().valueOf());
    if(created)logger.write('users',`user=${repo.userId(ctx.from!.id)} action=registered`);
    await next();
  });
  bot.command('start',async ctx=>{drafts.delete(ctx.from!.id);logger.write('users',`user=${user(ctx)} action=start`);await menu(ctx);});
  bot.command('menu',async ctx=>{drafts.delete(ctx.from!.id);logger.write('users',`user=${user(ctx)} action=menu`);await menu(ctx);});
  bot.command('cancel',async ctx=>{drafts.delete(ctx.from!.id);logger.write('users',`user=${user(ctx)} action=cancel`);await ctx.reply('Введення скасовано.');await menu(ctx);});
  bot.hears('🔍 Перевірити місця',async ctx=>{
    drafts.delete(ctx.from!.id);logger.write('users',`user=${user(ctx)} action=check`);
    await ctx.reply('Перевіряю доступність…');
    const result=await monitor.getDates(fallbackDates(4,[],now()));
    await sendLong(ctx,`🔍 Hamzabeyli — доступні місця\n\n${formatAvailability(result,now())}`);
  });
  bot.hears('🌍 Відстежувати всі дні',async ctx=>{
    drafts.delete(ctx.from!.id);const uid=user(ctx);
    if(repo.list(uid).some(t=>t.type==='GENERAL')){await ctx.reply('Загальне відстеження вже існує. Відкрийте «📋 Мої відстеження».');return;}
    const id=repo.create(uid,'GENERAL',null,null,null,'ACTIVE',false,now().valueOf());
    logger.write('users',`user=${uid} tracking=${id} action=tracking_created type=GENERAL`);
    await ctx.reply('Створено загальне відстеження. Початковий стан надійде після перевірки.');kick();
  });
  bot.hears('📅 Відстежувати період',async ctx=>{drafts.set(ctx.from!.id,{step:'DATE'});await ctx.reply(`Введіть дату у форматі DD.MM.YYYY, наприклад ${dateLabel(istanbulDate(now()))}, або /cancel.`);});
  bot.hears('📋 Мої відстеження',async ctx=>{
    drafts.delete(ctx.from!.id);await monitor.sweepExpired();const uid=user(ctx), list=repo.list(uid);
    if(!list.length){await ctx.reply('У вас немає активних відстежень.');return;}
    const count=repo.uncertainCount(uid);
    if(count) await ctx.reply(`Недоставлених або непідтверджених повідомлень: ${count}. Повторне надсилання може створити дублікати, якщо Telegram прийняв попередню спробу.`,{reply_markup:new InlineKeyboard().text('Повторити надсилання','retry_alerts')});
    for(const t of list) {
      const buttons=new InlineKeyboard().text('Переглянути',`v:${t.id}`).text('Видалити',`d:${t.id}`);
      if(t.type==='PERIOD')buttons.row().text(`Гучне сповіщення: ${t.urgent?'вимкнути':'увімкнути'}`,`u:${t.id}`);
      await ctx.reply(`${describe(t)}\nСтатус: ${t.status==='ACTIVE'?'активне':'очікування дати'}${t.type==='PERIOD'?`\nГучне сповіщення: ${t.urgent?'увімкнено':'вимкнено'}`:''}`,{reply_markup:buttons});
    }
  });
  bot.on('callback_query:data',async ctx=>{
    const value=ctx.callbackQuery.data, uid=user(ctx), draft=drafts.get(ctx.from!.id);
    await ctx.answerCallbackQuery();
    if(value==='cancel'){drafts.delete(ctx.from!.id);await ctx.reply('Введення скасовано.');return;}
    if(value==='retry_alerts') {const count=repo.retryUncertain(uid);logger.write('users',`user=${uid} action=notifications_retry count=${count}`);await ctx.reply(`Заплановано повторних надсилань: ${count}.`);schedule(async()=>{await notifications.flush();});return;}
    if(value==='create') {
      if(!draft || draft.step!=='CONFIRM' || !draft.period){await ctx.reply('Підтвердження застаріло. Створіть відстеження знову.');return;}
      const p=draft.period, today=istanbulDate(now());
      if(p.date<today || (p.date===today&&p.end<=clockMinutes(now()))) {drafts.delete(ctx.from!.id);await ctx.reply('Дата або період уже минули.');return;}
      drafts.delete(ctx.from!.id);
      const waiting=!fallbackDates(4,[],now()).includes(p.date), id=repo.create(uid,'PERIOD',p.date,p.start,p.end,waiting?'WAITING_FOR_DATE':'ACTIVE',defaultUrgent,now().valueOf());
      logger.write('users',`user=${uid} tracking=${id} action=tracking_created type=PERIOD`);
      await ctx.reply(waiting?`⏳ Відстеження створено. Дата ${dateLabel(p.date)} ще недоступна; перевірка почнеться після відкриття.`:`📅 Відстеження створено. Початковий стан надійде після перевірки.`);
      if(!waiting)kick();return;
    }
    const m=/^(v|d|yes|u):(\d+)$/.exec(value); if(!m){await ctx.reply('Невідома або застаріла дія.');return;}
    const id=Number(m[2]);await monitor.sweepExpired(); const t=repo.get(id,uid);
    if(!t){await ctx.reply('Відстеження не знайдено.');return;}
    if(m[1]==='d'){await ctx.reply(`Видалити ${describe(t)}?`,{reply_markup:new InlineKeyboard().text('Так, видалити',`yes:${id}`).text('Скасувати','cancel')});return;}
    if(m[1]==='yes'){if(repo.remove(id,uid))logger.write('users',`user=${uid} tracking=${id} action=tracking_deleted`);await ctx.reply('Відстеження видалено.');return;}
    if(m[1]==='u'){
      if(t.type!=='PERIOD'){await ctx.reply('Гучні сповіщення доступні лише для періодів.');return;}
      repo.setUrgent(id,uid,!t.urgent);logger.write('users',`user=${uid} tracking=${id} action=urgent_${t.urgent?'off':'on'}`);await ctx.reply(`Гучне сповіщення ${t.urgent?'вимкнено':'увімкнено'}.`);return;
    }
    await ctx.reply(`${describe(t)}\nСтатус: ${t.status==='ACTIVE'?'активне':'очікування дати'}${t.type==='PERIOD'?`\nГучне сповіщення: ${t.urgent?'увімкнено':'вимкнено'}`:''}`);
    if(t.status==='WAITING_FOR_DATE') {await ctx.reply('Дата ще не підтверджена API; перевірка почнеться автоматично.');return;}
    const dates=t.type==='GENERAL'?fallbackDates(4,[],now()):[t.date!];
    await sendLong(ctx,formatAvailability(await monitor.getDates(dates),now(),t));
  });
  bot.on('message:text',async ctx=>{
    const draft=drafts.get(ctx.from!.id); if(!draft){await menu(ctx);return;}
    try {
      if(draft.step==='DATE') {
        const date=parseDateInput(ctx.message.text);if(date<istanbulDate(now()))throw new Error('Минула дата недоступна.');
        drafts.set(ctx.from!.id,{step:'PERIOD',date});await ctx.reply('Введіть період HH:mm-HH:mm, наприклад 18:00-24:00.');return;
      }
      if(draft.step==='PERIOD') {
        const p=parsePeriod(draft.date!,ctx.message.text),today=istanbulDate(now());
        if(p.date<today || (p.date===today&&p.end<=clockMinutes(now())))throw new Error('Дата або період уже минули.');
        drafts.set(ctx.from!.id,{step:'CONFIRM',period:p});
        const note=p.date===today&&p.start<=clockMinutes(now())?'\nПеріод уже почався: відстежуються лише інтервали, що ще не почалися.':'';
        await ctx.reply(`📅 Нове відстеження\nДата: ${dateLabel(p.date)}\nЧас: ${p.label}\nСтоянка: Hamzabeyli\nГучне сповіщення: ${defaultUrgent?'увімкнено':'вимкнено'}${note}`,{reply_markup:new InlineKeyboard().text('Створити відстеження','create').row().text('Скасувати','cancel')});
      } else await ctx.reply('Підтвердіть створення кнопкою або /cancel.');
    } catch(e) {await ctx.reply(e instanceof Error?e.message:'Некоректне введення.');}
  });
  bot.catch(err=>{logger.write('monitor',`Помилка Telegram update=${err.ctx.update.update_id}`);});
  return bot;
}

