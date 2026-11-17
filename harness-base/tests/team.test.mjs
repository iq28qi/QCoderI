import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createState, formatReport, runPlan, taskPrompt, validatePlan } from '../assets/team/scheduler.js';

const task = (id, extra = {}) => ({ id, title: id, prompt: `Implement ${id}`, write_paths: [], ...extra });
const signal = () => new AbortController().signal;
const success = output => ({ status: 'completed', output });

test('rejects cycles, missing dependencies, duplicate ids, escaping paths and bad limits before running', () => {
  for (const input of [
    { tasks: [task('a', { depends_on: ['b'] }), task('b', { depends_on: ['a'] })] },
    { tasks: [task('a', { depends_on: ['missing'] })] },
    { tasks: [task('a'), task('a')] },
    ...['../secret', 'src/../../secret', 'C:\\temp', '/tmp', 'src/*'].map(path => ({ tasks: [task('a', { write_paths: [path] })] })),
    { tasks: [task('a')], concurrency: 5 }, { tasks: [task('a')], timeout_seconds: -1 },
  ]) assert.throws(() => validatePlan(input));
});

test('starts four independent tasks before any finish and respects the cap across a second wave', async () => {
  const plan = validatePlan({ tasks: ['a', 'b', 'c', 'd', 'e', 'f'].map(id => task(id)) });
  let active = 0, peak = 0;
  const started = [];
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const pending = runPlan(plan, { signal: signal(), execute: async item => {
    active++; peak = Math.max(peak, active); started.push(item.id);
    await barrier;
    active--;
    return success(item.id);
  } });
  await delay(0);
  assert.equal(started.length, 4);
  release();
  const state = await pending;
  assert.equal(peak, 4);
  assert.equal(state.status, 'completed');
  assert.equal(state.tasks.filter(item => item.status === 'completed').length, 6);
});

test('serializes overlapping file/directory paths case-insensitively but starts disjoint work', async () => {
  const plan = validatePlan({ tasks: [
    task('a', { write_paths: ['src'] }), task('b', { write_paths: ['SRC/file.js'] }),
    task('c', { write_paths: ['tests'] }), task('d', { write_paths: ['.'] }),
  ] });
  const active = new Set();
  let sawParallel = false;
  const state = await runPlan(plan, { signal: signal(), execute: async item => {
    if (item.id === 'b') assert(!active.has('a'));
    if (item.id === 'd') assert.equal(active.size, 0);
    active.add(item.id);
    sawParallel ||= active.size > 1;
    await delay(8);
    active.delete(item.id);
    return success('done');
  } });
  assert(sawParallel);
  assert.equal(state.status, 'completed');
});

test('passes dependency reports after successful completion and skips transitive failed prerequisites', async () => {
  const plan = validatePlan({ tasks: [
    task('review', { depends_on: ['implementation'] }), task('implementation'),
    task('broken'), task('dependent', { depends_on: ['broken'] }), task('transitive', { depends_on: ['dependent'] }),
  ] });
  const ran = [];
  const state = await runPlan(plan, { signal: signal(), execute: async (item, prompt) => {
    ran.push(item.id);
    if (item.id === 'broken') throw new Error('provider unavailable');
    if (item.id === 'review') assert(prompt.includes('implementation report'));
    return success('implementation report');
  } });
  assert.deepEqual(new Set(ran), new Set(['implementation', 'review', 'broken']));
  assert.equal(state.status, 'failed');
  assert.equal(state.tasks.find(item => item.id === 'dependent').status, 'skipped');
  assert.equal(state.tasks.find(item => item.id === 'transitive').status, 'skipped');
  assert(formatReport(state).includes('provider unavailable'));
});

test('cancellation stops active workers, awaits cleanup and never starts queued work', async () => {
  const controller = new AbortController();
  const plan = validatePlan({ tasks: [task('a'), task('b'), task('c')], concurrency: 2 });
  const started = [], cleaned = [];
  const pending = runPlan(plan, { signal: controller.signal, execute: async (item, _prompt, workerSignal) => {
    started.push(item.id);
    await new Promise(resolve => workerSignal.addEventListener('abort', resolve, { once: true }));
    await delay(5);
    cleaned.push(item.id);
    return success('partial');
  } });
  await delay(0);
  controller.abort('stop');
  const state = await pending;
  assert.deepEqual(started, ['a', 'b']);
  assert.deepEqual(cleaned.sort(), ['a', 'b']);
  assert.equal(state.status, 'cancelled');
  assert(state.tasks.every(item => item.status === 'cancelled'));
});

test('per-task timeout cancels the worker and skips its dependent', async () => {
  const plan = validatePlan({ tasks: [task('slow'), task('review', { depends_on: ['slow'] })] });
  plan.timeoutSeconds = 0.02;
  let cleaned = false;
  const state = await runPlan(plan, { signal: signal(), execute: async (_item, _prompt, workerSignal) => {
    await new Promise(resolve => workerSignal.addEventListener('abort', resolve, { once: true }));
    cleaned = true;
    throw new Error('cancelled');
  } });
  assert(cleaned);
  assert.equal(state.tasks[0].status, 'failed');
  assert.match(state.tasks[0].detail, /Истекло время/);
  assert.equal(state.tasks[1].status, 'skipped');
});

test('an already cancelled batch starts no workers; synchronous worker failure does not stall the queue', async () => {
  const plan = validatePlan({ tasks: [task('a'), task('b')], concurrency: 1 });
  const controller = new AbortController(); controller.abort();
  const cancelled = await runPlan(plan, { signal: controller.signal, execute: () => assert.fail('must not start') });
  assert.equal(cancelled.status, 'cancelled');
  const failed = await runPlan(plan, { signal: signal(), execute: () => { throw Error('sync failure'); } });
  assert(failed.tasks.every(item => item.status === 'failed'));
});

