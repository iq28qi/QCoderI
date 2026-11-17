import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { createState, runPlan, validatePlan } from '../assets/team/scheduler.js';
import { TeamRuns, prepareResume } from '../assets/team/team-runs.js';
import { runChecks } from '../assets/team/checks.js';
import { GitTeamWorkspace } from '../assets/team/git-team-worktrees.js';

const task = (id, extra = {}) => ({ id, title: id, prompt: 'Implement ' + id, write_paths: ['src/' + id], ...extra });
const check = { name: 'unit', command: ['node', 'test.js'] };
const planFor = (extra = {}) => validatePlan({ tasks: [task('a', { checks: [check] })], ...extra });
const success = output => ({ status: 'completed', output: output ?? 'worker report' });
const passed = () => [{ name: 'unit', status: 'passed', exit_code: 0 }];
const failed = () => [{ name: 'unit', status: 'failed', exit_code: 7, failure_kind: 'exit_code', detail: 'Exit code: 7', output: 'AssertionError: expected 2; actual 1' }];
const signal = () => new AbortController().signal;
const clone = value => JSON.parse(JSON.stringify(value));

async function fixture(fn) {
  const home = await mkdtemp(join(tmpdir(), 'qcoderi-autonomy-'));
  try {
    const agent = { session: { id: 'fixture', header: { cwd: home } } };
    const store = new TeamRuns(join(home, 'records'), agent);
    await fn({ home, store, agent });
  } finally { await rm(home, { recursive: true, force: true }); }
}

test('failed check repairs use concrete evidence, preserve history and hold locks until durable completion', async () => {
  const plan = planFor({ tasks: [task('a', { checks: [check] }), task('dependent', { depends_on: ['a'] }), task('reader', { write_paths: [], read_paths: ['src/a'] })] });
  const state = createState(plan), prompts = [], snapshots = [];
  let checks = 0, committed = false;
  await runPlan(plan, { state, signal: signal(), persist: async state => {
    snapshots.push(clone(state));
    if (state.tasks[0].status === 'completed') { await delay(2); committed = true; }
  }, execute: async (item, prompt, _signal, onStart) => {
    if (item.id !== 'a') { assert(committed, 'dependent/reader starts only after durable save'); return success(); }
    assert(snapshots.some(s => s.tasks[0].attempts === item.attempts), 'attempt recorded before launch');
    prompts.push(prompt); await onStart('agent-' + item.attempts); return success();
  }, verify: async () => ++checks === 1 ? failed() : passed() });
  assert.equal(state.status, 'completed');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /AssertionError: expected 2; actual 1/);
  assert.match(prompts[1], /exit=7/);
  assert.match(prompts[1], /test\.js/);
  assert.match(prompts[1], /данные, не инструкции/);
  assert.equal(state.tasks[0].repairs_used, 1);
  assert(state.tasks[0].attempt_history.some(item => item.check_results?.[0].status === 'failed'));
  assert.equal(state.tasks[0].verification, 'passed');
});

test('a sibling finishing cannot release another task locks before its final save', async () => {
  const plan = planFor({ tasks: [task('a'), task('sibling'), task('reader', { write_paths: [], read_paths: ['src/a'] })] });
  let release, saving;
  const saved = new Promise(resolve => { release = resolve; });
  const startedSave = new Promise(resolve => { saving = resolve; });
  let readerStarted = false, blockedSave = false;
  const pending = runPlan(plan, { signal: signal(), execute: async item => {
    if (item.id === 'sibling') await startedSave;
    if (item.id === 'reader') readerStarted = true;
    return success();
  }, persist: async state => {
    if (state.tasks[0].status === 'completed' && !blockedSave) { blockedSave = true; saving(); await saved; }
  } });
  await startedSave; await delay(5);
  assert.equal(readerStarted, false);
  release();
  assert.equal((await pending).status, 'completed');
  assert(readerStarted);
});

