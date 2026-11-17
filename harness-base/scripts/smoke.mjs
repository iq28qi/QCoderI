// Exercise the desktop renderer and its settings API in an isolated home.
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
const reportUi = process.env.QCODERI_REPORT_UI === '1';
const screenshotUi = process.env.QCODERI_SCREENSHOT_UI === '1' || reportUi;
const chatErrorUi = process.env.QCODERI_CHAT_ERROR_UI === '1';
const nativeWindow = process.argv.includes('--native');
const approvalUi = process.env.QCODERI_APPROVAL_UI === '1';
let screenshotRequests=0;
let chatFixtureRequests=0;
const chatFixtureBodies=[];
let fixtureServer;
if(historyUi||reasoningUi||screenshotUi||chatErrorUi){
  fixtureServer=createHttpServer(async(request,response)=>{
    const chunks=[];for await(const chunk of request)chunks.push(chunk);
    if(chatErrorUi && request.method==='GET' && request.url==='/v1/models'){
      response.writeHead(200,{'Content-Type':'application/json'});
      response.end(JSON.stringify({data:[{id:'gpt-6-astra',canonical_model:'test-provider-model'},{id:'gpt-6-sol'}]}));return;
    }
    if(chatErrorUi && request.method==='POST' && request.url==='/v1/chat/completions'){
      const body=JSON.parse(Buffer.concat(chunks).toString());
      const context=JSON.stringify(body.messages);
      const fail=context.includes('Проверка обрыва ответа') && !context.includes('Проверка следующего ответа');
      if(body.stream) {
        chatFixtureRequests++;
        chatFixtureBodies.push(body);
      }
      const chunk=(delta,finish_reason)=>({id:'chat-error-fixture',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason}]});
      response.writeHead(200,{'Content-Type':'text/event-stream','x-request-id':'req-chat-error-fixture'});
      response.write(`data: ${JSON.stringify(chunk({role:'assistant',content:fail?'Текст до обрыва':'Ответ на следующее сообщение'},null))}\n\n`);
      if(fail) await new Promise(resolve=>setTimeout(resolve,200));
      if(context.includes('Проверка смены модели')&&!context.includes('Сообщение пока ждёт'))
        await new Promise(resolve=>setTimeout(resolve,4800));
      if(context.includes('Проверка уровня на ходу')&&!context.includes('Применить новый уровень'))
        await new Promise(resolve=>setTimeout(resolve,4800));
      response.end(`data: ${JSON.stringify(chunk({},fail?'content_filter':'stop'))}\n\ndata: [DONE]\n\n`);
      return;
    }
    if((reasoningUi||screenshotUi)&&request.method==='GET'&&request.url==='/v1/models'){
      response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({data:screenshotUi?[{id:'kimi-k3-1-pro',input_modalities:['text','image']}]:[{id:'opaque-alias',effort:{supported_levels:['low','max']}}]}));return;
    }
    if(screenshotUi&&request.method==='POST'&&request.url==='/v1/chat/completions'){
      try {
        const body=JSON.parse(Buffer.concat(chunks).toString());
        let delta,finish_reason;
        const working=body.tools?.some(tool=>tool.function?.name===(reportUi?'interactive_report':approvalUi?'pwsh':'take_screenshot'));
        if(!working){delta={role:'assistant',content:reportUi?'Ожидается профиль с инструментом interactive_report.':'Снимок экрана'};finish_reason='stop';}
        else if(reportUi){
          if(body.messages.some(message=>message.role==='tool')){
            delta={role:'assistant',content:'Отчёт готов.'};finish_reason='stop';
          }else{
            const cards=Array.from({length:9},(_,index)=>`<article data-kind="${index%2?'limit':'done'}"><h2>${['Иконки и запуск','Профили моделей','Автономность'][index%3]}</h2><ul><li>Проверка интерфейса на чистом профиле.</li><li>Результаты доступны в истории диалога.</li><li>Проверено в настольном приложении.</li></ul></article>`).join('');
            const html=`<!doctype html><html><head><style>.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin-top:16px}article{padding:14px;background:#231c2f;border:1px solid #463752;border-radius:10px}h2{margin:0;color:#c9b0e3}.hidden{display:none}</style></head><body><h1>Сверка результата с запросом</h1><p>Проверки запуска, профилей и автономных задач.</p><button class="on" onclick="choose(this,'')">Всё</button> <button onclick="choose(this,'done')">Реализовано</button> <button onclick="choose(this,'limit')">Ограничения</button><div class="grid">${cards}</div><script>function choose(button,kind){document.querySelector('.on').classList.remove('on');button.classList.add('on');document.querySelectorAll('article').forEach(card=>card.classList.toggle('hidden',!!kind&&card.dataset.kind!==kind));}</script></body></html>`;
            const reportHtml=process.env.QCODERI_REPORT_FIXTURE ? readFileSync(process.env.QCODERI_REPORT_FIXTURE,'utf8') : html;
            delta={role:'assistant',tool_calls:[
              {index:0,id:'ui-plan',type:'function',function:{name:'todo_write',arguments:JSON.stringify({todos:[{content:'Проверить запуск и профили',status:'completed'},{content:'Подготовить интерактивный отчёт',status:'completed'}]})}},
              {index:1,id:'ui-report',type:'function',function:{name:'interactive_report',arguments:JSON.stringify({title:'Сверка результата с запросом',html:reportHtml})}},
            ]};finish_reason='tool_calls';
          }
        }
        else if(approvalUi){
          if(body.messages.some(message=>message.role==='tool')){
            delta={role:'assistant',content:'Проверка разрешения завершена.'};finish_reason='stop';
          }else{
            const args={command:"Write-Output 'fixture approval'",description:'Тест отображения разрешения',timeoutMs:3000,sandbox_permissions:'danger-full-access',justification:'Изолированный тест окна разрешения'};
            delta={role:'assistant',tool_calls:[{index:0,id:'fixture-native-approval',type:'function',function:{name:'pwsh',arguments:JSON.stringify(args)}}]};finish_reason='tool_calls';
          }
        }
        else if(++screenshotRequests===1){
          assert(body.messages.some(message=>['system','developer'].includes(message.role)&&JSON.stringify(message.content).includes('Не жди отдельной команды')),'proactive screenshot instruction reaches the model');
          delta={role:'assistant',tool_calls:[0,1].map(index=>({index,id:'ui-screenshot-'+index,type:'function',function:{name:'take_screenshot',arguments:JSON.stringify({target:'primary',x:0,y:0,width:index===0?320:300,height:180,caption:index===0?'Первый снимок':'Второй снимок'})}}))};finish_reason='tool_calls';
        }else{
          const images=body.messages.flatMap(message=>Array.isArray(message.content)?message.content:[]).filter(part=>part.type==='image_url');
          assert.equal(images.length,2,'the actual next model request contains both captured images');
          assert.match(images[0].image_url.url,/^data:image\/png;base64,/);
          delta={role:'assistant',content:'Снимок добавлен в чат.'};finish_reason='stop';
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
  writeFileSync(join(home,'settings.yaml'),`llm-pi-ai:\n  providers:\n    fixture:\n      api: openai-completions\n      baseURL: http://127.0.0.1:${fixtureServer.address().port}/v1\n      apiKeyEnv: FIXTURE_KEY\n      models:\n        - id: kimi-k3-1-pro\nagent-default-model:\n  provider: fixture\n  model: kimi-k3-1-pro\npermission:\n  defaultPreset: ${approvalUi ? 'workspace-write' : 'danger-full-access'}\n`);
  writeFileSync(join(home,'.credentials.yaml'),'version: 1\nrefs:\n  FIXTURE_KEY: fixture-only\n');
}
const workspaceId = randomUUID();
if(chatErrorUi){
  writeFileSync(join(home,'settings.yaml'),`llm-pi-ai:\n  providers:\n    fixture:\n      api: openai-completions\n      baseURL: http://127.0.0.1:${fixtureServer.address().port}/v1\n      apiKeyEnv: FIXTURE_KEY\n      models:\n        - id: gpt-6-astra\n        - id: gpt-6-sol\nagent-default-model:\n  provider: fixture\n  model: gpt-6-astra\n`);
  writeFileSync(join(home,'.credentials.yaml'),'version: 1\nrefs:\n  FIXTURE_KEY: fixture-only\n');
}
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
const environment = { ...process.env, DSH_HOME: home, DSH_DESKTOP_DIAGNOSTIC_FILE: join(home, 'diagnostics.log') };
delete environment.ELECTRON_RUN_AS_NODE;
const throughLauncher = process.argv.includes('--launcher');
const testApp = process.env.QCODERI_TEST_APP ?? join(base, 'app');
const executable = nativeWindow || throughLauncher ? process.env.QCODERI_TEST_LAUNCHER ?? join(base, '../QCoderI.exe') : join(testApp, 'QCoderI.exe');
if (nativeWindow) environment.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=' + port;
const launchedAt = performance.now();
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
      page = pages.find(p => p.type === 'page' && (nativeWindow ? /^http:\/\/127\.0\.0\.1:\d+\/index\.html$/.test(p.url) : p.url === 'dsh-app://app/index.html'));
      if (page) break;
    } catch {}
    if (child.exitCode !== null && !(throughLauncher && child.exitCode === 0)) throw Error(`Window exited ${child.exitCode}: ${diagnostics}`);
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
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  closeBrowser = async () => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    const closing = send('Browser.close');
    closing.catch(() => {});
    await Promise.race([closing, pause(1000)]).catch(() => {});
  };
  const evaluate = async (expression, sessionId) => {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (response.exceptionDetails) throw Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  await send('Runtime.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled:true });
  const until = async (expression, label) => {
    for (let i = 0; i < 100; i++) { const result = await evaluate(`Boolean(${expression})`); if (result) return result; await pause(150); }
    throw Error(`${label}: ${await evaluate('document.body.innerText')}`);
  };
  const clickText = text => evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)} || b.getAttribute('aria-label') === ${JSON.stringify(text)}); if (!button) throw Error('Missing button ' + ${JSON.stringify(text)}); button.click(); return true; })()`);
  await until(`document.documentElement?.lang === 'ru' && document.body?.innerText?.includes('QCoderI')`, 'Russian QCoderI shell');
  console.log(`Desktop shell visible after ${Math.round(performance.now()-launchedAt)} ms`);
  // QCoderI starts directly; the upstream testing and vendor-key gates are removed.
  assert(await evaluate(`!document.body.innerText.includes('Уведомление о тестировании') && !document.body.innerText.includes('Добавьте ключ API, чтобы начать')`), 'no upstream first-run modal');
  await until(`document.querySelector('.qc-hero-title') && document.querySelector('.qc-night-navigation') && document.querySelectorAll('.qc-quick-card').length === 4`, 'Moonlight Studio presentation loaded');
  if (nativeWindow) {
    assert(await evaluate(`[...document.querySelectorAll('.qc-night-navigation svg use')].length >= 6 &&
      [...document.querySelectorAll('.qc-night-navigation svg use')].every(icon =>
        icon.getAttribute('href').startsWith('#qcoderi-glyph-') && icon.getBBox().width > 0)`),
      'sidebar glyphs render on the first view from the document sprite');
  }
  assert(await evaluate(`new Promise(resolve => { const image = new Image(); image.onload = () => resolve(image.naturalWidth >= 1000); image.onerror = () => resolve(false); image.src = new URL('./qcoderi-moonlit-elf.png', document.baseURI).href; })`), 'packaged Moonlight illustration loads');
  if(chatErrorUi){
    await until(`document.querySelector('[data-qc-conversation="chat"] [contenteditable="true"]')`,'chat input ready');
    const submit=async text=>{
      await evaluate(`document.querySelector('[contenteditable="true"]').focus();true`);
      await send('Input.insertText',{text});
      await until(`[...document.querySelectorAll('button')].some(button=>!button.disabled&&button.getAttribute('aria-label')?.startsWith('Отправить'))`,'send enabled');
      await evaluate(`[...document.querySelectorAll('button')].find(button=>!button.disabled&&button.getAttribute('aria-label')?.startsWith('Отправить')).click();true`);
    };
    await submit('Проверка обрыва ответа');
    await until(`[...document.querySelectorAll('[data-chat-flow-kind="turn-error"]')].some(row=>row.innerText.includes('req-chat-error-fixture'))`,'partial stream ends with visible provider error');
    const requestCount = chatFixtureRequests;
    await submit('а какая ты модель?');
    await until(`document.body.innerText.includes('По каталогу провайдера за gpt-6-astra стоит модель test-provider-model.')`,'follow-up model identity appears in chat');
    assert.equal(chatFixtureRequests,requestCount);
    await submit('Проверка следующего ответа');
    await until(`[...document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')].some(row=>row.innerText.includes('Ответ на следующее сообщение'))`,'normal model response arrives after failure');
    await send('Page.reload');
    await until(`document.querySelector('[data-chat-flow-kind="turn-error"]')?.innerText.includes('req-chat-error-fixture') && document.body.innerText.includes('стоит модель test-provider-model') && document.body.innerText.includes('Ответ на следующее сообщение')`,'error and both replies survive reload');
    console.log('PASS: packaged ordinary chat displays interrupted provider failure, local identity and normal follow-up, then replays history on reload');
    if (nativeWindow) {
      assert.equal((await fetch(page.url)).status,403,'unauthenticated loopback access is rejected');
      assert(await evaluate(`(async()=>{const audio=await window.dshDesktop.voice.synthesize('Проверка озвучивания');return audio.type==='audio/wav' && audio.size>1000 && await audio.slice(0,4).text()==='RIFF';})()`),'offline speech returns real WAV');
      await until(`document.querySelector('.qc-composer-voice')`,'microphone button');
      await until(`document.querySelector('.qc-read-aloud')`,'read-aloud button');
      await clickText('Голосовая диктовка');
      await until(`document.querySelector('select[aria-label="Режим диктовки"]')?.value==='local'`,'local dictation default');
      await clickText('Свернуть панель');
      await submit('Проверка смены модели');
      await until(`document.querySelector('.qc-running-status')`,'single running status');
      assert.equal(await evaluate(`document.querySelectorAll('.qc-running-status,.qc-text-progress').length`),1);
      const statusPreview=await send('Page.captureScreenshot',{format:'png'});
      writeFileSync(join(base,'tests/native-running-preview.png'),Buffer.from(statusPreview.data,'base64'));
      await evaluate(`document.querySelector('[class*="_trigger"][aria-haspopup="menu"][title*="gpt-6-astra"]').click();true`);
      await until(`document.querySelector('[role="menu"] [class*="_cellLabel"]')`,'model popup opens during an active request');
      await evaluate(`document.querySelector('[role="menu"] [class*="_cellLabel"]').closest('button').click();true`);
      await until(`[...document.querySelectorAll('[role="menu"] button')].some(b=>b.innerText.includes('gpt-6-sol'))`,'second model available');
      await evaluate(`[...document.querySelectorAll('[role="menu"] button')].find(b=>b.innerText.includes('gpt-6-sol')).click();true`);
      await until(`[...document.querySelectorAll('[data-model-activity="pending"]')].some(row=>row.innerText.includes('gpt-6-sol'))`,'selection appears in chat');
      await submit('Сообщение пока ждёт');
      await until(`[...document.querySelectorAll('[data-model-activity="applied"]')].some(row=>row.innerText.includes('gpt-6-sol'))`,'actual next request uses newly selected model');
      await until(`[...document.querySelectorAll('[data-chat-flow-kind="user"],[data-chat-flow-kind="steering"]')].some(row=>row.innerText.includes('Сообщение пока ждёт'))`,'queued user text is retained');
      assert.equal(chatFixtureBodies.find(body=>JSON.stringify(body.messages).includes('Сообщение пока ждёт'))?.model,'gpt-6-sol');
      await until(`!document.querySelector('.qc-running-status')`,'model change turn completed');
      await submit('Проверка уровня на ходу');
      await until(`document.querySelector('.qc-running-status')`,'request for effort change is active');
      await evaluate(`document.querySelector('.Alm79a_trigger').click();true`);
      await until(`[...document.querySelectorAll('.Alm79a_cell')].some(b=>b.innerText.includes('Уровень рассуждений'))`,'effort menu opens while running');
      await evaluate(`[...document.querySelectorAll('.Alm79a_cell')].find(b=>b.innerText.includes('Уровень рассуждений')).click();true`);
      await clickText('Максимальный');
      await until(`[...document.querySelectorAll('[data-model-activity="pending"]')].some(row=>row.innerText.includes('gpt-6-sol · Максимальный'))`,'effort change appears before its request');
      await submit('Применить новый уровень');
      await until(`[...document.querySelectorAll('[data-model-activity="applied"]')].some(row=>row.innerText.includes('gpt-6-sol · Максимальный'))`,'actual next request uses newly selected reasoning');
      const effortRequest=chatFixtureBodies.find(body=>JSON.stringify(body.messages).includes('Применить новый уровень'));
      assert.equal(effortRequest?.reasoning_effort,'max');
      await until(`!document.querySelector('.qc-running-status')`,'effort change turn completed');
      await send('Emulation.setDeviceMetricsOverride',{width:700,height:490,deviceScaleFactor:1,mobile:false});
      await evaluate(`document.querySelector('[contenteditable="true"]').focus();true`);
      await send('Input.insertText',{text:Array.from({length:35},(_,i)=>'Строка '+i).join('\n')});
      await until(`document.querySelector('[contenteditable="true"]').innerText.includes('Строка 34')`,'long multiline draft');
      assert(await evaluate(`(()=>{const card=document.querySelector('[data-composer-card]'), mic=document.querySelector('.qc-composer-voice');const send=[...card.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')?.startsWith('Отправить'));if(!send)return false;const r=send.getBoundingClientRect(),m=mic.getBoundingClientRect();return card.getBoundingClientRect().height<235 && r.top<innerHeight && Math.abs(r.y-m.y)<4 && document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===send;})()`),'long draft keeps compact, aligned and clickable composer');
      const preview=await send('Page.captureScreenshot',{format:'png'});
      writeFileSync(join(base,'tests/native-window-preview.png'),Buffer.from(preview.data,'base64'));
      console.log('PASS: native chat, offline TTS, microphone, live model transition, visible user message, compact draft');
    }
  }else if(screenshotUi){
    if (reportUi) await pause(700);
    await clickText('Проекты');
    await until(`document.querySelector('[data-qc-conversation="project"]')`,'project mode');
    if(!await evaluate(`Boolean(document.querySelector('[contenteditable="true"]'))`)){
      await evaluate(`document.querySelector('button[aria-label="Выбрать рабочую область"]').click();true`);
      await until(`[...document.querySelectorAll('[role="menuitem"],button')].some(button=>button.textContent.trim()==='Тестовый проект')`,'workspace offered');
      await evaluate(`[...document.querySelectorAll('[role="menuitem"],button')].find(button=>button.textContent.trim()==='Тестовый проект').click();true`);
    }
    await until(`document.querySelector('[contenteditable="true"]')`,'project input ready');
    if (reportUi) await until(`document.querySelector('button._3Yb3Sq_seat')?.textContent.includes('Команда QCoderI')`,'project uses Team QCoderI');
    const request = reportUi ? 'Покажи интерактивный отчёт о выполненной работе' : 'Проверь интерфейс и продемонстрируй результат работы';
    await evaluate(`(()=>{const input=document.querySelector('[contenteditable="true"]');input.focus();document.execCommand('insertText',false,${JSON.stringify(request)});return true})()`);
    await until(`[...document.querySelectorAll('button')].some(button=>button.classList.contains('_5M8isa_primary')&&!button.disabled)`,'send enabled');
    await evaluate(`[...document.querySelectorAll('button')].find(button=>button.classList.contains('_5M8isa_primary')).click();true`);
    if (reportUi) {
      const selector = '.qc-report';
      await until(`document.querySelector('${selector} iframe') && document.body.innerText.includes('Отчёт готов.')`,'interactive report in the chat');
      assert.equal(await evaluate(`document.querySelector('${selector} iframe').sandbox.value`),'allow-scripts');
      assert.equal(await evaluate(`document.querySelector('${selector} strong').textContent`),'Интерактивный отчёт','heading is not repeated');
      await until(`document.querySelector('.qc-task-card[data-complete=true] .qc-task-heading[aria-expanded=false]')`,'completed plan occupies one line by default');
      await evaluate(`document.querySelector('.qc-task-heading').click();true`);
      await until(`document.querySelectorAll('.qc-task-list li').length===2`,'completed plan still expands');
      await evaluate(`document.querySelector('.qc-task-heading').click();true`);
      const frameTarget=(await send('Target.getTargets')).targetInfos.find(target=>target.type==='iframe'&&target.url==='about:srcdoc');
      assert(frameTarget,'sandboxed report target');
      const {sessionId}=await send('Target.attachToTarget',{targetId:frameTarget.targetId,flatten:true});
      const inReport=expression=>evaluate(expression,sessionId);
      assert.equal(await inReport(`getComputedStyle(document.documentElement).colorScheme`),'dark');
      assert(await inReport(`document.body.classList.contains('qc-report-cards')`),'report uses the card layout');
      await until(`parseInt(document.querySelector('${selector} iframe').style.getPropertyValue('--qc-report-height'))>500`,'report adjusts to content height');
      await send('Emulation.setDeviceMetricsOverride',{width:1340,height:900,deviceScaleFactor:1,mobile:false});
      await evaluate(`const report=document.querySelector('${selector}');window.reportFixtureFrame=report.querySelector('iframe');report.scrollIntoView({block:'center'});true`);
      await pause(150);
      assert(await evaluate(`document.querySelector('${selector}').getBoundingClientRect().bottom <= document.querySelector('.qc-task-card').getBoundingClientRect().top`),'inline report is visible above the plan and composer when scrolled into view');
      const preview=await send('Page.captureScreenshot',{format:'png'});
      writeFileSync(join(base,'tests/report-preview.png'),Buffer.from(preview.data,'base64'));
      await inReport(`document.querySelectorAll('button')[1].click();true`);
      assert.equal(await inReport(`document.querySelectorAll('article:not(.hidden)').length`),5);
      await evaluate(`document.querySelector('${selector} button').click();true`);
      await until(`document.querySelector('${selector}').matches(':modal')`,'report expands above chat controls');
      assert(await evaluate(`document.querySelector('${selector} iframe')===window.reportFixtureFrame`));
      assert.equal(await inReport(`document.querySelector('.on').textContent`),'Реализовано');
      await pause(150);
      const expanded=await send('Page.captureScreenshot',{format:'png'});
      writeFileSync(join(base,'tests/report-expanded-preview.png'),Buffer.from(expanded.data,'base64'));
      await inReport(`document.querySelector('.on').focus();true`);
      await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
      await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
      await until(`document.querySelector('${selector}[open]:not(:modal)')`,'Escape returns to the inline report');
      await send('Emulation.setDeviceMetricsOverride',{width:620,height:800,deviceScaleFactor:1,mobile:false});
      await evaluate(`document.querySelector('${selector} button').click();true`);
      await until(`document.querySelector('${selector}').matches(':modal') && document.querySelector('${selector}').getBoundingClientRect().width<innerWidth`,'expanded report fits a narrow window');
      const narrowFit=await inReport(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve({content:document.documentElement.scrollWidth,available:document.documentElement.clientWidth}))))`);
      assert(narrowFit.content<=narrowFit.available+1,'report fits without horizontal scrolling: '+JSON.stringify(narrowFit));
      await evaluate(`document.querySelector('${selector} button').click();true`);
      await until(`document.querySelector('${selector}[open]:not(:modal)')`,'close button returns to inline report');
      await send('Page.reload');
      await until(`document.querySelector('${selector} iframe')`,'interactive report survives reload');
      console.log('PASS: native interactive report, sandbox, filters, responsive layout, size, modal and Escape, persisted report');
    } else if (approvalUi) {
      await until(`document.querySelector('[data-approval-key]') && document.querySelector('.qc-running-status[data-phase="approval"]')?.innerText.includes('Ожидаю разрешения')`,'approval wait replaces the generic activity label');
      await evaluate(`document.querySelector('.qc-running-status[data-phase="approval"] button').click();true`);
      assert(await evaluate(`Boolean(document.activeElement?.closest('[data-approval-key]'))`), 'activity button focuses approval panel');
      await evaluate(`document.querySelector('[data-approval-key] button').click();true`);
      await until(`!document.querySelector('[data-approval-key]') && !document.querySelector('[data-phase="approval"]') && document.body.innerText.includes('Проверка разрешения завершена.')`,'rejecting the fixture clears the approval wait');
      console.log('PASS: a real approval request is visible in the chat status and remains under user control');
    } else {
    await until(`document.querySelector('[data-qcoderi-screenshot] img')?.naturalWidth>0`,'screenshot image is visible without expanding a tool row');
    await until(`document.body.innerText.includes('Снимок добавлен в чат.')`,'model inspected its screenshot');
    await until(`document.querySelector('.qc-image-stack')?.querySelectorAll('.qc-photo-cell').length===2`,'parallel image results share one strip');
    assert(await evaluate(`document.querySelector('.qc-photo-cell button')?.title === 'Первый снимок'`),'tool caption is available on hover');
    assert(await evaluate(`(()=>{
      const button=document.querySelector('[data-qc-conversation] .QFBU2W_composerSeat button._5M8isa_primary');
      const rect=button.getBoundingClientRect();
      const hit=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
      return button.contains(hit);
    })()`),'the chat splitter does not cover the send button');
    assert.equal(screenshotRequests,2);
    const before=await evaluate(`document.querySelector('[data-qcoderi-screenshot] img').src`);
    await evaluate(`document.querySelector('[data-qcoderi-screenshot]').scrollIntoView({block:'center'});true`);
    const preview=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    writeFileSync(join(base,'tests/screenshot-chat-preview.png'),Buffer.from(preview.data,'base64'));
    await send('Page.reload');
    await until(`document.querySelector('[data-qcoderi-screenshot] img')?.naturalWidth>0`,'screenshot survives session reload');
    assert.equal(screenshotRequests,2,'reload does not capture or generate another image');
    assert(before,'screenshot has a loaded image URL');
    await evaluate(`document.querySelector('[data-qcoderi-screenshot] button').click();true`);
    await until(`document.querySelector('[role="dialog"] img')?.naturalWidth>0`,'screenshot opens in the image viewer');
    await evaluate(`document.querySelector('.qc-photo-viewer-nav[data-side="next"]').click();true`);
    await until(`document.querySelector('[role="dialog"] img')?.alt==='Второй снимок'`,'viewer moves to the next image');
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));true`);
    await until(`!document.querySelector('.qc-photo-viewer-controls')`,'Escape closes the image viewer');
    await evaluate(`document.querySelector('.qc-image-stack summary').click();true`);
    await until(`!document.querySelector('.qc-image-stack')?.open`,'image strip collapses');
    console.log('PASS: packaged desktop screenshot tool, real capture, wire image to model, visible chat preview, persisted reload and full-size viewer; local API only');
    }
  }else if(reasoningUi){
    const saved = async predicate => {
      for(let i=0;i<100;i++) { if(predicate(readFileSync(join(home,'settings.yaml'),'utf8'))) return; await pause(50); }
      throw Error('Reasoning settings were not persisted');
    };
    await until(`document.querySelector('.Alm79a_trigger')?.title.includes('kimi-k3-1-pro')`, 'fixture model loaded');
    await evaluate(`document.querySelector('.Alm79a_trigger').click();true`);
    await until(`[...document.querySelectorAll('.Alm79a_cell')].some(button=>button.innerText.includes('Уровень рассуждений'))`, 'native reasoning control is available');
    await evaluate(`[...document.querySelectorAll('.Alm79a_cell')].find(button=>button.innerText.includes('Уровень рассуждений')).click();true`);
    await until(`[...document.querySelectorAll('[role="menuitemradio"]')].some(button=>button.innerText==='Максимальный')`, 'Kimi exposes real supported levels');
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('[role="menuitemradio"]')].map(button=>button.innerText)`), ['По умолчанию','Низкий','Высокий','Максимальный']);
    await clickText('Максимальный');
    await until(`document.querySelector('.Alm79a_trigger')?.title.includes('Максимальный')`, 'selected effort displayed');
    await saved(text=>/reasoningEffort: max/.test(text));
    await send('Page.reload');
    await until(`document.querySelector('.Alm79a_trigger')?.title.includes('Максимальный')`, 'selection survives renderer reload');
    await clickText('Модели');
    await until(`document.body.innerText.includes('Reasoning fixture')`, 'provider settings loaded');
    await evaluate(`(()=>{const row=[...document.querySelectorAll('._5a_YTa_rowCard')].find(row=>row.innerText.includes('Reasoning fixture')); row.querySelector('._5a_YTa_secondaryButton').click();return true})()`);
    await until(`document.querySelector('._5a_YTa_customizedSummary')`, 'provider editor opened');
    await evaluate(`document.querySelector('._5a_YTa_customizedSummary').click();true`);
    await until(`document.querySelector('._5a_YTa_modelEntry button[aria-expanded]')`, 'model options available');
    await evaluate(`document.querySelector('._5a_YTa_modelEntry button[aria-expanded]').click();true`);
    await until(`document.querySelector('._5a_YTa_modelAdvanced')`, 'ordinary model options expanded');
    assert.equal(await evaluate(`Boolean(document.querySelector('.qc-reasoning-editor')||document.querySelector('select[aria-label^="Уровни рассуждений"]')||document.querySelector('input[aria-label^="Значение API"]'))`),false,'no reasoning configuration in provider settings');
    assert.equal(await evaluate(`document.body.innerText.includes('Формат reasoning API')||document.body.innerText.includes('Передавать reasoning_effort')`),false);
    await evaluate(`document.querySelector('._5a_YTa_modelAdvanced').scrollIntoView({block:'center'});true`);
    await pause(200);
    const settingsShot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    writeFileSync(join(base,'tests/reasoning-settings-preview.png'),Buffer.from(settingsShot.data,'base64'));
    assert(!readFileSync(join(home,'settings.yaml'),'utf8').includes('reasoningEfforts:'),'auto detection needs no manual configuration');
    await evaluate(`document.querySelector('.Ri3YFq_close').click();true`);
    await evaluate(`document.querySelector('.Alm79a_trigger').click();true`);
    await evaluate(`[...document.querySelectorAll('.Alm79a_cell')].find(button=>button.innerText.includes('Уровень рассуждений')).click();true`);
    await clickText('По умолчанию');
    await until(`document.querySelector('.Alm79a_trigger')?.title.includes('По умолчанию')`, 'provider default restored');
    await saved(text=>!text.includes('reasoningEffort: max'));
    await evaluate(`document.querySelector('.Alm79a_trigger').click();true`);
    await evaluate(`[...document.querySelectorAll('.Alm79a_cell')].find(button=>button.innerText.includes('Модель')).click();true`);
    await until(`[...document.querySelectorAll('[role="menuitemradio"]')].some(button=>button.innerText==='opaque-alias')`, 'opaque model is available');
    await clickText('opaque-alias');
    await until(`document.querySelector('.Alm79a_trigger')?.title.includes('opaque-alias')`, 'opaque model selected');
    await until(`document.querySelector('.Alm79a_trigger')?.getAttribute('aria-expanded')==='false'`, 'model picker settles');
    await evaluate(`document.querySelector('.Alm79a_trigger').click();true`);
    await until(`[...document.querySelectorAll('.Alm79a_cell')].some(button=>button.innerText.includes('Уровень рассуждений'))`, 'reasoning settings for opaque model');
    await evaluate(`[...document.querySelectorAll('.Alm79a_cell')].find(button=>button.innerText.includes('Уровень рассуждений')).click();true`);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('[role="menuitemradio"]')].map(button=>button.innerText)`),['По умолчанию','Низкий','Максимальный'],'arbitrary alias levels come from the connected API');
    const menuShot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    writeFileSync(join(base,'tests/reasoning-menu-preview.png'),Buffer.from(menuShot.data,'base64'));
    const unexpected = diagnostics.split('\n').filter(line => /RENDERER:|CONSOLE:/.test(line)
      && !(nativeWindow && line.includes('[session-controller] control stream failed:') && line.includes('RemoteError: network error')));
    assert.equal(unexpected.length,0,unexpected.map(line=>line.slice(0,500)).join('\n'));
    console.log('PASS: chat-only reasoning menu; exact Kimi levels; select/persist/reload/reset; no provider form; opaque alias auto-detected from local API; no inference requests submitted');
  } else if(historyUi){
    // Real native turns use a local fixture that rejects inference with HTTP 400.
    // No public inference endpoint can receive these test prompts.
    const submit=async()=>{
      const before=await evaluate(`document.querySelectorAll('[data-qc-message-id]').length`);
      await evaluate(`document.querySelector('button._5M8isa_primary').click(); true`);
      await until(`document.querySelectorAll('[data-qc-message-id]').length>${before}`,'actual admitted user message');
      await until(`[...document.querySelectorAll('button')].some(button=>button.classList.contains('_5M8isa_primary')&&button.getAttribute('aria-label')?.startsWith('Отправить'))`,'local failed turn becomes idle');
      return await evaluate(`[...document.querySelectorAll('[data-qc-message-id]')].at(-1).dataset.qcMessageId`);
    };
    await evaluate(`document.querySelector('.qc-quick-card').click(); true`);
    await until(`document.querySelector('[contenteditable="true"]')?.innerText.includes('Кинематографичный пейзаж')`,'real suggestion fills history draft');
    const firstText=await evaluate(`document.querySelector('[contenteditable="true"]').innerText`);
    const first=await submit();
    const session=await evaluate(`[...window.__qcoderiModelSelections.keys()].find(id=>typeof id==='string')`);
    const jobsPath=join(home,'media-jobs');mkdirSync(jobsPath,{recursive:true});
    const record=(id,key,createdAt,state='completed')=>({sessionId:session,messageId:id,prompt:state==='completed'?firstText:'Новая сцена',provider:'niceai',model:'seedance-2.5',seconds:5,createdAt:Date.now()+createdAt,state,status:state==='completed'?'completed':'queued',progress:state==='completed'?100:0,...(state==='completed'?{id:'history-'+key,urls:process.env.QCODERI_LIVE_PLAYBACK?[process.env.QCODERI_LIVE_PLAYBACK]:[]}:{})});
    writeFileSync(join(jobsPath,'a'.repeat(64)+'.json'),JSON.stringify(record(first,'first',1)));
    await until(`document.querySelector('[data-qc-message-id="${first}"] [data-qc-video-key="${'a'.repeat(64)}"]')`,'first result is directly under its original request');
    await evaluate(`document.querySelector('[data-qc-video-key="${'a'.repeat(64)}"] .qc-video-response-actions button').click(); true`);
    await until(`document.querySelector('[contenteditable="true"]')?.innerText.includes('Кинематографичный пейзаж')`,'repeat prepares the second draft');
    const second=await submit();
    writeFileSync(join(jobsPath,'b'.repeat(64)+'.json'),JSON.stringify(record(second,'second',2)));
    await until(`document.querySelector('[data-qc-message-id="${second}"] [data-qc-video-key="${'b'.repeat(64)}"]')`,'second result has its own request');
    await evaluate(`document.querySelector('[data-qc-video-key="${'a'.repeat(64)}"] .qc-video-response-actions button').click(); true`);
    await until(`document.querySelector('[contenteditable="true"]')?.innerText.includes('Кинематографичный пейзаж')`,'repeat prepares the third draft');
    const third=await submit();
    writeFileSync(join(jobsPath,'c'.repeat(64)+'.json'),JSON.stringify(record(third,'third',3,'created')));
    await until(`document.querySelectorAll('.qc-video-answer article').length===3 && document.querySelectorAll('.qc-video-answer article[data-state="completed"]').length===2`,'a queued third generation preserves both earlier videos');
    assert(!await evaluate(`Boolean(document.querySelector('.qc-video-history'))`),'earlier videos are not hidden behind a selector');
    const sourceOrder=await evaluate(`[...document.querySelectorAll('.qc-video-answer article')].map(card=>card.dataset.videoMessageId)`);
    assert.deepEqual(sourceOrder,[first,second,third]);
    await send('Page.reload');
    await until(`document.querySelector('.qc-night-navigation')`,'real app reload');
    await until(`[...document.querySelectorAll('[role="treeitem"]')].some(item=>item.innerText.includes('Кинематографичный'))`,'persisted conversation remains in the sidebar');
    await evaluate(`[...document.querySelectorAll('[role="treeitem"]')].find(item=>item.innerText.includes('Кинематографичный')).click(); true`);
    await until(`document.querySelectorAll('.qc-video-answer article').length===3`,'all three cards return after reloading and reopening native history');
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('.qc-video-answer article')].map(card=>card.dataset.videoMessageId)`),sourceOrder);
    assert(!await evaluate(`document.body.innerText.includes('Этот ход завершился ошибкой') || document.body.innerText.includes('Системный промпт')`),'video-owned turns use the media card instead of contradictory text-transport status');
    await evaluate(`document.querySelector('.qc-video-answer article .qc-video-response-actions button').click(); true`);
    await until(`document.querySelector('[contenteditable="true"]')?.innerText.includes(${JSON.stringify(firstText)}) && document.querySelector('.qc-duration-presets button[aria-pressed="true"]')?.textContent==='5 с'`,'repeat restores prompt, model and duration without submitting');
    assert.equal(await evaluate(`document.querySelectorAll('[data-qc-message-id]').length`),3,'repeat never starts a new paid turn automatically');
    const historyShot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    writeFileSync(join(base,'tests/video-history-preview.png'),Buffer.from(historyShot.data,'base64'));
    console.log('PASS: three real native user turns -> separate inline video cards -> older results survive a new queued job -> reload and reopen history -> all cards preserved -> repeat prepares an unsent draft; no public inference calls');
  } else if (videoUi) {
    await until(`document.querySelector('.qc-hero-title')?.innerText.includes('Какое видео создадим?')`, 'selected Seedance is visibly a video model');
    await until(`document.querySelector('.qc-chat-context')?.innerText.includes('NiceAI · 5 с')`, 'video duration is shown before submission');
    await evaluate(`document.querySelector('.qc-quick-card').click(); true`);
    await until(`document.querySelector('[contenteditable="true"]')?.innerText.includes('Кинематографичный пейзаж')`, 'video suggestion fills the real draft');
    const videoShot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    writeFileSync(join(base,'tests/video-compose-preview.png'),Buffer.from(videoShot.data,'base64'));
    console.log('PASS: Seedance selected in the real UI, video-specific title, explicit 5-second duration and scene suggestions; no request submitted');
    await until(`document.querySelector('.qc-video-options')`, 'video duration controls are available before sending');
    await evaluate(`[...document.querySelectorAll('.qc-duration-presets button')].find(button=>button.textContent==='15 с').click(); true`);
    await until(`document.querySelector('.qc-duration-presets button[aria-pressed="true"]')?.textContent==='15 с' && document.querySelector('.qc-hero-description')?.textContent.includes('15 с')`, 'duration choice is saved and reflected before submission');
    const mediaSession=await evaluate(`[...window.__qcoderiModelSelections.keys()].find(id=>typeof id==='string')`);
    assert(mediaSession,'model selection identifies the current native session');
    const savedOptions=await evaluate(`window.__qcoderiGetMediaOptions(${JSON.stringify(mediaSession)},new AbortController().signal)`);
    assert.equal(savedOptions.seconds,15,'duration persists through the native service');
    const remoteJobs=await evaluate(`window.__qcoderiReadMedia(${JSON.stringify(mediaSession)},new AbortController().signal)`);
    assert.deepEqual(remoteJobs,[],'native recovery RPC returns only this isolated session');
    mkdirSync(join(home,'media-jobs'),{recursive:true});
    const mediaFile=join(home,'media-jobs','e'.repeat(64)+'.json');
    const mediaRecord={sessionId:mediaSession,model:'seedance-2.5',seconds:5,createdAt:Date.now(),state:'submitting',status:'queued',progress:0};
    writeFileSync(mediaFile,JSON.stringify(mediaRecord));
    await until(`document.querySelector('.qc-video-panel [role="progressbar"]')?.getAttribute('aria-valuenow')==='0'`, 'real recovery card displays service progress without invented percentages');
    const progressShot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    writeFileSync(join(base,'tests/video-progress-preview.png'),Buffer.from(progressShot.data,'base64'));
    const playbackUrl=process.env.QCODERI_LIVE_PLAYBACK;
    if(playbackUrl)await evaluate(`(()=>{
      window.__qcPlaybackTimings={};
      const observe=()=>{const video=document.querySelector('.qc-video-player video');if(!video||video.dataset.smokeWatched)return;video.dataset.smokeWatched='true';const began=performance.now();window.__qcPlaybackTimings={};video.addEventListener('loadedmetadata',()=>{window.__qcPlaybackTimings.metadataMs=Math.round(performance.now()-began);},{once:true});video.addEventListener('loadeddata',()=>{window.__qcPlaybackTimings.firstFrameMs=Math.round(performance.now()-began);},{once:true});};
      new MutationObserver(observe).observe(document.body,{childList:true,subtree:true});observe();return true;
    })()`);
    // A missing source produces a deterministic local 404 for the error UI;
    // the ordinary smoke must never depend on external DNS or media servers.
    writeFileSync(mediaFile,JSON.stringify({...mediaRecord,id:'verified-fixture',state:'completed',status:'completed',progress:100,urls:playbackUrl?[playbackUrl]:[]}));
    await until(`document.querySelector('.qc-video-player video')`,'completed player appears in history');
    await evaluate(`document.querySelector('.qc-video-player video').scrollIntoView({block:'center'});true`);
    await until(`document.querySelector('.qc-video-player video')?.src.includes('/qcoderi-media/')`, 'completed job is recovered with a same-origin media stream');
    assert(await evaluate(`(()=>{const v=document.querySelector('.qc-video-player video');return v.controls&&v.preload==='auto'&&!v.autoplay&&!v.poster})()`),'real player actively fetches video bytes without autoplay or a decorative poster');
    if(process.env.QCODERI_LIVE_PLAYBACK){
      await until(`document.querySelector('.qc-video-player video')?.readyState>=2`, 'actual NiceAI video bytes decode in packaged Electron');
      const coldTiming=await evaluate(`window.__qcPlaybackTimings`);
      await evaluate(`(()=>{const v=document.querySelector('.qc-video-player video');v.muted=true;return v.play().then(()=>true)})()`);
      await until(`document.querySelector('.qc-video-player video')?.currentTime>1`, 'actual video advances during playback');
      await evaluate(`(()=>{const v=document.querySelector('.qc-video-player video');v.pause();v.currentTime=3;return true})()`);
      await until(`document.querySelector('.qc-video-player video')?.readyState>=2 && Math.abs(document.querySelector('.qc-video-player video').currentTime-3)<.3`, 'actual video seeks using byte ranges');
      console.log('PASS: real NiceAI MP4 decoded, played past one second and sought to three seconds through the desktop media stream; no video generation POST');
      const cacheStatus=await evaluate(`(async()=>{const v=document.querySelector('.qc-video-player video');const r=await fetch(v.src+'&cache-fill='+Date.now(),{cache:'no-store',headers:{Range:'bytes=0-'}});if(!r.ok)throw Error('Cache warmup failed');const bytes=(await r.arrayBuffer()).byteLength;const head=await fetch(v.src+'&cache-check='+Date.now(),{method:'HEAD',cache:'no-store'});return {cache:head.headers.get('X-QCoderI-Cache'),bytes};})()`);
      assert.equal(cacheStatus.cache,'HIT','complete MP4 is served by the persistent local cache');
      await evaluate(`document.querySelector('button[aria-label="Перезагрузить видео"]').click(); true`);
      await until(`document.querySelector('.qc-video-player video')?.readyState>=2 && Number.isFinite(window.__qcPlaybackTimings.firstFrameMs)`, 'cached video shows its first frame without contacting NiceAI again');
      const warmTiming=await evaluate(`window.__qcPlaybackTimings`);
      assert(warmTiming.firstFrameMs<1500,'local replay first frame is below 1.5 seconds: '+JSON.stringify(warmTiming));
      console.log('Playback timing:',JSON.stringify({cold:coldTiming,cached:warmTiming}));
      const downloadDirectory=join(home,'downloads');mkdirSync(downloadDirectory,{recursive:true});
      try{await send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloadDirectory,eventsEnabled:true});}catch{await send('Page.setDownloadBehavior',{behavior:'allow',downloadPath:downloadDirectory});}
      await evaluate(`document.querySelector('.qc-video-download').click();true`);
      let savedVideo;
      for(let i=0;i<100;i++){savedVideo=readdirSync(downloadDirectory).find(name=>name.endsWith('.mp4'));if(savedVideo)break;await pause(150);}
      assert(savedVideo,'the actual Download action saves an MP4 through the desktop protocol');
      assert.equal(statSync(join(downloadDirectory,savedVideo)).size,cacheStatus.bytes,'saved MP4 matches the complete video length');
      console.log('PASS: Download saves the actual complete MP4 to the selected local folder without a new generation');
    }else{
      await until(`document.querySelector('.qc-video-viewport')?.dataset.playback==='error'`, 'a failed video load exposes a useful retry state');
      assert(await evaluate(`[...document.querySelectorAll('.qc-video-loading button')].some(button=>button.textContent.includes('Повторить загрузку'))`),'retry is available without another generation');
    }
    await pause(600);
    const recoveredShot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    writeFileSync(join(base,'tests/video-recovered-preview.png'),Buffer.from(recoveredShot.data,'base64'));
    console.log('PASS: native recovery RPC -> persisted job -> real progress card -> recovered video player and original link; no paid request');
  } else {
  await until(`document.querySelector('[data-qc-conversation="chat"] [contenteditable="true"]')`, 'ordinary chat opens without selecting a project');
  const systemSample=await evaluate(`window.dshDesktop.system.snapshot()`);
  assert(systemSample.ram>=0 && systemSample.ram<=100 && systemSample.gpu===null,'desktop bridge returns real RAM usage and explicit unavailable GPU data');
  await until(`[...document.querySelectorAll('.qc-system-meter')].slice(0,2).every(meter=>meter.textContent.includes('%'))`,'sidebar receives sampled CPU and RAM');
  assert.equal(await evaluate(`document.querySelectorAll('button[aria-label="Общение"]').length`),1,'mode navigation is not duplicated');
  await clickText('MCP');
  await until(`document.querySelector('._6A70Ea_search input')?.value==='mcp'`,'MCP opens the actual plugin inventory filtered to MCP');
  await evaluate(`document.querySelector('.Ri3YFq_close').click(); true`);
  await clickText('Инструменты');
  await until(`document.querySelector('.D2BIxW_tab[aria-selected="true"]')?.id.endsWith('-tab-configurable')`,'tools opens configurable plugins instead of the MCP filter');
  await evaluate(`document.querySelector('.Ri3YFq_close').click(); true`);
  await clickText('Модели');
  await until(`document.querySelector('.Ri3YFq_active')?.textContent.trim()==='Модели'`,'models shortcut opens actual model settings');
  await evaluate(`document.querySelector('.Ri3YFq_close').click(); true`);
  console.log('PASS: live CPU/RAM bridge, honest unavailable GPU, single mode navigation, functional MCP/tools/models shortcuts');
  assert(await evaluate(`typeof window.dshDesktop.quit==='function'`),'power button has a real owned-desktop quit operation');
  await clickText('Уведомления и обновления');
  await until(`document.querySelector('#qc-sidebar-notifications .qc-update-card')`,'bell opens notifications and native updater');
  await clickText('Закрыть уведомления');
  await until(`!document.querySelector('#qc-sidebar-notifications')`,'notifications can be dismissed');
  await clickText('Подключения моделей');
  await until(`document.querySelector('.Ri3YFq_active')?.textContent.trim()==='Модели'`,'cloud opens actual model connections');
  await evaluate(`document.querySelector('.Ri3YFq_close').click(); true`);
  assert(!await evaluate(`Boolean(document.querySelector('[data-qc-conversation="chat"] button[aria-label="Выбрать рабочую область"]'))`), 'ordinary chat has no workspace picker');
  assert(await evaluate(`getComputedStyle(document.querySelector('.lxT6lq_trigger')).display === 'none'`), 'project permission control is hidden in chat');
  await evaluate(`document.querySelector('.qc-quick-card').click(); true`);
  await until(`document.querySelector('[contenteditable="true"]')?.innerText.includes('Помоги разобраться в новой теме')`, 'conversation suggestion fills draft');
  const chatShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(base, 'tests/chat-preview.png'), Buffer.from(chatShot.data, 'base64'));
  const sideBounds=await evaluate(`(()=>{const box=document.querySelector('.pKYZ4q_root').getBoundingClientRect();return{x:box.x,y:box.y,width:box.width,height:box.height,scale:1}})()`);
  const sideShot=await send('Page.captureScreenshot',{format:'png',clip:sideBounds,captureBeyondViewport:false});
  writeFileSync(join(base,'tests/sidebar-reference-preview.png'),Buffer.from(sideShot.data,'base64'));
  writeFileSync(join(base,'tests/.runtime/sidebar-reference-geometry.json'),JSON.stringify(await evaluate(`['.pKYZ4q_root','.pKYZ4q_logoRow','.pKYZ4q_newSession','.qc-sidebar-shortcuts','.UVcMdq_sectionHeader','.qc-system-card','.qc-profile-card','.qc-sidebar-utilities'].map(selector=>{const box=document.querySelector(selector).getBoundingClientRect();return{selector,x:box.x,y:box.y,width:box.width,height:box.height}})`),null,2));
  await clickText('Проекты');
  await until(`document.querySelector('[data-qc-conversation="project"]')`, 'project mode opens independently');
  if (!await evaluate(`Boolean(document.querySelector('[contenteditable="true"]'))`)) {
    await evaluate(`document.querySelector('button[aria-label="Выбрать рабочую область"]').click(); true`);
    await until(`[...document.querySelectorAll('[role="menuitem"],button')].some(button=>button.textContent.trim()==='Тестовый проект')`, 'fixture workspace offered');
    await evaluate(`[...document.querySelectorAll('[role="menuitem"],button')].find(button=>button.textContent.trim()==='Тестовый проект').click(); true`);
    await until(`document.querySelector('[contenteditable="true"]')`, 'workspace session ready');
  }
  await pause(700);
  const homeShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(base, 'tests/home-preview.png'), Buffer.from(homeShot.data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 960, height: 640, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await pause(300);
  assert(await evaluate(`document.documentElement.scrollWidth <= innerWidth && getComputedStyle(document.querySelector('.V8U9sa_frame')).animationName === 'none'`), 'narrow layout and reduced motion');
  const narrowShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(base, 'tests/home-compact-preview.png'), Buffer.from(narrowShot.data, 'base64'));
  await send('Emulation.clearDeviceMetricsOverride');
  await send('Emulation.setEmulatedMedia', { features: [] });
  await evaluate(`document.querySelector('.qc-quick-card').click(); true`);
  await until(`document.querySelector('[contenteditable="true"]')?.innerText.includes('Помоги написать и проверить код')`, 'quick-start fills the real draft without sending');
  await clickText('Файлы');
  await until(`document.body.innerText.includes('README.md')`, 'file shortcut lists the real project directory');
  await clickText('Чат');
  await until(`document.querySelector('.V8U9sa_frame')?.hasAttribute('data-rightbar-collapsed')`, 'chat shortcut collapses the file pane');
  await clickText('Агенты');
  await until(`document.querySelector('.Ri3YFq_active')?.textContent.trim() === 'Профили агентов'`, 'agent shortcut opens the real settings section');
  await until(`document.body.innerText.includes('Команда QCoderI')`, 'team preset is discoverable');
  await until(`document.body.innerText.includes('Unreal Engine 5')`, 'Unreal preset is discoverable');
  const teamCard = `document.querySelector('button[aria-label$=": Команда QCoderI"][aria-pressed]')`;
  await until(`${teamCard}?.getAttribute('aria-pressed') === 'true'`, 'new projects default to Team QCoderI');
  const unrealCard = `document.querySelector('button[aria-label$=": Unreal Engine 5"][aria-pressed]')`;
  assert(await evaluate(`${unrealCard} && ${unrealCard}.getAttribute('aria-disabled') !== 'true'`), 'Unreal preset composition is healthy: ' + await evaluate(`${unrealCard}?.closest('li')?.innerText`));
  await evaluate(`${unrealCard}.click(); true`);
  await until(`${unrealCard}?.getAttribute('aria-pressed') === 'true'`, 'Unreal preset selected');
  assert(readFileSync(join(home, 'settings.yaml'), 'utf8').includes('qcoder-unreal'), 'Unreal default is persisted');
  const unrealShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(base, 'tests/unreal-profile-preview.png'), Buffer.from(unrealShot.data, 'base64'));
  console.log('PASS: packaged Unreal profile discovered, healthy, selected and persisted in real UI');
  assert(await evaluate(`${teamCard}?.getAttribute('aria-disabled') !== 'true'`), 'team preset composition is healthy: ' + await evaluate(`${teamCard}?.closest('li')?.innerText`));
  await until(`${teamCard} && !${teamCard}.disabled`, 'previous preset save and blank-session sync have finished');
  await evaluate(`${teamCard}.click(); true`);
  await until(`${teamCard}?.getAttribute('aria-pressed') === 'true'`, 'team preset selected for new tasks');
  assert(readFileSync(join(home, 'settings.yaml'), 'utf8').includes('qcoder-team'), 'team default is persisted');
  assert(await evaluate(`[...document.querySelectorAll('.Rq-35q_cardHead > *')].every(element => element.getBoundingClientRect().right <= element.closest('li').getBoundingClientRect().right)`), 'preset badges fit inside their cards');
  const teamShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(base, 'tests/team-preview.png'), Buffer.from(teamShot.data, 'base64'));
  await evaluate(`document.querySelector('.Ri3YFq_close').click(); true`);
  await until(`document.querySelector('button._3Yb3Sq_seat')?.textContent.includes('Команда QCoderI')`, 'blank conversation switched to team profile');
  console.log('PASS: packaged team profile discovered, healthy, selected and persisted in real UI');
  await clickText('Настройки');
  await until(`document.body.innerText.includes('Системный промпт')`, 'system prompt navigation');
  assert(await evaluate(`document.querySelector('.Ri3YFq_panel').getBoundingClientRect().width > 900`), 'settings dialog escapes sidebar and uses the viewport');
  await clickText('Системный промпт');
  await until(`document.querySelector('textarea') && !document.querySelector('textarea').disabled`, 'prompt field');
  const value = 'ПРОВЕРКА QCoderI: отвечай по-русски.\n{{literal}}';
  const setText = text => evaluate(`(() => { const input = document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)}); input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await setText(value);
  await until(`![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Сохранить').disabled`, 'save enabled');
  await clickText('Сохранить');
  await until(`document.body.innerText.includes('Сохранено. Начните новый диалог.')`, 'settings persisted');
  assert(readFileSync(join(home, 'settings.yaml'), 'utf8').includes('ПРОВЕРКА QCoderI'));
  const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(base, 'tests/settings-preview.png'), Buffer.from(screenshot.data, 'base64'));
  await clickText('Основные');
  await until(`document.querySelectorAll('.Q4vj7G_themeCube').length === 3`, 'theme choices');
  await evaluate(`document.querySelectorAll('.Q4vj7G_themeCube')[0].click(); true`);
  await until(`!document.body.hasAttribute('data-ds-dark-theme')`, 'light theme applied');
  const lightShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(base, 'tests/settings-light-preview.png'), Buffer.from(lightShot.data, 'base64'));
  await evaluate(`document.querySelector('.Ri3YFq_close').click(); true`);
  await clickText('Общение');
  await until(`document.querySelector('[data-qc-conversation="chat"] [contenteditable="true"]')`, 'ordinary chat uses the light theme');
  await pause(400);
  const lightChat = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(base, 'tests/chat-light-preview.png'), Buffer.from(lightChat.data, 'base64'));
  await clickText('Настройки');
  await until(`document.querySelectorAll('.Q4vj7G_themeCube').length === 3`, 'theme choices reopen');
  await evaluate(`document.querySelectorAll('.Q4vj7G_themeCube')[1].click(); true`);
  await until(`document.body.hasAttribute('data-ds-dark-theme')`, 'dark theme restored');
  await clickText('Системный промпт');
  await until(`document.querySelector('textarea')?.value === ${JSON.stringify(value)}`, 'saved value reloads');
  await clickText('Очистить');
  await clickText('Сохранить');
  await until(`document.body.innerText.includes('Сохранено. Начните новый диалог.')`, 'clear persisted');
  await evaluate(`document.querySelector('.Ri3YFq_close').click(); true`);
  await clickText('Общение');
  await until(`document.querySelector('[data-qc-conversation="chat"] [contenteditable="true"]')`, 'return from project to ordinary chat');
  await send('Emulation.setDeviceMetricsOverride', { width: 960, height: 640, deviceScaleFactor: 1, mobile: false });
  await pause(700);
  await until(`!document.querySelector('.pKYZ4q_fading')`, 'sidebar transition settles before compact screenshot');
  const compactGeometry = await evaluate(`['.V8U9sa_frame','.V8U9sa_centerCol','.QFBU2W_root','.QFBU2W_scrollBody','._5M8isa_hero','._5M8isa_card','.qc-quick-cards'].map(selector=>{const el=document.querySelector(selector);const box=el.getBoundingClientRect();return{selector,width:el.clientWidth,scroll:el.scrollWidth,left:box.left,right:box.right,cssWidth:getComputedStyle(el).width,minWidth:getComputedStyle(el).minWidth}})`);
  assert(compactGeometry.filter(item=>item.selector!=='.V8U9sa_frame').every(item=>item.scroll<=item.width+2 && item.right<=962), 'ordinary chat fits compact window: '+JSON.stringify(compactGeometry));
  const compactChat = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(base, 'tests/chat-compact-preview.png'), Buffer.from(compactChat.data, 'base64'));
  await send('Emulation.clearDeviceMetricsOverride');
  console.log('PASS: ordinary chat without project selection, editable draft, suggestions, mode switching and compact layout');
  await send('Page.navigate', { url:'dsh-app://shell/startup.html' });
  await until(`document.querySelector('.startup-emblem') && document.querySelector('#title')?.innerText.includes('Открываем ваше пространство')`, 'refined startup screen');
  assert(await evaluate(`window.dshDesktop.system===undefined`),'system bridge is exposed only to the owned application renderer');
  assert(await evaluate(`window.dshDesktop.quit===undefined`),'quit operation is unavailable to shell documents');
  await pause(500);
  const startupShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(base, 'tests/startup-preview.png'), Buffer.from(startupShot.data, 'base64'));
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert(await evaluate(`getComputedStyle(document.querySelector('#spinner'),'::after').animationName === 'none'`), 'startup respects reduced motion');
  }
  console.log(`PASS: Russian QCoderI boot in ${nativeWindow ? 'Rust/WebView2' : 'Electron'}`);
  console.log('Isolated smoke home:', home);
  const pendingClose = nativeWindow ? evaluate('window.dshDesktop.quit();true') : send('Browser.close');
  pendingClose.catch(() => {});
  await Promise.race([new Promise(r => child.once('exit', r)), pause(5000)]);
} catch (error) {
  writeFileSync(join(base, 'tests/smoke-diagnostics.log'), diagnostics);
  throw error;
} finally {
  await closeBrowser?.();
  socket?.close();
  if (child.exitCode === null) child.kill();
  await new Promise(resolve=>fixtureServer?fixtureServer.close(resolve):resolve());
}
