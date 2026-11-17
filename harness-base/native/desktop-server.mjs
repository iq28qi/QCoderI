import { timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { cpus, freemem, totalmem } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { createUpdates } from './updates.mjs';
import { createStartupAssetHandler, enableStartupCompileCache } from '../source/dsh/qcoderi-startup-cache.mjs';

const [runtime, profile] = process.argv.slice(2);
const secret = process.env.QCODERI_WINDOW_CAPABILITY;
delete process.env.QCODERI_WINDOW_CAPABILITY;
if (!/^[a-f0-9]{64}$/.test(secret ?? '')) throw new Error('Missing native window credential');
const key = Buffer.from(secret);
const cookieName = 'qcoderi_window';
const sameKey = candidate => typeof candidate === 'string' && candidate.length === key.length &&
  Buffer.byteLength(candidate) === key.length && timingSafeEqual(key, Buffer.from(candidate));

const startupPhase = phase => process.stdout.write('QCODERI_BOOT ' + phase + '\n');
startupPhase('подготовка профиля');

try {
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }), { flag: 'wx' });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}

// Enable only before the dynamic host graph, never reuse boot/profile results.
const compileCache = enableStartupCompileCache(process.env.DSH_HOME);
if (compileCache?.directory) console.error('[startup] bytecode cache: ' + compileCache.directory);
const startupAssets = createStartupAssetHandler(join(runtime, 'node_modules/@deepseek-ai/dsh-web-frontend/dist'));
startupPhase('импорт движка');
const { runDesktopHost } = await import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js')));
const host = await runDesktopHost(runtime, profile, () => {}, { nativeWindow: true, onStartupPhase: startupPhase });
startupPhase('запуск локального сервера');
const installation = process.env.QCODERI_INSTALL_ROOT;
const updateResult = installation
  ? await readFile(join(installation, 'harness-base/update-result.txt'), 'utf8').catch(() => null)
  : null;
const updates = installation && createUpdates({
  configPath: join(installation, 'harness-base/update-channel.json'),
  stage: process.env.QCODERI_UPDATE_STAGE,
  currentVersion: process.env.QCODERI_NATIVE_VERSION,
  isBusy: () => host.isBusy(),
  launch: async (version, sha256) => {
    if (!host.reserveUpdate()) throw Error('Дождитесь завершения активных задач.');
    await host.flush();
    setTimeout(() => process.stdout.write('QCODERI_UPDATE ' + version + ' ' + sha256 + '\n'), 500).unref();
  },
});
const updateState = () => ({ ...updates?.state?.() ?? { phase: 'unconfigured' },
  ...(updateResult ? { previousError: updateResult } : {}) });
