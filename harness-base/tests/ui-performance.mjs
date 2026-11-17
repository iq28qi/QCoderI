// Real Electron + local streaming provider. No user data or paid requests.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const base = resolve(fileURLToPath(new URL('..', import.meta.url)));
const home = mkdtempSync(join(tmpdir(), 'qcoderi-performance-'));
const team = process.argv.includes('--team');
const label = process.argv.find(arg => arg.startsWith('--label='))?.slice(8) ?? 'sample';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let active = 0, requests = 0, peak = 0;
const fixture = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  if (!request.url.endsWith('/chat/completions')) { response.writeHead(200, {'Content-Type':'application/json'}); response.end(JSON.stringify({data:[{id:'qcoder-perf',object:'model'}]})); return; }
  const args = JSON.parse(body); requests++; active++; peak = Math.max(peak, active);
  response.writeHead(200, {'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
  const emit = delta => { if (!response.destroyed) response.write('data: '+JSON.stringify({id:'perf-'+requests,object:'chat.completion.chunk',created:1,model:'qcoder-perf',choices:[{index:0,delta,finish_reason:null}]})+'\n\n'); };
  try {
    const called = args.messages.some(message => message.role === 'tool');
    const leader = args.messages.some(message => typeof message.content === 'string' && message.content.includes('QC_PERF_TEAM'));
    if (team && leader && !called && args.tools?.some(tool => tool.function.name === 'team_run')) {
      const plan={tasks:Array.from({length:4},(_,i)=>({id:'worker'+i,title:'Perf worker '+i,prompt:'Stream a technical answer. No edits.',write_paths:[]}))};
      emit({role:'assistant',tool_calls:[{index:0,id:'perf-team',type:'function',function:{name:'team_run',arguments:JSON.stringify(plan)}}]});
      response.write('data: '+JSON.stringify({id:'perf',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})+'\n\n');
    } else {
      emit({role:'assistant',content:''});
      for (let i=0; i<240 && !response.destroyed; i++) {
        emit({content: i%12===0 ? `\n\n### Section ${i}\n\n| Item | Value |\n|---|---|\n| ${i} | streaming |\n\n` : 'Streaming **result '+i+'** with `code` and [reference](https://example.invalid). More explanatory text for rendering.\n'});
        await pause(25);
      }
      response.write('data: '+JSON.stringify({id:'perf',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\n');
    }
    response.end('data: [DONE]\n\n');
  } finally { active--; }
});
await new Promise(resolve => fixture.listen(0,'127.0.0.1',resolve));
const workspace = join(home,'workspace'); mkdirSync(workspace);
const workspaceId = randomUUID(); mkdirSync(join(home,'storages'));
writeFileSync(join(home,'storages/workspace.json'), JSON.stringify({unit:{name:'workspace',version:2},global:{initialized:true,workspaceIds:[workspaceId],archivedSessionIds:[]},tables:{workspaces:{[workspaceId]:{path:workspace,title:'Performance fixture',sessionIds:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}}}}));
writeFileSync(join(home,'settings.yaml'), `llm-pi-ai:\n  providers:\n    perf:\n      displayName: Local performance fixture\n      api: openai-completions\n      baseURL: http://127.0.0.1:${fixture.address().port}/v1\n      apiKeyEnv: QC_PERF_KEY\n      models:\n        - id: qcoder-perf\nagent-default-model:\n  provider: perf\n  model: qcoder-perf\n`);
writeFileSync(join(home,'.credentials.yaml'),'version: 1\nrefs:\n  QC_PERF_KEY: local-fixture-only\n');
const app = process.env.QCODERI_TEST_APP ?? join(base,'app');
const env = {...process.env,DSH_HOME:home}; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(join(app,'QCoderI.exe'),['--remote-debugging-address=127.0.0.1','--remote-debugging-port=0'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let log='',socket,send;
child.stdout.on('data',chunk=>{log+=chunk});child.stderr.on('data',chunk=>{log+=chunk});
try {
  let endpoint;
  for(let i=0;i<200;i++){endpoint=/DevTools listening on (ws:\/\/[^\s]+)/.exec(log)?.[1];if(endpoint)break;await pause(200);}
  assert(endpoint,log);
  const origin = new URL(endpoint).origin.replace('ws:','http:'); let page;
  for(let i=0;i<200;i++){page=(await fetch(origin+'/json/list').then(r=>r.json())).find(row=>row.url==='dsh-app://app/index.html');if(page)break;await pause(200);}
  assert(page,log);socket=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
  let sequence=0;const pending=new Map();
  socket.onmessage=event=>{const data=JSON.parse(event.data);const p=pending.get(data.id);if(p){pending.delete(data.id);data.error?p.reject(Error(JSON.stringify(data.error))):p.resolve(data.result)}};
  send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}))});
  const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value};
  const until=async expression=>{for(let i=0;i<200;i++){if(await evaluate(`Boolean(${expression})`))return;await pause(100)}throw Error('Timed out: '+expression+' '+await evaluate('document.body.innerText'))};
  const click=text=>evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)});if(!b)throw Error('Missing button');b.click()})()`);
  await send('Emulation.setFocusEmulationEnabled',{enabled:true});
  await until(`document.querySelector('.qc-quick-card')`);
  if(team){
    await click('Агенты');await until(`document.querySelector('button[aria-label$=": Команда QCoderI"]')`);
    await evaluate(`document.querySelector('button[aria-label$=": Команда QCoderI"]').click()`);
    await evaluate(`document.querySelector('.Ri3YFq_close').click()`);
    await click('Проекты');
  }
  await until(`document.querySelector('[contenteditable="true"]')`);
  await pause(1000);
  await send('Performance.enable');await send('Profiler.enable');await send('Profiler.start');
  const before=await send('Performance.getMetrics');
  await evaluate(`window.__qcPerf={frames:[],longTasks:[],mutations:0};let last=performance.now();window.__qcPerfRaf=requestAnimationFrame(function frame(now){window.__qcPerf.frames.push(now-last);last=now;window.__qcPerfRaf=requestAnimationFrame(frame)});window.__qcPerfObserver=new MutationObserver(rows=>window.__qcPerf.mutations+=rows.length);window.__qcPerfObserver.observe(document.body,{subtree:true,childList:true,characterData:true});window.__qcPerfLong=new PerformanceObserver(list=>window.__qcPerf.longTasks.push(...list.getEntries().map(e=>e.duration)));window.__qcPerfLong.observe({type:'longtask',buffered:false})`);
  await evaluate(`document.querySelector('.qc-quick-card').click()`);
  await until(`document.querySelector('[contenteditable="true"]').textContent.length>0`);
  if(team) {
    await evaluate(`(()=>{const el=document.querySelector('[contenteditable="true"]');el.focus();const range=document.createRange();range.selectNodeContents(el);range.collapse(false);const selection=getSelection();selection.removeAllRanges();selection.addRange(range)})()`);
    await send('Input.insertText',{text:'QC_PERF_TEAM'});
    await until(`document.querySelector('[contenteditable="true"]').textContent.includes('QC_PERF_TEAM')`);
  }
  await evaluate(`document.querySelector('button._5M8isa_primary').click()`);
  for(let i=0;i<200&&requests===0;i++)await pause(100);
  assert(requests>0,'local provider received no requests: '+await evaluate('document.body.innerText'));
  const latency=[];
  for(let i=0;i<30;i++){
    const start=performance.now();await send('Input.insertText',{text:'x'});await evaluate('new Promise(resolve=>requestAnimationFrame(()=>resolve(true)))');latency.push(performance.now()-start);await pause(120);
  }
  await pause(1500);
  if(team) assert(peak>=4&&requests>=5,'benchmark must actually launch concurrent team workers');
  const after=await send('Performance.getMetrics');const {profile}=await send('Profiler.stop');
  const pageStats=await evaluate(`cancelAnimationFrame(window.__qcPerfRaf);window.__qcPerfObserver.disconnect();window.__qcPerfLong.disconnect();window.__qcPerf`);
  const percentile=(values,p)=>values.slice().sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*p))]??0;
  const b=new Map(before.metrics.map(m=>[m.name,m.value]));
  const metrics=Object.fromEntries(after.metrics.filter(m=>/Duration|Count|Heap/.test(m.name)).map(m=>[m.name,m.value-(b.get(m.name)??0)]));
  const stats={label,team,requests,peak,latency_p50:percentile(latency,.5),latency_p95:percentile(latency,.95),frame_p95:percentile(pageStats.frames,.95),frames:pageStats.frames.length,longTasks:pageStats.longTasks,mutations:pageStats.mutations,metrics};
  writeFileSync(join(base,`tests/performance-${label}${team?'-team':''}.json`),JSON.stringify(stats,null,2));
  writeFileSync(join(base,`tests/performance-${label}${team?'-team':''}.cpuprofile`),JSON.stringify(profile));
  console.log(JSON.stringify(stats,null,2));
  const sums=new Map();const nodes=new Map(profile.nodes.map(n=>[n.id,n]));
  profile.samples?.forEach((id,i)=>{const n=nodes.get(id);const key=n.callFrame.functionName+' '+n.callFrame.url+':'+n.callFrame.lineNumber;sums.set(key,(sums.get(key)??0)+(profile.timeDeltas?.[i]??0))});
  console.log('HOT FUNCTIONS',JSON.stringify([...sums].sort((a,b)=>b[1]-a[1]).slice(0,18)));
  if(process.argv.includes('--verify-scroll')) {
    // A separate turn keeps this behavior check outside the measured interval.
    await evaluate(`(()=>{const el=document.querySelector('[contenteditable="true"]');el.focus();})()`);
    await send('Input.insertText',{text:' Continue streaming another detailed answer.'});
    await evaluate(`document.querySelector('button._5M8isa_primary').click()`);
    await pause(2000);
    const top=await evaluate(`(()=>{const el=document.querySelector('[data-conversation-scroll]');el.scrollTop=0;el.dispatchEvent(new Event('scroll'));return el.scrollTop})()`);
    await pause(1500);
    assert.equal(await evaluate(`document.querySelector('[data-conversation-scroll]').scrollTop`),top,'streaming must preserve reader scroll ownership');
    for(let i=0;i<200&&active>0;i++)await pause(100);
    await until(`document.body.textContent.includes('result 239')`);
    assert(await evaluate(`document.querySelector('[contenteditable="true"]').textContent===' '` ) || await evaluate(`document.querySelector('[contenteditable="true"]').textContent.length===0`),'submitted draft clears');
    console.log('PASS: reader scroll position survives continued streaming and final text is complete');
  }
} finally {
  if(send&&socket?.readyState===WebSocket.OPEN){send('Browser.close').catch(()=>{});await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(5000)])}
  socket?.close();if(child.exitCode===null)child.kill();
  fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve));
}
