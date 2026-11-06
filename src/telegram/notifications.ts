import { GrammyError } from 'grammy';
import { Repository } from './database.js';
import { Logger } from './log.js';

export type Sender={sendMessage:(chat:number,text:string)=>Promise<{message_id:number}>;deleteMessage:(chat:number,id:number)=>Promise<unknown>};
export class Notifications {
  private running?:Promise<void>;
  constructor(private repo:Repository,private sender:Sender,private logger:Logger,private now:()=>number=Date.now){}
  flush():Promise<void> {
    if(!this.running)this.running=this.drain().finally(()=>{this.running=undefined;});
    return this.running;
  }
  private async drain():Promise<void> {
    if(this.repo.rateLimitedUntil(this.now())>this.now())return;
    while(true) {
      const d=this.repo.pending(this.now())[0];if(!d)break;
      if(!this.repo.get(d.tracking_id,d.user_id) || !this.repo.claim(d.id))continue;
      this.logger.write('users',`user=${d.user_id} tracking=${d.tracking_id} action=notification_attempt kind=${d.kind}`);
      const old=d.kind==='CHANGE'&&d.slot_key?this.repo.lastMessage(d.tracking_id,d.chat_id,d.slot_key):undefined;
      let sent:{message_id:number};
      // Deliveries already queued by earlier versions may still contain a visible ID.
      const text=d.text.replace(/(відстеження) #\d+/giu,'$1');
      try { sent=await this.sender.sendMessage(d.chat_id,text); }
      catch(e) {
        // Only explicit 429 is safe to retry: other failures may have happened after Telegram accepted a send.
        if(e instanceof GrammyError && e.error_code===429) {
          const delay=Math.max(1000,(e.parameters.retry_after??60)*1000);this.repo.failure(d.id,delay,this.now());this.repo.holdTelegram(this.now()+delay);
          this.logger.write('users',`user=${d.user_id} tracking=${d.tracking_id} action=notification_rate_limited wait_ms=${delay}`);
          break;
        }
        this.repo.failure(d.id,0,this.now(),true);
        this.logger.write('users',`user=${d.user_id} tracking=${d.tracking_id} action=notification_uncertain`);
        continue;
      }
      if(!this.repo.get(d.tracking_id,d.user_id)) {
        try {await this.sender.deleteMessage(d.chat_id,sent.message_id);} catch { /* The tracking was removed while sending. */ }
        continue;
      }
      // Persist the new message before deleting the previous one, so a failed send never loses it.
      this.repo.delivered(d,sent.message_id,this.now());
      this.logger.write('users',`user=${d.user_id} tracking=${d.tracking_id} action=notification_sent kind=${d.kind}`);
      if(old && this.now()-old.sent_at<48*3600000) {
        try {await this.sender.deleteMessage(d.chat_id,old.message_id);}
        catch(e) {
          this.logger.write('users',`user=${d.user_id} tracking=${d.tracking_id} action=delete_message_failed`);
          if(e instanceof GrammyError && e.error_code===429) {this.repo.holdTelegram(this.now()+Math.max(1000,(e.parameters.retry_after??60)*1000));break;}
        }
      }
    }
  }
}
