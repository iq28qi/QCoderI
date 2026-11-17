import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const base = resolve(fileURLToPath(new URL('..', import.meta.url)));
const archive = resolve(process.env.HARNESS_ARCHIVE ?? join(base, 'source'));
const packages = join(archive, 'dsh/node_modules');
const load = name => import(pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href);
const protocol = 'aether-jsonrpc-v1';
const tool = (name, mutation = false, implemented = true) => ({
  name, implemented, mutation, reversible: mutation, description: `Fixture ${name}`,
  arguments_schema: { type: 'object', properties: { object_id: { type: 'string' } } },
});

async function createEditor(t, home, pid, label) {
  const metadata = {
    protocol, pid, token: randomBytes(32).toString('base64url'), started_at: Date.now() / 1000,
    socket: `AetherMotion-${randomBytes(6).toString('hex')}-${pid}-${randomBytes(5).toString('hex')}`,
  };
  const path = join(home, '.runtime', `bridge-${pid}.json`);
  await fs.mkdir(join(home, '.runtime'), { recursive: true });
  await fs.writeFile(path, JSON.stringify(metadata));
  const requests = [];
  const sockets = new Set();
  const failures = [];
  const state = { revision: 3, capturePath: join(home, 'artifacts/captures/viewport.png') };
  const tools = [
    tool('scene.get_summary'), tool('scene.get_object'), tool('scene.set_transform', true),
    tool('scene.create_primitive', true), tool('scene.conflict', true), tool('skeleton.auto_rig', true, false),
  ];
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      try {
        const request = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
        buffer = buffer.subarray(newline + 1);
        requests.push(request);
        assert.equal(request.token, metadata.token);
        let data;
        switch (request.method) {
          case 'bridge.get_session': data = { pid, live_document: true, protocol }; break;
          case 'system.list_tools': data = { tools, capabilities: { scene: true, skeletal_animation: false } }; break;
          case 'scene.get_summary': data = { name: label, objects: [{ object_id: `${label}-cube`, name: 'Cube' }] }; break;
          case 'scene.get_object': data = { object_id: `${label}-cube`, mesh: { vertices: [[0, 0, 0], [1, 1, 1]], triangles: [[0, 1, 0]] } }; break;
          case 'scene.set_transform': data = { object_id: request.params.object_id, changed: true }; break;
          case 'scene.create_primitive': socket.end(); return;
          case 'scene.conflict':
            socket.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: {
              code: -32010, message: 'Scene changed', data: { code: 'REVISION_CONFLICT', actual_revision: state.revision },
            } }) + '\n');
            return;
          case 'viewport.capture': data = { path: state.capturePath, scope: 'Fixture active viewport' }; break;
          default: throw new Error(`Unexpected AETHER fixture method ${request.method}`);
        }
        socket.end(JSON.stringify({ jsonrpc: '2.0', id: request.id,
          result: { ok: true, revision: state.revision, changed_ids: [], data } }) + '\n');
      } catch (error) {
        failures.push(error);
        socket.destroy();
      }
    });
  });
  server.on('error', error => failures.push(error));
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(process.platform === 'win32' ? `\\\\.\\pipe\\${metadata.socket}` : metadata.socket, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolveClose => server.close(resolveClose));
    assert.deepEqual(failures, []);
  });
  return { metadata, path, requests, state };
}

