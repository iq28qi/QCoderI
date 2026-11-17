// Run this orchestrator via desktop_launch on the hidden desktop, not the live app.
// Both roots must be disposable, physically copied installations with independent DSH_HOME.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import {benchmarkRuntimeIdentity,assertBenchmarkReuse} from './native-benchmark-identity.mjs';
const [baseline, candidate, resultPath, roundsArg = '3', only='both'] = process.argv.slice(2).map((x,i)=>i<3?resolve(x):x);
assert(baseline && candidate && resultPath, 'Expected baseline root, candidate root, result.json');
assert(['both','baseline','candidate'].includes(only));
const rounds = Number(roundsArg); assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 7);
const manifests={};
for (const [name,root] of [['baseline',baseline],['candidate',candidate]].filter(([name])=>only==='both'||name===only)) {
  const manifest = JSON.parse(await readFile(join(root,'release-manifest.json'),'utf8'));
  assert(manifest.files.some(file=>file.path==='QCoderI.exe'), 'Must use staged installation');
  assert(root.includes('tests\\.runtime\\') || root.includes('tests/.runtime/'), 'Benchmark only disposable test stages');
  manifests[name]={root,version:manifest.version,exe_sha256:manifest.files.find(file=>file.path==='QCoderI.exe').sha256,runtime_sha256:benchmarkRuntimeIdentity(manifest)};
}
const sockets = new Set();
async function waitFor(fn, message, timeout=90000) {
  const start = performance.now(); let last;
  while(performance.now()-start<timeout) {
    try { const value=await fn();if(value)return value; } catch(error) { last=error.message; }
    await delay(50);
  }
  throw Error(message + (last ? ': '+last : ''));
}
async function inspect(root, home, label) {
  await mkdir(home,{recursive:true});
  // No update channel, providers or user preferences copied into this empty home.
  const server=createServer(); server.listen(0,'127.0.0.1'); await once(server,'listening');
  const port=server.address().port; await new Promise(done=>server.close(done));
  const started=performance.now();
  const child=spawn(join(root,'QCoderI.exe'),[],{cwd:root,stdio:'ignore',windowsHide:false,
    env:{...process.env,DSH_HOME:home,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --disable-background-networking`}});
  child.on('error',()=>{});
  let socket;
  try {
    const page=await waitFor(async()=>{if(child.exitCode!==null)throw Error('Native process exited: '+child.exitCode);return (await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(2000)}).then(r=>r.json())).find(p=>p.url.endsWith('/index.html'));},'WebView2 missing');
    const connectedAt=performance.now()-started;
    socket=new WebSocket(page.webSocketDebuggerUrl); sockets.add(socket); await once(socket,'open');
    let id=0;const pending=new Map(),errors=[],external=[];
    socket.onmessage=event=>{const message=JSON.parse(event.data);const request=pending.get(message.id);if(request){pending.delete(message.id);clearTimeout(request.timer);message.error?request.reject(Error(JSON.stringify(message.error))):request.done(message.result);}if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.text);if(message.method==='Network.requestWillBeSent'&&/^https?:/.test(message.params.request.url)&&new URL(message.params.request.url).origin!==new URL(page.url).origin)external.push(message.params.request.url);};
    const send=(method,params={})=>new Promise((done,reject)=>{const next=++id;const timer=setTimeout(()=>{pending.delete(next);reject(Error('CDP timeout: '+method));},45000);pending.set(next,{done,reject,timer});socket.send(JSON.stringify({id:next,method,params}));});
    const evaluate=async expression=>{try{const response=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(response.exceptionDetails)throw Error(response.exceptionDetails.text);return response.result.value;}catch(error){throw new Error(`${label}: ${error.message}; expression=${expression.slice(0,200)}`,{cause:error});}};
    await send('Runtime.enable');await send('Network.enable');await send('Network.setBlockedURLs',{urls:['https://*']});
    const ready=await waitFor(async()=>await evaluate(`(()=>{const root=document.getElementById('root');const editor=document.querySelector('[contenteditable="true"]');if(!editor||root?.inert||!document.querySelector('.qc-sidebar-glyph'))return false;return {navigation_ms:performance.now(),time_origin:performance.timeOrigin,paint:performance.getEntriesByType('paint').map(x=>({name:x.name,at:x.startTime}))}})()`),'Interactive composer missing');
    const processToComposer=performance.now()-started;
    const images=await waitFor(()=>evaluate(`(()=>{const list=[...document.images];return list.every(x=>x.complete&&x.naturalWidth>0)?{count:list.length,navigation_ms:performance.now()}:false})()`),'Startup image not decoded');
    const processToImages=performance.now()-started;
    const glyphs=await evaluate(`[...document.querySelectorAll('.qc-sidebar-glyph,.qc-session-glyph')].map(e=>{const r=e.getBBox();return {href:e.querySelector('use')?.getAttribute('href'),width:r.width,height:r.height}})`);
    assert(glyphs.length>=12&&glyphs.every(g=>g.width>0&&g.height>0));assert.equal(errors.length,0);
    const resources=await evaluate(`performance.getEntriesByType('resource').map(r=>({name:new URL(r.name).pathname,transfer:r.transferSize,decoded:r.decodedBodySize,duration:r.duration}))`);
    const result={label,connected_ms:connectedAt,process_to_composer_ms:processToComposer,process_to_images_ms:processToImages,ready,images,glyphs,resources,errors,external_after_debug_attach:external};
    // quit may destroy the WebView before CDP can acknowledge Runtime.evaluate.
    // Completion is the exit of THIS spawned fixture, never a response packet.
    socket.send(JSON.stringify({id:++id,method:'Runtime.evaluate',params:{expression:'window.dshDesktop.quit();true'}}));
    await waitFor(()=>child.exitCode!==null,label+': test window did not exit',10000);
    return result;
  } finally {
    if(socket){socket.close();sockets.delete(socket);}
    if(child.exitCode===null){child.kill();await Promise.race([once(child,'exit'),delay(5000)]);}
  }
}
let saved;
try{saved=JSON.parse(await readFile(resultPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
if(saved)for(const [name,manifest]of Object.entries(manifests))if(saved.manifests?.[name])assertBenchmarkReuse(saved.manifests[name],manifest);
const result=saved??{schema_version:1,started_at:new Date().toISOString(),conditions:'Real WebView2 EXE on isolated background desktop; process-cold fresh profiles and same-profile warm relaunches; OS filesystem cache NOT flushed; compositor paint may be hidden-desktop throttled; 50ms polling overhead; HTTPS blocked after debug attachment; no model requests',samples:[]};
result.manifests={...result.manifests,...manifests};
await mkdir(resolve(resultPath,'..'),{recursive:true});
try {
  for(let round=0;round<rounds;round++) {
    // Alternate order to reduce drift, never compare a source-only preview to native EXE.
    for(const [name,root] of (round%2?[['candidate',candidate],['baseline',baseline]]:[['baseline',baseline],['candidate',candidate]]).filter(([name])=>only==='both'||name===only)) {
      if(['fresh','warm'].every(profile=>result.samples.some(s=>s.build===name&&s.round===round+1&&s.profile===profile)))continue;
      result.samples=result.samples.filter(s=>!(s.build===name&&s.round===round+1));
      const home=await mkdtemp(join(resolve(resultPath,'..'),`native-startup-${name}-`));
      for(const state of ['fresh','warm']) {
        const sample=await inspect(root,home,`${name}-${round+1}-${state}`);
        result.samples.push({...sample,build:name,round:round+1,profile:state});
        await writeFile(resultPath,JSON.stringify(result,null,2));
      }
    }
  }
  const median=xs=>{const values=[...xs].sort((a,b)=>a-b);return values.length%2?values[(values.length-1)/2]:(values[values.length/2-1]+values[values.length/2])/2;};
  result.summary={};
  for(const profile of ['fresh','warm']) {
    const values=Object.fromEntries(['baseline','candidate'].map(build=>[build,result.samples.filter(s=>s.build===build&&s.profile===profile)]));
    if(!values.baseline.length||!values.candidate.length)continue;
    const a=median(values.baseline.map(s=>s.process_to_composer_ms)),b=median(values.candidate.map(s=>s.process_to_composer_ms));
    result.summary[profile]={baseline_median_ms:a,candidate_median_ms:b,change_percent:(b-a)/a*100,samples_each:rounds,negative_is_faster:true};
  }
  result.status=Object.keys(result.summary).length===2?'passed':'partial';
  delete result.error;
} catch(error) { result.status='failed';result.error=error.stack;process.exitCode=1; }
finally {for(const socket of sockets)socket.close();result.finished_at=new Date().toISOString();await writeFile(resultPath,JSON.stringify(result,null,2));}