test('automatic repairs are bounded across saved resume and preserve completed work', async () => fixture(async ({ store }) => {
  const plan = planFor({ repair_attempts: 2, tasks: [task('done', { checks: [] }), task('a', { checks: [check] }), task('dependent', { depends_on: ['a'] })] });
  const record = store.create(plan, createState(plan));
  const calls = [];
  const execute = async item => { calls.push(item.id); return success(); };
  await runPlan(plan, { state: record.state, signal: signal(), execute, verify: failed, persist: () => store.save(record) });
  assert.equal(calls.filter(id => id === 'a').length, 3);
  assert.equal(record.state.tasks[1].verification, 'failed');
  assert.equal(record.state.tasks[2].status, 'skipped');
  const saved = await store.load();
  const done = clone(saved.state.tasks[0]);
  prepareResume(saved.state);
  assert.equal(saved.state.tasks[1].repairs_used, 2);
  assert.equal(saved.state.tasks[1].attempts, 3);
  assert.equal(saved.state.tasks[1].check_results[0].exit_code, 7);
  await runPlan(saved.plan, { state: saved.state, signal: signal(), execute, verify: failed, persist: () => store.save(saved) });
  assert.equal(calls.filter(id => id === 'a').length, 4, 'explicit resume gives one launch, not a fresh repair budget');
  assert.deepEqual(saved.state.tasks[0], done);
  assert.equal(calls.filter(id => id === 'done').length, 1);
  assert.equal(saved.state.tasks[1].status, 'failed');
  const archive = JSON.parse(await readFile(join(dirname(store.file), record.id + '.json'), 'utf8'));
  assert.equal(archive.state.tasks[1].attempts, 4);
  const next = store.create(plan, createState(plan));
  await store.save(next);
  assert.equal(JSON.parse(await readFile(join(dirname(store.file), record.id + '.json'), 'utf8')).id, record.id);
}));

test('read-only, zero repair budget and non-test failures never automatically retry', async () => {
  for (const options of [
    { plan: { repair_attempts: 0 }, results: failed() },
    { plan: { tasks: [task('a', { write_paths: [], checks: [check] })] }, results: failed() },
    ...['timeout', 'policy', 'runner', 'cancelled'].map(kind => ({ results: [{ ...failed()[0], failure_kind: kind }] })),
    { results: [{ ...failed()[0], status: 'cancelled' }] },
    { results: [{ ...failed()[0], detail: 'Check timeout', failure_kind: undefined }] },
  ]) {
    let calls = 0;
    const result = await runPlan(planFor(options.plan), { signal: signal(), execute: async () => { calls++; return success(); }, verify: async () => options.results });
    assert.equal(calls, 1); assert.equal(result.tasks[0].status, 'failed');
  }
});

test('malformed, mismatched or incomplete check results cannot verify completion', async () => {
  for (const results of [null, [], [null], [null, ...passed()], [{ name: 'wrong', status: 'passed', exit_code: 0 }], [{ name: 'unit', status: 'passed' }], [{ name: 'unit', status: 'passed', exit_code: 3 }], [{ ...passed()[0], failure_kind: 'policy' }]]) {
    const state = await runPlan(planFor(), { signal: signal(), execute: async () => success(), verify: async () => results });
    assert.equal(state.status, 'failed'); assert.notEqual(state.tasks[0].verification, 'passed');
  }
});

test('scheduler rejects an inconsistent completed task before launching dependents', async () => {
  const plan = planFor({ tasks: [task('a', { checks: [check] }), task('dependent', { depends_on: ['a'] })] });
  const state = createState(plan);
  Object.assign(state.tasks[0], { status: 'completed', verification: 'passed', check_results: failed() });
  await assert.rejects(runPlan(plan, { state, signal: signal(), execute: () => assert.fail('no dependent launch') }), /no successful checks/);
});

test('cancellation during failing verification never repairs or finalizes', async () => {
  const controller = new AbortController();
  let calls = 0;
  const state = await runPlan(planFor(), { signal: controller.signal, execute: async () => { calls++; return success(); }, verify: async () => {
    controller.abort('cancel'); return failed();
  }, finalize: () => assert.fail('cancelled checks cannot finalize') });
  assert.equal(calls, 1); assert.equal(state.status, 'cancelled');
  assert.equal(state.tasks[0].status, 'cancelled');
  assert.throws(() => prepareResume(state), /Продолжить/);
});

test('pause awaits worker cleanup, preserves completion and does not start queued work', async () => fixture(async ({ store }) => {
  const plan = planFor({ concurrency: 1, tasks: [task('done'), task('slow'), task('queued')] });
  const controller = new AbortController(), record = store.create(plan, createState(plan));
  const started = []; let cleaned = false;
  await runPlan(plan, { state: record.state, signal: controller.signal, persist: () => store.save(record), execute: async (item, _prompt, workerSignal) => {
    started.push(item.id);
    if (item.id === 'slow') {
      controller.abort({ kind: 'paused' });
      assert(workerSignal.aborted); await delay(5); cleaned = true;
    }
    return success();
  } });
  assert(cleaned); assert.deepEqual(started, ['done', 'slow']);
  assert.equal(record.state.status, 'paused'); assert.equal(record.state.pause_reason, 'paused');
  const resumed = await store.load(); prepareResume(resumed.state);
  assert(!resumed.state.pause_reason);
  await runPlan(resumed.plan, { state: resumed.state, signal: signal(), execute: async item => { started.push(item.id); return success(); }, persist: () => store.save(resumed) });
  assert.deepEqual(started, ['done', 'slow', 'slow', 'queued']);
  assert.equal(resumed.state.status, 'completed');
}));

