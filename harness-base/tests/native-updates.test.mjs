import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { createUpdates } from '../native/updates.mjs';

test('native updater validates manifests and archives and defers installation for active chats', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qcoderi-updates-'));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const archive = Buffer.from('fixture archive body');
  const digest = createHash('sha256').update(archive).digest('hex');
  const manifest = (version, sha256 = digest) => {
    const file = `QCoderI-${version}-windows-x64.zip`;
    const payload = JSON.stringify([1, 'windows-x64', version, file, archive.length, sha256]);
    return { schema: 1, platform: 'windows-x64', version, file, bytes: archive.length, sha256,
      signature: sign(null, Buffer.from(payload), privateKey).toString('base64') };
  };
  let published = manifest('1.2.0');
  let body = archive;
  const server = createServer((request, response) => {
    if (request.url === '/latest.json') response.end(JSON.stringify(published));
    else response.end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const configPath = join(directory, 'channel.json');
  const stage = join(directory, 'stage');
  let busy = false;
  let installed = 0;
  const updates = createUpdates({ configPath, stage, currentVersion: '1.1.0',
    isBusy: () => busy,
    launch: async (version, sha256) => {
      assert.equal(version, '1.2.0');
      assert.equal(sha256, digest);
      assert.deepEqual(await readFile(join(stage, 'release.zip')), archive);
      installed++;
    },
  });
  try {
    assert.equal((await updates.check()).phase, 'unconfigured');
    await writeFile(configPath, JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/latest.json`,
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }));
    published = manifest('1.0.0');
    assert.equal((await updates.check()).phase, 'current');
    published = { ...manifest('1.2.0'), sha256: '0'.repeat(64) };
    assert.match((await updates.check()).message, /Подпись/);
    await t.test('rejects a signed manifest with a non-string version', async () => {
      published = manifest(['1.2.0']);
      const result = await updates.check();
      assert.equal(result.phase, 'error');
      assert.match(result.message, /Неверный формат манифеста/);
    });
    await t.test('rejects a signed manifest with a non-string SHA-256 at check time', async () => {
      published = manifest('1.2.0', [digest]);
      const result = await updates.check();
      assert.equal(result.phase, 'error');
      assert.match(result.message, /Неверный формат манифеста/);
    });
    published = manifest('1.2.0');
    assert.equal((await updates.check()).phase, 'available');
    busy = true;
    assert.match((await updates.install()).message, /активных задач/);
    busy = false;
    body = Buffer.alloc(archive.length);
    assert.match((await updates.install()).message, /Контрольная сумма/);
    assert.equal(installed, 0);
    await assert.rejects(readFile(join(stage, 'release.zip')), { code: 'ENOENT' });
    body = archive;
    const first = updates.install();
    assert.strictEqual(updates.install(), first);
    assert.equal((await first).phase, 'restarting');
    assert.equal(installed, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
