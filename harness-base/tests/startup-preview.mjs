// Isolated icon fixture: no host boot, profile, model API or application UI.
// node tests/startup-preview.mjs --serve (ephemeral loopback port, Ctrl+C to stop)
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStartupAssetHandler } from '../native/startup-cache.mjs';

export const dist = fileURLToPath(new URL('../source/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/', import.meta.url));
export async function startupIconHTML() {
  const index = await readFile(new URL('../source/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html', import.meta.url), 'utf8');
  const sprite = index.match(/<!-- QCODERI_STARTUP_ICONS -->[\s\S]*?<!-- \/QCODERI_STARTUP_ICONS -->/)?.[0];
  if (!sprite) throw new Error('Run optimize-startup.py after syncing design assets');
  const ids = [...sprite.matchAll(/<symbol id="qcoderi-glyph-([^"]+)"/g)].map(match => match[1]);
  const rows = ids.map(id => `<div class="icon"><svg width="32" height="32" viewBox="0 0 ${id === 'system' ? '48 48' : '24 24'}" aria-hidden="true"><use href="#qcoderi-glyph-${id}"/></svg><span>${id}</span></div>`).join('');
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>QCoderI · изолированная проверка иконок</title><style>
*{box-sizing:border-box}body{margin:0;padding:36px;font:15px system-ui;background:#100e1b;color:#ede7ff}h1{font-size:26px;margin:0 0 8px}p{color:#ada4c4;margin:8px 0 24px}section{border:1px solid #59506c;border-radius:18px;padding:22px;margin-top:20px}h2{font-size:18px;margin:0 0 20px}.grid{display:grid;grid-template-columns:repeat(6,1fr);gap:18px}.icon{display:flex;align-items:center;gap:12px;min-width:0}.icon span{font-size:12px}.light{color:#423455;background:#f5f2fc}.status{color:#a6e9cf;font:13px ui-monospace}svg{flex-shrink:0}
</style><body>${sprite}<h1>QCoderI · локальные иконки</h1><p>Изолированный HTTP fixture. Не запускает приложение, не читает профиль и не обращается к API.</p><section><h2>Тёмная палитра</h2><div class="grid">${rows}</div></section><section class="light"><h2>Светлая палитра</h2><div class="grid">${rows}</div></section><p class="status" id="result">Проверка геометрии…</p><script>
requestAnimationFrame(()=>{const icons=[...document.querySelectorAll('.icon svg')];const painted=icons.filter(svg=>{const b=svg.getBBox();return b.width>0&&b.height>0}).length;const resources=performance.getEntriesByType('resource').length;document.querySelector('#result').textContent=painted+'/'+icons.length+' SVG имеют геометрию · запросов ресурсов: '+resources;document.body.dataset.check=painted===icons.length&&resources===0?'passed':'failed';});
</script></body></html>`;
}
export async function createStartupPreview() {
  const html = await startupIconHTML();
  const assets = createStartupAssetHandler(dist);
  const requests = [];
  const server = createServer(async (req, res) => {
    requests.push(req.url);
    try {
      if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; object-src 'none'" });
        res.end(html); return;
      }
      const response = await assets.fetch(new Request('http://127.0.0.1' + req.url, { method: req.method, headers: req.headers }));
      if (!response) { res.writeHead(404).end(); return; }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { res.writeHead(500).end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, requests, assets, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes('--serve')) throw new Error('Pass --serve for the isolated browser fixture');
  const fixture = await createStartupPreview();
  console.log('STARTUP_PREVIEW ' + fixture.url);
  const stop = () => fixture.close().then(() => process.exit());
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
