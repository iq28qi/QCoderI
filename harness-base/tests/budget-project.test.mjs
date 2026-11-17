// Focused budget lineage tests. Local temporary files only; no credential/network
// access and no staged/live source patching. Real services are imported read-only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBudgetProjectResolver } from '../assets/team/budget-project.js';
import { BudgetError, projectBudgetKey } from '../assets/team/usage-ledger.js';
import { createUsageBudget } from '../assets/team/usage-budget.js';

const canonical = path => {
  const value = realpathSync.native(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
};
const header = (id, meta = {}) => Object.freeze({ version: 3, id, createdAt: 1, isSeeded: false, ...meta });
const child = (id, parentSession, cwd) => header(id, { parentSession, origin: 'subagent', delegationDepth: 1, ...(cwd === undefined ? {} : { cwd }) });
const code = expected => error => {
  assert(error instanceof BudgetError, `${error?.constructor?.name}: ${error?.message}`);
  assert.equal(error.code, expected);
  assert.equal(error.failure.code, expected);
  return true;
};
function fixture({ live = [], persisted = [], persistence = true } = {}) {
  const sessions = new Map(live.map(h => [h.id, Object.freeze({ id: h.id, header: h })]));
  const stored = new Map(persisted.map(h => [h.id, Object.freeze({ header: h, revision: 'fixture-revision' })]));
  const reads = [];
  // Shape matches the real services: SessionStore.get is synchronous;
  // ctx.get is the optional Cordis lookup; stat is async and returns a snapshot,
  // NOT a Session, array, header directly, or {session: ...} wrapper.
  const service = { async stat(id) { reads.push(id); return stored.get(id); } };
  const ctx = {
    sessions: { get: id => sessions.get(id) },
    get(name) { assert.equal(name, 'sessionPersistence'); return persistence ? service : undefined; },
    get agents() { assert.fail('Agent presence is not lineage authority'); }
  };
  return { ctx, sessions, stored, reads, service, resolve: createBudgetProjectResolver(ctx) };
}
function paths(t) {
  const home = mkdtempSync(join(tmpdir(), 'qc-budget-project-'));
  const cleanups = [];
  t.after(async () => {
    try { for (const cleanup of cleanups.reverse()) await cleanup(); }
    finally { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
  const project = join(home, 'original'), worktree = join(home, 'worktree'), alternate = join(home, 'other-project');
  for (const path of [project, worktree, alternate]) mkdirSync(path);
  return { home, project, worktree, alternate, beforeRemove: cleanup => cleanups.push(cleanup) };
}

// Do not read project/prompt/purpose/context fields even as a purported hint.
const hostile = sessionId => Object.defineProperties({ sessionId }, Object.fromEntries(
  ['project', 'cwd', 'prompt', 'purpose', 'parentSession'].map(key => [key, { get() { assert.fail(`Untrusted ${key} was read`); } }])
));

test('top-level cwd is canonical and request/context project claims are ignored', async t => {
  const { project, alternate } = paths(t);
  const f = fixture({ live: [header('root', { cwd: join(project, '..', 'original') })] });
  assert.equal(await f.resolve(hostile('root'), { project: alternate, agent: { session: { header: { cwd: alternate } } } }), canonical(project));
  assert.deepEqual(f.reads, []);
});

test('worktree child and grandchild resolve persisted original parent without loaded agents', async t => {
  const { project, worktree, alternate } = paths(t);
  const f = fixture({ live: [child('grandchild', 'child', alternate)], persisted: [child('child', 'root', worktree), header('root', { cwd: project })] });
  assert.equal(await f.resolve(hostile('grandchild')), canonical(project));
  assert.deepEqual(f.reads, ['child', 'root']);
  assert.equal(projectBudgetKey(await f.resolve({ sessionId: 'grandchild', project: alternate })), projectBudgetKey(project));
  assert.notEqual(projectBudgetKey(project), projectBudgetKey(worktree));
});

test('cold initiating session and forked/seeded history retain persisted parentSession', async t => {
  const { project, worktree } = paths(t);
  const f = fixture({ persisted: [header('fork', { cwd: worktree, isSeeded: true, parentSession: 'root' }), header('root', { cwd: project })] });
  assert.equal(await f.resolve({ sessionId: 'fork', purpose: 'compaction' }), canonical(project));
  assert.deepEqual(f.reads, ['fork', 'root']);
});

test('missing parent never falls back to child cwd or request.project', async t => {
  const { project, worktree } = paths(t);
  const f = fixture({ live: [child('child', 'missing', worktree)] });
  await assert.rejects(f.resolve({ sessionId: 'child', project, purpose: 'compaction', prompt: project }), code('BUDGET_PARENT_SESSION_NOT_FOUND'));
});

test('missing persistence is allowed for live roots but cannot erase a cold parent', async t => {
  const { project, worktree } = paths(t);
  const f = fixture({ live: [header('root', { cwd: project }), child('child', 'cold', worktree)], persistence: false });
  assert.equal(await f.resolve({ sessionId: 'root' }), canonical(project));
  await assert.rejects(f.resolve({ sessionId: 'child', project }), code('BUDGET_PARENT_SESSION_NOT_FOUND'));
});

test('known cwd-less top-level can return undefined; descendant attribution cannot', async t => {
  const { worktree } = paths(t);
  const f = fixture({ live: [header('root'), child('child', 'root', worktree)] });
  assert.equal(await f.resolve(hostile('root')), undefined);
  await assert.rejects(f.resolve({ sessionId: 'child' }), code('BUDGET_PROJECT_REQUIRED'));
});

test('unknown and anonymous sessions fail closed regardless of claimed project/purpose', async t => {
  const { project } = paths(t);
  const f = fixture();
  await assert.rejects(f.resolve({ sessionId: 'unknown', project, purpose: 'compaction' }), code('BUDGET_SESSION_NOT_FOUND'));
  await assert.rejects(f.resolve({ project }), code('BUDGET_SESSION_REQUIRED'));
  for (const value of ['', null, 4, {}, ' root', 'root\n', '\0']) {
    await assert.rejects(f.resolve({ sessionId: value, project }), code('BUDGET_INVALID_SESSION_ID'));
  }
});

test('orphan subagent, depth marker, or fork marker cannot impersonate a root', async t => {
  const { project } = paths(t);
  for (const meta of [{ origin: 'subagent' }, { delegationDepth: 2 }, { isSeeded: true }]) {
    const f = fixture({ live: [header('orphan', { cwd: project, ...meta })] });
    await assert.rejects(f.resolve({ sessionId: 'orphan' }), code('BUDGET_PARENT_SESSION_REQUIRED'));
  }
});

test('self-cycle and persisted multi-hop cycles are typed refusals', async t => {
  const { project } = paths(t);
  const self = fixture({ live: [child('self', 'self', project)] });
  await assert.rejects(self.resolve({ sessionId: 'self' }), code('BUDGET_SESSION_CYCLE'));
  const f = fixture({ live: [child('a', 'b', project)], persisted: [child('b', 'c', project), child('c', 'a', project)] });
  await assert.rejects(f.resolve({ sessionId: 'a' }), code('BUDGET_SESSION_CYCLE'));
  assert.deepEqual(f.reads, ['b', 'c']);
});

test('depth limit bounds reads and does not admit the last child cwd', async t => {
  const { project } = paths(t);
  const persisted = Array.from({ length: 127 }, (_, i) => child(`node-${i + 1}`, `node-${i + 2}`, project));
  persisted.push(header('node-128', { cwd: project }));
  const f = fixture({ live: [child('node-0', 'node-1', project)], persisted });
  await assert.rejects(f.resolve({ sessionId: 'node-0' }), code('BUDGET_SESSION_DEPTH_LIMIT'));
  assert.equal(f.reads.length, 127);
  assert(!f.reads.includes('node-128'));
  // Exact inclusive limit: 128 sessions, not 128 parent hops.
  f.stored.set('node-127', { header: header('node-127', { cwd: project }), revision: 'at-limit' });
  assert.equal(await f.resolve({ sessionId: 'node-0' }), canonical(project));
});

test('malformed or identity-mismatched service snapshots fail closed', async t => {
  const { project } = paths(t);
  const malformed = [null, [], {}, header('wrong', { cwd: project }), header('id', { version: 99, cwd: project }),
    header('id', { parentSession: '' }), header('id', { parentSession: null }), header('id', { parentSession: 7 }),
    header('id', { createdAt: NaN }), header('id', { isSeeded: 'false' }), header('id', { delegationDepth: -1 })];
  for (const value of malformed) {
    const f = fixture(); f.stored.set('id', { header: value, revision: 'bad' });
    await assert.rejects(f.resolve({ sessionId: 'id' }), code('BUDGET_INVALID_SESSION_HEADER'));
  }
  for (const value of [[], {}, { header: undefined }, header('id', { cwd: project })]) {
    const f = fixture(); f.stored.set('id', value);
    await assert.rejects(f.resolve({ sessionId: 'id' }), code('BUDGET_INVALID_SESSION_HEADER'));
  }
  const f = fixture(); f.sessions.set('id', { id: 'other', header: header('id', { cwd: project }) });
  await assert.rejects(f.resolve({ sessionId: 'id' }), code('BUDGET_INVALID_SESSION_HEADER'));
  f.sessions.set('id', { id: 'id' });
  await assert.rejects(f.resolve({ sessionId: 'id' }), code('BUDGET_INVALID_SESSION_HEADER'));
});

test('backend exceptions and invalid service APIs are BudgetError, never cwd fallbacks', async t => {
  const { worktree } = paths(t);
  const f = fixture({ live: [child('child', 'parent', worktree)] });
  const cause = new Error('fixture persistence corruption');
  f.service.stat = async () => { throw cause; };
  await assert.rejects(f.resolve({ sessionId: 'child' }), error => {
    code('BUDGET_SESSION_READ_FAILED')(error); assert.equal(error.cause, cause); return true;
  });
  delete f.service.stat;
  await assert.rejects(f.resolve({ sessionId: 'child' }), code('BUDGET_SESSION_SERVICE_REQUIRED'));
  await assert.rejects(createBudgetProjectResolver({})({ sessionId: 'child' }), code('BUDGET_SESSION_SERVICE_REQUIRED'));
});

test('invalid root paths, missing root and non-directory root refuse attribution', async t => {
  const { home, project } = paths(t);
  const invalid = ['', '.', 'relative/project', null, 4, `${project}\0`, ` ${project}`];
  if (process.platform === 'win32') invalid.push('C:relative', '\\current-drive', '\\\\?\\C:\\device-root',
    join(project, 'reserved:stream'), join(project, 'bad*name'), join(project, 'NUL'), join(project, 'ambiguous.'));
  for (const cwd of invalid) {
    const f = fixture({ live: [header('root', { cwd })] });
    await assert.rejects(f.resolve({ sessionId: 'root' }), code('BUDGET_INVALID_PROJECT_PATH'));
  }
  const missing = fixture({ live: [header('root', { cwd: join(home, 'removed') })] });
  await assert.rejects(missing.resolve({ sessionId: 'root' }), code('BUDGET_PROJECT_NOT_FOUND'));
  const file = join(home, 'not-a-directory'); writeFileSync(file, 'fixture');
  const nonDirectory = fixture({ live: [header('root', { cwd: file })] });
  await assert.rejects(nonDirectory.resolve({ sessionId: 'root' }), code('BUDGET_PROJECT_NOT_DIRECTORY'));
});

test('missing worktree is not needed, but invalid child cwd syntax is refused', async t => {
  const { home, project } = paths(t);
  const f = fixture({ live: [child('child', 'root', join(home, 'removed-worktree'))], persisted: [header('root', { cwd: project })] });
  assert.equal(await f.resolve({ sessionId: 'child' }), canonical(project));
  f.sessions.set('child', { id: 'child', header: child('child', 'root', 'relative-worktree') });
  await assert.rejects(f.resolve({ sessionId: 'child' }), code('BUDGET_INVALID_PROJECT_PATH'));
});

test('canonical symlink/junction original and direct original share project key', async t => {
  const { home, project } = paths(t);
  const alias = join(home, 'alias');
  symlinkSync(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const f = fixture({ live: [header('root', { cwd: alias })] });
  const resolved = await f.resolve({ sessionId: 'root' });
  assert.equal(resolved, canonical(project));
  assert.equal(projectBudgetKey(resolved), projectBudgetKey(project));
});

test('no attribution cache survives missing parent or resumed parent state', async t => {
  const { project, worktree } = paths(t);
  const f = fixture({ live: [child('child', 'root', worktree)], persisted: [header('root', { cwd: project })] });
  assert.equal(await f.resolve({ sessionId: 'child' }), canonical(project));
  f.stored.delete('root');
  await assert.rejects(f.resolve({ sessionId: 'child' }), code('BUDGET_PARENT_SESSION_NOT_FOUND'));
  f.sessions.set('root', { id: 'root', header: header('root', { cwd: project }) });
  assert.equal(await f.resolve({ sessionId: 'child' }), canonical(project));
  f.sessions.delete('root');
  await assert.rejects(f.resolve({ sessionId: 'child' }), code('BUDGET_PARENT_SESSION_NOT_FOUND'));
});

test('activated core shares original project cap across descendants and denies unknown before dispatch', async t => {
  const { home, project, worktree, beforeRemove } = paths(t);
  const f = fixture({ live: [header('root', { cwd: project }), child('child', 'root', worktree), child('grandchild', 'child', worktree)] });
  const human = Object.freeze({});
  const budget = createUsageBudget({ home: join(home, 'budget'), resolveProject: f.resolve, authorizeHuman: value => value === human,
    getTrustedBounds: () => ({ inputTokens: 3, maxOutputTokens: 2, coversEntireRequest: true, outputCapEnforced: true, singleAttempt: true }) });
  beforeRemove(() => budget.close());
  const prices = [{ provider: 'fixture', model: 'm', currency: 'USD', inputPerMillion: '1', outputPerMillion: '1', cacheReadPerMillion: '1', cacheWritePerMillion: '1', maxTokensIncludesReasoning: true }];
  let calls = 0;
  async function* dispatch() {
    calls++;
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  const collect = async (sessionId, purpose) => {
    for await (const _ of budget.intercept({ provider: 'fixture', model: 'm', sessionId, purpose, messages: [], project: worktree }, dispatch)) {}
  };
  budget.handle('configure', { scope: 'global', callsEnabled: true, moneyCapUsd: null, tokenCap: 100, prices }, human);
  budget.handle('configure', { scope: 'project', project, callsEnabled: true, moneyCapUsd: null, tokenCap: 10 }, human);
  await collect('root'); await collect('child', 'compaction');
  await assert.rejects(collect('grandchild', 'quality-review'), code('BUDGET_TOKEN_LIMIT'));
  await assert.rejects(collect('unknown', 'compaction'), code('BUDGET_SESSION_NOT_FOUND'));
  assert.equal(calls, 2, 'no dispatch/reservation for cap denial or unknown attribution');
  const scopes = budget.modelStatus().scopes;
  assert.equal(scopes.find(s => s.policy.scope === 'project').policy.key, projectBudgetKey(project));
  assert(scopes.every(s => s.spent.tokens === 10 && s.held.tokens === 0));
});

// Read the actual packages only from the local dependency archive; never patch
// them or load Workbench. An actual resume proves header shape/lifetime behavior.
const base = resolve(fileURLToPath(new URL('..', import.meta.url)));
const archive = resolve(process.env.HARNESS_ARCHIVE ?? join(base, 'source'));
const load = name => import(pathToFileURL(join(archive, 'dsh/node_modules/@deepseek-ai', name, 'lib/index.js')).href);

test('actual services: cold parent, agent resume, fork and real compaction request preserve original project', { timeout: 30000 }, async t => {
  const { home, project, worktree, beforeRemove } = paths(t);
  const { Context } = await load('cordis');
  const ctx = new Context();
  const handles = [];
  beforeRemove(async () => { try { for (const handle of handles.reverse()) await handle.dispose(); } finally { await ctx.fiber.dispose(); } });
  // If any service unexpectedly tries inference, fail before a network request.
  const oldFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Network is forbidden in lineage tests'); };
  t.after(() => { globalThis.fetch = oldFetch; });
  for (const name of ['dsh-session', 'dsh-session-projection', 'dsh-llm', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-agent-loop']) {
    await ctx.plugin((await load(name)).default, {});
  }
  await ctx.plugin((await load('dsh-session-persistence-jsonl')).default, { root: join(home, 'sessions'), compression: 'none' });
  const llm = await load('dsh-llm');
  const resolveProject = createBudgetProjectResolver(ctx);
  const observed = [];
  class FixtureAdapter extends llm.LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text'] }; }
    async *stream(options) {
      observed.push({ sessionId: options.sessionId, purpose: options.purpose, project: await resolveProject(options) });
      yield { type: 'text-delta', index: 0, text: 'fixture compacted summary' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['fixture'], new FixtureAdapter());
  const agentOptions = { provider: 'fixture', model: 'lineage-fixture' };
  let parent = await ctx.agents.create({ sessionId: 'actual-parent', meta: { cwd: project }, agentOptions });
  // Empty sessions are intentionally not materialized merely by close().
  // Use the actual awaited durability checkpoint before disposing/resuming.
  await ctx.sessions.flush(parent.agent.session);
  await parent.dispose();
  assert.equal(ctx.agents.get('actual-parent'), undefined);
  assert.equal(ctx.sessions.get('actual-parent'), undefined);
  const persisted = await ctx.get('sessionPersistence').stat('actual-parent');
  assert.equal(persisted.header.cwd, project);
  assert.equal(persisted.header.version, 3);
  assert.equal(typeof persisted.revision, 'string');

  const childHandle = await ctx.agents.create({ sessionId: 'actual-child', meta: { cwd: worktree, parentSession: 'actual-parent', origin: 'subagent', delegationDepth: 1 }, agentOptions });
  handles.push(childHandle);
  assert.equal(await resolveProject({ sessionId: childHandle.agent.id }), canonical(project));
  const fork = ctx.sessions.fork(childHandle.agent.session, undefined, 'actual-fork');
  assert.equal(fork.header.parentSession, childHandle.agent.id);
  assert.equal(fork.header.isSeeded, true);
  assert.equal(await resolveProject({ sessionId: fork.id }), canonical(project));

  parent = await ctx.agents.resume({ resumeSessionId: 'actual-parent', agentOptions });
  assert.equal(parent.agent.session.header.cwd, project);
  assert.equal(parent.agent.id, 'actual-parent');
  assert.equal(await resolveProject({ sessionId: fork.id }), canonical(project));
  await parent.dispose();
  assert.equal(await resolveProject({ sessionId: fork.id }), canonical(project));
  // Resume the child as well: no live parentAgent is supplied, so persisted
  // parentSession, not current ownership or the worktree cwd, must drive scope.
  await ctx.sessions.flush(childHandle.agent.session);
  await childHandle.dispose();
  const resumedChild = await ctx.agents.resume({ resumeSessionId: 'actual-child', agentOptions });
  handles.push(resumedChild);
  assert.equal(resumedChild.agent.session.header.parentSession, 'actual-parent');
  assert.equal(await resolveProject({ sessionId: resumedChild.agent.id }), canonical(project));

  const { BasicCompactionEngine } = await load('dsh-compaction-basic');
  const engine = { ctx, config: { summarizationProvider: 'fixture', summarizationModel: 'lineage-fixture', maxTokens: 100, modelPolicies: [] } };
  const summary = await BasicCompactionEngine.prototype.summarize.call(engine,
    { messages: [llm.createUserMessage({ content: [{ type: 'text', text: 'local fixture' }] })] }, resumedChild.agent);
  assert(summary.summary.some(block => block.text.includes('fixture compacted summary')));
  assert.deepEqual(observed, [{ sessionId: 'actual-child', purpose: 'compaction', project: canonical(project) }]);
  await assert.rejects(resolveProject({ sessionId: 'does-not-exist', project }), code('BUDGET_SESSION_NOT_FOUND'));
});