test('reports live child identities, bounds long outputs and marks provider failure', async () => {
  const plan = validatePlan({ tasks: [task('a')] });
  const state = createState(plan);
  await runPlan(plan, { state, signal: signal(), execute: async (_task, _prompt, _signal, onStart) => {
    onStart('native-child-session');
    return { status: 'failed', output: 'x'.repeat(30000), detail: 'dispose failed' };
  } });
  assert.equal(state.tasks[0].agent_id, 'native-child-session');
  assert(state.tasks[0].output.length < 17000);
  assert.equal(state.status, 'failed');
});

test('unlocks critical dependency chains first; explicit priority takes precedence', async () => {
  const tasks = [task('unrelated'), task('start'), task('middle', { depends_on: ['start'] }), task('end', { depends_on: ['middle'] })];
  const started = [];
  const execute = async item => { started.push(item.id); return success('ok'); };
  await runPlan(validatePlan({ tasks, concurrency: 1 }), { signal: signal(), execute });
  assert.deepEqual(started.slice(0, 2), ['start', 'middle']);
  tasks[0].priority = 10; started.length = 0;
  await runPlan(validatePlan({ tasks, concurrency: 1 }), { signal: signal(), execute });
  assert.equal(started[0], 'unrelated');
});

test('allows concurrent readers while excluding writers and shared resources', async () => {
  const plan = validatePlan({ tasks: [
    task('reader1', { read_paths: ['src'] }), task('reader2', { read_paths: ['SRC/file.js'] }),
    task('writer', { write_paths: ['src/file.js'] }),
    task('build1', { resources: ['Build'] }), task('build2', { resources: ['build'] }),
  ] });
  const active = new Set(); let readersOverlap = false;
  await runPlan(plan, { signal: signal(), execute: async item => {
    if (item.id === 'writer') assert(!active.has('reader1') && !active.has('reader2'));
    if (item.id.startsWith('reader')) assert(!active.has('writer'));
    if (item.id === 'build2') assert(!active.has('build1'));
    active.add(item.id); readersOverlap ||= active.has('reader1') && active.has('reader2');
    await delay(8); active.delete(item.id); return success('ok');
  } });
  assert(readersOverlap);
});

test('holds locks during verification and blocks dependents on check failure', async () => {
  const plan = validatePlan({ tasks: [
    task('implement', { write_paths: ['src'], checks: [{ name: 'build', command: ['node', 'build.js'] }] }),
    task('dependent', { depends_on: ['implement'] }), task('reader', { read_paths: ['src'] }),
  ] });
  let checking = false, checked = false;
  const state = await runPlan(plan, { signal: signal(), execute: async item => {
    assert.notEqual(item.id, 'dependent');
    if (item.id === 'reader') { assert(!checking); assert(checked); }
    return success('implemented');
  }, verify: async () => {
    checking = true; await delay(10); checking = false; checked = true;
    return [{ name: 'build', status: 'failed', exit_code: 2, output: 'compile failed' }];
  } });
  assert.equal(state.status, 'failed');
  assert.equal(state.tasks[0].verification, 'failed');
  assert.equal(state.tasks[1].status, 'skipped');
  assert(formatReport(state).includes('compile failed'));
});

test('distinguishes passed checks from unverified completion and fails without a runner', async () => {
  const plan = validatePlan({ tasks: [task('a', { checks: [{ name: 'test', command: ['node', 'test.js'] }] }), task('b')] });
  const state = await runPlan(plan, { signal: signal(), execute: async () => success('ok'), verify: async () => [{ name: 'test', status: 'passed', exit_code: 0 }] });
  assert.equal(state.status, 'completed');
  assert.equal(state.tasks[0].verification, 'passed');
  assert.equal(state.tasks[1].verification, 'not_configured');
  const missing = await runPlan(plan, { signal: signal(), execute: async () => success('ok') });
  assert.equal(missing.tasks[0].status, 'failed');
});

test('shares context/criteria while bounding dependency text and compact statuses', () => {
  const dependencies = Array.from({ length: 11 }, (_, i) => task('dependency' + i));
  const plan = validatePlan({ shared_context: 'Use existing architecture {{literal}}', tasks: [...dependencies, task('review', { depends_on: dependencies.map(item => item.id), acceptance_criteria: ['No regressions'] })] });
  const state = createState(plan);
  for (const item of state.tasks.slice(0, -1)) item.output = 'x'.repeat(16000);
  const prompt = taskPrompt(state.tasks.at(-1), state);
  assert(prompt.includes('Use existing architecture {{literal}}'));
  assert(prompt.includes('No regressions'));
  assert(prompt.length < 20000, `dependency prompt has ${prompt.length} characters`);
  assert(!formatReport(state, { includeReports: false }).includes('xxxxx'));
});

test('validates new fields and check commands before starting workers', () => {
  for (const extra of [
    { read_paths: ['../outside'] }, { resources: 'build' }, { priority: 101 }, { timeout_seconds: 1 },
    { tools: [null] }, { acceptance_criteria: [''] }, { checks: [{ name: 'test', command: [] }] },
    { checks: [{ name: 'test', command: ['node', '\0'] }] },
    { checks: [{ name: 'test', command: ['node'], cwd: '../outside' }] },
    { checks: [{ name: 'test', command: ['node'], timeout_seconds: 0 }] },
  ]) assert.throws(() => validatePlan({ tasks: [task('a', extra)] }));
});
