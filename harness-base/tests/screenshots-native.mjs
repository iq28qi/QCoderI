import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,readdirSync,chmodSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const base=resolve(fileURLToPath(new URL('..',import.meta.url)));
const archive=resolve(process.env.HARNESS_ARCHIVE ?? join(base,'source'));
const load=name=>import(pathToFileURL(join(archive,'dsh/node_modules/@deepseek-ai',name,'lib/index.js')).href);
const team=name=>import(pathToFileURL(join(archive,'dsh/node_modules/@qcoderi/team',name)).href);
const {captureScreen,validateCapture}=await team('screen-capture.js');
const {installScreenshot}=await team('screenshot.js');
const {installDesktop}=await team('desktop.js');
for(const args of [{target:'other'},{x:0},{x:0,y:0,width:0,height:10},{delay_ms:5000},{x:'0',y:0,width:10,height:10}])assert.throws(()=>validateCapture(args));
const cancelled=new AbortController();cancelled.abort();
assert.throws(()=>validateCapture({target:'primary',window:'123'}));
assert.throws(()=>validateCapture({target:'window'}));
assert.equal(validateCapture({target:'active_window',window:'123'}).window,'123');
assert.equal(validateCapture({target:'window',window:'123'}).target,'window');
assert.equal(validateCapture({window:'123'}).target,'window');
await assert.rejects(captureScreen({},cancelled.signal),/abort/i);
if(process.platform==='win32') {
  await assert.rejects(captureScreen({target:'active_window',window:'1'}),/выбранное окно/);
  // Verify direct window capture works for unfocused / background-desktop windows (no focus switch needed).
  const bgHome=mkdtempSync(join(tmpdir(),'qcoderi-shotbg-'));
  let bgPid,bgCtx,bgHandle;
  try {
    const {Context}=await load('cordis');const {LlmAdapter}=await load('dsh-llm');
    bgCtx=new Context();
    for(const name of ['dsh-session','dsh-session-projection','dsh-llm','dsh-system-prompt','dsh-tools','dsh-agent','dsh-agent-loop'])await bgCtx.plugin((await load(name)).default??await load(name),{});
    await bgCtx.plugin((await load('dsh-attachment-local')).default,{dshHome:bgHome});
    await bgCtx.plugin((await load('dsh-fs-local')).default,{});
    for(let i=0;i<100&&(!bgCtx.get('agentLoop')||!bgCtx.get('attachments'));i++)await delay(10);
    installDesktop(bgCtx,{});
    class DummyAdapter extends LlmAdapter{resolveModel(p,id){return Promise.resolve({provider:p,id,name:id,inputModalities:['text']});}async *stream(){yield{type:'finish',reason:{kind:'stop'}};}}
    bgCtx.llm.registerAdapter(['fixture'],new DummyAdapter());
    bgHandle=await bgCtx.agents.create({sessionId:'shot-bg',meta:{cwd:bgHome},agentOptions:{provider:'fixture',model:'dummy'}});
    const bgResFile=join(bgHome,'bg-result.json');
    const fixCode=readFileSync(join(base,'tests/desktop-fixture.ps1'),'utf8');
    const wrapper=`$env:QC_FIXTURE_TITLE='QCShotBg';$env:QC_FIXTURE_RESULT='${bgResFile.replaceAll("'","''")}';$env:QC_FIXTURE_VISIBLE='1'\n${fixCode}`;
    const launched=await bgCtx.tools.execute({name:'desktop_launch',arguments:{executable:'powershell.exe',arguments:['-NoLogo','-NoProfile','-STA','-EncodedCommand',Buffer.from(wrapper,'utf16le').toString('base64')]},agent:bgHandle.agent,callId:'shot-bg-launch',signal:new AbortController().signal});
    assert(!launched.isError,JSON.stringify(launched));
    bgPid=JSON.parse(launched.content[0].text).pid;
    for(let i=0;i<100&&!existsSync(bgResFile+'.handle');i++)await delay(100);
    assert(existsSync(bgResFile+'.handle'),'background window handle file created');
    const bgWinId=readFileSync(bgResFile+'.handle','utf8').replace(/^\uFEFF/,'').trim();
    await delay(250);
    const shotWin=await captureScreen({target:'window',window:bgWinId});
    assert.equal(shotWin.desktop,'background');
    assert(shotWin.bounds.width>=300&&shotWin.bounds.height>=200);
    assert.equal(shotWin.data.readUInt32BE(16),shotWin.bounds.width);
    const shotActiveId=await captureScreen({target:'active_window',window:bgWinId});
    assert.equal(shotActiveId.desktop,'background');
    assert.equal(shotActiveId.bounds.width,shotWin.bounds.width);
    const shotCrop=await captureScreen({target:'window',window:bgWinId,x:shotWin.bounds.x+10,y:shotWin.bounds.y+10,width:60,height:40});
    assert.equal(shotCrop.data.readUInt32BE(16),60);assert.equal(shotCrop.data.readUInt32BE(20),40);
    console.log('PASS: direct background-desktop window and active_window(window=...) PrintWindow capture without focus switch');
  } finally {
    if(bgPid){try{process.kill(bgPid);}catch{}for(let i=0;i<20;i++){try{process.kill(bgPid,0);await delay(100);}catch{break;}}}
    await bgHandle?.dispose();await bgCtx?.fiber.dispose();
    for(let i=0;i<15;i++){try{rmSync(bgHome,{recursive:true,force:true});break;}catch(e){if(i===14||!['EPERM','EBUSY','ENOTEMPTY'].includes(e?.code))throw e;await delay(200);}}
  }
  const shot=await captureScreen({target:'primary',x:0,y:0,width:64,height:48});
  assert.deepEqual(shot.bounds,{x:0,y:0,width:64,height:48});
  assert.equal(shot.data.readUInt32BE(16),64);assert.equal(shot.data.readUInt32BE(20),48);
  assert.equal(shot.target,'primary');assert(Number.isFinite(Date.parse(shot.captured_at)));
  console.log('PASS: real Windows GDI screenshot, correct PNG dimensions, hidden process and bounds');
}
const {Context}=await load('cordis');
const {LlmAdapter,createUserMessage}=await load('dsh-llm');
const ctx=new Context();
const home=mkdtempSync(join(tmpdir(),'qcoderi-screenshots-'));
let project,chat;
let calls=0,captures=0;
const watchdog=setTimeout(()=>{console.error('Screenshot test timed out');process.exit(1)},30000);
try {
  for(const name of ['dsh-session','dsh-session-projection','dsh-llm','dsh-system-prompt','dsh-tools','dsh-agent','dsh-agent-loop'])await ctx.plugin((await load(name)).default ?? await load(name),{});
  await ctx.plugin((await load('dsh-attachment-local')).default,{dshHome:home});
  await ctx.plugin((await load('dsh-session-persistence-jsonl')).default,{root:join(home,'sessions'),compression:'none'});
  for(let i=0;i<100&&(!ctx.get('agentLoop')||!ctx.get('attachments'));i++)await delay(10);
  installScreenshot(ctx,{capture:async(request,signal)=>{signal.throwIfAborted();captures++;assert.equal(request.target,'primary');return {data:readFileSync(join(base,'assets/qcoderi.png')),target:request.target,bounds:{x:0,y:0,width:512,height:512},captured_at:'2026-11-08T18:00:00.000Z'};}});
  class ScreenshotAdapter extends LlmAdapter {
    resolveModel(provider,id){return Promise.resolve({provider,id,name:id,inputModalities:['text','image']});}
    async *stream(options) {
      calls++;
      if(calls===1) {
        assert(options.tools.some(tool=>tool.name==='take_screenshot'));
        const prompt=options.messages.filter(message=>message.role==='system').flatMap(message=>message.content).map(block=>block.text??'').join('\n');
        assert(prompt.includes('Не жди отдельной команды'),'the model receives proactive demonstration instructions');
        yield {type:'block-end',index:0,block:{type:'tool-call',id:'screenshot-fixture',name:'take_screenshot',arguments:JSON.stringify({caption:'Проверка интерфейса'})}};
      } else {
        const results=options.messages.flatMap(message=>message.content).filter(block=>block.type==='tool-result');
        assert.equal(results.length,1);
        assert(!results[0].isError,JSON.stringify(results[0]));
        const image=results[0].content.find(block=>block.type==='image');
        assert(image?.attachment.attachmentId,'the next model turn sees the actual screenshot attachment');
        assert(results[0].content.some(block=>block.type==='text'&&block.text.includes('Проверка интерфейса')));
        yield {type:'text-delta',index:0,text:'Снимок готов и виден в чате.'};
      }
      yield {type:'finish',reason:{kind:'stop'}};
    }
  }
  ctx.llm.registerAdapter(['fixture'],new ScreenshotAdapter());
  project=await ctx.agents.create({sessionId:'screenshot-project',meta:{cwd:home},agentOptions:{provider:'fixture',model:'vision'}});
  project.agent.followup(createUserMessage({content:[{type:'text',text:'Проверь интерфейс и продемонстрируй результат работы'}],source:{kind:'user'}}));
  await project.agent.whenIdle();
  const events=project.agent.session.snapshotEvents();
  assert.equal(events.findLast(e=>e.type==='turn/end')?.data.reason.kind,'completed',JSON.stringify(events.filter(e=>['step/end','turn/end','tool/result'].includes(e.type))));
  assert.equal(calls,2);assert.equal(captures,1);
  const result=events.find(e=>e.type==='tool/result');
  assert(result,JSON.stringify(events.map(e=>e.type)));
  assert(JSON.stringify(result).includes('"type":"image"'));
  chat=await ctx.agents.create({sessionId:'screenshot-chat',agentOptions:{provider:'fixture',model:'vision'},setup:async scope=>{await scope.plugin({name:'no-chat-tools',inject:['tools'],apply(scope){scope.tools.restrict({allow:[]});}});}});
  assert(!chat.agent.ctx.tools.schemas(chat.agent).some(tool=>tool.name==='take_screenshot'),'ordinary chat does not gain screen access');
  console.log('PASS: real AgentLoop -> screenshot tool -> stored image -> model turn; durable result image and caption; ordinary chat remains without screen tools');
} finally {
  await project?.dispose();await chat?.dispose();await ctx.fiber.dispose();clearTimeout(watchdog);
  assert(home.startsWith(join(tmpdir(),'qcoderi-screenshots-')));
  const writable=path=>{for(const child of readdirSync(path,{withFileTypes:true})){const target=join(path,child.name);if(child.isDirectory())writable(target);else chmodSync(target,0o600);}chmodSync(path,0o700);};
  writable(home);rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
