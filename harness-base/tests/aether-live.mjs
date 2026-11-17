import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';

assert.equal(process.platform, 'win32', 'This live test requires the packaged Windows application');
assert(process.env.HARNESS_ARCHIVE, 'Run with scripts/test-next-runtime.mjs aether-live.mjs');
const base = resolve(fileURLToPath(new URL('..', import.meta.url)));
const archive = resolve(process.env.HARNESS_ARCHIVE);
const packages = join(archive, 'dsh/node_modules');
const executable = resolve(process.env.QCODERI_AETHER_EXE ?? 'G:\\IAAnimeshAETHER\\dist\\AetherMotionStudio\\AetherMotionStudio.exe');
const appDirectory = dirname(executable);
const runtimeDirectory = join(appDirectory, '.runtime');
let protectedPid = process.env.QCODERI_AETHER_PROTECTED_PID === undefined ? undefined : Number(process.env.QCODERI_AETHER_PROTECTED_PID);
assert(protectedPid === undefined || (Number.isSafeInteger(protectedPid) && protectedPid > 0), 'QCODERI_AETHER_PROTECTED_PID must be a positive PID');
const run = promisify(execFile);
const load = name => import(pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href);
const { discoverSessions, callSession } = await import(pathToFileURL(join(packages, '@qcoderi/aether/bridge.js')).href);
const home = await fs.mkdtemp(join(base, 'tests/.runtime/aether-live-'));
const evidencePath = join(home, 'evidence.json');
const evidence = { started_at: new Date().toISOString(), executable, home, checks: [] };
const capturePaths = new Set();
const controller = new AbortController();
const watchdog = setTimeout(() => controller.abort(new Error('AETHER live test exceeded 120 seconds')), 120000);
let editor;
let launchStartedAt;
let rootIdentity;
let ownedChain;
let ownedSession;
let protectedIdentity;
let protectedRevision;
let ctx;
let agentHandle;
let failure;

function inside(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return path && !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
}

