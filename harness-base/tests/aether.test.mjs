import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AetherBridgeError, discoverSessions, callSession } from '../assets/aether/bridge.js';

const protocol = 'aether-jsonrpc-v1';
const requestLimit = 2 * 1024 * 1024;
const responseLimit = 32 * 1024 * 1024;

async function temporaryHome(t) {
  const home = await fs.mkdtemp(join(tmpdir(), 'qcoderi-aether-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

function metadata(overrides = {}) {
  const pid = overrides.pid ?? process.pid;
  return {
    protocol,
    socket: `AetherMotion-${randomBytes(6).toString('hex')}-${pid}-${randomBytes(5).toString('hex')}`,
    token: randomBytes(32).toString('base64url'),
    pid,
    started_at: Date.now() / 1000,
    ...overrides,
  };
}

async function writeMetadata(home, value, runtimeDir = join(home, '.runtime')) {
  await fs.mkdir(runtimeDir, { recursive: true });
  const path = join(runtimeDir, `bridge-${value.pid}.json`);
  await fs.writeFile(path, JSON.stringify(value));
  return path;
}

async function pipeFixture(t, handleRequest = (request, socket) => {
  socket.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }) + '\n');
}) {
  const home = await temporaryHome(t);
  const value = metadata();
  const path = await writeMetadata(home, value);
  const sockets = new Set();
  const requests = [];
  const failures = [];
  const handlers = new Set();
  let resolveFirstRequest;
  const firstRequest = new Promise(resolve => { resolveFirstRequest = resolve; });
  let connections = 0;
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\${value.socket}` : value.socket;
  const server = net.createServer(socket => {
    connections++;
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      try {
        const request = JSON.parse(line.toString('utf8'));
        requests.push(request);
        resolveFirstRequest(request);
        const handler = Promise.resolve(handleRequest(request, socket)).catch(error => {
          failures.push(error);
          socket.destroy();
        }).finally(() => handlers.delete(handler));
        handlers.add(handler);
      } catch (error) {
        failures.push(error);
        socket.destroy();
      }
    });
  });
  server.on('error', error => failures.push(error));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => {
      server.off('error', reject);
      resolve();
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await Promise.allSettled([...handlers]);
    assert.deepEqual(failures, []);
  });
  const sessions = await discoverSessions({ home });
  assert.equal(sessions.length, 1);
  return {
    home,
    metadata: value,
    path,
    session: sessions[0],
    requests,
    firstRequest,
    get connections() { return connections; },
    async waitForRequest() {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (requests.length) return requests[0];
        await delay(5);
      }
      assert.fail('AETHER fixture did not receive a request');
    },
  };
}

function transportError(ambiguous, code) {
  return error => {
    assert(error instanceof AetherBridgeError);
    assert.equal(typeof error.code, 'string');
    assert(error.code.length > 0);
    if (code) assert.equal(error.code, code);
    assert.equal(error.ambiguous, ambiguous);
    return true;
  };
}

test('discovery finds root and packaged runtime metadata and never exposes authentication tokens', async t => {
  const home = await temporaryHome(t);
  const direct = metadata();
  const packaged = metadata({ pid: process.pid + 1 });
  const directPath = await writeMetadata(home, direct);
  const packagedPath = await writeMetadata(home, packaged, join(home, 'dist/AetherMotionStudio/.runtime'));
  const sessions = await discoverSessions({ home });
  assert.deepEqual(new Set(sessions.map(session => session.metadata_path)), new Set([directPath, packagedPath]));
  for (const session of sessions) {
    assert.equal(session.protocol, protocol);
    assert.equal(typeof session.id, 'string');
    assert(session.id.length > 0);
    assert.equal(Object.hasOwn(session, 'token'), false);
    assert.equal(Object.hasOwn(session, 'auth'), false);
  }
  const serialized = JSON.stringify(sessions);
  assert(!serialized.includes(direct.token));
  assert(!serialized.includes(packaged.token));
  const duplicates = await discoverSessions({ home, homePaths: [home, home], runtimeDirs: [join(home, '.runtime')] });
  assert.equal(duplicates.length, 2, 'repeated discovery roots return each metadata file once');
});

test('discovery retains multiple candidates including an unreachable stale session for caller selection', async t => {
  const fixture = await pipeFixture(t);
  const stale = metadata({ pid: process.pid + 2, started_at: 1 });
  await writeMetadata(fixture.home, stale);
  const sessions = await discoverSessions({ home: fixture.home });
  assert.equal(sessions.length, 2);
  assert.equal(fixture.connections, 0, 'discovery only reads metadata');
  const live = sessions.find(session => session.pid === process.pid);
  const unavailable = sessions.find(session => session.pid === stale.pid);
  assert.deepEqual((await callSession(live, 'bridge.get_session')).result, { ok: true });
  await assert.rejects(callSession(unavailable, 'bridge.get_session', {}, { timeoutMs: 5000 }), transportError(false, 'CONNECT_FAILED'));
});

test('discovery supports an explicit runtime directory and the configured home environment', async t => {
  const home = await temporaryHome(t);
  const customRuntime = join(home, 'custom-runtime');
  const value = metadata();
  const path = await writeMetadata(home, value, customRuntime);
  assert.equal((await discoverSessions({ runtimeDir: customRuntime }))[0].metadata_path, path);
  await writeMetadata(home, value);
  const previous = process.env.QCODERI_AETHER_HOME;
  process.env.QCODERI_AETHER_HOME = home;
  try {
    const sessions = await discoverSessions();
    assert(sessions.some(session => session.metadata_path === join(home, '.runtime', `bridge-${value.pid}.json`)));
    const isolatedHome = await temporaryHome(t);
    assert.deepEqual(await discoverSessions({ home: isolatedHome }), [], 'an explicit home scopes discovery independently of the environment');
  } finally {
    if (previous === undefined) delete process.env.QCODERI_AETHER_HOME;
    else process.env.QCODERI_AETHER_HOME = previous;
  }
});

test('workspace discovery searches ancestor installation folders', async t => {
  const home = await temporaryHome(t);
  const installation = join(home, 'AETHER');
  const value = metadata();
  const path = await writeMetadata(installation, value);
  const workspace = join(home, 'workspace/project/src');
  await fs.mkdir(workspace, { recursive: true });
  assert((await discoverSessions({ workspace })).some(session => session.metadata_path === path));
});

test('discovery skips malformed, oversized and inconsistent metadata without returning token data', async t => {
  const home = await temporaryHome(t);
  const runtime = join(home, '.runtime');
  await fs.mkdir(runtime, { recursive: true });
  const valid = metadata();
  await writeMetadata(home, valid);
  const invalid = [
    metadata({ pid: process.pid + 3, protocol: 'wrong-protocol' }),
    metadata({ pid: process.pid + 4, token: 'short' }),
    metadata({ pid: process.pid + 5, socket: '\\\\remote\\pipe\\untrusted' }),
    metadata({ pid: process.pid + 6, started_at: -1 }),
    metadata({ pid: process.pid + 7, token: 'x'.repeat(70000) }),
  ];
  for (const value of invalid) await writeMetadata(home, value);
  const mismatch = metadata({ pid: process.pid + 8 });
  await fs.writeFile(join(runtime, `bridge-${process.pid + 9}.json`), JSON.stringify(mismatch));
  await fs.writeFile(join(runtime, `bridge-${process.pid + 10}.json`), '{invalid');
  const sessions = await discoverSessions({ home });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].pid, valid.pid);
  assert(!JSON.stringify(sessions).includes(valid.token));
});

test('calls authenticate from metadata, correlate unique request ids and preserve params', async t => {
  const fixture = await pipeFixture(t, (request, socket) => {
    socket.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: request.params }) + '\n');
  });
  const params = { project: 'Пример', nested: { revision: 7 }, values: [true, null, 0] };
  const first = await callSession(fixture.session, 'document.inspect', params);
  const second = await callSession(fixture.path, 'bridge.get_session');
  assert.deepEqual(first.result, params);
  assert.deepEqual(second.result, {});
  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.requests[0].jsonrpc, '2.0');
  assert.equal(fixture.requests[0].token, fixture.metadata.token);
  assert.equal(fixture.requests[0].method, 'document.inspect');
  assert.equal(typeof fixture.requests[0].id, 'string');
  assert.notEqual(fixture.requests[0].id, fixture.requests[1].id);
  assert.equal(first.id, fixture.requests[0].id);
  assert(!JSON.stringify(fixture.session).includes(fixture.metadata.token));
});

test('each call rereads the private token and rejects a replaced session endpoint', async t => {
  const fixture = await pipeFixture(t);
  const replacementToken = randomBytes(32).toString('base64url');
  const refreshed = { ...fixture.metadata, token: replacementToken };
  await fs.writeFile(fixture.path, JSON.stringify(refreshed));
  await callSession({ ...fixture.session, token: 'untrusted-descriptor-token' }, 'bridge.get_session');
  assert.equal(fixture.requests[0].token, replacementToken);
  await fs.writeFile(fixture.path, JSON.stringify({ ...refreshed, socket: metadata().socket }));
  await assert.rejects(callSession(fixture.session, 'document.update'), transportError(false, 'SESSION_CHANGED'));
  assert.equal(fixture.connections, 1);
});

test('metadata failures are determinate and errors omit authentication credentials', async t => {
  const fixture = await pipeFixture(t);
  await fs.writeFile(fixture.path, JSON.stringify({ ...fixture.metadata, protocol: 'invalid' }));
  await assert.rejects(callSession(fixture.session, 'document.update'), error => {
    transportError(false, 'METADATA_INVALID')(error);
    const diagnostic = JSON.stringify({ message: error.message, stack: error.stack, details: error.details, ...error });
    assert(!diagnostic.includes(fixture.metadata.token));
    return true;
  });
  await fs.writeFile(fixture.path, 'x'.repeat(65537));
  await assert.rejects(callSession(fixture.path, 'bridge.get_session'), transportError(false, 'METADATA_TOO_LARGE'));
  await fs.rm(fixture.path);
  await assert.rejects(callSession(fixture.path, 'bridge.get_session'), transportError(false, 'METADATA_UNAVAILABLE'));
  assert.equal(fixture.connections, 0);
});

test('reads chunked UTF-8 JSON responses across code-point and newline boundaries', async t => {
  const expected = { name: 'Привет 🌌', revision: 12, values: [1, 2, 3] };
  const fixture = await pipeFixture(t, async (request, socket) => {
    const response = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: expected }) + '\n');
    const split = response.indexOf(Buffer.from('🌌')) + 1;
    for (const chunk of [response.subarray(0, 3), response.subarray(3, split), response.subarray(split, -1), response.subarray(-1)]) {
      socket.write(chunk);
      await delay(3);
    }
    socket.end();
  });
  assert.deepEqual((await callSession(fixture.session, 'document.inspect')).result, expected);
});

test('concurrent calls keep their own ids and results when replies arrive in reverse order', async t => {
  const pending = [];
  const fixture = await pipeFixture(t, (request, socket) => {
    pending.push({ request, socket });
    if (pending.length === 2) {
      for (const item of [...pending].reverse()) {
        item.socket.end(JSON.stringify({ jsonrpc: '2.0', id: item.request.id, result: item.request.params }) + '\n');
      }
    }
  });
  const results = await Promise.all([
    callSession(fixture.session, 'document.inspect', { target: 'first' }, { timeoutMs: 1000 }),
    callSession(fixture.session, 'document.inspect', { target: 'second' }, { timeoutMs: 1000 }),
  ]);
  assert.deepEqual(results.map(response => response.result), [{ target: 'first' }, { target: 'second' }]);
  assert.equal(new Set(fixture.requests.map(request => request.id)).size, 2);
  assert.equal(fixture.connections, 2);
});

test('returns remote JSON-RPC error envelopes as determinate responses', async t => {
  const remoteError = { code: -32010, message: 'Revision conflict', data: { expected: 1, actual: 2 } };
  const fixture = await pipeFixture(t, (request, socket) => {
    socket.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: remoteError }) + '\n');
  });
  const response = await callSession(fixture.session, 'document.update', { expected_revision: 1 });
  assert.deepEqual(response.error, remoteError);
  assert.equal(Object.hasOwn(response, 'result'), false);
  assert.equal(fixture.connections, 1);
});

test('rejects mismatched ids and malformed response envelopes after sending', async t => {
  const cases = [
    ['mismatched id', request => ({ jsonrpc: '2.0', id: request.id + '-other', result: {} }), 'RESPONSE_ID_MISMATCH'],
    ['missing id', () => ({ jsonrpc: '2.0', result: {} }), 'RESPONSE_ID_MISMATCH'],
    ['incorrect version', request => ({ jsonrpc: '1.0', id: request.id, result: {} })],
    ['missing result and error', request => ({ jsonrpc: '2.0', id: request.id })],
    ['result and error together', request => ({ jsonrpc: '2.0', id: request.id, result: {}, error: { code: -1, message: 'error' } })],
    ['invalid error object', request => ({ jsonrpc: '2.0', id: request.id, error: { code: 'bad', message: 'error' } })],
    ['invalid JSON', () => '{broken'],
  ];
  for (const [name, responseFor, code = 'INVALID_RESPONSE'] of cases) await t.test(name, async subtest => {
    const fixture = await pipeFixture(subtest, (request, socket) => {
      const response = responseFor(request);
      socket.end((typeof response === 'string' ? response : JSON.stringify(response)) + '\n');
    });
    await assert.rejects(callSession(fixture.session, 'document.update'), transportError(true, code));
    assert.equal(fixture.connections, 1);
    assert.equal(fixture.requests.length, 1);
  });
});

test('rejects invalid UTF-8 response bytes without echoing request credentials', async t => {
  const fixture = await pipeFixture(t, (_request, socket) => socket.end(Buffer.from([0xff, 0xfe, 10])));
  await assert.rejects(callSession(fixture.session, 'document.update'), error => {
    transportError(true, 'INVALID_RESPONSE')(error);
    assert(!error.message.includes(fixture.metadata.token));
    return true;
  });
});

test('a disconnected or truncated mutation response stays ambiguous and is never retried', async t => {
  for (const partial of ['', '{"jsonrpc":"2.0"']) await t.test(partial ? 'truncated' : 'empty', async subtest => {
    const fixture = await pipeFixture(subtest, (_request, socket) => socket.end(partial));
    await assert.rejects(callSession(fixture.session, 'document.update', { name: 'Changed' }), transportError(true, 'CONNECTION_CLOSED'));
    await delay(30);
    assert.equal(fixture.connections, 1);
    assert.equal(fixture.requests.length, 1);
  });
});

test('timeout after sending marks a mutation ambiguous and never reconnects or retries', async t => {
  const fixture = await pipeFixture(t, () => {});
  const nativeSetTimeout = globalThis.setTimeout;
  let expire;
  t.mock.method(globalThis, 'setTimeout', (callback, milliseconds, ...args) => {
    if (milliseconds === 10000) expire = () => callback(...args);
    return nativeSetTimeout(callback, milliseconds, ...args);
  });
  const pending = callSession(fixture.session, 'document.update', { name: 'Changed' }, { timeoutMs: 10000 });
  const rejected = assert.rejects(pending, transportError(true, 'TIMEOUT'));
  await fixture.firstRequest;
  assert.equal(typeof expire, 'function');
  expire();
  await rejected;
  await delay(30);
  assert.equal(fixture.connections, 1);
  assert.equal(fixture.requests.length, 1);
});

test('abort after sending marks a mutation ambiguous and never retries it', async t => {
  const fixture = await pipeFixture(t, () => {});
  const controller = new AbortController();
  const pending = callSession(fixture.session, 'document.update', { name: 'Changed' }, { signal: controller.signal });
  const rejected = assert.rejects(pending, transportError(true, 'ABORTED'));
  await fixture.waitForRequest();
  controller.abort();
  await rejected;
  await delay(30);
  assert.equal(fixture.connections, 1);
  assert.equal(fixture.requests.length, 1);
});

test('an already aborted call sends nothing and reports a determinate cancellation', async t => {
  const fixture = await pipeFixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(callSession(fixture.session, 'document.update', {}, { signal: controller.signal }), transportError(false, 'ABORTED'));
  assert.equal(fixture.connections, 0);
  assert.equal(fixture.requests.length, 0);
});

test('validates parameters and request size before opening a connection', async t => {
  const fixture = await pipeFixture(t);
  const cyclic = {};
  cyclic.self = cyclic;
  for (const params of [[], null, 'bad', cyclic, { value: 1n }, { value: Infinity }, { value: NaN }]) {
    await assert.rejects(callSession(fixture.session, 'document.update', params), transportError(false, 'INVALID_REQUEST'));
  }
  await assert.rejects(callSession(fixture.session, 'document.update', { payload: 'x'.repeat(requestLimit) }), transportError(false, 'REQUEST_TOO_LARGE'));
  await assert.rejects(callSession(fixture.session, 'document.update', { payload: 'я'.repeat(requestLimit / 2) }), transportError(false, 'REQUEST_TOO_LARGE'));
  await assert.rejects(callSession(fixture.session, '', {}), transportError(false, 'INVALID_REQUEST'));
  assert.equal(fixture.connections, 0);
  assert.equal(fixture.requests.length, 0);
});

test('enforces the response byte limit before accepting an unterminated oversized frame', async t => {
  const fixture = await pipeFixture(t, async (_request, socket) => {
    const chunk = Buffer.alloc(1024 * 1024, 120);
    for (let sent = 0; sent <= responseLimit && !socket.destroyed; sent += chunk.length) {
      if (!socket.write(chunk)) {
        await new Promise(resolve => {
          const ready = () => {
            socket.off('drain', ready);
            socket.off('close', ready);
            resolve();
          };
          socket.once('drain', ready);
          socket.once('close', ready);
        });
      }
    }
  });
  await assert.rejects(callSession(fixture.session, 'document.inspect', {}, { timeoutMs: 5000 }), transportError(true, 'RESPONSE_TOO_LARGE'));
  assert.equal(fixture.connections, 1);
});
