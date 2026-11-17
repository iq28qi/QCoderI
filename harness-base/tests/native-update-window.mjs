// End-to-end update through the actual WebView2 window. All writes use a disposable installation.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const [oldExecutable, releaseDirectory] = process.argv.slice(2).map(file => resolve(file));
assert(oldExecutable && releaseDirectory, 'Pass the old executable and a signed fixture release directory');
const base = fileURLToPath(new URL('..', import.meta.url));
const root = await mkdtemp(join(base, 'tests/.runtime/update-installation-'));
const home = join(root, 'profile');
const manifest = JSON.parse(await readFile(join(releaseDirectory, 'latest.json'), 'utf8'));
const server = createServer(async (request, response) => {
  const filename = request.url === '/latest.json' ? 'latest.json' : request.url === '/' + manifest.file ? manifest.file : null;
  if (!filename) return response.writeHead(404).end();
  const file = join(releaseDirectory, filename);
  response.writeHead(200, { 'Content-Length': (await stat(file)).size });
  createReadStream(file).pipe(response);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
let child;
let socket;
let currentPort;
const freePort = createServer();
freePort.listen(0, '127.0.0.1');
await once(freePort, 'listening');
const debugPort = freePort.address().port;
freePort.close();

async function waitFor(predicate, reason, timeout = 40000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const value = await predicate(); if (value) return value; } catch {}
    await pause(200);
  }
  throw Error(reason);
}
try {
  for (const relative of ['source/dsh', 'app/resources/runtime', 'native/desktop-server.mjs', 'native/updates.mjs']) {
    const destination = join(root, 'harness-base', relative);
    await mkdir(dirname(destination), { recursive: true });
    const source = join(base, relative);
    if ((await stat(source)).isDirectory()) await symlink(source, destination, 'junction');
    else await cp(source, destination);
  }
  await mkdir(home);
  const marker = join(home, 'verification.txt');
  await writeFile(marker, 'profile preserved');
  await writeFile(join(root, 'harness-base/update-channel.json'), JSON.stringify({
    url: `http://127.0.0.1:${server.address().port}/latest.json`,
    publicKey: await readFile(join(releaseDirectory, 'fixture-public.pem'), 'utf8'),
  }));
  const executable = join(root, 'QCoderI.exe');
  await cp(oldExecutable, executable);
  child = spawn(executable, [], { env: { ...process.env, DSH_HOME: home,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + debugPort }, stdio:'ignore' });

  async function connect() {
    const page = await waitFor(async () => (await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(r => r.json()))
      .find(p => p.url.endsWith('/index.html')), 'WebView2 page did not open', 280000);
    currentPort = new URL(page.url).port;
    const connection = new WebSocket(page.webSocketDebuggerUrl);
    await once(connection, 'open');
    socket = connection;
    let id = 0;
    return expression => new Promise((resolve, reject) => {
      const next = ++id;
      const handle = event => {
        const message = JSON.parse(event.data);
        if (message.id !== next) return;
        connection.removeEventListener('message', handle);
        if (message.error || message.result.exceptionDetails) reject(Error(JSON.stringify(message)));
        else resolve(message.result.result.value);
      };
      connection.addEventListener('message', handle);
      connection.send(JSON.stringify({ id: next, method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  }
  let evaluate = await connect();
  await waitFor(() => evaluate(`window.dshDesktop?.updates?.request().then(s=>s.phase==='available')`),
    'Automatic check did not detect the signed fixture');
  await waitFor(() => evaluate(`!!document.querySelector('.qc-sidebar-utilities button:nth-child(2)')`), 'Notification button missing');
  await evaluate(`document.querySelector('.qc-sidebar-utilities button:nth-child(2)').click();true`);
  await waitFor(() => evaluate(`!!document.querySelector('[data-update-phase="available"]')`), 'Update was not shown in the sidebar');
  await evaluate(`document.querySelector('[data-update-phase="available"] button').click();true`);
  await waitFor(() => child.exitCode !== null, 'The old window did not close for installation', 125000);
  const oldPageConnection = socket;
  socket.close();
  await waitFor(() => oldPageConnection.readyState === WebSocket.CLOSED, 'Old WebView did not shut down');
  evaluate = await connect();
  await waitFor(() => evaluate(`window.dshDesktop?.updates?.request().then(s=>s.currentVersion===${JSON.stringify(manifest.version)})`),
    'Updated window did not report the new version');
  assert.equal(await readFile(marker,'utf8'),'profile preserved');
  assert((await stat(join(root,'.qcoderi-releases',manifest.version,'harness-base/native/updates.mjs'))).isFile());
  await waitFor(async () => {
    const stages = await readdir(join(root,'.qcoderi-update'),{withFileTypes:true});
    const backups = await Promise.all(stages.filter(entry=>entry.isDirectory()).map(entry =>
      stat(join(root,'.qcoderi-update',entry.name,'previous.exe')).then(()=>true,()=>false)));
    return !backups.some(Boolean);
  },'The installer did not confirm startup and finish the transaction',20000);
  assert.equal(await readFile(join(root,'harness-base/update-result.txt'),'utf8').catch(error=>{
    if(error.code!=='ENOENT')throw error;
    return null;
  }),null);
  console.log('PASS: signed update found in background, installed from the sidebar and restarted with the same profile');
  await evaluate(`window.dshDesktop.quit();true`);
} finally {
  socket?.close();
  if (child?.exitCode === null) child.kill();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  console.log('Isolated installation:', root, 'engine port:', currentPort);
}
