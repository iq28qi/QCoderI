// A separate native HTTP host + empty profile for visual review; never launches
// QCoderI.exe, touches live data, reloads its UI or contacts model providers.
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const base = resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = join(base, 'tests/.runtime');
await mkdir(output, { recursive: true });
const home = await mkdtemp(join(output, 'ui-preview-'));
const profile = join(home, 'profiles/desktop');
await mkdir(profile, { recursive: true });
await writeFile(join(home, 'settings.yaml'), 'locale:\n  language: ru-RU\n');
const secret = randomBytes(32).toString('hex');
const env = { ...process.env, DSH_HOME: home, QCODERI_WINDOW_CAPABILITY: secret };
for (const name of ['QCODERI_INSTALL_ROOT', 'QCODERI_UPDATE_STAGE', 'NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) delete env[name];
const host = spawn(process.execPath, [join(base, 'native/desktop-server.mjs'), join(base, 'source/dsh'), profile],
  { cwd: profile, env, windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
const ready = await new Promise((done, reject) => {
  const timeout = setTimeout(() => reject(Error('Preview host timed out')), 60000);
  let text = '';
  host.stdout.on('data', data => {
    text += data;
    const match = /QCODERI_READY (\d+)/.exec(text);
    if (match) { clearTimeout(timeout); done(Number(match[1])); }
  });
  host.once('error', reject);
  host.once('exit', code => { clearTimeout(timeout); reject(Error('Preview host exited: ' + code)); });
});
const native = await readFile(join(base, 'native/window.js'), 'utf8');
const proxy = createServer((request, response) => {
  // The credential belongs ONLY to this disposable host, never the working app.
  const headers = { ...request.headers, host: `127.0.0.1:${ready}` };
  if (headers.origin) headers.origin = `http://127.0.0.1:${ready}`;
  if (request.url === '/index.html' && request.method === 'GET') headers['x-qcoderi-window'] = secret;
  const upstream = httpRequest({ host: '127.0.0.1', port: ready, path: request.url, method: request.method, headers }, result => {
    if (request.url === '/index.html' && request.method === 'GET' && result.statusCode === 200) {
      const parts = [];
      result.on('data', part => parts.push(part));
      result.on('end', () => {
        const body = Buffer.concat(parts).toString('utf8').replace('<head>', '<head><script>window.ipc={postMessage(){}};' + native + '</script>');
        const headers = { ...result.headers }; delete headers['content-length']; delete headers['transfer-encoding'];
        response.writeHead(200, headers); response.end(body);
      });
    } else { response.writeHead(result.statusCode, result.headers); result.pipe(response); }
  });
  upstream.on('error', error => { if (!response.headersSent) response.writeHead(502); response.end(error.message); });
  request.pipe(upstream);
});
await new Promise(done => proxy.listen(0, '127.0.0.1', done));
const info = { url: `http://127.0.0.1:${proxy.address().port}/index.html`, home, browserProfile: join(home, 'browser'), pid: process.pid };
await writeFile(join(base, 'tests/next-ui-preview.json'), JSON.stringify(info, null, 2));
console.log(JSON.stringify(info, null, 2));
let closing = false;
async function close() {
  if (closing) return; closing = true;
  proxy.closeAllConnections(); proxy.close(); host.stdin.end();
  const fallback = setTimeout(() => host.kill(), 5000); fallback.unref();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, close);
const lifetime = setTimeout(close, 20 * 60 * 1000); lifetime.unref();
