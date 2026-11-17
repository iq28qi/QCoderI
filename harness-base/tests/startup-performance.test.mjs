import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { createStartupAssetHandler, enableStartupCompileCache, isStartupAssetPath } from '../native/startup-cache.mjs';
import { createStartupPreview, dist, startupIconHTML } from './startup-preview.mjs';

const base = new URL('../', import.meta.url);
const text = path => readFile(new URL(path, base), 'utf8');
const request = (path, options) => new Request('http://127.0.0.1:12345' + path, options);

test('small sprite is present before the React mount and contains every shipped glyph', async () => {
  const html = await text('source/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html');
  const source = await text('assets/qcoderi-sidebar-glyphs.svg');
  const sprite = html.match(/<!-- QCODERI_STARTUP_ICONS -->[\s\S]*?<!-- \/QCODERI_STARTUP_ICONS -->/)?.[0];
  assert.ok(sprite);
  assert.ok(html.indexOf(sprite) < html.indexOf('<div id="root">'));
  assert.ok(Buffer.byteLength(sprite) < 8 * 1024, 'Do not eagerly import an icon catalog');
  const ids = [...source.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  for (const id of ids) assert.ok(sprite.includes(`id="qcoderi-glyph-${id}"`), id);
  for (const [, id] of sprite.matchAll(/url\(#([^)]+)\)/g)) assert.ok(sprite.includes(`id="${id}"`), id);
  assert.doesNotMatch(sprite, /<script|<image|\bon\w+=|\bhref=/i);
  assert.match(sprite, /stroke="currentColor"/);
  assert.doesNotMatch(sprite, /display:none/); // Keep SVG gradients usable in Chromium.
  const fixture = await startupIconHTML();
  assert.doesNotMatch(fixture, /(?:src|href)="https?:/);
});

test('source-owned sidebar and session components use only document-local glyphs', async () => {
  for (const path of ['assets/studio-sidebar.js', 'assets/studio-session-glyph.js']) {
    const source = await text(path);
    assert.match(source, /href:'#qcoderi-glyph-/);
    assert.doesNotMatch(source, /qcoderi-sidebar-glyphs\.svg#|iconify|jsdelivr|unpkg/);
  }
});

test('asset routing excludes credentials, profile, HTML, plugins, source maps and unknown paths', () => {
  for (const path of ['/assets/index-DZAlNKh9.js', '/assets/fonts/KaTeX.woff2', '/qcoderi-sidebar-glyphs.svg', '/qcoderi-moonlight.css']) assert.equal(isStartupAssetPath(path), true, path);
  for (const path of ['/index.html', '/', '/api/settings.js', '/plugins/client.js', '/data/profile.json', '/assets/a.js.map', '/assets/../secret.js', '/assets/%2e%2e/secret.js', '/qcoderi-media/image.png', '/other.svg']) assert.equal(isStartupAssetPath(path), false, path);
});

test('cold GET, conditional GET and HEAD use correct MIME and content validators', async () => {
  const handler = createStartupAssetHandler(dist);
  const cold = await handler.fetch(request('/qcoderi-sidebar-glyphs.svg'));
  assert.equal(cold.status, 200);
  assert.equal(cold.headers.get('content-type'), 'image/svg+xml');
  assert.equal(cold.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(cold.headers.get('cache-control'), 'private, max-age=0, must-revalidate');
  const body = await cold.text();
  const etag = cold.headers.get('etag');
  const warm = await handler.fetch(request('/qcoderi-sidebar-glyphs.svg', { headers: { 'if-none-match': `"old", W/${etag}` } }));
  assert.equal(warm.status, 304);
  assert.equal(await warm.text(), '');
  assert.equal(warm.headers.get('etag'), etag);
  assert.equal(handler.snapshot().entries, 1);
  assert.equal(handler.snapshot().bytes, Buffer.byteLength(body));
  const head = await handler.fetch(request('/qcoderi-sidebar-glyphs.svg', { method: 'HEAD' }));
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(body)));
  assert.equal(await head.text(), '');
  const stale = await handler.fetch(request('/qcoderi-sidebar-glyphs.svg', { headers: { 'if-none-match': '"stale"' } }));
  assert.equal(stale.status, 200);
  assert.equal(await stale.text(), body);
});

test('missing icons are a real 404, not boot HTML; dynamic requests bypass cache', async () => {
  const handler = createStartupAssetHandler(dist);
  const missing = await handler.fetch(request('/qcoderi-does-not-exist.svg'));
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('cache-control'), 'no-store');
  assert.equal(await missing.text(), '');
  assert.equal((await handler.fetch(request('/qcoderi-app.png', { method: 'POST' }))).status, 405);
  for (const path of ['/index.html', '/api/settings', '/plugins/??a/client.js&rev=123', '/.qcoderi/update']) assert.equal(await handler.fetch(request(path)), null);
  assert.equal((await handler.fetch(request('/qcoderi-%ZZ.svg'))).status, 400);
});

test('asset cache is bounded, coalesces concurrent reads and does not preload art', async () => {
  const handler = createStartupAssetHandler(dist, { maxEntries: 1, maxBytes: 8000 });
  assert.deepEqual(handler.snapshot(), { entries: 0, bytes: 0, pending: 0 });
  const results = await Promise.all(Array.from({ length: 8 }, () => handler.fetch(request('/qcoderi-sidebar-glyphs.svg'))));
  assert.equal(new Set(results.map(response => response.headers.get('etag'))).size, 1);
  assert.equal(handler.snapshot().entries, 1);
  await handler.fetch(request('/qcoderi-card-moon.svg'));
  assert.equal(handler.snapshot().entries, 1);
  assert.ok(handler.snapshot().bytes <= 8000);
  const noCache = createStartupAssetHandler(dist, { maxBytes: 0 });
  assert.equal((await noCache.fetch(request('/qcoderi-sidebar-glyphs.svg'))).status, 200);
  assert.deepEqual(noCache.snapshot(), { entries: 0, bytes: 0, pending: 0 });
});

test('edited assets invalidate old validators, same-size changes and symlinks cannot leak cached bytes', async () => {
  const root = resolve('startup-test-root');
  let body = Buffer.from('first');
  let revision = 1n;
  let reads = 0;
  let escaped = false;
  const handler = createStartupAssetHandler(root, { files: {
    realpath: async path => path === root ? root : escaped ? resolve(root, '../outside.svg') : path,
    stat: async () => ({ isFile: () => true, dev: 1n, ino: 1n, size: BigInt(body.length), mtimeNs: revision, ctimeNs: revision }),
    readFile: async () => { reads++; return body; },
  } });
  const first = await handler.fetch(request('/qcoderi-test.svg'));
  assert.equal(await first.text(), 'first');
  const etag = first.headers.get('etag');
  const warm = await handler.fetch(request('/qcoderi-test.svg', { headers: { 'if-none-match': etag } }));
  assert.equal(warm.status, 304);
  assert.equal(reads, 1, 'A warm revalidation does not reread file bytes');
  body = Buffer.from('newer'); revision++;
  const changed = await handler.fetch(request('/qcoderi-test.svg', { headers: { 'if-none-match': etag } }));
  assert.equal(changed.status, 200);
  assert.equal(await changed.text(), 'newer');
  assert.notEqual(changed.headers.get('etag'), etag);
  assert.equal(reads, 2);
  escaped = true;
  assert.equal((await handler.fetch(request('/qcoderi-test.svg'))).status, 403);
  assert.equal(reads, 2, 'Symlink targets outside dist are not read, even with a cached entry');
});

test('loopback fixture verifies 304 eliminates response bytes without booting a host', async t => {
  const fixture = await createStartupPreview();
  t.after(() => fixture.close());
  const cold = await fetch(fixture.url + '/qcoderi-sidebar-glyphs.svg');
  const coldBytes = (await cold.arrayBuffer()).byteLength;
  const warm = await fetch(fixture.url + '/qcoderi-sidebar-glyphs.svg', { headers: { 'if-none-match': cold.headers.get('etag') } });
  const warmBytes = (await warm.arrayBuffer()).byteLength;
  assert.equal(warm.status, 304);
  assert.equal(warmBytes, 0);
  assert.ok(coldBytes > 0);
  t.diagnostic(`Isolated HTTP response bodies: cold=${coldBytes} bytes, revalidated=${warmBytes} bytes; not a startup wall-clock benchmark.`);
});

test('native authorization, CSP, injected profile/theme and failure reporting remain on the critical path', async () => {
  const source = await text('native/desktop-server.mjs');
  assert.ok(source.indexOf('sameKey(cookie.slice') < source.indexOf('startupAssets.fetch(request)'));
  assert.match(source, /incoming\.headers\.host !== authority/);
  assert.match(source, /incoming\.headers\['sec-fetch-site'\] === 'cross-site'/);
  assert.match(source, /HttpOnly; SameSite=Strict/);
  assert.match(source, /responseHeaders\['cache-control'\] = 'no-store'/);
  for (const policy of ["default-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) assert.ok(source.includes(policy));
  assert.match(source, /await host\.fetchRequest\(request\)/);
  assert.match(source, /console\.error\('Native request failed:'/);
  assert.match(source, /outgoing\.writeHead\(500\)/);
  assert.ok(source.indexOf('enableStartupCompileCache(process.env.DSH_HOME)') < source.indexOf('const { runDesktopHost } = await import'));
  const frontend = await text('source/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-DZAlNKh9.js');
  assert.match(frontend, /await globalThis\.__DSH_BOOT_READY__\?\.promise/);
  assert.match(frontend, /this\.page\.fail\(t instanceof Error\?t\.message:String\(t\)\)/);
  const rust = await text('native/src/main.rs');
  assert.match(rust, /ProfileLock::acquire/);
  assert.match(rust, /STARTUP_PHASE_TIMEOUT: Duration = Duration::from_secs\(90\)/);
  assert.match(rust, /STARTUP_TOTAL_TIMEOUT: Duration = Duration::from_secs\(180\)/);
  assert.match(rust, /host\.0\.try_wait\(\)/);
  assert.match(rust, /StartupEvent::Closed/);
  assert.match(source, /onStartupPhase: startupPhase/);
  const updater = await text('native/src/update.rs');
  assert.match(updater, /crate::STARTUP_TOTAL_TIMEOUT \+ Duration::from_secs\(60\)/);
});

test('native host startup stages are applied reproducibly to the normal profile boot', async () => {
  const host = await text('source/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js');
  assert.match(host, /onStartupPhase\?\.\("разрешение зависимостей профиля"\)/);
  assert.match(host, /onStartupPhase\?\.\("загрузка модулей и сервисов"\)/);
  assert.match(host, /onStartupPhase\?\.\("подготовка интерфейса"\)/);
  const check=spawnSync('python',['-B','-c',`import runpy\nfrom pathlib import Path\np=Path('harness-base/source/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js')\nbefore=p.read_bytes()\nrunpy.run_path('harness-base/scripts/optimize-native-startup.py')['apply']()\nassert p.read_bytes()==before\n`],{cwd:fileURLToPath(new URL('../../',import.meta.url)),windowsHide:true});
  assert.ifError(check.error);
  assert.equal(check.status,0,check.stderr?.toString());
});

test('actual native request callback rejects unauthenticated/cross-origin icon requests before cache access', async () => {
  const source = await text('native/desktop-server.mjs');
  const start = source.indexOf('const server = createServer(');
  const end = source.indexOf('\nconst speechCommand', start);
  let callback, assetCalls = 0, hostCalls = 0;
  const secret = 'fixture-credential';
  vm.runInNewContext(source.slice(start, end), {
    createServer(fn) { callback = fn; }, authority: '127.0.0.1:12345', secret,
    cookieName: 'qcoderi_window', sameKey: candidate => candidate === secret,
    Headers, Request, Response, AbortController, console,
    startupAssets: { fetch: async request => { assetCalls++; return request.url.endsWith('.svg') ? new Response(null) : null; } },
    host: { fetchRequest: async () => { hostCalls++; return new Response(null); } },
    updates: null,
  });
  async function call(url, headers = {}, method = 'GET') {
    const result = { status: undefined, headers: undefined, ended: false,
      once() {}, writeHead(status, headers) { this.status = status; this.headers = headers; return this; },
      end() { this.ended = true; }, destroy() {} };
    await callback({ url, method, headers: { host: '127.0.0.1:12345', ...headers } }, result);
    return result;
  }
  const cookie = 'qcoderi_window=' + secret;
  assert.equal((await call('/qcoderi-test.svg')).status, 403);
  assert.equal((await call('/qcoderi-test.svg', { cookie, origin: 'https://external.invalid' })).status, 403);
  assert.equal((await call('/qcoderi-test.svg', { cookie, host: 'external.invalid' })).status, 403);
  assert.equal((await call('/qcoderi-test.svg', { cookie, 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal(assetCalls, 0);
  assert.equal((await call('/qcoderi-test.svg', { cookie })).status, 200);
  assert.equal(assetCalls, 1);
  const index = await call('/index.html', { 'x-qcoderi-window': secret });
  assert.equal(index.status, 200);
  assert.equal(index.headers['cache-control'], 'no-store');
  assert.match(index.headers['set-cookie'], /HttpOnly; SameSite=Strict/);
  assert.match(index.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(hostCalls, 1, 'Authenticated HTML still comes from fresh host injection');
});

test('bytecode cache is optional and never changes boot/profile resolution on failure', () => {
  let calls = 0;
  assert.equal(enableStartupCompileCache(undefined, () => { calls++; }), undefined);
  assert.equal(calls, 0);
  assert.equal(enableStartupCompileCache('test-home', () => { throw new Error('read-only'); }), undefined);
  assert.deepEqual(enableStartupCompileCache('test-home', path => {
    assert.match(path, /test-home[\\/]cache[\\/]node-compile$/);
    return { status: 3, message: 'disabled' };
  }, null), { status: 3, message: 'disabled' });
});

test('Windows bytecode cache prefers the local system drive and falls back for unavailable folders', () => {
  const paths = [];
  const success = { status: 1 };
  assert.equal(enableStartupCompileCache('portable-home', path => {
    paths.push(path);
    return paths.length === 1 ? { status: 0 } : success;
  }, 'local-data'), success);
  assert.match(paths[0], /local-data[\\/]QCoderI[\\/]cache[\\/]node-compile$/);
  assert.match(paths[1], /portable-home[\\/]cache[\\/]node-compile$/);
  let calls = 0;
  assert.equal(enableStartupCompileCache('portable-home', () => {
    if (++calls === 1) throw Error('local cache is read-only');
    return success;
  }, 'local-data'), success);
  assert.equal(calls, 2);
  calls = 0;
  assert.deepEqual(enableStartupCompileCache('portable-home', () => {
    calls++;
    return { status: 3 };
  }, 'local-data'), { status: 3 });
  assert.equal(calls, 1, 'explicit compile-cache disabling is respected');
});

test('plugin transport snapshots bytes once and preserves HEAD and failure responses', async () => {
  const source = await text('source/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js');
  const start = source.indexOf('\tasync fetchBundle(request) {');
  const end = source.indexOf('\n\t}', start) + '\n\t}'.length;
  assert.ok(start > 0 && end > start);
  const method = source.slice(start, end).replace('async fetchBundle(request)', 'async function fetchBundle(request)');
  assert.match(method, /QCODERI_BUNDLE_RESPONSE/);
  assert.doesNotMatch(method, /Uint8Array\.from/);
  const fetchBundle = vm.runInNewContext('(' + method + ')', { Response });
  const body = Buffer.from('startup plugin');
  let status = 200;
  const calls = [];
  const host = { bundleResource: async (method, url) => {
    calls.push({ method, url });
    return { status, headers: { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=31536000, immutable' },
      ...(method === 'GET' && status === 200 ? { body } : {}) };
  } };
  const response = await fetchBundle.call(host, { method: 'GET', url: 'http://local/plugins/??bundle&rev=current' });
  body.fill(120);
  assert.equal(await response.text(), 'startup plugin', 'Response owns an independent snapshot');
  assert.equal(response.headers.get('content-type'), 'text/javascript');
  assert.match(response.headers.get('cache-control'), /immutable/);
  assert.equal(calls[0].url, 'http://local/plugins/??bundle&rev=current');
  const head = await fetchBundle.call(host, { method: 'HEAD', url: 'http://local/plugins/??bundle&rev=current' });
  assert.equal(await head.text(), '');
  status = 404;
  const missing = await fetchBundle.call(host, { method: 'GET', url: 'http://local/plugins/??bundle&rev=old' });
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), '');
});

test('generator is reproducible and rejects remote/active SVG without modifying source', () => {
  // Read-only Python check: no full build, no imports that write __pycache__, no user profile.
  const program = `import runpy\nfrom pathlib import Path\np=runpy.run_path('harness-base/scripts/optimize-startup.py')\nb=Path('harness-base')\ns=p['inline_sprite']((b/'assets/qcoderi-sidebar-glyphs.svg').read_text(encoding='utf-8'))\nh=(b/'source/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html').read_text(encoding='utf-8')\nassert p['START']+'\\n'+s+'\\n'+p['END'] in h\nfor bad in ['<svg xmlns="http://www.w3.org/2000/svg"><script id="bad"/></svg>', '<svg xmlns="http://www.w3.org/2000/svg"><path id="bad" onclick="alert(1)"/></svg>']:\n try: p['inline_sprite'](bad)\n except ValueError: pass\n else: raise AssertionError('unsafe SVG accepted')\nprint('Startup sprite generator: reproducible, source unchanged')\n`;
  const result = spawnSync('python', ['-B', '-c', program], { cwd: fileURLToPath(new URL('../../', import.meta.url)), stdio: 'inherit', windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0);
});

// Avoid importing the full minified React app just to check the patched server.
test('fixture inline verification script parses without application imports', async () => {
  const html = await startupIconHTML();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
});
