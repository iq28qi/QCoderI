// Exercise the real AgentLoop, Tools, Jobs and in-process spawn provider.
// Only the LLM transport is scripted: no credentials or paid requests are used.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const base = resolve(fileURLToPath(new URL('..', import.meta.url)));
const archive = resolve(process.env.HARNESS_ARCHIVE ?? join(base, 'source'));
const packageUrl = name => pathToFileURL(join(archive, 'dsh/node_modules', name, 'lib/index.js')).href;
const load = async name => import(packageUrl('@deepseek-ai/' + name));
const nodeExecutable = process.env.QCODERI_TEST_NODE ?? (process.versions.electron ? 'node' : process.execPath);
const home = mkdtempSync(join(tmpdir(), 'qcoderi-team-test-'));
const originalHome = process.env.DSH_HOME;
process.env.DSH_HOME = home;
const watchdog = setTimeout(() => { console.error('FAIL: native team test exceeded 120 seconds'); process.exit(1); }, 120000);
const { Context } = await load('cordis');
const { LlmAdapter } = await load('dsh-llm');
const { defineTool } = await load('dsh-tools');
const ctx = new Context();
let parent;
try {
  await ctx.plugin((await load('dsh-settings-file')).default, { path: join(home, 'settings.yaml'), watch: false });
  for (const name of ['dsh-session', 'dsh-session-projection', 'dsh-llm', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-agent-loop', 'dsh-subagent', 'dsh-subagent-spawn-in-process', 'dsh-jobs-local', 'dsh-tool-jobs', 'dsh-commands']) {
    await ctx.plugin((await load(name)).default ?? await load(name), {});
  }
  await ctx.plugin((await load('dsh-subprocess-local')).default, {});
  await ctx.plugin((await load('dsh-pwsh-local')).default, { cwd: home });
  await ctx.plugin(await load('dsh-shell-env'), { dshHome: home });
  await ctx.plugin(await load('dsh-tool-pwsh'), {});
  await ctx.plugin(await load('dsh-tool-subagent'), { provider: 'spawn', backgroundMode: 'continuable' });
  await ctx.plugin(await load('dsh-tool-subagent-control'));
  await ctx.plugin(await import(pathToFileURL(join(archive, 'dsh/node_modules/@qcoderi/team/index.js')).href));
  await ctx.plugin(await import(pathToFileURL(join(archive, 'dsh/node_modules/@qcoderi/team/studio3d.js')).href));
  await ctx.plugin(await import(pathToFileURL(join(archive, 'dsh/node_modules/@qcoderi/unreal/index.js')).href));
  for (let i = 0; i < 100 && (!ctx.get('agentLoop') || !ctx.get('jobs') || !ctx.tools.get('team_run')); i++) await delay(10);
  assert(ctx.get('agentLoop'), 'native loop is ready');
  let active = 0, peak = 0, cancellationWorkerStarted = false;
  const workerTools = [], workerPrompts = [], childIds = [];
  ctx.on('subagent/start', info => childIds.push(info.id));
  ctx.tools.register(defineTool({
    name: 'write_fixture', description: 'Write a fixture file in the temporary test workspace',
    parameters: { id: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute(args, exec) {
      assert(/^[ab]$/.test(args.id));
      writeFileSync(join(exec.agent.session.header.cwd, args.id + '.txt'), `worker ${args.id}`);
      return Promise.resolve('written ' + args.id);
    },
  }));
  class ScriptedAdapter extends LlmAdapter {
    async *stream(options) {
      assert.equal(options.provider, 'fixture');
      assert.equal(options.model, 'team-fixture');
      const allText = options.messages.flatMap(message => message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
      const id = /Задача: ([abcdefgh])\b/.exec(allText)?.[1];
      assert(id, 'child receives its standalone assignment');
      assert(allText.includes('TEAM_PARENT_INSTRUCTIONS {{literal}}'), 'child receives the leader snapshot');
      assert(!allText.includes('CHANGED_SETTINGS'), 'later settings do not change child instructions');
      if (id === 'd') {
        cancellationWorkerStarted = true;
        await delay(60000, undefined, { signal: options.signal });
      }
      const called = options.messages.some(message => message.content?.some(block => block.type === 'tool-result'));
      workerTools.push(options.tools?.map(tool => tool.name) ?? []);
      workerPrompts.push(allText);
      if (!called && (id === 'a' || id === 'b')) {
        active++; peak = Math.max(peak, active);
        try { await delay(60, undefined, { signal: options.signal }); }
        finally { active--; }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'write-' + id, name: 'write_fixture', arguments: JSON.stringify({ id }) } };
      } else {
        yield { type: 'text-delta', index: 0, text: `REPORT ${id}: checked` };
      }
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['fixture'], new ScriptedAdapter());
  await ctx.settings.update('system-prompt', { text: 'TEAM_PARENT_INSTRUCTIONS {{literal}}' });
  parent = await ctx.agents.create({ sessionId: 'team-test-parent', agentOptions: { provider: 'fixture', model: 'team-fixture' }, meta: { cwd: home } });
  const agent = parent.agent;
  await ctx.systemPrompt.assemble({ agent, scope: agent.ctx });
  await ctx.settings.update('system-prompt', { text: 'CHANGED_SETTINGS' });
  assert(ctx.tools.schemas(agent).some(tool => tool.name === 'subagent'), 'leader has the standard delegation tool');
  const execute = async (name, args = {}) => {
    const result = await ctx.tools.execute({ name, arguments: args, callId: `fixture-${Date.now()}`, agent, signal: new AbortController().signal });
    assert(!result.isError, JSON.stringify(result));
    return result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  };
  const result = await execute('team_run', { shared_context: 'COMMON_PROJECT_CONTEXT', tasks: [
    { id: 'a', title: 'a', role: 'Моделлер', prompt: 'Write a.txt using write_fixture', write_paths: ['a.txt'], tools: ['write_fixture', 'blender_status', 'blender_run'] },
    { id: 'b', title: 'b', prompt: 'Write b.txt using write_fixture', write_paths: ['b.txt'] },
    { id: 'c', title: 'c', role: 'Интегратор Unreal', prompt: 'Review the reports of both workers', write_paths: [], read_paths: ['a.txt', 'b.txt'], tools: ['unreal_status', 'unreal_command'], resources: ['unreal-editor'], depends_on: ['a', 'b'],
      acceptance_criteria: ['Both files contain worker output'], checks: [{ name: 'combined', command: [nodeExecutable, '-e', "const fs=require('node:fs'); for(const id of ['a','b']) if(fs.readFileSync(id+'.txt','utf8')!=='worker '+id) process.exit(2); console.log('combined check passed')"] }] },
  ] });
  const jobId = /job_id: ([^\s]+)/.exec(result)?.[1];
  assert(jobId, result);
  const duplicate = await ctx.tools.execute({ name: 'team_run', arguments: { tasks: [{ id: 'duplicate', title: 'duplicate', prompt: 'no', write_paths: [] }] }, callId: 'duplicate', agent, signal: new AbortController().signal });
  assert(duplicate.isError, 'a second live batch is refused');
  const collected = await execute('job_output', { job_id: jobId, wait: true, timeout_ms: 30000 });
  await ctx.jobs.wait(jobId, 30000, agent, new AbortController().signal);
  assert(collected.includes('REPORT c: checked'), collected);
  const compact = await execute('team_status');
  assert(!compact.includes('REPORT c: checked'), 'compact status omits worker reports');
  const report = await execute('team_status', { include_reports: true });
  assert(report.includes('Команда: completed'), report);
  assert(report.includes('REPORT c: checked'), report);
  assert(report.includes('combined check passed'), report);
  assert(report.includes('Проверки: passed'), report);
  assert.equal(peak, 2, 'real child LLM requests overlap');
  assert.equal(readFileSync(join(home, 'a.txt'), 'utf8'), 'worker a');
  assert.equal(readFileSync(join(home, 'b.txt'), 'utf8'), 'worker b');
  assert.equal(new Set(childIds).size, 3, 'three separate native child sessions');
  assert(workerTools.every(tools => !tools.some(name => /^(team_|subagent|workflow|send_message$|interrupt_agent$)/.test(name))), 'workers cannot delegate');
  assert(workerTools.some(tools => tools.includes('write_fixture') && tools.includes('blender_run') && !tools.includes('unreal_command')), 'modeler gets Blender tools');
  assert(workerTools.some(tools => tools.includes('unreal_command') && !tools.includes('blender_run') && !tools.includes('write_fixture')), 'dependent integrator gets UE tools');
  assert(workerPrompts.every(prompt => prompt.includes('COMMON_PROJECT_CONTEXT')), 'shared context reaches every initial worker');
  assert(workerPrompts.some(prompt => prompt.includes('Задача: c') && prompt.includes('REPORT a: checked') && prompt.includes('REPORT b: checked')), 'dependent child gets real reports');
  for (const id of childIds) assert.equal(ctx.agents.get(id), undefined, 'settled child is disposed');
  console.log('PASS: native team tool -> Jobs -> three real child sessions -> parallel LLM calls -> tool writes -> dependent review -> collected report and disposal');
  console.log('PASS: pinned parent instructions, shared context, minimal tools, compact status and automatic combined check');
  const invalid = await ctx.tools.execute({ name: 'team_run', arguments: { tasks: [{ id: 'e', title: 'e', prompt: 'no', write_paths: [], tools: ['team_run'] }] }, callId: 'invalid-tools', agent, signal: new AbortController().signal });
  assert(invalid.isError, 'worker cannot request delegation tools');
  const failure = await execute('team_run', { tasks: [
    { id: 'e', title: 'e', prompt: 'Finish then fail verification', write_paths: [], tools: [], checks: [{ name: 'intentional failure', command: [nodeExecutable, '-e', 'process.exit(9)'] }] },
    { id: 'f', title: 'f', prompt: 'Must not start', write_paths: [], depends_on: ['e'] },
    { id: 'g', title: 'g', prompt: 'Independent task', write_paths: [], tools: [] },
  ] });
  const failedJobId = /job_id: ([^\s]+)/.exec(failure)[1];
  await ctx.jobs.wait(failedJobId, 30000, agent, new AbortController().signal);
  assert.equal(ctx.jobs.get(failedJobId, agent).status, 'failed', 'batch failure propagates to Jobs');
  const failedReport = await execute('team_status');
  assert(failedReport.includes('[skipped] f'), failedReport);
  assert(failedReport.includes('[completed] g'), failedReport);
  console.log('PASS: failed automatic check fails the real background job, blocks dependents and preserves independent work');
  const cancelResult = await execute('team_run', { tasks: [{ id: 'd', title: 'd', prompt: 'Wait for cancellation', write_paths: [] }] });
  const cancelJobId = /job_id: ([^\s]+)/.exec(cancelResult)[1];
  for (let i = 0; i < 100 && !cancellationWorkerStarted; i++) await delay(10);
  assert(cancellationWorkerStarted);
  await execute('job_kill', { job_id: cancelJobId });
  await ctx.jobs.wait(cancelJobId, 5000, agent, new AbortController().signal);
  assert.equal(ctx.jobs.get(cancelJobId, agent).status, 'killed');
  assert.match(await execute('team_status'), /Команда: cancelled/);
  for (const id of childIds) assert.equal(ctx.agents.get(id), undefined, 'cancelled child is disposed');
  console.log('PASS: native job_kill cancels the actual child LLM stream and releases its session');
  const checking = await execute('team_run', { tasks: [{ id: 'h', title: 'h', prompt: 'Finish then wait in check', write_paths: ['checking.txt'],
    checks: [{ name: 'slow check', command: [nodeExecutable, '-e', "require('node:fs').writeFileSync('checking.txt','started'); setInterval(() => {}, 1000)"] }] }] });
  const checkingJobId = /job_id: ([^\s]+)/.exec(checking)[1];
  for (let i = 0; i < 3000 && !existsSync(join(home, 'checking.txt')); i++) await delay(10);
  assert(existsSync(join(home, 'checking.txt')), 'automatic check actually started');
  await execute('job_kill', { job_id: checkingJobId });
  await ctx.jobs.wait(checkingJobId, 15000, agent, new AbortController().signal);
  assert.equal(ctx.jobs.get(checkingJobId, agent).status, 'killed');
  assert.match(await execute('team_status'), /Команда: cancelled/);
  console.log('PASS: job_kill during automatic verification waits for managed process shutdown');
  const repo = join(home, 'repo');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { windowsHide: true, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Test fixture');
  git('config', 'user.email', 'fixture@localhost');
  writeFileSync(join(repo, 'README.md'), '# fixture');
  git('add', 'README.md');
  git('commit', '-qm', 'Initial fixture');
  await parent.dispose();
  parent = await ctx.agents.create({ sessionId: 'team-test-worktree', agentOptions: { provider: 'fixture', model: 'team-fixture' }, meta: { cwd: repo } });
  const isolatedAgent = parent.agent;
  await ctx.settings.update('system-prompt', { text: 'TEAM_PARENT_INSTRUCTIONS {{literal}}' });
  const invoke = async (name, args) => {
    const result = await ctx.tools.execute({ name, arguments: args, callId: 'git-fixture-' + Date.now(), agent: isolatedAgent, signal: new AbortController().signal });
    assert(!result.isError, JSON.stringify(result));
    return result.content.filter(block=>block.type === 'text').map(block=>block.text).join('\n');
  };
  const selected = await invoke('team_run', { workspace_mode: 'git_worktree', tasks: ['a', 'b'].map(id=>({
    id, title: id, prompt: 'Write the fixture file in the current checkout', write_paths: [id+'.txt'], tools: ['write_fixture'],
    checks: [{ name: 'check worktree file', command: [nodeExecutable, '-e', `if (!require("node:fs").existsSync("${id}.txt")) process.exit(2)`] }],
  })) });
  const gitJob = /job_id: ([^\s]+)/.exec(selected)[1];
  await ctx.jobs.wait(gitJob, 60000, isolatedAgent, new AbortController().signal);
  const gitReport = await invoke('team_status', { include_reports: true });
  assert.equal(ctx.jobs.get(gitJob, isolatedAgent).status, 'completed', gitReport);
  const ref = /Git-ветка результата: (\S+)\./.exec(gitReport)[1];
  assert.equal(git('show', ref+':a.txt'), 'worker a');
  assert.equal(git('show', ref+':b.txt'), 'worker b');
  assert(!existsSync(join(repo, 'a.txt')));
  assert.equal(git('status','--porcelain'), '');
  console.log('PASS: actual spawned agents and checks use separate worktrees and integrate their changes into a result branch');
} finally {
  await parent?.dispose();
  await ctx.fiber.dispose();
  clearTimeout(watchdog);
  if (originalHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
}
