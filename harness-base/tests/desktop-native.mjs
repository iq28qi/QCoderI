import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,readdirSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const base=resolve(fileURLToPath(new URL('..',import.meta.url))),archive=resolve(process.env.HARNESS_ARCHIVE??join(base,'source'));
const load=name=>import(pathToFileURL(join(archive,'dsh/node_modules/@deepseek-ai',name,'lib/index.js')).href);
const {desktopDriver,desktopRequest,installDesktop}=await import(pathToFileURL(join(archive,'dsh/node_modules/@qcoderi/team/desktop.js')).href);
for(const args of [{action:'other'},{action:'click',window:'0',x:1,y:2},{action:'type',window:'123',text:3},{action:'invoke',window:'123'},{action:'hotkey',window:'123',keys:['{evil}']},{action:'drag',window:'123',x:1,y:2,to_x:3}])assert.throws(()=>desktopRequest(args));
const home=mkdtempSync(join(tmpdir(),'qcoderi-desktop-')),signal=new AbortController().signal;
const interactive=process.env.QCODERI_DESKTOP_INTERACTIVE_TEST==='1';
let fixture,bgPid,guiPid,handle,bgHandle,chat,ctx,bgCtx;
const watchdog=setTimeout(()=>{console.error('Desktop test timed out');process.exit(1)},120000);
try {
  const title='QCoderI desktop fixture '+Date.now(),resultFile=join(home,'result.json');
  const code=readFileSync(join(base,'tests/desktop-fixture.ps1'),'utf8');
  fixture=spawn('powershell.exe',['-NoLogo','-NoProfile','-STA','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,QC_FIXTURE_TITLE:title,QC_FIXTURE_RESULT:resultFile,QC_FIXTURE_VISIBLE:interactive?'1':'0'}});
  let errors='';fixture.stderr.on('data',chunk=>{errors+=chunk;});fixture.stdout.on('data',chunk=>{errors+=chunk;});
  for(let i=0;i<100&&!existsSync(resultFile+'.handle')&&fixture.exitCode===null;i++)await delay(100);
  assert(existsSync(resultFile+'.handle'),`exit=${fixture.exitCode}; ${errors}`);
  let id;for(let attempt=0;attempt<40;attempt++){try{id=readFileSync(resultFile+'.handle','utf8').replace(/^\uFEFF/,'').trim();if(/^\d+$/.test(id))break;}catch(error){if(!['EBUSY','ENOENT'].includes(error.code))throw error;}await delay(50);}assert(/^\d+$/.test(id),'fixture handle is fully published');
  if(interactive)await desktopDriver({action:'focus',window:id},signal);
  const inspected=await desktopDriver({action:'inspect',window:id},signal);
  const input=inspected.elements.find(row=>row.type.includes('Win32.')&&row.type.toUpperCase().includes('EDIT')),button=inspected.elements.find(row=>row.type.includes('Win32.')&&row.type.toUpperCase().includes('BUTTON')),canvas=inspected.elements.find(row=>row.name==='QC Canvas');
  assert(input&&button,JSON.stringify(inspected));
  await assert.rejects(desktopDriver({action:'focus',window:id,background_only:true},signal),/пользовательском рабочем столе/);
  await desktopDriver({action:'set_value',window:id,element:input.element,text:'UIA проверка'},signal);
  await desktopDriver({action:'invoke',window:id,element:button.element},signal);
  await delay(100);assert.equal(JSON.parse(readFileSync(resultFile,'utf8').replace(/^\uFEFF/,'' )).text,'UIA проверка');
  if(interactive){
  await desktopDriver({action:'click',window:id,element:input.element},signal);
  await desktopDriver({action:'hotkey',window:id,keys:['CTRL','A']},signal);
  const literal='Привет 3D — {+} "test" 🧊';
  await desktopDriver({action:'type',window:id,text:literal},signal);
  await desktopDriver({action:'click',window:id,x:button.bounds.x+20,y:button.bounds.y+20},signal);
  assert.equal(JSON.parse(readFileSync(resultFile,'utf8').replace(/^\uFEFF/,'' )).text,literal,'Unicode SendInput preserves literal text');
  await desktopDriver({action:'drag',window:id,x:canvas.bounds.x+10,y:canvas.bounds.y+15,to_x:canvas.bounds.x+170,to_y:canvas.bounds.y+60},signal);
  assert(existsSync(resultFile+'.drag'));
  await desktopDriver({action:'scroll',window:id,x:canvas.bounds.x+30,y:canvas.bounds.y+30,steps:-2},signal);
  await assert.rejects(desktopDriver({action:'click',window:id,x:-90000,y:-90000},signal),/вне/);
  }
  await assert.rejects(desktopDriver({action:'invoke',window:id,element:'999.123456'},signal),/устарел/);
  console.log('PASS: hidden real Win32 window inspection, Unicode set_value, native button invocation and stale element refusal'+(interactive?'; visible input/drag/scroll also checked':'; interactive mouse/keyboard test not run'));
  // Test full background-desktop (CreateDesktopW) launch, unfocused PrintWindow screenshot, click/type/hotkey/drag/scroll without touching user foreground.
  {
    const {Context}=await load('cordis');const {LlmAdapter}=await load('dsh-llm');bgCtx=new Context();
    for(const name of ['dsh-session','dsh-session-projection','dsh-llm','dsh-system-prompt','dsh-tools','dsh-agent','dsh-agent-loop'])await bgCtx.plugin((await load(name)).default??await load(name),{});
    await bgCtx.plugin((await load('dsh-attachment-local')).default,{dshHome:home});
    await bgCtx.plugin((await load('dsh-fs-local')).default,{});
    for(let i=0;i<100&&(!bgCtx.get('agentLoop')||!bgCtx.get('attachments'));i++)await delay(10);
    installDesktop(bgCtx,{});
    class BgAdapter extends LlmAdapter{resolveModel(p,m){return Promise.resolve({provider:p,id:m,name:m,inputModalities:['text','image']});}async *stream(){yield{type:'finish',reason:{kind:'stop'}};}}
    bgCtx.llm.registerAdapter(['fixture'],new BgAdapter());
    bgHandle=await bgCtx.agents.create({sessionId:'desktop-bg-real',meta:{cwd:home},agentOptions:{provider:'fixture',model:'vision'}});
    const bgResFile=join(home,'bg-result.json');
    const fixCode=readFileSync(join(base,'tests/desktop-fixture.ps1'),'utf8');
    const wrapper=`$env:QC_FIXTURE_TITLE='QCoderI Bg Fixture';$env:QC_FIXTURE_RESULT='${bgResFile.replaceAll("'","''")}';$env:QC_FIXTURE_VISIBLE='1'\n${fixCode}`;
    const launched=await bgCtx.tools.execute({name:'desktop_launch',arguments:{executable:'powershell.exe',arguments:['-NoLogo','-NoProfile','-STA','-EncodedCommand',Buffer.from(wrapper,'utf16le').toString('base64')]},agent:bgHandle.agent,callId:'bg-launch',signal});
    assert(!launched.isError,JSON.stringify(launched));
    const launchMeta=JSON.parse(launched.content[0].text);
    assert.equal(launchMeta.desktop,'background');bgPid=launchMeta.pid;
    for(let i=0;i<100&&!existsSync(bgResFile+'.handle');i++)await delay(100);
    assert(existsSync(bgResFile+'.handle'),'background fixture handle exists');
    const bgId=readFileSync(bgResFile+'.handle','utf8').replace(/^\uFEFF/,'').trim();
    await delay(250);
    const listRes=await bgCtx.tools.execute({name:'desktop_inspect',arguments:{},agent:bgHandle.agent,callId:'bg-list',signal});
    assert(!listRes.isError,JSON.stringify(listRes));
    const winEntry=JSON.parse(listRes.content[0].text).windows.find(w=>w.window===bgId);
    assert(winEntry&&winEntry.desktop==='background'&&winEntry.foreground===false,JSON.stringify(winEntry));
    const inspRes=await bgCtx.tools.execute({name:'desktop_inspect',arguments:{window:bgId,screenshot:true},agent:bgHandle.agent,callId:'bg-insp',signal});
    assert(!inspRes.isError,JSON.stringify(inspRes));
    assert(inspRes.content.some(b=>b.type==='image'),'background inspect captures real screenshot without focus');
    const inspJson=JSON.parse(inspRes.content[0].text);
    let obs=inspJson.observation_id;assert(obs);
    const bgEdit=inspJson.elements.find(row=>row.type.includes('Win32.')&&row.type.toUpperCase().includes('EDIT'));
    const bgBtn=inspJson.elements.find(row=>row.type.includes('Win32.')&&row.type.toUpperCase().includes('BUTTON'));
    const bgCanvas=inspJson.elements.find(row=>row.name==='QC Canvas');
    assert(bgEdit&&bgBtn&&bgCanvas,JSON.stringify(inspJson));
    const act=async(name,a)=>{const r=await bgCtx.tools.execute({name:'desktop_action',arguments:{window:bgId,observation_id:obs,...a},agent:bgHandle.agent,callId:name,signal});assert(!r.isError,JSON.stringify(r));const d=JSON.parse(r.content[0].text);obs=d.observation_id;return {r,d};};
    await act('bg-type-old',{action:'type',element:bgEdit.element,text:'Old',screenshot:false});
    await act('bg-hotkey-all',{action:'hotkey',element:bgEdit.element,keys:['CTRL','A'],screenshot:false});
    const bgLiteral='Привет BG — "test" 🧊';
    await act('bg-type-lit',{action:'type',element:bgEdit.element,text:bgLiteral,screenshot:false});
    const {r:clickBtnRes}=await act('bg-click-btn',{action:'click',x:bgBtn.bounds.x+20,y:bgBtn.bounds.y+20});
    assert(clickBtnRes.content.some(b=>b.type==='image'),'background desktop_action returns real screenshot');
    await delay(100);
    assert.equal(JSON.parse(readFileSync(bgResFile,'utf8').replace(/^\uFEFF/,'')).text,bgLiteral,'background Ctrl+A + Unicode WM_CHAR + coord click');
    await act('bg-drag',{action:'drag',x:bgCanvas.bounds.x+10,y:bgCanvas.bounds.y+15,to_x:bgCanvas.bounds.x+170,to_y:bgCanvas.bounds.y+60,screenshot:false});
    await delay(100);assert(existsSync(bgResFile+'.drag'),'background PostMessage drag triggers MouseUp');
    const dragOut=JSON.parse(readFileSync(bgResFile+'.drag','utf8').replace(/^\uFEFF/,''));
    assert.equal(dragOut.drag_end_x,170);assert.equal(dragOut.drag_end_y,60);
    await act('bg-scroll',{action:'scroll',x:bgCanvas.bounds.x+30,y:bgCanvas.bounds.y+30,steps:-2,screenshot:false});
    console.log('PASS: isolated background desktop launch, unfocused PrintWindow screenshot, PostMessage click/type/hotkey/drag/scroll');
    const guiLaunch=await bgCtx.tools.execute({name:'desktop_launch',arguments:{executable:'notepad.exe'},agent:bgHandle.agent,callId:'gui-launch',signal});
    assert(!guiLaunch.isError,JSON.stringify(guiLaunch));
    const guiMeta=JSON.parse(guiLaunch.content[0].text);
    assert.equal(guiMeta.desktop,'background');guiPid=guiMeta.pid;
    let guiWindow;
    for(let i=0;i<50&&!guiWindow;i++){
      const listed=await bgCtx.tools.execute({name:'desktop_inspect',arguments:{},agent:bgHandle.agent,callId:'gui-windows-'+i,signal});
      assert(!listed.isError,JSON.stringify(listed));
      guiWindow=JSON.parse(listed.content[0].text).windows.find(w=>w.pid===guiPid&&w.desktop==='background');
      if(!guiWindow)await delay(100);
    }
    assert(guiWindow,'native GUI executable appears on the background desktop');
    const guiInspect=await bgCtx.tools.execute({name:'desktop_inspect',arguments:{window:guiWindow.window,screenshot:true},agent:bgHandle.agent,callId:'gui-inspect',signal});
    assert(!guiInspect.isError,JSON.stringify(guiInspect));
    assert(guiInspect.content.some(block=>block.type==='image'),'native GUI window can be captured without focus');
    console.log('PASS: native GUI executable launches detached on background desktop and yields an unfocused screenshot');
  }
  const {Context}=await load('cordis');const {LlmAdapter,createUserMessage}=await load('dsh-llm');ctx=new Context();
  for(const name of ['dsh-session','dsh-session-projection','dsh-llm','dsh-system-prompt','dsh-tools','dsh-agent','dsh-agent-loop'])await ctx.plugin((await load(name)).default??await load(name),{});
  await ctx.plugin((await load('dsh-attachment-local')).default,{dshHome:home});
  await ctx.plugin((await load('dsh-fs-local')).default,{});
  for(let i=0;i<100&&(!ctx.get('agentLoop')||!ctx.get('attachments'));i++)await delay(10);
  installDesktop(ctx,{driver:async()=>({ok:true}),capture:async()=>({data:readFileSync(join(base,'assets/qcoderi.png'))})});let calls=0;
  class Adapter extends LlmAdapter{
    resolveModel(provider,id){return Promise.resolve({provider,id,name:id,inputModalities:['text','image']});}
    async *stream(options){calls++;if(calls===1){assert(options.tools.some(tool=>tool.name==='desktop_action'));yield{type:'block-end',index:0,block:{type:'tool-call',id:'desktop-test',name:'desktop_action',arguments:JSON.stringify({window:id,action:'focus'})}};}else{const results=options.messages.flatMap(m=>m.content).filter(b=>b.type==='tool-result');const result=results.at(-1);assert(!result.isError,JSON.stringify(result));assert(result.content.some(b=>b.type==='image'));yield{type:'text-delta',index:0,text:'Проверено реальное окно.'};}yield{type:'finish',reason:{kind:'stop'}};}
  }
  ctx.llm.registerAdapter(['fixture'],new Adapter());
  handle=await ctx.agents.create({sessionId:'desktop-native',meta:{cwd:home},agentOptions:{provider:'fixture',model:'vision'}});
  handle.agent.followup(createUserMessage({content:[{type:'text',text:'Проверь приложение'}],source:{kind:'user'}}));await handle.agent.whenIdle();
  assert.equal(calls,2);assert.equal(handle.agent.session.snapshotEvents().findLast(e=>e.type==='turn/end').data.reason.kind,'completed');
  const imagePath=join(home,'work.png');writeFileSync(imagePath,readFileSync(join(base,'assets/qcoderi.png')));
  const shared=await ctx.tools.execute({name:'share_image',arguments:{file_path:imagePath,caption:'Рендер модели'},agent:handle.agent,callId:'share',signal});
  assert(!shared.isError,JSON.stringify(shared));assert(shared.content.some(b=>b.type==='image'));
  chat=await ctx.agents.create({sessionId:'desktop-chat',agentOptions:{provider:'fixture',model:'vision'},setup:async scope=>{await scope.plugin((await import(pathToFileURL(join(archive,'dsh/node_modules/@qcoderi/team/chat.js')).href)));}});
  assert.equal(chat.agent.ctx.tools.schemas(chat.agent).length,0);
  console.log('PASS: real AgentLoop -> desktop tool -> image pixels to model (scripted capture); actual share_image file; ordinary chat has no desktop tools');
}catch(error){console.error('DESKTOP TEST ERROR:',error);throw error;}finally{
  fixture?.kill();for(const pid of [bgPid,guiPid]){if(pid){try{process.kill(pid);}catch{}for(let i=0;i<20;i++){try{process.kill(pid,0);await delay(100);}catch{break;}}}}
  await bgHandle?.dispose();await bgCtx?.fiber.dispose();
  await handle?.dispose();await chat?.dispose();await ctx?.fiber.dispose();clearTimeout(watchdog);
  assert(home.startsWith(join(tmpdir(),'qcoderi-desktop-')));
  const writable=path=>{for(const item of readdirSync(path,{withFileTypes:true})){const child=join(path,item.name);if(item.isDirectory())writable(child);else chmodSync(child,0o600);}chmodSync(path,0o700);};
  writable(home);for(let i=0;i<15;i++){try{rmSync(home,{recursive:true,force:true});break;}catch(e){if(i===14||!['EPERM','EBUSY','ENOTEMPTY'].includes(e?.code))throw e;await delay(200);}}
}