test('budget pauses in the scheduler itself; interrupted verification resumes without rerunning worker', async () => fixture(async ({ store }) => {
  const plan = planFor();
  const record = store.create(plan, createState(plan));
  // Validate production limits normally; shorten only the in-memory timer for this test.
  plan.budgetSeconds = 0.03;
  let workers = 0, cleaned = false;
  await runPlan(plan, { state: record.state, signal: signal(), execute: async () => { workers++; return success(); }, verify: async (_task, checkSignal) => {
    await new Promise(resolve => { if (checkSignal.aborted) resolve(); else checkSignal.addEventListener('abort', resolve, { once: true }); });
    await delay(5); cleaned = true; return [{ name: 'unit', status: 'cancelled', exit_code: null }];
  } });
  assert(cleaned); assert.equal(record.state.status, 'paused'); assert.equal(record.state.pause_reason, 'budget');
  delete plan.budgetSeconds;
  await store.save(record);
  const saved = await store.load(); prepareResume(saved.state);
  assert.equal(saved.state.tasks[0].resume_phase, 'verification');
  await runPlan(saved.plan, { state: saved.state, signal: signal(), execute: async () => { workers++; return success(); }, verify: passed, persist: () => store.save(saved) });
  assert.equal(workers, 1); assert.equal(saved.state.status, 'completed');
}));

test('crash snapshots are resumable, preserve completed work and reject forged verification', async () => fixture(async ({ store }) => {
  const plan = planFor({ tasks: [task('done'), task('a', { checks: [check] })] });
  const record = store.create(plan, createState(plan));
  Object.assign(record.state.tasks[0], { status: 'completed', output: 'durable completed work' });
  Object.assign(record.state.tasks[1], { status: 'running', phase: 'verification', worker_completed: true, attempts: 1 });
  await store.save(record);
  const saved = await store.load(); assert.equal(saved.state.status, 'interrupted'); prepareResume(saved.state);
  await runPlan(saved.plan, { state: saved.state, signal: signal(), execute: () => assert.fail('no worker rerun'), verify: passed, persist: () => store.save(saved) });
  assert.equal((await store.load()).state.tasks[0].output, 'durable completed work');
  saved.state.tasks[1].check_results = failed();
  await store.save(saved);
  await assert.rejects(store.load(), /без успешных проверок/);
  assert.throws(() => prepareResume({ ...saved.state, status: 'failed' }), /без успешных проверок/);
}));

test('a crash between archive and latest writes recovers completed work from the run record', async () => fixture(async ({ store }) => {
  const plan = planFor(), record = store.create(plan, createState(plan));
  await store.save(record);
  const staleLatest = await readFile(store.file, 'utf8');
  await runPlan(plan, { state: record.state, signal: signal(), execute: async () => success(), verify: passed, persist: () => store.save(record) });
  await writeFile(store.file, staleLatest);
  const recovered = await store.load();
  assert.equal(recovered.state.status, 'completed');
  assert.equal(recovered.state.tasks[0].verification, 'passed');
}));

test('durable records reject changed definitions and another workspace', async () => fixture(async ({ store, home }) => {
  const plan = planFor(), record = store.create(plan, createState(plan));
  await store.save(record);
  const other = new TeamRuns(join(home, 'records'), { session: { id: 'fixture', header: { cwd: join(home, 'elsewhere') } } });
  await assert.rejects(other.load(), /другой рабочей/);
  record.state.tasks[0].checks = [];
  await store.save(record);
  await assert.rejects(store.load(), /задание изменено/);
}));

test('persistence failure aborts active workers and waits for disposal before rejecting', async () => {
  const plan = planFor({ concurrency: 2, tasks: [task('a'), task('b'), task('queued')] });
  let childStarted = false, cleaned = false;
  const started = [];
  await assert.rejects(runPlan(plan, { signal: signal(), persist: async state => {
    if (childStarted && state.tasks[1].attempts) throw Error('disk full');
  }, execute: async (item, _prompt, workerSignal, onStart) => {
    started.push(item.id);
    if (item.id === 'a') {
      childStarted = true;
      // Trigger a save with another child still active; fail closed on a bad disk.
      onStart('persisted-agent').catch(() => {});
      await new Promise(resolve => { if (workerSignal.aborted) resolve(); else workerSignal.addEventListener('abort', resolve, { once: true }); });
      await delay(5); cleaned = true;
    }
    return success();
  } }), /disk full/);
  assert(cleaned); assert(!started.includes('queued'));
});