let input = '';
process.stdin.on('data', chunk => {
  input += chunk.toString('utf8');
  let end;
  while ((end = input.indexOf('\n')) !== -1) {
    const line = input.slice(0, end);
    input = input.slice(end + 1);
    if (line === 'QCODERI_INSTALLER_FAILED') {
      host.releaseUpdate();
      updates?.failed?.('Не удалось запустить установку. Проверьте доступ на запись в папку QCoderI.');
    }
  }
});
if (updates) {
  setInterval(() => updates.check(), 6 * 60 * 60 * 1000).unref();
  setTimeout(() => updates.check(), 1500).unref();
}
let authority;
const server = createServer(async (incoming, outgoing) => {
  const origin = 'http://' + authority;
  const requestUrl = incoming.url;
  if (incoming.headers.host !== authority || !requestUrl?.startsWith('/') ||
      requestUrl.startsWith('//') || requestUrl.includes('\\') ||
      (incoming.headers.origin && incoming.headers.origin !== origin) ||
      incoming.headers['sec-fetch-site'] === 'cross-site') {
    outgoing.writeHead(403).end();
    return;
  }
  const initial = incoming.method === 'GET' && requestUrl === '/index.html' &&
    sameKey(incoming.headers['x-qcoderi-window']);
  const cookies = (incoming.headers.cookie ?? '').split(';').map(part => part.trim());
  if (!initial && !cookies.some(cookie => cookie.startsWith(cookieName + '=') && sameKey(cookie.slice(cookieName.length + 1)))) {
    outgoing.writeHead(403).end();
    return;
  }
  const abort = new AbortController();
  outgoing.once('close', () => {
    if (!outgoing.writableFinished) abort.abort();
  });
  try {
    const headers = new Headers(incoming.headers);
    headers.delete('x-qcoderi-window');
    headers.delete('cookie');
    const method = incoming.method;
    const request = new Request(origin + requestUrl, {
      method, headers, signal: abort.signal,
      ...(method === 'GET' || method === 'HEAD' ? {} : { body: Readable.toWeb(incoming), duplex: 'half' }),
    });
    let response;
    if (requestUrl === '/.qcoderi/speech' && method === 'POST') response = await synthesize(request);
    else if (requestUrl === '/.qcoderi/system' && method === 'GET') response = Response.json(systemSnapshot());
    else if (requestUrl === '/.qcoderi/update' && method === 'GET') response = Response.json(updateState(), { headers: { 'Cache-Control': 'no-store' } });
    else if (updates && requestUrl === '/.qcoderi/update/check' && method === 'POST') {
      await updates.check();
      response = Response.json(updateState());
    } else if (updates && requestUrl === '/.qcoderi/update/install' && method === 'POST') {
      void updates.install();
      response = Response.json(updateState(), { status: 202 });
    }
    else response = await startupAssets.fetch(request) ?? await host.fetchRequest(request);
    const responseHeaders = Object.fromEntries(response.headers);
    if (initial) {
      responseHeaders['set-cookie'] = `${cookieName}=${secret}; Path=/; HttpOnly; SameSite=Strict`;
      responseHeaders['cache-control'] = 'no-store';
    }
    if (requestUrl === '/index.html' || requestUrl === '/') {
      responseHeaders['content-security-policy'] = [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "media-src 'self' data: blob: https:",
        "font-src 'self' data: https:",
        "connect-src 'self' https:",
        "frame-src 'self' data: blob:",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join('; ');
      responseHeaders['referrer-policy'] = 'no-referrer';
    }
    outgoing.writeHead(response.status, responseHeaders);
    if (!response.body || method === 'HEAD') {
      await response.body?.cancel();
      outgoing.end();
    } else {
      await pipeline(Readable.fromWeb(response.body), outgoing, { signal: abort.signal });
    }
  } catch (error) {
    if (abort.signal.aborted) return;
    console.error('Native request failed:', error.message);
    if (!outgoing.headersSent) outgoing.writeHead(500).end();
    else outgoing.destroy();
  }
});

const speechCommand = Buffer.from(`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Speech
$text = [Console]::In.ReadToEnd()
$speech = [System.Speech.Synthesis.SpeechSynthesizer]::new()
$output = [System.IO.MemoryStream]::new()
try {
  $language = if ($text -match '[А-Яа-яЁё]') { 'ru' } else { 'en' }
  $voice = $speech.GetInstalledVoices() | Where-Object {
    $_.Enabled -and $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq $language
  } | Select-Object -First 1
  if ($voice) { $speech.SelectVoice($voice.VoiceInfo.Name) }
  $speech.SetOutputToWaveStream($output)
  $speech.Speak($text)
  $speech.SetOutputToNull()
  $bytes = $output.ToArray()
  [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
} finally {
  $speech.Dispose()
  $output.Dispose()
}
`, 'utf16le').toString('base64');
let lastCpu;
let sampledAt = 0;
let systemSample;
function systemSnapshot() {
  const now = Date.now();
  if (systemSample && now - sampledAt < 1500) return systemSample;
  const current = cpus().reduce((sample, core) => ({
    idle: sample.idle + core.times.idle,
    total: sample.total + Object.values(core.times).reduce((sum, value) => sum + value, 0),
  }), { idle: 0, total: 0 });
  const elapsed = lastCpu && current.total - lastCpu.total;
  const cpu = elapsed > 0 ? 100 * (1 - (current.idle - lastCpu.idle) / elapsed) : null;
  const memory = totalmem();
  sampledAt = now;
  lastCpu = current;
  return systemSample = { cpu, ram: memory > 0 ? 100 * (1 - freemem() / memory) : null, gpu: null, phase: 'ready' };
}

let speechRunning = false;
async function synthesize(request) {
  const input = [];
  let length = 0;
  for await (const chunk of request.body ?? []) {
    length += chunk.byteLength;
    if (length > 48000) return new Response(null, { status: 413 });
    input.push(chunk);
  }
  const text = Buffer.concat(input).toString('utf8').trim();
  if (!text || [...text].length > 8000) return new Response(null, { status: 400 });
  if (speechRunning) return new Response(null, { status: 429 });
  speechRunning = true;
  try {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30000)]);
    const child = spawn(join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', speechCommand], { windowsHide: true, signal });
    const exit = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    child.stdin.on('error', () => {});
    child.stderr.resume();
    child.stdin.end(text, 'utf8');
    const wave = (async () => {
      const chunks = [];
      for await (const chunk of child.stdout) chunks.push(chunk);
      return Buffer.concat(chunks);
    })();
    const [code, audio] = await Promise.all([exit, wave]);
    if (code !== 0 || audio.toString('ascii', 0, 4) !== 'RIFF') return new Response(null, { status: 503 });
    return new Response(audio, { headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' } });
  } finally {
    speechRunning = false;
  }
}

const portFile = join(process.env.DSH_HOME, 'webview-port');
const previousPort = Number(await readFile(portFile, 'utf8').catch(() => ''));
function listen(port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}
try {
  await listen(Number.isInteger(previousPort) && previousPort >= 1024 && previousPort <= 65535 ? previousPort : 0);
} catch (error) {
  if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error;
  await listen(0);
}
authority = '127.0.0.1:' + server.address().port;
await writeFile(portFile, String(server.address().port));
process.stdout.write('QCODERI_READY ' + server.address().port + '\n');
process.stdin.resume();
process.stdin.once('end', async () => {
  server.close();
  server.closeAllConnections();
  try { await host.dispose(); }
  finally { process.exit(); }
});
