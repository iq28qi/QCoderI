import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { validatePlan } from '../assets/team/scheduler.js';

const base = resolve(fileURLToPath(new URL('..', import.meta.url)));
const archive = resolve(process.env.HARNESS_ARCHIVE ?? join(base, 'source'));
const { runChecks } = await import('../assets/team/checks.js');
const load = name => import(pathToFileURL(join(archive, 'dsh/node_modules/@deepseek-ai', name, 'lib/index.js')).href);
const { Context } = await load('cordis');
const ctx = new Context();
for (const name of ['dsh-system-prompt', 'dsh-tools', 'dsh-subprocess-local', 'dsh-pwsh-local']) await ctx.plugin((await load(name)).default, {});
await ctx.plugin(await load('dsh-shell-env'), { dshHome: tmpdir() });
await ctx.plugin(await load('dsh-tool-pwsh'), {});
for (let i = 0; i < 100 && !ctx.tools?.get('pwsh'); i++) await new Promise(resolve => setTimeout(resolve, 10));
after(async () => { await ctx.fiber.dispose(); });
let callId = 0;
const executeTool = (args, signal) => ctx.tools.execute({ name: 'pwsh', arguments: args, callId: 'check-' + ++callId, signal });
const run = (task, workspace, signal) => runChecks(task, workspace, signal, executeTool);
// Electron's managed shell intentionally strips its Node-mode flag for targets.
// Use an actual Node executable for fixtures rather than launching the GUI exe.
const nodeExecutable = process.env.QCODERI_TEST_NODE ?? (process.versions.electron ? 'node' : process.execPath);
const node = code => [nodeExecutable, '-e', code];
const task = checks => validatePlan({ tasks: [{ id: 'check', title: 'Check', prompt: 'Check', write_paths: [], checks }] }).tasks[0];

test('real exit codes gate success, preserve literal argv and bound output', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qcoderi-check-'));
  try {
    const literal = '$(no-execution) & `literal` "quoted" Юникод';
    const results = await run(task([
      { name: 'argv', command: [...node("require('node:fs').writeFileSync('argv.txt', process.argv[1]); console.log('x'.repeat(20000))"), literal] },
      { name: 'failure', command: node("console.error('deliberate failure'); process.exit(7)") },
      { name: 'skipped', command: node("require('node:fs').writeFileSync('unexpected.txt', 'bad')") },
    ]), home, new AbortController().signal);
    assert.equal(results[0].status, 'passed');
    assert.equal(await readFile(join(home, 'argv.txt'), 'utf8'), literal);
    assert(results[0].output.length <= 6000);
    assert.equal(results[1].exit_code, 7); assert.equal(results[1].status, 'failed');
    assert(results[1].output.includes('deliberate failure'));
    assert.equal(results[2].status, 'skipped');
    await assert.rejects(readFile(join(home, 'unexpected.txt')));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('missing commands, linked cwd escape and timeouts fail; cancellation stops commands', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qcoderi-check-'));
  const outside = await mkdtemp(join(tmpdir(), 'qcoderi-outside-'));
  try {
    let results = await run(task([{ name: 'missing', command: ['qcoderi-nonexistent-fixture-executable'] }]), home, new AbortController().signal);
    assert.equal(results[0].status, 'failed'); assert(results[0].detail);
    await symlink(outside, join(home, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    results = await run(task([{ name: 'escape', command: node('process.exit(0)'), cwd: 'linked' }]), home, new AbortController().signal);
    assert.equal(results[0].status, 'failed'); assert.match(results[0].detail, /leaves the workspace/);
    results = await run(task([{ name: 'timeout', command: node('setInterval(() => {}, 1000)'), timeout_seconds: 1 }]), home, new AbortController().signal);
    assert.equal(results[0].status, 'failed'); assert.equal(results[0].detail, 'Check timeout');
    const controller = new AbortController();
    const running = run(task([{ name: 'cancel', command: node("console.log('started'); setInterval(() => {}, 1000)") }]), home, controller.signal);
    const timer = setTimeout(() => controller.abort('test cancellation'), 300);
    try { results = await running; } finally { clearTimeout(timer); }
    assert.equal(results[0].status, 'cancelled');
  } finally { await rm(home, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('automatic checks honor tool guards and cannot claim success from untyped output', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qcoderi-check-'));
  const removeGuard = ctx.tools.guard(exec => exec.name === 'pwsh' ? 'Fixture policy denied execution' : undefined);
  try {
    const results = await run(task([{ name: 'guarded', command: node("require('node:fs').writeFileSync('forbidden.txt','bad')") }]), home, new AbortController().signal);
    assert.equal(results[0].status, 'failed');
    await assert.rejects(readFile(join(home, 'forbidden.txt')));
    const invalid = await runChecks(task([{ name: 'untyped', command: node('process.exit(0)') }]), home, new AbortController().signal,
      async () => ({ isError: false, content: [{ type: 'text', text: 'passed' }] }));
    assert.equal(invalid[0].status, 'failed');
  } finally { removeGuard(); await rm(home, { recursive: true, force: true }); }
});
