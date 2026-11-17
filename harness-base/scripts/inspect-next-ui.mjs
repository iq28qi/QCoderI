// CDP attaches ONLY to the disposable browser created by preview-next-ui.mjs.
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const base = resolve(fileURLToPath(new URL('..', import.meta.url)));
const info = JSON.parse(await readFile(join(base, 'tests/next-ui-preview.json'), 'utf8'));
assert(info.home.includes('tests\\.runtime\\ui-preview-') || info.home.includes('tests/.runtime/ui-preview-'));
const port = Number((await readFile(join(info.browserProfile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
const page = pages.find(page => page.url === info.url); assert(page, 'Isolated preview page required');
const watchdog = setTimeout(() => { console.error('Isolated UI inspection timed out'); process.exit(1); }, 60000);
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
let sequence = 0;
const pending = new Map(), requested = [], failed = [], errors = [];
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  const waiting = pending.get(message.id);
  if (waiting) { pending.delete(message.id); message.error ? waiting.reject(Error(JSON.stringify(message.error))) : waiting.done(message.result); }
  if (message.method === 'Network.requestWillBeSent') requested.push(message.params.request.url);
  if (message.method === 'Network.loadingFailed') failed.push({ id: message.params.requestId, error: message.params.errorText });
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
};
const send = (method, params = {}) => new Promise((done, reject) => {
  const id = ++sequence; pending.set(id, { done, reject }); socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const data = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (data.exceptionDetails) throw Error(JSON.stringify(data.exceptionDetails)); return data.result.value;
};
try {
  await send('Runtime.enable'); await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Network.setBlockedURLs', { urls: ['https://*'] });
  await send('Page.enable');
  const loaded = new Promise((done, reject) => {
    const previous = socket.onmessage;
    const timeout = setTimeout(() => reject(Error('Preview load timeout')), 45000);
    socket.onmessage = event => { previous(event); if (JSON.parse(event.data).method === 'Page.loadEventFired') { clearTimeout(timeout); done(); } };
  });
  await send('Page.reload', { ignoreCache: true }); await loaded;
  const ready = await evaluate(`new Promise(resolve=>{const started=performance.now();const check=()=>{if(document.querySelector('.qc-quick-card'))return resolve({ready:true,at:performance.now()});if(performance.now()-started>20000)return resolve({ready:false,at:performance.now()});setTimeout(check,50)};check()})`);
  assert(ready.ready, 'Preview UI did not mount');
  const iconPaint = await evaluate(`new Promise(resolve=>{const started=performance.now();const check=()=>{const images=[...document.images];if(images.every(x=>x.complete&&x.naturalWidth>0))return setTimeout(()=>resolve({ready:true,at:performance.now()}),50);if(performance.now()-started>5000)return resolve({ready:false,at:performance.now()});setTimeout(check,50)};check()})`);
  const snapshot = await evaluate(`({title:document.title,buttons:[...document.querySelectorAll('button')].slice(0,40).map(x=>({label:x.getAttribute('aria-label')||x.textContent.trim().slice(0,60),svg:!!x.querySelector('svg')})),images:[...document.images].map(x=>({src:x.src,loaded:x.complete&&x.naturalWidth>0})),navigation:performance.getEntriesByType('navigation').map(x=>({duration:x.duration,domContentLoaded:x.domContentLoadedEventEnd})),resources:performance.getEntriesByType('resource').map(x=>({name:x.name,duration:x.duration,bytes:x.transferSize})),icons:performance.getEntriesByType('resource').filter(x=>/iconify/.test(x.name)).length})`);
  const label = process.argv.includes('--after') ? 'after' : 'before';
  const glyphs = await evaluate(`([...document.querySelectorAll('svg.qc-sidebar-glyph, svg.qc-session-glyph')].map(svg=>{const href=svg.querySelector('use')?.getAttribute('href');const box=svg.getBBox();return {icon:svg.dataset.icon,href,exists:href?.startsWith('#')&&!!document.getElementById(href.slice(1)),width:box.width,height:box.height}}))`);
  if (label === 'after') {
    assert(glyphs.length >= 12 && glyphs.every(g=>g.exists&&g.width>0&&g.height>0), 'All shipped sidebar/session glyphs must be document-local and paint geometry');
    assert(!snapshot.resources.some(x=>x.name.includes('qcoderi-sidebar-glyphs.svg')), 'No external sprite fetch');
    assert(iconPaint.ready, 'All startup image elements loaded');
    assert.equal(errors.length, 0, 'No uncaught renderer exceptions');
  }
  const result = { label, glyphs, conditions: 'Separate Chrome/profile, warmed fixture host, cold browser cache, HTTPS blocked; not full native cold startup', ready, iconPaint, snapshot, externalRequests: requested.filter(url => !url.startsWith(new URL(info.url).origin) && !url.startsWith('data:') && !url.startsWith('blob:')), failed, errors };
  await writeFile(join(base, `tests/startup-isolated-${label}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ label, ready, iconPaint, resources: snapshot.resources.length, icons: snapshot.icons, externalRequests: result.externalRequests, failed: failed.length, errors }, null, 2));
  const startupState = await evaluate(`({inert:document.getElementById('root')?.inert,notice:/Уведомление о тестировании|Добавьте ключ API, чтобы начать|Internal Testing Notice|Add an API key to get started/.test(document.body.innerText)})`);
  assert.equal(startupState.inert, false, 'Fresh QCoderI shell is interactive');
  assert.equal(startupState.notice, false, 'No upstream onboarding without acknowledging/skipping it');
  console.log('PASS: fresh profile starts directly without upstream notice or forced provider');
  // Window screenshots are captured separately with desktop tools. CDP screenshot
  // can hang on a hidden desktop's compositor, so do not gate verification on it.
} finally { clearTimeout(watchdog); socket.close(); }
