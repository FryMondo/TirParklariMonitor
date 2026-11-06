import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export class Logger {
  constructor(private readonly retentionDays:number, private readonly dir='logs') {mkdirSync(dir,{recursive:true});}
  write(kind:'monitor'|'users',message:string,now=new Date()):void {
    const path=join(this.dir,`${kind}.log`), day=now.toISOString().slice(0,10);
    if(existsSync(path)) {
      const modified=statSync(path).mtime;
      const oldDay=modified.toISOString().slice(0,10);
      if(oldDay<day) {
        let suffix=0, rotated=join(this.dir,`${kind}.${oldDay}.log`);
        while(existsSync(rotated)) rotated=join(this.dir,`${kind}.${oldDay}.${++suffix}.log`);
        renameSync(path,rotated);
      }
    }
    appendFileSync(path,`[${now.toISOString()}] ${message}\n`,'utf8');
  }
  cleanup(now=new Date()):void {
    const cutoff=now.valueOf()-this.retentionDays*86400000;
    for(const name of readdirSync(this.dir)) {
      if(!/^(monitor|users)\.\d{4}-\d{2}-\d{2}(?:\.\d+)?\.log$/.test(name)) continue;
      const path=join(this.dir,name); if(statSync(path).mtimeMs<cutoff) unlinkSync(path);
    }
  }
}
