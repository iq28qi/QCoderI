// Inspect only the disposable preview created by preview-next-ui.mjs.
// Never attaches to QCoderI.exe, writes credentials or calls a provider.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
const base = resolve(fileURLToPath(new URL('..', import.meta.url)));
const info = JSON.parse(await readFile(join(base, 'tests/next-ui-preview.json'), 'utf8'));
assert(info.home.includes('tests\\.runtime\\ui-preview-') || info.home.includes('tests/.runtime/ui-preview-'));
const port = Number((await readFile(join(info.browserProfile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
const page = pages.find(item => item.url === info.url);
assert(page, 'Disposable preview required');
const watchdog = setTimeout(() => { console.error('Disposable settings inspection timed out'); process.exit(1); }, 30000);
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject; });
let sequence = 0;
const pending = new Map(), errors = [], externalRequests = [];
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (pending.has(message.id)) {
    const { done, reject } = pending.get(message.id); pending.delete(message.id);
    message.error ? reject(Error(JSON.stringify(message.error))) : done(message.result);
  }
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
  if (message.method === 'Network.requestWillBeSent' && /^https?:/.test(message.params.request.url) && new URL(message.params.request.url).origin !== new URL(info.url).origin) externalRequests.push(message.params.request.url);
};
const send = (method, params = {}) => new Promise((done, reject) => {
  const id = ++sequence; pending.set(id, { done, reject }); socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.text);
  return result.result.value;
};
const waitFor = expression => evaluate(`new Promise((resolve,reject)=>{const start=Date.now();const tick=()=>{try{if(${expression})return resolve(true);if(Date.now()-start>12000)return reject(Error('UI state timeout'));setTimeout(tick,50)}catch(e){reject(e)}};tick()})`);
try {
  await send('Runtime.enable'); await send('Network.enable');
  await send('Network.setBlockedURLs', { urls: ['https://*', 'http://*/*/models'] });
  assert(await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Модели');if(!b)return false;b.click();return true})()`));
  await waitFor(`document.body.innerText.includes('Добавить провайдера') || document.body.innerText.includes('Add provider')`);
  const models = await evaluate(`({title:document.body.innerText.includes('Модели'),buttons:[...document.querySelectorAll('button')].map(b=>({label:(b.getAttribute('aria-label')||b.textContent).trim(),enabled:!b.disabled})).filter(b=>/провайдер|provider/i.test(b.label)),inert:document.getElementById('root')?.inert})`);
  assert.equal(models.inert, false);
  const opened = await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/своего провайдера|свой провайдер|custom provider/i.test(x.textContent));if(!b||b.disabled)return false;b.click();return true})()`);
  assert(opened, 'Custom-provider draft remains accessible');
  await waitFor(`!!document.querySelector('input[type="password"]')`);
  const editor = await evaluate(`({fields:[...document.querySelectorAll('input,select')].map(e=>({type:e.type,label:e.getAttribute('aria-label'),enabled:!e.disabled})),buttons:[...document.querySelectorAll('button')].map(e=>e.textContent.trim()).filter(x=>/Отмена|Cancel|Сохранить|Save/.test(x))})`);
  assert(editor.fields.some(field => field.type === 'password' && field.enabled), 'Credential editor available');
  assert(editor.fields.some(field => /URL|адрес|endpoint/i.test(field.label ?? '') && field.enabled), 'Endpoint editor available');
  assert.equal(errors.length, 0); assert.equal(externalRequests.length, 0);
  const result = { preview:info.url, models, editor, errors, externalRequests, writes:false, providerCalls:false, conditions:'Disposable empty profile; normal Models -> custom provider draft; not saved; real DOM; no live app reload' };
  await writeFile(join(base,'tests/provider-neutral-models-ui.json'),JSON.stringify(result,null,2));
  console.log('PASS: normal Models navigation, custom-provider draft and key/endpoint editors work after onboarding deletion; no provider request or credential write');
} finally { clearTimeout(watchdog); socket.close(); }
