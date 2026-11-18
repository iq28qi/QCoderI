import { createHash, createPublicKey, verify } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const maxArchive = 1024 * 1024 * 1024;
const versionPattern = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const hashPattern = /^[a-f0-9]{64}$/;

function newer(a, b) {
  const right = b.split('.').map(Number);
  return a.split('.').map(Number).reduce((order, value, index) => order || value - right[index], 0) > 0;
}

function endpoint(value, relative) {
  const url = new URL(value, relative);
  if (url.username || url.password || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1')))
    throw Error('Адрес обновления должен использовать HTTPS.');
  if (relative && url.origin !== relative.origin) throw Error('Пакет должен находиться на сервере канала.');
  return url;
}

async function readManifest(url) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(12000) });
  if (!response.ok || !response.body) throw Error('Сервер обновлений вернул HTTP ' + response.status + '.');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 16384) throw Error('Манифест обновления слишком большой.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function releaseFrom(manifest, url, key) {
  const { version, file, bytes, sha256, signature } = manifest;
  if (manifest.schema !== 1 || manifest.platform !== 'windows-x64' ||
      typeof version !== 'string' || !versionPattern.test(version) ||
      typeof file !== 'string' || file !== `QCoderI-${version}-windows-x64.zip` ||
      !Number.isSafeInteger(bytes) || bytes < 1 || bytes > maxArchive ||
      typeof sha256 !== 'string' || !hashPattern.test(sha256) ||
      typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature))
    throw Error('Неверный формат манифеста обновления.');
  const payload = Buffer.from(JSON.stringify([manifest.schema, manifest.platform, version, file, bytes, sha256]));
  if (!verify(null, payload, key, Buffer.from(signature, 'base64'))) throw Error('Подпись обновления недействительна.');
  return { version, url: endpoint(file, url), bytes, sha256 };
}

async function download(release, archive, report) {
  const signal = AbortSignal.timeout(20 * 60 * 1000);
  const response = await fetch(release.url, { redirect: 'error', signal });
  if (!response.ok || !response.body) throw Error('Не удалось скачать пакет. HTTP ' + response.status + '.');
  const hash = createHash('sha256');
  let received = 0;
  const measure = new Transform({
    transform(chunk, _encoding, done) {
      received += chunk.length;
      if (received > release.bytes) return done(Error('Размер пакета не совпадает с манифестом.'));
      hash.update(chunk);
      report(Math.floor(received * 100 / release.bytes));
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), measure, createWriteStream(archive, { flags: 'wx' }), { signal });
  if (received !== release.bytes || hash.digest('hex') !== release.sha256)
    throw Error('Контрольная сумма или размер пакета не совпадают.');
}

export function createUpdates({ configPath, stage, currentVersion, launch, isBusy }) {
  let state = { phase: 'idle', currentVersion };
  let release;
  let operation;
  const publish = (phase, details = {}) => state = { phase, currentVersion, ...details };
  const run = task => operation ??= task().catch(error => publish('error', { message: error.message }))
    .finally(() => { operation = undefined; });
  const check = () => run(async () => {
    release = undefined;
    publish('checking');
    let config;
    try { config = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, '')); }
    catch (error) {
      if (error.code === 'ENOENT') return publish('unconfigured');
      throw error;
    }
    const url = endpoint(config.url);
    const key = createPublicKey(config.publicKey);
    if (key.asymmetricKeyType !== 'ed25519') throw Error('Каналу нужен открытый ключ Ed25519.');
    const releaseCandidate = releaseFrom(await readManifest(url), url, key);
    if (!newer(releaseCandidate.version, currentVersion)) return publish('current');
    release = releaseCandidate;
    return publish('available', { version: release.version });
  });
  const install = () => run(async () => {
    if (!release) throw Error('Сначала проверьте наличие обновления.');
    const { version, sha256 } = release;
    if (isBusy()) return publish('available', { version, message: 'Дождитесь завершения активных задач.' });
    const archive = join(stage, 'release.zip');
    publish('downloading', { version, percent: 0 });
    await mkdir(stage, { recursive: true });
    await rm(archive, { force: true });
    try {
      await download(release, archive, percent => {
        if (state.percent !== percent) publish('downloading', { version, percent });
      });
      if (isBusy()) {
        await rm(archive, { force: true });
        return publish('available', { version, message: 'Дождитесь завершения активных задач.' });
      }
      await launch(version, sha256);
      release = undefined;
      return publish('restarting', { version });
    } catch (error) {
      await rm(archive, { force: true });
      throw error;
    }
  });
  return { state: () => state, check, install,
    failed: message => publish('error', { message }) };
}
