import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,lstat,realpath,readdir,unlink} from 'node:fs/promises';
import {resolve,relative,join,dirname,isAbsolute,basename} from 'node:path';
import { matchScore, words } from './project-context.js';

export const hash=data=>createHash('sha256').update(data).digest('hex');
const queues=new Map();
export async function serial(key,fn){const previous=queues.get(key)??Promise.resolve();const current=previous.catch(()=>{}).then(fn);queues.set(key,current);try{return await current;}finally{if(queues.get(key)===current)queues.delete(key);}}
export async function atomic(file,data){await mkdir(dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';try{await writeFile(temp,data,{mode:0o600});await rename(temp,file);}finally{await unlink(temp).catch(()=>{});}}
export async function json(file,fallback){try{const info=await lstat(file);if(info.size>16*1024*1024)throw Error('Хранилище превышает 16 МБ');return JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return fallback;throw error;}}
export const protectedPath=path=>/(^|[\\/])(?:\.git|node_modules|\.env(?:\.[^\\/]*)?|\.credentials[^\\/]*|secrets?\.(?:json|ya?ml)|settings\.ya?ml)([\\/]|$)/i.test(path);
export async function inside(cwd,path){
  const root=await realpath(cwd),target=resolve(root,path),rel=relative(root,target);
  if(!rel||rel.startsWith('..')||isAbsolute(rel)||protectedPath(rel))throw Error('Нужен файл проекта вне служебных каталогов и секретов');
  let part=root;for(const name of rel.split(/[\\/]/)){part=join(part,name);try{if((await lstat(part)).isSymbolicLink())throw Error('Ссылки и junction не поддерживаются');}catch(error){if(error.code!=='ENOENT')throw error;}}
  return target;
}
export class WorkspaceStore{
  constructor(home,cwd){this.cwd=resolve(cwd);this.directory=join(home,hash(this.cwd.toLowerCase()));this.stateFile=join(this.directory,'project.json');}
  async state(){return json(this.stateFile,{version:1,revision:0,memory:[],dictionary:[],reports:[]});}
  async update(change,expected){return serial(this.directory,async()=>{const value=await this.state();if(expected!==undefined&&expected!==value.revision)throw Error('Запись изменилась. Обновите панель.');await change(value);value.revision++;await atomic(this.stateFile,JSON.stringify(value));return value;});}
  async remember(args,source){
    if(typeof args.key!=='string'||!args.key.trim()||args.key.length>120||typeof args.content!=='string'||!args.content.trim()||args.content.length>2400)throw Error('Нужны key до 120 и content до 2400 символов');
    if(!['preference','lesson','decision','procedure','context'].includes(args.kind))throw Error('Неизвестный вид памяти');
    if(!source||source.length>2400)throw Error('Нужен подтверждённый источник');
    if(args.expiresAt!==undefined&&(!Number.isFinite(args.expiresAt)||args.expiresAt<=Date.now()))throw Error('expiresAt должен быть временем в будущем');
    return this.update(value=>{const old=value.memory.find(x=>x.key===args.key);if(!old&&value.memory.length>=300)throw Error('Лимит памяти: 300 записей');const record={id:old?.id??randomUUID(),key:args.key,kind:args.kind,content:args.content,source,updatedAt:Date.now(),revision:(old?.revision??0)+1,...args.expiresAt?{expiresAt:args.expiresAt}:{}};value.memory=value.memory.filter(x=>x.key!==args.key);value.memory.push(record);},args.revision);
  }
  async forget(id,revision){return this.update(value=>{value.memory=value.memory.filter(x=>x.id!==id);},revision);}
  async term(args){if(typeof args.term!=='string'||!args.term.trim()||args.term.length>100||typeof args.definition!=='string'||!args.definition.trim()||args.definition.length>1200||!Array.isArray(args.aliases??[])||(args.aliases??[]).some(x=>typeof x!=='string'||x.length>100)||(args.aliases??[]).length>12)throw Error('Неверное определение термина');return this.update(value=>{value.dictionary=value.dictionary.filter(x=>x.term!==args.term);if(value.dictionary.length>=300)throw Error('Лимит словаря: 300');value.dictionary.push({term:args.term,definition:args.definition,aliases:args.aliases??[]});},args.revision);}
  async context(text=''){
    const value=await this.state(),terms=words(text);
    const memory=value.memory.filter(x=>!x.expiresAt||x.expiresAt>Date.now())
      .map(item=>({item,score:matchScore(item.key,terms)*3+matchScore(item.content,terms)}))
      .sort((a,b)=>b.score-a.score||b.item.updatedAt-a.item.updatedAt);
    let budget=6500;const chosen=[];
    for(const {item} of memory){
      const line=`[${item.kind}] ${item.key}: ${item.content}`;
      if(line.length+1<=budget){chosen.push(line);budget-=line.length+1;}
    }
    return {memory:chosen.join('\n'),dictionary:matchTerms(text,value.dictionary).map(x=>`${x.term}: ${x.definition}`).join('\n').slice(0,4000)};
  }
  async report(args){if(typeof args.title!=='string'||args.title.length>200||typeof args.html!=='string'||args.html.length>160000)throw Error('Отчёт: title до 200, html до 160000 символов');const record={id:randomUUID(),title:args.title,html:args.html,sessionId:args.sessionId,at:Date.now()};await this.update(value=>{value.reports.push(record);value.reports=value.reports.slice(-40);});return record;}
  async read(path){const target=await inside(this.cwd,path);let data;try{const info=await lstat(target);if(!info.isFile()||info.size>2*1024*1024)throw Error('Редактор поддерживает файлы до 2 МБ');data=await readFile(target);}catch(error){if(error.code==='ENOENT')return {path,exists:false,hash:null,text:''};throw error;}if(data.includes(0))throw Error('Бинарный файл: используйте версии сцены');return {path,exists:true,hash:hash(data),text:data.toString('utf8')};}
  async save(path,text,expected){if(typeof text!=='string'||Buffer.byteLength(text)>2*1024*1024)throw Error('Текст до 2 МБ');const target=await inside(this.cwd,path);return serial(target,async()=>{const before=await this.read(path);if(before.hash!==expected)throw Error('Конфликт: файл изменился на диске. Сохранение отменено.');const checkpoint=await this.begin([path],'Редактор: '+path);await atomic(target,text);await this.finish(checkpoint);return this.read(path);});}
  async begin(paths,label){
    if(!Array.isArray(paths)||!paths.length||paths.length>100)throw Error('От 1 до 100 файлов');
    const record={id:randomUUID(),label:String(label??'Изменение').slice(0,200),at:Date.now(),status:'pending',files:[]};
    for(const path of [...new Set(paths)]){const target=await inside(this.cwd,path);let data=null;try{const info=await lstat(target);if(!info.isFile()||info.size>128*1024*1024)throw Error('Версии поддерживают файлы до 128 МБ');data=await readFile(target);}catch(error){if(error.code!=='ENOENT')throw error;}const before=data===null?null:await this.object(data);record.files.push({path:relative(this.cwd,target),before});}
    await atomic(join(this.directory,'changes',record.id+'.json'),JSON.stringify(record));return record;
  }
  async object(data){const id=hash(data);await atomic(join(this.directory,'objects',id),data);return id;}
  async finish(record){for(const file of record.files){const target=await inside(this.cwd,file.path);try{const info=await lstat(target);if(!info.isFile()||info.size>128*1024*1024)throw Error('Слишком большой результат');file.after=await this.object(await readFile(target));}catch(error){if(error.code!=='ENOENT')throw error;file.after=null;}}record.status='ready';await atomic(join(this.directory,'changes',record.id+'.json'),JSON.stringify(record));return record;}
  async changes(){let names;try{names=await readdir(join(this.directory,'changes'));}catch(error){if(error.code==='ENOENT')return [];throw error;}const items=await Promise.all(names.filter(x=>/^[\da-f-]{36}\.json$/.test(x)).map(x=>json(join(this.directory,'changes',x),null)));return items.filter(Boolean).sort((a,b)=>b.at-a.at).slice(0,150);}
  async checkpoint(id){if(!/^[\da-f-]{36}$/.test(id))throw Error('Неверная версия');const record=await json(join(this.directory,'changes',id+'.json'),null);if(!record)throw Error('Версия не найдена');return record;}
  async diff(id,path){const record=await this.checkpoint(id),file=record.files.find(x=>x.path===path);if(!file)throw Error('Файл не входит в версию');const load=async key=>{if(!key)return '';const data=await readFile(join(this.directory,'objects',key));return data.length>2*1024*1024||data.includes(0)?null:data.toString('utf8');};return {path,before:await load(file.before),after:await load(file.after),status:record.status};}
  async restore(id,path,side='before'){
    if(!['before','after'].includes(side))throw Error('Неизвестная сторона версии');const record=await this.checkpoint(id);if(record.status!=='ready')throw Error('Версия ещё не завершена');const files=record.files.filter(x=>!path||x.path===path);if(!files.length)throw Error('Файл не входит в версию');const restored=[],conflicts=[];
    for(const file of files){const target=await inside(this.cwd,file.path);await serial(target,async()=>{let current=null;try{current=hash(await readFile(target));}catch(error){if(error.code!=='ENOENT')throw error;}const want=file[side],expected=file[side==='before'?'after':'before'];if(current===want)return;if(current!==expected){conflicts.push(file.path);return;}if(want===null)await unlink(target);else{const data=await readFile(join(this.directory,'objects',want));if(hash(data)!==want)throw Error('Повреждена сохранённая версия');await atomic(target,data);}restored.push(file.path);});}return {restored,conflicts};
  }
  async files(path=''){const root=path?await inside(this.cwd,path):this.cwd;const result=[];for(const entry of await readdir(root,{withFileTypes:true})){const name=relative(this.cwd,join(root,entry.name));if(entry.isSymbolicLink()||protectedPath(name))continue;result.push({path:name,name:entry.name,directory:entry.isDirectory()});if(result.length>=1000)break;}return result.sort((a,b)=>Number(b.directory)-Number(a.directory)||a.name.localeCompare(b.name));}
  async search(query){
    if(typeof query!=='string'||!query||query.length>300)throw Error('Поиск: строка от 1 до 300 символов');
    const matches=[];let visited=0,truncated=false;
    const visit=async path=>{for(const entry of await this.files(path)){if(visited++>=5000||matches.length>=200){truncated=true;return;}if(entry.directory){if(!/(^|[\\/])(?:dist|build|Binaries|Intermediate|Saved|DerivedDataCache|\.venv)([\\/]|$)/i.test(entry.path))await visit(entry.path);continue;}const target=await inside(this.cwd,entry.path);const info=await lstat(target);if(info.size>512*1024)continue;const bytes=await readFile(target);if(bytes.includes(0))continue;const lines=bytes.toString('utf8').split(/\r?\n/);for(let i=0;i<lines.length&&matches.length<200;i++)if(lines[i].toLowerCase().includes(query.toLowerCase()))matches.push({path:entry.path,line:i+1,text:lines[i].slice(0,250)});}};
    await visit('');return {matches,truncated,visited};
  }
}
const keysEn='qwertyuiop[]asdfghjkl;\'zxcvbnm,.',keysRu='йцукенгшщзхъфывапролджэячсмитьбю';
export function matchTerms(text,terms){
  const normal=value=>String(value).toLowerCase().normalize('NFKC');
  const source=normal(text),variants=[source,[...source].map(c=>keysRu[keysEn.indexOf(c)]??c).join(''),[...source].map(c=>keysEn[keysRu.indexOf(c)]??c).join('')];
  const exact=terms.filter(term=>[term.term,...term.aliases].some(alias=>variants.some(value=>{const wanted=normal(alias);let at=value.indexOf(wanted);while(at>=0){if(!/[\p{L}\p{N}_]/u.test(value[at-1]??' ')&&!/[\p{L}\p{N}_]/u.test(value[at+wanted.length]??' '))return true;at=value.indexOf(wanted,at+1);}return false;})));
  const words=[...new Set(variants.flatMap(value=>value.match(/[\p{L}\p{N}_]+/gu)??[]))];
  for(const word of words){if(word.length<8||word.length>64)continue;const matches=terms.filter(term=>[term.term,...term.aliases].some(alias=>{const name=normal(alias);return name.length>=8&&oneEdit(word,name);}));if(matches.length===1&&!exact.includes(matches[0]))exact.push(matches[0]);}
  return exact.slice(0,24);
}
function oneEdit(a,b){if(Math.abs(a.length-b.length)>1)return false;let i=0,j=0,edits=0;while(i<a.length&&j<b.length){if(a[i]===b[j]){i++;j++;continue;}if(++edits>1)return false;if(a.length>=b.length)i++;if(b.length>=a.length)j++;}return edits+(i<a.length||j<b.length?1:0)<=1;}