test('worktree mode is opt-in and cleanup never uses force', async () => {
  assert.equal(planFor().workspaceMode, 'shared');
  assert.equal(planFor({ workspace_mode: 'git_worktree' }).workspaceMode, 'git_worktree');
  // No Git mutations in regression tests. Unintegrated trees must fail closed
  // before any removal, even if they contain newer user changes.
  const workspace = new GitTeamWorkspace({ directory: 'fixture', repo: 'fixture' });
  workspace.checkTask = async () => {};
  workspace.lookupTask = async () => null;
  await assert.rejects(workspace.closeTask({}), /ещё не интегрированы/);
  const source = await readFile(new URL('../assets/team/git-team-worktrees.js', import.meta.url), 'utf8');
  assert(!/\['worktree', 'remove', '--force'/.test(source));
  assert.match(source, /--ignored/);
  const integration = { status: 'interrupted', tasks: [{ ...planFor().tasks[0], status: 'running', phase: 'integration' }] };
  assert.throws(() => prepareResume(integration), /ручная проверка/);
});

test('legacy records retain repair count and configured model through migration', async () => fixture(async ({ store }) => {
  const plan = planFor({ tasks: [task('a', { model: { provider: 'fixture', model: 'model', effort: 'high' }, checks: [check] })] });
  const record = store.create(plan, createState(plan));
  record.schema = 1; record.state.status = 'failed';
  Object.assign(record.state.tasks[0], { status: 'failed', attempts: 3, verification: 'failed', check_results: failed() });
  await store.save(record);
  const saved = await store.load();
  assert.equal(saved.state.tasks[0].repairs_used, 2);
  assert.deepEqual(saved.plan.tasks[0].model, { provider: 'fixture', model: 'model', reasoningEffort: 'high' });
}));

test('tool schema and session-keyed pause/resume use durable records without real agents', async () => fixture(async ({ home }) => {
  // Resolve maintained assets against bundled dependencies without copying or reloading any live tool.
  const assets = new URL('../assets/team/', import.meta.url).href;
  const archive = process.env.HARNESS_ARCHIVE ? pathToFileURL(resolve(process.env.HARNESS_ARCHIVE) + '/').href : new URL('../source/', import.meta.url).href;
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier.startsWith('@deepseek-ai/') && context.parentURL?.startsWith(assets)) {
      return next(new URL('dsh/node_modules/' + specifier + '/lib/index.js', archive).href, context);
    }
    return next(specifier, context);
  } });
  const originalHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const { apply } = await import('../assets/team/index.js');
    const tools = new Map(), jobs = [], requests = [], models = [], hooks = new Map();
    let cleaned = false;
    let started; const didStart = new Promise(resolve => { started = resolve; });
    const ctx = {
      on(name, handler) { hooks.set(name, handler); },
      systemPrompt: { section() {}, getSectionOrder() { return 0; } },
      tools: { register(tool) { tools.set(tool.name, tool); }, schemas() { return [{ name: 'fixture' }]; } },
      llm: { async resolveCallConfig(model) { models.push(model); } },
      subagents: {
        getProvider() { return { capabilities: { toolFilter: true, persona: true, depthLimit: true } }; },
        async start(_provider, request) {
          requests.push(request); started();
          const result = requests.length === 1 ? new Promise(resolve => request.signal.addEventListener('abort', () => resolve({ stopReason: 'aborted' }), { once: true })) : Promise.resolve({ stopReason: 'completed', output: [] });
          return { id: 'fixture-child-' + requests.length, result, async dispose() { await delay(5); cleaned = true; } };
        },
      },
      jobs: { start(job) { const running = job.run(); jobs.push(running); return 'job-' + jobs.length; } },
    };
    apply(ctx);
    assert.deepEqual(tools.get('team_run').parameters.properties.workspace_mode.enum, ['shared', 'git_worktree']);
    assert(tools.get('team_run').parameters.properties.repair_attempts);
    assert(tools.get('team_run').parameters.properties.budget_seconds);
    const agent = { options: {}, ctx, session: { id: 'tool-fixture', header: { cwd: home } } };
    const exec = { agent, signal: signal() };
    const preStep = hooks.get('agent/pre-step');
    const decision = { kind:'enter', messages:[] };
    assert.equal(await preStep({ ...exec, step:8 }, async()=>decision), decision);
    assert.equal(await preStep({ ...exec, step:9 }, async()=>({kind:'reject'})).then(value=>value.kind), 'reject');
    const checkpoint = await preStep({ ...exec, step:9 }, async()=>decision);
    assert.equal(checkpoint.messages.length,1);
    assert.match(checkpoint.messages[0].content[0].text,/передай их команде/);
    assert.equal(decision.messages.length,0);
    await tools.get('team_run').execute({ tasks: [task('a', { tools: ['fixture'], model: { provider: 'fixture', model: 'offline', effort: 'high' } })] }, exec);
    await didStart;
    const restored = { ...exec, agent: { ...agent } };
    await assert.rejects(tools.get('team_run').execute({ tasks: [task('b')] }, restored), /уже работает/);
    assert.match(await tools.get('team_control').execute({ action: 'pause' }, restored), /Запрошена пауза/);
    assert.equal((await jobs[0].done).status, 'killed'); assert(cleaned);
    assert.match(await tools.get('team_status').execute({}, exec), /Команда: paused/);
    await tools.get('team_control').execute({ action: 'resume' }, restored);
    assert.equal((await jobs[1].done).status, 'completed');
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].agentOptions, { provider: 'fixture', model: 'offline', reasoningEffort: 'high' });
    assert.equal(models.length, 2);
    assert.match(await tools.get('team_status').execute({}, restored), /Команда: completed/);
    const store = new TeamRuns(join(home, 'team-runs'), agent);
    assert.equal((await store.load()).state.tasks[0].attempts, 2);
  } finally {
    hooks.deregister();
    if (originalHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalHome;
  }
}));

