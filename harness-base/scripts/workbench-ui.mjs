// Exercise the actual Electron renderer and its settings API in an isolated home.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';

const base = resolve(fileURLToPath(new URL('..', import.meta.url)));
const home = mkdtempSync(join(tmpdir(), 'qcoderi-ui-'));
const historyUi=process.env.QCODERI_VIDEO_HISTORY_UI==='1';
const videoUi = process.env.QCODERI_VIDEO_UI === '1'||historyUi;
const reasoningUi = process.env.QCODERI_REASONING_UI === '1';
const screenshotUi = true;
let screenshotRequests=0,voiceRequests=0,reportNetworkRequests=0;
const parallelNames=['Проверить геометрию персонажа','Подготовить материалы и текстуры','Настроить свет и камеры','Проверить экспорт в движок'];
let fixtureServer;
if(historyUi||reasoningUi||screenshotUi){
  fixtureServer=createHttpServer(async(request,response)=>{
    const chunks=[];for await(const chunk of request)chunks.push(chunk);
    if(request.url==='/report-network')reportNetworkRequests++;
    if(request.url==='/v1/audio/transcriptions'){voiceRequests++;assert(request.headers['content-type'].includes('multipart/form-data'));assert(Buffer.concat(chunks).includes(Buffer.from('voice.webm')));response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({text:'Тестовая диктовка'}));return;}
    if((reasoningUi||screenshotUi)&&request.method==='GET'&&request.url==='/v1/models'){
      response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({data:screenshotUi?[{id:'kimi-k3-1-pro',input_modalities:['text','image']}]:[{id:'opaque-alias',effort:{supported_levels:['low','max']}}]}));return;
    }
    if(screenshotUi&&request.method==='POST'&&request.url==='/v1/chat/completions'){
      try {
        const body=JSON.parse(Buffer.concat(chunks).toString());
        if(parallelNames.some(name=>JSON.stringify(body.messages).includes(name))){await new Promise(resolve=>{const timer=setTimeout(resolve,15000);response.once('close',()=>{clearTimeout(timer);resolve();});});}
        let delta,finish_reason;
        const working=body.tools?.some(tool=>tool.function?.name==='take_screenshot');
        if(!working){delta={role:'assistant',content:'Снимок экрана'};finish_reason='stop';}
        else if(++screenshotRequests===1){
          assert(body.messages.some(message=>['system','developer'].includes(message.role)&&JSON.stringify(message.content).includes('Не жди отдельной команды')),'proactive screenshot instruction reaches the model');
          delta={role:'assistant',tool_calls:[{index:0,id:'ui-screenshot',type:'function',function:{name:'project_memory',arguments:JSON.stringify({operation:'list'})}}]};finish_reason='tool_calls';
        }else if(screenshotRequests===2){delta={role:'assistant',tool_calls:[{index:0,id:'ui-report',type:'function',function:{name:'interactive_report',arguments:JSON.stringify({title:'Проверка отчёта',html:'<button onclick="this.textContent=123">Нажать</button><details><summary>Показать</summary>Данные</details><script>try{parent.__reportEscape=true}catch{};fetch("http://127.0.0.1:'+fixtureServer.address().port+'/report-network").catch(()=>{});</script>'})}}]};finish_reason='tool_calls';
        }else{
          const images=body.messages.flatMap(message=>Array.isArray(message.content)?message.content:[]).filter(part=>part.type==='image_url');
          assert.equal(images.length,0);

          delta={role:'assistant',content:'Готово к работе.'};finish_reason='stop';
        }
        response.writeHead(200,{'Content-Type':'text/event-stream'});
        response.end(`data: ${JSON.stringify({id:'ui-shot',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason:null}]})}\n\ndata: ${JSON.stringify({id:'ui-shot',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{},finish_reason}]})}\n\ndata: [DONE]\n\n`);return;
      }catch(error){console.error('Screenshot API fixture:',String(error));response.writeHead(500,{'Content-Type':'application/json'});response.end(JSON.stringify({error:{message:String(error)}}));return;}
    }
    response.writeHead(400,{'Content-Type':'application/json'});response.end(JSON.stringify({error:{type:'invalid_request_error',message:'Local fixture: inference is intentionally disabled'}}));
  });
  await new Promise(resolve=>fixtureServer.listen(0,'127.0.0.1',resolve));
}
if (videoUi) {
  writeFileSync(join(home,'settings.yaml'), 'llm-pi-ai:\n  providers:\n    niceai:\n      displayName: NiceAI\n      api: openai-completions\n      baseURL: https://api.niceai.rest/v1\n      apiKeyEnv: FIXTURE_VIDEO_KEY\n      models:\n        - id: seedance-2.5\n        - id: kling-3.0-pro\nagent-default-model:\n  provider: niceai\n  model: seedance-2.5\n');
  writeFileSync(join(home,'.credentials.yaml'), 'version: 1\nrefs:\n  FIXTURE_VIDEO_KEY: fixture-only-not-a-real-key\n');
  if(historyUi)writeFileSync(join(home,'settings.yaml'),readFileSync(join(home,'settings.yaml'),'utf8').replace('https://api.niceai.rest/v1','http://127.0.0.1:'+fixtureServer.address().port+'/v1'));
}
if (reasoningUi) {
  writeFileSync(join(home,'settings.yaml'), 'llm-pi-ai:\n  providers:\n    fixture:\n      displayName: Reasoning fixture\n      api: openai-completions\n      baseURL: https://reasoning.invalid/v1\n      apiKeyEnv: FIXTURE_KEY\n      models:\n        - id: kimi-k3-1-pro\n        - id: deepseek-v4-pro\n        - id: seedance-2.5\nagent-default-model:\n  provider: fixture\n  model: kimi-k3-1-pro\n');
  writeFileSync(join(home,'.credentials.yaml'), 'version: 1\nrefs:\n  FIXTURE_KEY: fixture-only\n');
  writeFileSync(join(home,'settings.yaml'),readFileSync(join(home,'settings.yaml'),'utf8').replace('https://reasoning.invalid/v1','http://127.0.0.1:'+fixtureServer.address().port+'/v1').replace('        - id: seedance-2.5','        - id: seedance-2.5\n        - id: opaque-alias'));
}
if(screenshotUi){
  writeFileSync(join(home,'settings.yaml'),`llm-pi-ai:\n  providers:\n    fixture:\n      api: openai-completions\n      baseURL: http://127.0.0.1:${fixtureServer.address().port}/v1\n      apiKeyEnv: FIXTURE_KEY\n      models:\n        - id: kimi-k3-1-pro\nagent-default-model:\n  provider: fixture\n  model: kimi-k3-1-pro\npermission:\n  defaultPreset: danger-full-access\n`);
  writeFileSync(join(home,'.credentials.yaml'),'version: 1\nrefs:\n  FIXTURE_KEY: fixture-only\n');
}
const workspaceId = randomUUID();
const workspacePath = join(home, 'test-project');
mkdirSync(workspacePath, { recursive: true });
mkdirSync(join(home, 'storages'), { recursive: true });
writeFileSync(join(workspacePath, 'README.md'), '# QCoderI UI smoke fixture\n');
writeFileSync(join(home, 'storages/workspace.json'), JSON.stringify({
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, workspaceIds: [workspaceId], archivedSessionIds: [] },
  tables: { workspaces: { [workspaceId]: { path: workspacePath, title: 'Тестовый проект', sessionIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } } }
}));
const port = await new Promise((resolvePort, reject) => {
  const listener = createServer();
  listener.once('error', reject);
  listener.listen(0, '127.0.0.1', () => {
    const selected = listener.address().port;
    listener.close(error => error ? reject(error) : resolvePort(selected));
  });
});
const environment = { ...process.env, QCODERI_TEST_HIDDEN:'1', DSH_HOME: home, DSH_DESKTOP_DIAGNOSTIC_FILE: join(home, 'diagnostics.log') };
delete environment.ELECTRON_RUN_AS_NODE;
const throughLauncher = process.argv.includes('--launcher');
const testApp = process.env.QCODERI_TEST_APP ?? join(base, 'app');
const executable = throughLauncher ? process.env.QCODERI_TEST_LAUNCHER ?? join(base, '../QCoderI.exe') : join(testApp, 'QCoderI.exe');
const child = spawn(executable, ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`], {
  cwd: base,
  env: environment,
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
});
let diagnostics = '';
child.stdout.on('data', data => { diagnostics += data.toString(); });
child.stderr.on('data', data => { diagnostics += data.toString(); });
const pause = ms => new Promise(r => setTimeout(r, ms));
let socket, closeBrowser;
try {
  let page;
  for (let i = 0; i < 150; i++) {
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
      page = pages.find(p => p.type === 'page' && p.url === 'dsh-app://app/index.html');
      if (page) break;
    } catch {}
    if (child.exitCode !== null && !(throughLauncher && child.exitCode === 0)) throw Error(`Electron exited ${child.exitCode}: ${diagnostics}`);
    await pause(400);
  }
  assert(page, `application page did not become ready: ${diagnostics}`);
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, reject) => { socket.onopen = r; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const response = JSON.parse(event.data);
    if(response.method==='Runtime.exceptionThrown')diagnostics+='\nRENDERER: '+JSON.stringify(response.params.exceptionDetails);
    if(response.method==='Runtime.consoleAPICalled' && response.params.type==='error')diagnostics+='\nCONSOLE: '+JSON.stringify(response.params.args.map(arg=>arg.description??arg.value));
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    response.error ? entry.reject(Error(JSON.stringify(response.error))) : entry.resolve(response.result);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId?{sessionId}:{}) }));
  });
  closeBrowser = async () => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    const closing = send('Browser.close');
    closing.catch(() => {});
    await Promise.race([closing, pause(1000)]).catch(() => {});
  };
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  await send('Runtime.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled:true });
  const until = async (expression, label) => {
    for (let i = 0; i < 100; i++) { const result = await evaluate(`Boolean(${expression})`); if (result) return result; await pause(150); }
    throw Error(`${label}: ${await evaluate('document.body.innerText')}`);
  };
  const clickText = text => evaluate(`(() => { const button = [...document.querySelectorAll('.qc-workbench-panel button'),...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)} || b.getAttribute('aria-label') === ${JSON.stringify(text)}); if (!button) throw Error('Missing button ' + ${JSON.stringify(text)}); button.click(); return true; })()`);
  await until(`document.documentElement?.lang === 'ru' && document.body?.innerText?.includes('QCoderI')`, 'Russian QCoderI shell');
  assert(await evaluate(`!document.body.innerText.includes('Уведомление о тестировании') && !document.body.innerText.includes('Добавьте ключ API, чтобы начать')`), 'QCoderI starts without upstream modal');
  await until(`document.querySelector('.qc-hero-title') && document.querySelector('.qc-night-navigation') && document.querySelectorAll('.qc-quick-card').length === 4`, 'Moonlight Studio presentation loaded');
  assert(await evaluate(`new Promise(resolve => { const image = new Image(); image.onload = () => resolve(image.naturalWidth >= 1000); image.onerror = () => resolve(false); image.src = new URL('./qcoderi-moonlit-elf.png', document.baseURI).href; })`), 'packaged Moonlight illustration loads');

  await clickText('Проекты');
  await until(`document.querySelector('[data-qc-conversation="project"]')`,'project mode');
  if(!await evaluate(`Boolean(document.querySelector('[contenteditable="true"]'))`)){
    await evaluate(`document.querySelector('button[aria-label="Выбрать рабочую область"]').click();true`);
    await until(`[...document.querySelectorAll('[role="menuitem"],button')].some(button=>button.textContent.trim()==='Тестовый проект')`,'workspace offered');
    await evaluate(`[...document.querySelectorAll('[role="menuitem"],button')].find(button=>button.textContent.trim()==='Тестовый проект').click();true`);
  }
  await until(`document.querySelector('[contenteditable="true"]')`,'project input');
  await evaluate(`(()=>{const input=document.querySelector('[contenteditable="true"]');input.focus();document.execCommand('insertText',false,'Помни: тесты без видимых окон');return true})()`);
  await until(`[...document.querySelectorAll('button')].some(button=>button.classList.contains('_5M8isa_primary')&&!button.disabled)`,'send ready');
  await evaluate(`[...document.querySelectorAll('button')].find(button=>button.classList.contains('_5M8isa_primary')).click();true`);
  await until(`document.body?.innerText?.includes('Готово к работе.')`,'native turn completed');
  await evaluate(`(()=>{const original=window.__qcoderiWorkbench;window.__qcoderiWorkbench=(data,signal)=>{window.__qcTestSession=data.sessionId;return original(data,signal);};return true})()`);
  await clickText('Рабочая панель');await until(`document.querySelector('.qc-popup-menu')`,'workspace panel open');await clickText('Память');
  await until(`document.querySelector('.qc-workbench-panel')&&window.__qcTestSession`,'memory panel mounted');
  const sessionId=await evaluate('window.__qcTestSession');
  const rpc=(action,args={})=>evaluate(`window.__qcoderiWorkbench(${JSON.stringify({sessionId,action,args})})`);
  await rpc('remember',{key:'style',kind:'preference',content:'Тесты без видимых окон'});
  await until(`document.querySelector('.qc-workbench-panel')?.innerText.includes('Тесты без видимых окон')`,'persistent memory visible');
  await clickText('Назад');await clickText('Словарь');
  await rpc('term',{term:'герой',definition:'Главный персонаж',aliases:['персонаж']});
  await until(`document.querySelector('.qc-workbench-panel')?.innerText.includes('Главный персонаж')`,'dictionary visible');
  await clickText('Назад');await clickText('Редактор');
  await until(`document.querySelector('.qc-workbench-files')?.innerText.includes('README.md')`,'project files');
  await clickText('README.md');
  await until(`document.querySelector('textarea[aria-label="Код файла"]')?.value.includes('QCoderI UI smoke fixture')`,'editor opens real file');
  const file=await rpc('read',{path:'README.md'});await rpc('save',{path:'README.md',hash:file.hash,text:'# Edited from Workbench'});
  await clickText('Назад');await clickText('Изменения');
  await until(`document.querySelector('.qc-workbench-panel')?.innerText.includes('Редактор: README.md')`,'saved diff visible');
  await clickText('Сравнить');
  await until(`document.querySelector('.qc-workbench-diff')?.innerText.includes('Edited from Workbench')`,'before/after diff');
  await clickText('Откатить файл');for(let i=0;i<100&&!(await rpc('read',{path:'README.md'})).text.includes('QCoderI UI smoke fixture');i++)await pause(50);assert((await rpc('read',{path:'README.md'})).text.includes('QCoderI UI smoke fixture'));
  await clickText('Назад');await clickText('Компьютер');
  await clickText('Забрать управление');await until(`document.querySelector('.qc-workbench-panel')?.innerText.includes('Управление у вас')`,'human takeover');
  await clickText('Продолжить агенту');await until(`document.querySelector('.qc-workbench-panel')?.innerText.includes('Агент может управлять')`,'agent resume');
  await clickText('Назад');await clickText('Диктовка');await until(`document.querySelector('select[aria-label="Режим диктовки"]')`,'dictation settings');
  await evaluate(`(()=>{const audio=new AudioContext(),osc=audio.createOscillator(),destination=audio.createMediaStreamDestination();osc.connect(destination);osc.start();window.__testAudio=audio;navigator.mediaDevices.getUserMedia=async()=>destination.stream;return true})()`);
  await clickText('Записать речь');await pause(500);await clickText('Остановить запись');
  await until(`document.querySelector('textarea[aria-label="Распознанный текст"]')?.value==='Тестовая диктовка'`,'actual MediaRecorder to transcriptions API');
  await clickText('Вставить в сообщение');await until(`document.querySelector('[contenteditable="true"]')?.textContent.includes('Тестовая диктовка')`,'dictation inserts draft');assert.equal(voiceRequests,1);
  await evaluate(`window.__testAudio.close();true`);

  await clickText('Назад');await clickText('Задачи');await until(`document.querySelector('.qc-popup-summary')`,'worker controls');
  await until(`document.querySelector('iframe[name="qcoderi-report"]')`,'interactive report in chat');
  const targets=await send('Target.getTargets');const reportTarget=targets.targetInfos.find(x=>x.type==='iframe'&&x.url==='about:srcdoc');assert(reportTarget,'isolated report target: '+JSON.stringify(targets));const attached=await send('Target.attachToTarget',{targetId:reportTarget.targetId,flatten:true});
  const reportBody=await send('Runtime.evaluate',{expression:'document.body.innerText',returnByValue:true},attached.sessionId);assert(reportBody.result.value.includes('Нажать'),JSON.stringify(reportBody));
  const clicked=await send('Runtime.evaluate',{expression:'document.querySelector("button").click();document.querySelector("button").textContent',returnByValue:true},attached.sessionId);assert.equal(clicked.result.value,'123','report inline interaction works');
  assert.equal(reportNetworkRequests,0,'report cannot fetch over network');
  assert(!await evaluate(`Boolean(window.__reportEscape)`),'report cannot access parent window');
  assert(!diagnostics.includes('RENDERER:'),diagnostics);
  for(let i=0;i<4;i++)await rpc('workerStart',{task:parallelNames[i],write_paths:['part-'+i+'.txt']});
  await until(`document.querySelectorAll('.qc-worker-task').length===4`,'four live task cards');
  const board=await rpc('state');assert.equal(board.worker.active,4);assert(await evaluate(`Boolean(document.querySelector('[contenteditable=\"true\"]')&&document.querySelector('.Alm79a_triggerLabel'))`));
  assert(await evaluate(`(()=>{const label=document.querySelector('.Alm79a_triggerLabel');return getComputedStyle(label).display!=='none'&&label.getBoundingClientRect().width>40&&label.textContent.includes('kimi')})()`),'selected model name remains readable');
  await clickText('Свернуть панель');await evaluate(`document.querySelector('.Alm79a_trigger').click();true`);await until(`document.querySelector('.Alm79a_menu')`,'native model menu opens while chat remains unchanged');await evaluate(`document.querySelector('.Alm79a_trigger').click();true`);await clickText('Рабочая панель');await clickText('Задачи');await until(`document.querySelectorAll('.qc-worker-task').length===4`,'task popover reopened');
  const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(join(base,'tests/workbench-preview.png'),Buffer.from(shot.data,'base64'));
  await send('Emulation.setDeviceMetricsOverride',{width:1000,height:740,deviceScaleFactor:1,mobile:false});await pause(600);const compact=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(join(base,'tests/studio-compact-preview.png'),Buffer.from(compact.data,'base64'));
  assert(await evaluate(`(()=>{const panel=document.querySelector('.qc-workbench-panel').getBoundingClientRect();return panel.right<=innerWidth+1&&panel.left>=0})()`));
  await evaluate(`document.body.removeAttribute('data-ds-dark-theme');true`);await pause(100);const light=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(join(base,'tests/studio-light-preview.png'),Buffer.from(light.data,'base64'));
  await rpc('workerStop');await send('Emulation.clearDeviceMetricsOverride');
  await send('Page.reload');await until(`document.body?.innerText?.includes('Готово к работе.')`,'history restored');await pause(400);
  await clickText('Рабочая панель');await until(`document.querySelector('.qc-popup-menu')`,'workspace panel open');await clickText('Память');await until(`document.querySelector('.qc-workbench-panel')?.innerText.includes('Тесты без видимых окон')`,'memory persists after reload');
  console.log('PASS: packaged Electron, actual remote service, memory/dictionary panels, editor, before/after diff and undo, computer takeover/resume, voice controls, worker controls, session reload. Window stayed hidden.');
}finally{
  await closeBrowser?.();socket?.close();child.kill();await new Promise(resolve=>fixtureServer?.close(resolve)??resolve());
  writeFileSync(join(base,'tests/workbench-ui-diagnostics.log'),diagnostics);
}
