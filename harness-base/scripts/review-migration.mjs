// Read the migrated library in its real application; never submit model prompts.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const base = resolve(fileURLToPath(new URL('..', import.meta.url)));
const home = join(base, 'data');
const env = { ...process.env, DSH_HOME: home };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(join(base, 'app/QCoderI.exe'), ['--remote-debugging-address=127.0.0.1','--remote-debugging-port=19448'], { cwd:base,env,windowsHide:true,stdio:['ignore','pipe','pipe'] });
let diagnostic = '';
child.stderr.on('data', data => { diagnostic += data.toString(); });
child.stdout.on('data', data => { diagnostic += data.toString(); });
const pause = ms => new Promise(r => setTimeout(r,ms));
let socket;
try {
  let page;
  for(let i=0;i<150;i++) {
    try { page=(await fetch('http://127.0.0.1:19448/json/list').then(r=>r.json())).find(p=>p.url==='dsh-app://app/index.html');if(page)break; } catch {}
    if(child.exitCode!==null)throw Error('Migrated application exited: '+diagnostic);
    await pause(300);
  }
  assert(page, 'migrated backend did not become ready: '+diagnostic);
  socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
  const pending=new Map();let counter=0;
  socket.onmessage=e=>{const v=JSON.parse(e.data),item=pending.get(v.id);if(item){pending.delete(v.id);v.error?item.reject(Error(JSON.stringify(v.error))):item.resolve(v.result);}};
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++counter;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const result=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.text);return result.result.value;};
  const until=async expression=>{for(let i=0;i<150;i++){const value=await evaluate(`Boolean(${expression})`);if(value)return value;await pause(100);}throw Error('UI condition did not settle');};
  await until(`document.body?.innerText?.includes('Рабочие области') && document.querySelectorAll('[role=treeitem]').length > 0`);
  await evaluate(`document.querySelectorAll('[role=treeitem][aria-expanded=false]').forEach(element=>element.click())`);
  await until(`document.querySelectorAll('[role=treeitem][aria-selected]').length > 0`);
  for(let i=0;i<20;i++) {
    const more=await evaluate(`(() => {const groups=[...document.querySelectorAll('[role=treeitem][aria-expanded=false]')];groups.forEach(e=>e.click());const elements=[...document.querySelectorAll('button')].filter(b=>/Показать.*диалогов/.test(b.textContent));elements.forEach(e=>e.click());return groups.length+elements.length;})()`);
    if(!more && i>2)break;
    await pause(120);
  }
  const visibleChats=await evaluate(`document.querySelectorAll('[role=treeitem][aria-selected]').length`);
  const cacheRoot=join(home,'storages/session_projcache/sessions');
  const rootChats=readdirSync(cacheRoot).filter(name=>name.endsWith('.json')).map(name=>JSON.parse(readFileSync(join(cacheRoot,name),'utf8')).record.rows).filter(rows=>!rows.sessionListMetadata?.val?.blank && !rows.subagent?.val?.identity).length;
  assert(visibleChats>=rootChats,'root conversations must be browsable, expected '+rootChats+', got '+visibleChats);
  await evaluate(`(() => {const rows=[...document.querySelectorAll('[role=treeitem][aria-selected]')];const previous=rows.find(r=>r.getAttribute('aria-selected')!=='true');if(previous)previous.click();return true;})()`);
  await until(`document.body.innerText.length>1800 && document.querySelector('[data-phase=active]')`);
  await pause(500);
  const chatShot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  writeFileSync(join(base,'tests/migrated-chat-preview.png'),Buffer.from(chatShot.data,'base64'));
  await evaluate(`(() => {const b=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Настройки'||b.textContent.trim()==='Настройки');b.click();return true;})()`);
  await until(`document.body.innerText.includes('Системный промпт')`);
  assert(await evaluate(`document.querySelector('.Ri3YFq_panel').getBoundingClientRect().width > 900`), 'settings modal is not clipped by the sidebar');
  await evaluate(`(() => {const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Модели');b.click();return true;})()`);
  await until(`document.querySelectorAll('._5a_YTa_rowCard').length>=11`);
  const providerCards=await evaluate(`document.querySelectorAll('._5a_YTa_rowCard').length`);
  const modelsShot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  writeFileSync(join(base,'tests/migrated-models-preview.png'),Buffer.from(modelsShot.data,'base64'));
  const report=JSON.parse(readFileSync(join(base,'docs/migration-report.json')));
  report.application_library_verified=true;
  report.visible_chat_rows=visibleChats;
  report.provider_cards=providerCards;
  writeFileSync(join(base,'docs/migration-report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(`PASS: ${visibleChats} conversation rows browsable, old transcript opened, ${providerCards} provider cards loaded`);
  call('Browser.close').catch(()=>{});
  await Promise.race([new Promise(r=>child.once('exit',r)),pause(5000)]);
} catch(error) {
  writeFileSync(join(base,'tests/migration-ui-diagnostics.log'),diagnostic);
  throw error;
} finally {socket?.close();if(child.exitCode===null)child.kill();}