test('check runner classifies execution failures structurally and never trusts output text', async () => fixture(async ({ home }) => {
  const task = planFor().tasks[0];
  const cases = [
    [{ kind: 'foreground', exitCode: 7 }, 'failed', 'exit_code'],
    [{ kind: 'foreground', exitCode: 0, timedOut: true }, 'failed', 'timeout'],
    [{ kind: 'foreground', exitCode: 0, sandbox: { denied: true } }, 'failed', 'policy'],
    [{ kind: 'foreground', exitCode: 0, aborted: true }, 'cancelled', 'cancelled'],
    [{ kind: 'foreground', exitCode: NaN }, 'failed', 'runner'],
    [{ kind: 'background', exitCode: 0 }, 'failed', 'runner'],
    [{ kind: 'foreground', exitCode: 0 }, 'passed', undefined],
  ];
  for (const [value, status, kind] of cases) {
    const [result] = await runChecks(task, home, signal(), async () => ({ value, content: [{ type: 'text', text: 'all tests passed' }] }));
    assert.equal(result.status, status); assert.equal(result.failure_kind, kind);
  }
}));

test('independent checks overlap, keep their order and block dependent checks on failure', async () => fixture(async ({ home }) => {
  const checks = ['first','second','last'].map((name,index)=>({
    name, command:['fixture',name], ...(index<2?{parallel_group:'independent'}:{}),
  }));
  const run = async (group, fail = false) => {
    let active=0, peak=0;
    const order=[];
    const started=performance.now();
    const plan = planFor({tasks:[task('checks',{checks:group})]});
    const results = await runChecks(plan.tasks[0],home,signal(),async args=>{
      active++;
      peak=Math.max(peak,active);
      order.push(args.description);
      await delay(args.description.endsWith('first')?200:150);
      active--;
      return {value:{kind:'foreground',exitCode:fail&&args.description.endsWith('second')?2:0},content:[]};
    });
    return {results,peak,order,elapsed:Math.round(performance.now()-started)};
  };
  const sequential=await run(checks.map(({parallel_group,...check})=>check));
  const concurrent=await run(checks);
  assert.equal(sequential.peak,1);
  assert.equal(concurrent.peak,2);
  assert.deepEqual(concurrent.results.map(row=>[row.name,row.status]),sequential.results.map(row=>[row.name,row.status]));
  const failed=await run(checks,true);
  assert.deepEqual(failed.results.map(row=>row.status),['passed','failed','skipped']);
  assert.equal(failed.order.length,2);
  console.log(`Same verification fixture, sequential ${sequential.elapsed} ms, parallel ${concurrent.elapsed} ms`);
}));
