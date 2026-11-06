import { mkdir, readFile, writeFile, rename, appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { stateSchema, type State } from './core.js';
export async function loadState(path = 'data/state.json'): Promise<State> {
  let content: string;
  try { content = await readFile(path,'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {version:1,slots:{}}; throw e; }
  try { return stateSchema.parse(JSON.parse(content)); } catch (e) { throw new Error(`Файл стану ${path} пошкоджений або має невідомий формат; зупинка без перезапису: ${String(e)}`); }
}
export async function saveState(state: State, path = 'data/state.json'): Promise<void> {
  const { dirname } = await import('node:path'); await mkdir(dirname(path),{recursive:true});
  const temp = `${path}.${randomUUID()}.tmp`; await writeFile(temp, JSON.stringify(state,null,2)+'\n', {flag:'wx'}); await rename(temp,path);
}
export async function append(path: string, line: string): Promise<void> { const {dirname} = await import('node:path'); await mkdir(dirname(path),{recursive:true}); await appendFile(path,line+'\n','utf8'); }
