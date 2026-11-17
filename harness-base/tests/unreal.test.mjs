import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';

const base = resolve(fileURLToPath(new URL('..', import.meta.url)));
const archive = resolve(process.env.HARNESS_ARCHIVE ?? join(base, 'source'));
const moduleUrl = name => pathToFileURL(join(archive, 'dsh/node_modules', name, 'lib/index.js')).href;
const load = async name => import(moduleUrl('@deepseek-ai/' + name));
const bridge = await import(pathToFileURL(join(archive, 'dsh/node_modules/@qcoderi/unreal/bridge.js')).href);
const home = await fs.mkdtemp(join(tmpdir(), 'qcoderi-unreal-'));
const project = join(home, 'BlueprintOnly.uproject');
const original = JSON.stringify({ FileVersion: 3, EngineAssociation: '5.7', Plugins: [{ Name: 'ExistingPlugin', Enabled: true }] });
await fs.writeFile(project, original);
let ctx, parent;
try {
  assert.equal(await bridge.projectFile(home), project);
  await assert.rejects(bridge.projectFile(home, 'bad.txt'), /uproject/);
  assert.equal((await bridge.status(project)).connected, false);
  const installed = await bridge.install(project);
  assert.equal(await fs.readFile(installed.backup, 'utf8'), original);
  const descriptor = JSON.parse(await fs.readFile(project, 'utf8'));
  assert(descriptor.Plugins.some(p => p.Name === 'ExistingPlugin' && p.Enabled));
  assert(descriptor.Plugins.some(p => p.Name === 'QCoderIBridge' && p.Enabled));
  assert((await fs.readFile(join(installed.plugin, 'Source/QCoderIBridge/Private/QCoderIBridge.cpp'), 'utf8')).includes('IMPLEMENT_MODULE'));
  await bridge.install(project);
  assert.equal(JSON.parse(await fs.readFile(project, 'utf8')).Plugins.filter(p => p.Name === 'QCoderIBridge').length, 1);
  const prebuilt = join(archive, 'dsh/node_modules/@qcoderi/unreal/prebuilt/5.7.4');
  const bundled = JSON.parse(await fs.readFile(join(prebuilt, 'manifest.json'), 'utf8'));
  assert.equal(bundled.source_sha256, await bridge.pluginFingerprint(), 'bundled DLL matches shipped source');
  const fakeEngine = join(home, 'FixtureEngine');
  await fs.mkdir(join(fakeEngine, 'Engine/Build'), { recursive: true }); await fs.mkdir(join(fakeEngine, 'Engine/Binaries/Win64'), { recursive: true });
  await fs.writeFile(join(fakeEngine, 'Engine/Build/Build.version'), JSON.stringify({ MajorVersion: 5, MinorVersion: 7, PatchVersion: 4 }));
  const modulesFile = join(fakeEngine, 'Engine/Binaries/Win64/UnrealEditor.modules');
  await fs.writeFile(modulesFile, JSON.stringify({ BuildId: bundled.build_id }));
  assert((await bridge.install(project, { engineDirectory: fakeEngine })).prebuilt_installed);
  const dll = await fs.readFile(join(installed.plugin, 'Binaries/Win64/UnrealEditor-QCoderIBridge.dll'));
  assert.equal(createHash('sha256').update(dll).digest('hex'), bundled.binary_sha256);
  await fs.writeFile(modulesFile, JSON.stringify({ BuildId: 'incompatible-fixture' }));
  assert.equal((await bridge.install(project, { engineDirectory: fakeEngine })).prebuilt_installed, false);
  console.log('PASS: packaged prebuilt DLL extracts correctly and incompatible engine build id is refused');
  const dir = bridge.mailbox(project); await fs.mkdir(dir, { recursive: true });
  const heartbeat = async (instance = 'fixture-editor', updated_at = Date.now() / 1000, assets = true) => bridge.atomicJson(join(dir, 'status.json'), { protocol: 1, instance, updated_at, project, asset_pipeline: assets });
  await heartbeat();
  const observed = [];
  async function serve(result, ok = true) {
    for (let count = 0; count < 100; count++) {
      const file = (await fs.readdir(dir)).find(name => name.endsWith('.request.json'));
      if (!file) { await delay(10); continue; }
      const request = JSON.parse(await fs.readFile(join(dir, file), 'utf8')); observed.push(request);
      assert(request.expires_at > Date.now() / 1000); assert.equal(request.instance, 'fixture-editor');
      await fs.rename(join(dir, file), join(dir, request.id + '.processing'));
      await bridge.atomicJson(join(dir, request.id + '.response.json'), { id: request.id, instance: request.instance, ok, result, error: 'fixture compile failure' });
      await fs.rm(join(dir, request.id + '.processing')); return;
    }
    throw new Error('No editor request received');
  }
  let result = await Promise.all([bridge.command(project, 'widget_font', { blueprint: '/Game/UI/WBP_Menu', widget: 'Title', size: 48 }), serve({ changed: true })]);
  assert.deepEqual(result[0], { changed: true }); assert.equal(observed[0].args.size, 48);
  const importFile = join(home, 'example.fbx');
  await fs.writeFile(importFile, 'fixture handled by the mocked editor');
  await heartbeat('fixture-editor', Date.now() / 1000, false);
  await assert.rejects(bridge.command(project, 'asset_import', { source: importFile }), /старая версия/);
  await heartbeat();
  assert((await bridge.status(project)).asset_pipeline);
  await assert.rejects(bridge.command(project, 'asset_import', { source: fileURLToPath(import.meta.url) }), /из папки/);
  const importResult = await Promise.all([
    bridge.command(project, 'asset_import', { source: importFile, path: '/Game/SM_Example' }),
    serve({ path: '/Game/SM_Example.SM_Example' }),
  ]);
  assert.equal(importResult[0].path, '/Game/SM_Example.SM_Example');
  assert.equal(observed.at(-1).args.source, 'example.fbx', 'bridge sends a project-relative path to UE');
  assert(!(await fs.readdir(dir)).some(name => /request|response|processing/.test(name)));
  await Promise.all([assert.rejects(bridge.command(project, 'blueprint_compile'), /fixture compile failure/), serve({}, false)]);
  await assert.rejects(bridge.command(project, 'unknown'), /Неизвестная/);
  await assert.rejects(bridge.command(project, 'describe', []), /JSON/);
  await assert.rejects(bridge.command(project, 'describe', { value: 'x'.repeat(300000) }), /256/);
  await assert.rejects(bridge.command(project, 'actor_spawn', {}, { timeoutMs: 100 }), /Результат операции неизвестен/);
  assert(!(await fs.readdir(dir)).some(name => name.endsWith('.request.json')), 'timeout removes unclaimed mutation');
  const controller = new AbortController();
  const aborted = bridge.command(project, 'actor_spawn', {}, { signal: controller.signal });
  const rejection = assert.rejects(aborted, /abort/i);
  await delay(25); controller.abort(); await rejection;
  assert(!(await fs.readdir(dir)).some(name => name.endsWith('.request.json')), 'cancel removes queued mutation');
  await heartbeat('old-instance', Date.now() / 1000 - 60);
  await assert.rejects(bridge.command(project, 'actor_spawn'), /Мост не отвечает/);
  await heartbeat();
  console.log('PASS: .uproject discovery, reversible installation, editor handshake, JSON transport, failures, timeout/cancellation and stale editor protection');

  const { Context } = await load('cordis'); ctx = new Context();
  for (const name of ['dsh-session', 'dsh-session-projection', 'dsh-llm', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-agent-loop', 'dsh-jobs-local', 'dsh-tool-jobs']) { const module = await load(name); await ctx.plugin(module.default ?? module, {}); }
  await ctx.plugin(await import(pathToFileURL(join(archive, 'dsh/node_modules/@qcoderi/unreal/index.js')).href));
  for (let i = 0; i < 100 && !ctx.tools?.get('unreal_command'); i++) await delay(10);
  parent = await ctx.agents.create({ sessionId: 'unreal-fixture', agentOptions: { provider: 'fixture', model: 'deepseek-selected-fixture' }, meta: { cwd: home } });
  const agent = parent.agent;
  const schemas = ctx.tools.schemas(agent);
  for (const name of ['unreal_status', 'unreal_setup', 'unreal_command', 'unreal_build_bridge']) assert(schemas.some(s => s.name === name), name);
  const execution = ctx.tools.execute({ name: 'unreal_command', arguments: { action: 'scene_list' }, callId: 'ue-native-1', agent, signal: new AbortController().signal });
  const native = (await Promise.all([execution, serve({ actors: [{ label: 'FixtureFloor' }] })]))[0];
  assert(!native.isError, JSON.stringify(native)); assert(JSON.stringify(native).includes('FixtureFloor'));
  assert.equal(agent.options.model, 'deepseek-selected-fixture', 'profile does not replace selected model');
  console.log('PASS: real Cordis/Tools/Agent runtime exposes UE tools, dispatches workspace command and preserves selected model');
  const { LlmAdapter, createUserMessage } = await load('dsh-llm');
  let requests = 0;
  class UnrealAdapter extends LlmAdapter {
    async *stream(options) {
      requests++;
      assert.equal(options.model, 'deepseek-selected-fixture');
      assert(options.tools.some(tool => tool.name === 'unreal_command'));
      if (requests === 1) yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'model-ue-call', name: 'unreal_command', arguments: JSON.stringify({ action: 'widget_tree', arguments_json: JSON.stringify({ blueprint: '/Game/UI/WBP_Menu' }) }) } };
      else {
        assert(JSON.stringify(options.messages).includes('NativeTitle'));
        yield { type: 'text-delta', index: 0, text: 'Проверено дерево виджетов: NativeTitle' };
      }
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['fixture'], new UnrealAdapter());
  await heartbeat();
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Проверь меню в UE' }], source: { kind: 'user' } }));
  await Promise.all([agent.whenIdle(), serve({ widgets: [{ name: 'NativeTitle' }] })]);
  assert.equal(requests, 2, 'model calls editor tool, consumes its response and answers');
  console.log('PASS: selected-model AgentLoop -> unreal_command -> editor transport -> real tool result -> second model request');
} finally {
  await parent?.dispose(); await ctx?.fiber.dispose();
  await fs.rm(home, { recursive: true, force: true });
}