async function processSnapshot() {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$rows = @(Get-CimInstance Win32_Process | ForEach-Object {
  [pscustomobject]@{
    pid = [int]$_.ProcessId
    parent_pid = [int]$_.ParentProcessId
    path = $_.ExecutablePath
    created_at = $_.CreationDate.ToUniversalTime().ToString('o')
  }
})
ConvertTo-Json -InputObject $rows -Compress
`;
  const { stdout } = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
}

function sameProcess(left, right) {
  return left && right && left.pid === right.pid && left.created_at === right.created_at
    && left.path?.toLowerCase() === right.path?.toLowerCase();
}

function chainToRoot(pid, processes, rootPid = editor.pid) {
  const lookup = new Map(processes.map(process => [process.pid, process]));
  const chain = [];
  const visited = new Set();
  let current = lookup.get(pid);
  while (current && !visited.has(current.pid)) {
    chain.push(current);
    if (current.pid === rootPid) return chain;
    visited.add(current.pid);
    current = lookup.get(current.parent_pid);
  }
  return null;
}

async function stopOwnedEditor() {
  if (!editor?.pid) return;
  const processes = await processSnapshot();
  const currentRoot = processes.find(process => process.pid === editor.pid);
  let killPid;
  if (currentRoot) {
    assert.equal(currentRoot.parent_pid, process.pid, 'Cleanup root must belong to this Node test process');
    assert.equal(currentRoot.path?.toLowerCase(), executable.toLowerCase(), 'Cleanup root must use the spawned executable');
    if (!rootIdentity) {
      assert.equal(editor.exitCode, null, 'The tracked child must still be running when recovering its identity');
      assert.equal(editor.signalCode, null);
      assert(Date.parse(currentRoot.created_at) >= launchStartedAt - 1000, 'Recovered root must have been created by this launch');
      rootIdentity = currentRoot;
    }
    assert(sameProcess(currentRoot, rootIdentity), 'Spawned root identity changed before cleanup');
    killPid = currentRoot.pid;
  } else if (ownedChain) {
    const currentSession = processes.find(process => process.pid === ownedChain[0].pid);
    if (currentSession) {
      assert(sameProcess(currentSession, ownedChain[0]), 'Owned editor identity changed before cleanup');
      const currentChain = chainToRoot(currentSession.pid, [...processes, rootIdentity]);
      assert(currentChain, 'Orphaned owned editor must retain its recorded parent chain');
      for (const process of currentChain) {
        const recorded = ownedChain.find(item => item.pid === process.pid);
        assert(recorded && sameProcess(process, recorded), 'Recorded editor ancestor changed before cleanup');
      }
      killPid = currentSession.pid;
    }
  }
  if (killPid) {
    const descendants = processes.filter(process => chainToRoot(process.pid, processes, killPid));
    assert.notEqual(killPid, protectedPid);
    assert(descendants.every(process => process.pid !== protectedPid), 'Protected user editor must remain outside the owned tree');
    await run('taskkill.exe', ['/PID', String(killPid), '/T', '/F'], { windowsHide: true, timeout: 15000 });
    for (let attempt = 0; attempt < 30; attempt++) {
      if (editor.exitCode !== null || editor.signalCode !== null) break;
      await delay(100);
    }
    const after = await processSnapshot();
    assert(!after.some(process => sameProcess(process, rootIdentity)), 'Owned root must terminate');
    assert(!ownedChain || !after.some(process => sameProcess(process, ownedChain[0])), 'Owned editor child must terminate');
    evidence.cleanup = { terminated_owned_pid: killPid, owned_processes_stopped: true };
  } else evidence.cleanup = { owned_processes_stopped: true, already_exited: true };
  if (ownedSession) {
    const currentMetadata = (await discoverSessions({ runtimeDir: runtimeDirectory })).find(session => session.pid === ownedSession.pid);
    const metadataMatches = currentMetadata?.id === ownedSession.id && currentMetadata?.socket === ownedSession.socket
      && currentMetadata?.protocol === ownedSession.protocol;
    if (metadataMatches) {
      for (const name of [`bridge-${ownedSession.pid}.json`, `audit-${ownedSession.pid}.jsonl`]) {
        await fs.rm(join(runtimeDirectory, name), { force: true });
      }
    }
    evidence.cleanup.session_metadata_removed = metadataMatches;
  }
}

function capturePath(text) {
  const path = text.split('\n').find(line => isAbsolute(line) && line.toLowerCase().endsWith('.png'));
  assert(path && inside(join(appDirectory, 'artifacts/captures'), path), 'Capture must belong to the application capture directory');
  capturePaths.add(path);
  return path;
}

async function recordImage(ref, text, filename) {
  capturePath(text);
  assert(ref?.attachmentId && ref.width > 0 && ref.height > 0 && ref.bytes > 100, 'Viewport must produce a real image attachment');
  const source = ctx.attachments.imageHostPath(ref);
  assert(inside(home, source), 'Image attachment must remain in the test-owned profile');
  const path = join(home, filename);
  await fs.copyFile(source, path);
  const bytes = await fs.readFile(path);
  assert(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Stored viewport must contain PNG pixels');
  assert.equal(bytes.readUInt32BE(16), ref.width);
  assert.equal(bytes.readUInt32BE(20), ref.height);
  return { path, attachment_id: ref.attachmentId, width: ref.width, height: ref.height,
    bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

try {
  await fs.access(executable);
  const initialSessions = await discoverSessions({ home: appDirectory });
  if (protectedPid === undefined) {
    for (const session of initialSessions) {
      try {
        const state = await callSession(session, 'bridge.get_session', {}, { timeoutMs: 1500 });
        if (state.result?.data?.pid === session.pid && state.result.data.live_document === true) {
          protectedPid = session.pid;
          break;
        }
      } catch { /* An old metadata file can outlive its editor. */ }
    }
  }
  protectedIdentity = (await processSnapshot()).find(process => process.pid === protectedPid);
  const baselineSockets = new Map(initialSessions.map(session => [session.metadata_path.toLowerCase(), session.socket]));
  const protectedSession = initialSessions.find(session => session.pid === protectedPid);
  if (protectedSession) protectedRevision = (await callSession(protectedSession, 'bridge.get_session')).result.revision;
  evidence.protected_user_editor = { pid: protectedPid, present_before: Boolean(protectedIdentity), revision_before: protectedRevision };
  const seedProject = join(home, 'seed.aemotion');
  await fs.writeFile(seedProject, JSON.stringify({ schema_version: 1, name: 'QCoderI isolated E2E', objects: [], clips: [],
    active_clip_id: null, settings: { fps: 30 }, metadata: { purpose: 'qcoderi-live-test' } }, null, 2));
  for (const directory of ['profile/AppData/Roaming', 'profile/AppData/Local', 'profile/config', 'profile/cache']) {
    await fs.mkdir(join(home, directory), { recursive: true });
  }
  launchStartedAt = Date.now();
  editor = spawn(executable, ['--project', seedProject], { cwd: appDirectory, windowsHide: true, shell: false,
    stdio: 'ignore', env: { ...process.env, QT_QPA_PLATFORM: 'offscreen',
      APPDATA: join(home, 'profile/AppData/Roaming'), LOCALAPPDATA: join(home, 'profile/AppData/Local'),
      XDG_CONFIG_HOME: join(home, 'profile/config'), XDG_CACHE_HOME: join(home, 'profile/cache') } });
  await new Promise((resolveSpawn, reject) => { editor.once('spawn', resolveSpawn); editor.once('error', reject); });
  editor.on('error', () => {});
  assert.notEqual(editor.pid, protectedPid);
  rootIdentity = (await processSnapshot()).find(process => process.pid === editor.pid);
  assert(rootIdentity, 'Tracked editor root must remain alive after launch');
  assert.equal(rootIdentity.parent_pid, process.pid);
  assert.equal(rootIdentity.path.toLowerCase(), executable.toLowerCase());
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !ownedSession) {
    controller.signal.throwIfAborted();
    if (editor.exitCode !== null) throw new Error(`Owned editor exited before creating a session (${editor.exitCode})`);
    const candidates = (await discoverSessions({ home: appDirectory }))
      .filter(session => baselineSockets.get(session.metadata_path.toLowerCase()) !== session.socket && session.pid !== protectedPid);
    if (candidates.length) {
      const processes = await processSnapshot();
      assert(sameProcess(processes.find(process => process.pid === editor.pid), rootIdentity), 'Tracked root identity changed during launch');
      for (const candidate of candidates) {
        const chain = chainToRoot(candidate.pid, processes);
        if (!chain) continue;
        assert(chain.every(process => process.pid !== protectedPid && process.path?.toLowerCase() === executable.toLowerCase()));
        const response = await callSession(candidate, 'bridge.get_session', {}, { signal: controller.signal, timeoutMs: 1500 });
        if (response.result?.data?.pid === candidate.pid) {
          ownedSession = candidate;
          ownedChain = chain;
          break;
        }
      }
    }
    if (!ownedSession) await delay(250, undefined, { signal: controller.signal });
  }
  assert(ownedSession, 'A new session belonging to the spawned process tree must become available');
  evidence.ownership = { root: rootIdentity, session: ownedSession, process_chain: ownedChain, qt_platform: 'offscreen' };

  const { Context } = await load('cordis');
  const { LlmAdapter, createUserMessage } = await load('dsh-llm');
  ctx = new Context();
  for (const name of ['dsh-session', 'dsh-session-projection', 'dsh-llm', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-agent-loop']) {
    const module = await load(name);
    await ctx.plugin(module.default ?? module, {});
  }
  await ctx.plugin((await load('dsh-attachment-local')).default, { dshHome: join(home, 'profile') });
  await ctx.plugin(await import(pathToFileURL(join(packages, '@qcoderi/aether/index.js')).href));
  for (let attempt = 0; attempt < 200 && (!ctx.tools?.get('aether_command') || !ctx.get('attachments')); attempt++) await delay(10);
  assert(ctx.tools?.get('aether_command') && ctx.get('attachments'), 'Native tools and local attachment storage must initialize');
  agentHandle = await ctx.agents.create({ sessionId: `aether-live-${editor.pid}`, meta: { cwd: home },
    agentOptions: { provider: 'fixture', model: 'selected-live-aether-model' } });
  const agent = agentHandle.agent;
  let callId = 0;
  const execute = (name, args = {}) => ctx.tools.execute({ name,
    arguments: { app_directory: appDirectory, session: ownedSession.id, ...args },
    callId: `aether-live-${++callId}`, agent, signal: controller.signal });
  const successful = async (name, args) => {
    const result = await execute(name, args);
    assert(!result.isError, JSON.stringify(result));
    return typeof result.value === 'string' ? JSON.parse(result.value) : result.value;
  };
  const status = await successful('aether_status');
  assert.equal(status.sessions.length, 1);
  assert.equal(status.sessions[0].pid, ownedSession.pid);
  assert.equal(status.connected, true);
  assert.equal(status.scene.data.object_count, 0);
  assert.equal(status.scene.data.name, 'QCoderI isolated E2E');
  const catalog = await successful('aether_tools');
  assert(catalog.tools.some(tool => tool.name === 'scene.create_object' && tool.implemented));
  const transformSchema = await successful('aether_tools', { method: 'scene.set_transform' });
  assert(transformSchema.tool.arguments_schema.properties.position);
  evidence.checks.push({ name: 'native_status_and_tool_schemas', revision: status.scene.revision, tools: catalog.tools.length });
  let revision = status.scene.revision;
  const command = async (method, args = {}) => {
    const result = await successful('aether_command', { method, arguments: args, expected_revision: revision });
    revision = result.revision;
    evidence.checks.push({ name: method, revision, changed_ids: result.changed_ids });
    return result;
  };
  const created = await command('scene.create_object', { primitive: 'cube', name: 'Live E2E Cube', color: [0.25, 0.65, 0.95] });
  const objectId = created.data.object_id;
  const staleRevision = revision;
  await command('scene.set_transform', { object_id: objectId, position: [0.8, 0.5, -0.25], rotation: [0, 35, 0], scale: [1.2, 1.1, 1] });
  const transformed = await command('scene.get_object', { object_id: objectId });
  assert.deepEqual(transformed.data.object.transform.position, [0.8, 0.5, -0.25]);
  assert.equal(transformed.data.object.mesh.geometry_omitted, true);
  const conflict = await execute('aether_command', { method: 'scene.rename_object',
    arguments: { object_id: objectId, name: 'Rejected stale mutation' }, expected_revision: staleRevision });
  assert.equal(conflict.isError, true);
  assert(JSON.stringify(conflict).includes('REVISION_CONFLICT'));
  assert.equal((await command('scene.get_object', { object_id: objectId })).data.object.name, 'Live E2E Cube');
  evidence.checks.push({ name: 'expected_revision_conflict', rejected: true, revision });
  const beforeBatch = revision;
  const batch = await command('system.batch', { commands: [
    { tool: 'animation.create_clip', arguments: { name: 'Live E2E motion', duration: 1.5 } },
    { tool: 'animation.set_keyframe', arguments: { object_id: objectId, channel: 'position', time: 0, value: [0, 0.5, 0] } },
    { tool: 'animation.set_keyframe', arguments: { object_id: objectId, channel: 'position', time: 1.5, value: [1.5, 0.5, 0] } },
    { tool: 'animation.set_keyframe', arguments: { object_id: objectId, channel: 'rotation', time: 0, value: [0, 0, 0] } },
    { tool: 'animation.set_keyframe', arguments: { object_id: objectId, channel: 'rotation', time: 1.5, value: [0, 90, 0] } },
    { tool: 'animation.set_fps', arguments: { fps: 60 } },
  ] });
  assert.equal(batch.data.results.length, 6);
  assert.equal(revision, beforeBatch + 1, 'Atomic animation batch commits one revision');
  assert.equal((await command('scene.get_summary')).data.clip_count, 1);
  await command('history.undo');
  assert.equal((await command('scene.get_summary')).data.clip_count, 0);
  await command('history.redo');
  assert.equal((await command('scene.get_summary')).data.clip_count, 1);
  const validation = await command('validation.run');
  assert.equal(validation.data.status, 'pass');
  assert.equal(validation.data.metrics.objects, 1);
  assert.equal(validation.data.metrics.clips, 1);
  evidence.validation = validation.data;
  const savedPath = join(home, 'scene.aemotion');
  await command('project.save', { path: savedPath });
  const saved = JSON.parse(await fs.readFile(savedPath, 'utf8'));
  assert.equal(saved.settings.fps, 60);
  assert.equal(saved.objects[0].id, objectId);
  assert.equal(saved.clips[0].tracks.length, 2);
  assert(saved.clips[0].tracks.every(track => track.keys.length === 2));
  await command('scene.rename_object', { object_id: objectId, name: 'Unsaved test change' });
  await command('project.load', { path: savedPath });
  assert.equal((await command('scene.get_object', { object_id: objectId })).data.object.name, 'Live E2E Cube');
  assert.equal((await command('scene.get_summary')).data.dirty, false);
  evidence.project = { path: savedPath, object_id: objectId, object_count: saved.objects.length, clip_count: saved.clips.length };
  const viewport = await successful('aether_viewport', { caption: 'Live packaged AETHER E2E viewport' });
  evidence.viewport = await recordImage(viewport.image, viewport.text, 'viewport.png');

  let modelCalls = 0;
  let loopImage;
  let loopText;
  class LiveAdapter extends LlmAdapter {
    resolveModel(provider, id) { return Promise.resolve({ provider, id, name: id, inputModalities: ['text', 'image'] }); }
    async *stream(options) {
      modelCalls++;
      assert.equal(options.model, 'selected-live-aether-model');
      assert(options.tools.some(tool => tool.name === 'aether_viewport'));
      if (modelCalls === 1) {
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'live-viewport-call', name: 'aether_viewport',
          arguments: JSON.stringify({ app_directory: appDirectory, session: ownedSession.id, caption: 'AgentLoop live AETHER viewport' }) } };
      } else {
        const results = options.messages.flatMap(message => message.content).filter(block => block.type === 'tool-result');
        assert.equal(results.length, 1);
        assert.equal(results[0].isError, false);
        loopImage = results[0].content.find(block => block.type === 'image')?.attachment;
        loopText = results[0].content.find(block => block.type === 'text')?.text;
        assert(loopImage?.attachmentId, 'The next model request must receive the actual live viewport image');
        assert(loopText.includes('AgentLoop live AETHER viewport'));
        yield { type: 'text-delta', index: 0, text: 'Live viewport inspected.' };
      }
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['fixture'], new LiveAdapter());
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect the live isolated AETHER viewport.' }], source: { kind: 'user' } }));
  let onAbort;
  try {
    await Promise.race([agent.whenIdle(), new Promise((_resolve, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    })]);
  } finally { controller.signal.removeEventListener('abort', onAbort); }
  assert.equal(modelCalls, 2);
  const events = agent.session.snapshotEvents();
  assert.equal(events.findLast(event => event.type === 'turn/end')?.data.reason.kind, 'completed');
  assert.equal(agent.options.model, 'selected-live-aether-model');
  evidence.agent_loop = { model_calls: modelCalls, selected_model: agent.options.model,
    completed: true, image: await recordImage(loopImage, loopText, 'agent-loop-viewport.png') };
  evidence.checks.push({ name: 'native_tools_agent_loop_image_roundtrip', passed: true });
} catch (error) {
  failure = error;
} finally {
  clearTimeout(watchdog);
  const cleanupErrors = [];
  for (const cleanup of [async () => agentHandle?.dispose(), async () => ctx?.fiber.dispose(), stopOwnedEditor]) {
    try { await cleanup(); } catch (error) { cleanupErrors.push(error); }
  }
  for (const path of capturePaths) {
    try { await fs.rm(path, { force: true }); } catch (error) { cleanupErrors.push(error); }
  }
  try {
    const after = (await processSnapshot()).find(process => process.pid === protectedPid);
    if (protectedIdentity) assert(sameProcess(after, protectedIdentity), 'The protected user editor must retain its original process identity');
    const protectedSession = (await discoverSessions({ home: appDirectory })).find(session => session.pid === protectedPid);
    let afterRevision;
    if (protectedSession && protectedRevision !== undefined) {
      afterRevision = (await callSession(protectedSession, 'bridge.get_session')).result.revision;
      assert.equal(afterRevision, protectedRevision, 'The protected user document revision must remain unchanged');
    }
    evidence.protected_user_editor = { ...evidence.protected_user_editor,
      present_after: Boolean(after), identity_preserved: !protectedIdentity || sameProcess(after, protectedIdentity), revision_after: afterRevision };
  } catch (error) { cleanupErrors.push(error); }
  evidence.finished_at = new Date().toISOString();
  evidence.passed = !failure && cleanupErrors.length === 0;
  if (failure) evidence.failure = { name: failure.name, message: failure.message };
  if (cleanupErrors.length) evidence.cleanup_errors = cleanupErrors.map(error => ({ name: error.name, message: error.message }));
  await fs.writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  if (cleanupErrors.length) failure = new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'AETHER live test or cleanup failed');
}
if (failure) throw failure;
console.log('PASS packaged offscreen AETHER, owned process isolation, native Cordis tools, transactional animation, project persistence and image AgentLoop');
console.log(`Evidence ${evidencePath}`);