test('real Cordis tools and AgentLoop dispatch AETHER requests and preserve the selected model', { timeout: 30000 }, async t => {
  const home = await fs.mkdtemp(join(tmpdir(), 'qcoderi-aether-native-'));
  let ctx;
  let parent;
  t.after(async () => {
    await parent?.dispose();
    await ctx?.fiber.dispose();
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  // Resolve the source-owned plugin through the existing runtime dependencies.
  const plugin = join(home, 'plugin');
  await fs.cp(join(base, 'assets/aether'), plugin, { recursive: true });
  await fs.symlink(packages, join(home, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const editor = await createEditor(t, home, process.pid, 'FixtureScene');
  const stalePid = process.pid + 2;
  await fs.writeFile(join(home, '.runtime', `bridge-${stalePid}.json`), JSON.stringify({
    protocol, pid: stalePid, token: randomBytes(32).toString('base64url'), started_at: 1,
    socket: `AetherMotion-${randomBytes(6).toString('hex')}-${stalePid}-${randomBytes(5).toString('hex')}`,
  }));
  const { Context } = await load('cordis');
  ctx = new Context();
  for (const name of ['dsh-session', 'dsh-session-projection', 'dsh-llm', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-agent-loop']) {
    const module = await load(name);
    await ctx.plugin(module.default ?? module, {});
  }
  await ctx.plugin((await load('dsh-attachment-local')).default, { dshHome: join(home, 'attachments') });
  await ctx.plugin(await import(pathToFileURL(join(plugin, 'index.js')).href));
  for (let attempt = 0; attempt < 100 && !ctx.tools?.get('aether_command'); attempt++) await delay(10);
  parent = await ctx.agents.create({ sessionId: 'aether-native-fixture', meta: { cwd: home },
    agentOptions: { provider: 'fixture', model: 'selected-aether-fixture-model' } });
  const agent = parent.agent;
  let callId = 0;
  const execute = (name, args = {}) => ctx.tools.execute({ name, arguments: { app_directory: home, ...args },
    callId: `aether-native-${++callId}`, agent, signal: new AbortController().signal });
  const successful = async (name, args) => {
    const result = await execute(name, args);
    assert(!result.isError, JSON.stringify(result));
    return typeof result.value === 'string' ? JSON.parse(result.value) : result.value;
  };
  let selected;

  await t.test('schemas, live session probing, stale reporting and existing-editor open', async () => {
    const schemas = ctx.tools.schemas(agent);
    for (const name of ['aether_status', 'aether_tools', 'aether_command', 'aether_viewport', 'aether_open']) {
      assert(schemas.some(schema => schema.name === name), name);
    }
    const status = await successful('aether_status');
    assert.equal(status.connected, true);
    assert.equal(status.selection_required, false);
    assert.equal(status.sessions.filter(session => session.connected).length, 1);
    assert.equal(status.sessions.filter(session => !session.connected).length, 1);
    assert.equal(status.scene.data.name, 'FixtureScene');
    selected = status.sessions.find(session => session.connected).id;
    assert(!JSON.stringify(status).includes(editor.metadata.token));
    const opened = await successful('aether_open');
    assert.equal(opened.already_running, true);
    assert.equal(opened.connected, true);
    assert.equal(agent.options.model, 'selected-aether-fixture-model');
  });

  await t.test('catalog summaries and exact operation schemas use the live API', async () => {
    const catalog = await successful('aether_tools', { session: selected });
    assert.equal(catalog.revision, 3);
    assert.equal(catalog.capabilities.skeletal_animation, false);
    assert.equal(catalog.tools.find(tool => tool.name === 'skeleton.auto_rig').implemented, false);
    assert.equal(Object.hasOwn(catalog.tools[0], 'arguments_schema'), false);
    const described = await successful('aether_tools', { session: selected, method: 'scene.set_transform' });
    assert.equal(described.tool.arguments_schema.type, 'object');
  });

  await t.test('mutation revision defaults, explicit revisions and unavailable operations', async () => {
    const result = await successful('aether_command', { session: selected, method: 'scene.set_transform', arguments: { object_id: 'cube' } });
    assert.equal(result.data.changed, true);
    assert.equal(editor.requests.findLast(request => request.method === 'scene.set_transform').params.expected_revision, 3);
    await successful('aether_command', { session: selected, method: 'scene.set_transform', expected_revision: 2, arguments: { object_id: 'cube' } });
    assert.equal(editor.requests.findLast(request => request.method === 'scene.set_transform').params.expected_revision, 2);
    const before = editor.requests.filter(request => request.method === 'scene.set_transform').length;
    const conflict = await execute('aether_command', { session: selected, method: 'scene.set_transform', expected_revision: 3,
      arguments: { object_id: 'cube', expected_revision: 2 } });
    assert.equal(conflict.isError, true);
    assert.equal(editor.requests.filter(request => request.method === 'scene.set_transform').length, before);
    const unavailable = await execute('aether_command', { session: selected, method: 'skeleton.auto_rig' });
    assert.equal(unavailable.isError, true);
    assert.equal(editor.requests.some(request => request.method === 'skeleton.auto_rig'), false);
  });

  await t.test('geometry compaction, remote errors and ambiguous mutation failures reach tool results', async () => {
    const compact = await successful('aether_command', { session: selected, method: 'scene.get_object' });
    assert.deepEqual(compact.data.mesh, { vertices: 2, triangles: 1, geometry_omitted: true });
    const full = await successful('aether_command', { session: selected, method: 'scene.get_object', include_geometry: true });
    assert.equal(full.data.mesh.vertices.length, 2);
    assert.equal(Object.hasOwn(editor.requests.findLast(request => request.method === 'scene.get_object').params, 'expected_revision'), false);
    const conflict = await execute('aether_command', { session: selected, method: 'scene.conflict' });
    assert.equal(conflict.isError, true);
    assert(JSON.stringify(conflict).includes('REVISION_CONFLICT'));
    const ambiguous = await execute('aether_command', { session: selected, method: 'scene.create_primitive' });
    assert.equal(ambiguous.isError, true);
    const diagnostic = ambiguous.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    assert.match(diagnostic, /"ambiguous":true/);
    assert.match(diagnostic, /CONNECTION_CLOSED/);
    assert.equal(editor.requests.filter(request => request.method === 'scene.create_primitive').length, 1);
  });

  await t.test('viewport PNG becomes a real image attachment and capture paths stay within the capture directory', async () => {
    await fs.mkdir(join(home, 'artifacts/captures'), { recursive: true });
    await fs.copyFile(join(base, 'assets/qcoderi.png'), editor.state.capturePath);
    const result = await execute('aether_viewport', { session: selected, caption: 'Fixture viewport' });
    assert(!result.isError, JSON.stringify(result));
    assert(result.content.some(block => block.type === 'image' && block.attachment.bytes > 100));
    assert(result.content.some(block => block.type === 'text' && block.text.includes('Fixture viewport')));
    editor.state.capturePath = join(home, 'outside-captures.png');
    await fs.copyFile(join(base, 'assets/qcoderi.png'), editor.state.capturePath);
    const escaped = await execute('aether_viewport', { session: selected });
    assert.equal(escaped.isError, true);
    editor.state.capturePath = join(home, 'artifacts/captures/invalid.png');
    await fs.writeFile(editor.state.capturePath, 'Invalid PNG fixture');
    const malformed = await execute('aether_viewport', { session: selected });
    assert.equal(malformed.isError, true);
  });

  await t.test('multiple live editors require selection and explicit selection routes to the intended editor', async subtest => {
    const second = await createEditor(subtest, home, process.pid + 1, 'SecondScene');
    const status = await successful('aether_status');
    assert.equal(status.selection_required, true);
    const ambiguous = await execute('aether_command', { method: 'scene.get_summary' });
    assert.equal(ambiguous.isError, true);
    assert.equal(second.requests.some(request => request.method === 'scene.get_summary'), false);
    const secondId = status.sessions.find(session => session.pid === second.metadata.pid).id;
    assert.equal((await successful('aether_command', { session: secondId, method: 'scene.get_summary' })).data.name, 'SecondScene');
    assert.equal((await successful('aether_command', { session: selected, method: 'scene.get_summary' })).data.name, 'FixtureScene');
    await fs.rm(second.path);
  });

  await t.test('selected-model AgentLoop consumes the actual AETHER tool response', async () => {
    const { LlmAdapter, createUserMessage } = await load('dsh-llm');
    let requests = 0;
    class AetherAdapter extends LlmAdapter {
      async *stream(options) {
        requests++;
        assert.equal(options.model, 'selected-aether-fixture-model');
        assert(options.tools.some(tool => tool.name === 'aether_command'));
        if (requests === 1) {
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'model-aether-call', name: 'aether_command',
            arguments: JSON.stringify({ app_directory: home, session: selected, method: 'scene.get_summary' }) } };
        } else {
          const results = options.messages.flatMap(message => message.content).filter(block => block.type === 'tool-result');
          assert.equal(results.at(-1).isError, false);
          assert(JSON.stringify(results.at(-1)).includes('FixtureScene'));
          yield { type: 'text-delta', index: 0, text: 'Проверена сцена FixtureScene' };
        }
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    ctx.llm.registerAdapter(['fixture'], new AetherAdapter());
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Проверь открытую сцену AETHER' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    assert.equal(requests, 2);
    assert.equal(agent.options.model, 'selected-aether-fixture-model');
    assert.equal(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason.kind, 'completed');
  });
});
