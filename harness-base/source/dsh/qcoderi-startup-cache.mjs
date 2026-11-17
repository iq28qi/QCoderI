import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { constants, enableCompileCache } from 'node:module';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// Optional V8 bytecode only: never cache profile composition, settings or credentials.
// A read-only installation/profile must still boot. NODE_DISABLE_COMPILE_CACHE is
// respected by Node, and Node separates cache entries by runtime/source version.
export function enableStartupCompileCache(home, enable = enableCompileCache, localAppData = process.env.LOCALAPPDATA) {
  if (!home) return;
  const fallback = join(home, 'cache', 'node-compile');
  const folders = localAppData ? [join(localAppData, 'QCoderI', 'cache', 'node-compile'), fallback] : [fallback];
  let result;
  for (const directory of folders) {
    try {
      result = enable(directory);
      if (result?.status !== constants.compileCacheStatus.FAILED) return result;
    } catch {}
  }
  return result;
}

const MIME = Object.freeze({
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
});
const inside = (root, target) => {
  const path = relative(root, target);
  return path !== '' && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
};

/** Only bundled presentation files; never HTML, plugin graphs, API or profile data. */
export function isStartupAssetPath(path) {
  return Object.hasOwn(MIME, extname(path)) &&
    (/^\/assets\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/.test(path) ||
     /^\/qcoderi-[A-Za-z0-9_.-]+$/.test(path) ||
     path === '/favicon.svg' || path === '/manifest.webmanifest');
}

/** Call only AFTER the native capability/origin gate. Returns null for other routes.
 * Revalidate stable filenames on every navigation; do not mark patched Vite names
 * immutable. Memory is bounded and cold requests read only the requested file.
 */
export function createStartupAssetHandler(distRoot, {
  maxBytes = 16 * 1024 * 1024, maxEntryBytes = 4 * 1024 * 1024, maxEntries = 96,
  files = { readFile, realpath, stat },
} = {}) {
  const cache = new Map();
  const pending = new Map();
  let bytes = 0;
  let rootPromise;
  const drop = key => { const entry = cache.get(key); if (entry) bytes -= entry.body.length; cache.delete(key); };
  const failure = status => new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });
  async function load(path) {
    const root = await (rootPromise ??= files.realpath(distRoot).catch(error => { rootPromise = undefined; throw error; }));
    const target = resolve(root, '.' + path);
    if (!inside(root, target)) return { status: 403 };
    const actual = await files.realpath(target);
    if (!inside(root, actual)) return { status: 403 };
    const info = await files.stat(actual, { bigint: true });
    if (!info.isFile()) return { status: 404 };
    const version = `${actual}:${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    const previous = cache.get(path);
    if (previous?.version === version) {
      cache.delete(path); cache.set(path, previous); // LRU, not a second copy.
      return previous;
    }
    drop(path);
    const body = await files.readFile(actual);
    const entry = { body, version, etag: '"' + createHash('sha256').update(body).digest('hex') + '"' };
    if (body.length <= maxEntryBytes && body.length <= maxBytes && maxEntries > 0) {
      while (cache.size >= maxEntries || bytes + body.length > maxBytes) drop(cache.keys().next().value);
      cache.set(path, entry); bytes += body.length;
    }
    return entry;
  }
  return {
    snapshot: () => ({ entries: cache.size, bytes, pending: pending.size }),
    async fetch(request) {
      const url = new URL(request.url);
      let path;
      try { path = decodeURIComponent(url.pathname); }
      catch { return url.pathname.startsWith('/assets/') || url.pathname.startsWith('/qcoderi-') ? failure(400) : null; }
      if (!isStartupAssetPath(path)) return null;
      if (request.method !== 'GET' && request.method !== 'HEAD') return failure(405);
      try {
        let work = pending.get(path);
        if (!work) {
          work = load(path).finally(() => pending.delete(path));
          pending.set(path, work);
        }
        const entry = await work;
        if (entry.status) return failure(entry.status);
        const headers = {
          'Content-Type': MIME[extname(path)], 'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, max-age=0, must-revalidate', ETag: entry.etag,
        };
        const tags = request.headers.get('if-none-match')?.split(',').map(tag => tag.trim().replace(/^W\//, '')) ?? [];
        if (tags.includes('*') || tags.includes(entry.etag)) return new Response(null, { status: 304, headers });
        headers['Content-Length'] = String(entry.body.length);
        return new Response(request.method === 'HEAD' ? null : entry.body, { headers });
      } catch (error) {
        drop(path);
        if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) return failure(404);
        throw error; // Keep the native transport's explicit 500 + logging path.
      }
    },
  };
}
