// Real, staged LlmRuntime service + registered adapter seam + real compaction
// summarizer. Transport is a fixture. No credentials, network or live deployment.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const base = resolve(fileURLToPath(new URL('..', import.meta.url)));
const archive = resolve(process.env.HARNESS_ARCHIVE ?? join(base, 'source'));
const python = process.env.QCODERI_TEST_PYTHON ?? 'C:\\Python314\\python.exe';
const home = mkdtempSync(join(tmpdir(), 'qc-budget-native-'));
const stage = join(home, 'archive'), packageRoot = join(stage, 'dsh/node_modules/@deepseek-ai/dsh-llm');
const livePath = join(archive, 'dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js');
const liveBefore = readFileSync(livePath, 'utf8');
const oldHome = process.env.DSH_HOME, oldFetch = globalThis.fetch;
process.env.DSH_HOME = home;
globalThis.fetch = async () => { throw new Error('Network is forbidden in budget native fixture'); };
const load = name => import(pathToFileURL(join(archive, 'dsh/node_modules/@deepseek-ai', name, 'lib/index.js')).href);
let ctx, budget;
try {
  mkdirSync(join(stage, 'dsh/node_modules/@deepseek-ai'), { recursive: true });
  cpSync(join(archive, 'dsh/node_modules/@deepseek-ai/dsh-llm'), packageRoot, { recursive: true });
  // Only dependency resolution is delegated to existing runtime files. The LLM
  // and owned modules are real isolated copies; no symlink to live mutable code.
  writeFileSync(join(stage, 'package.json'), JSON.stringify({ type: 'module' }));
  // Node resolves dependencies via node_modules ancestors. Junction contains
  // read-only dependencies and is never a patch destination.
  const { symlinkSync } = await import('node:fs');
  symlinkSync(join(archive, 'dsh/node_modules'), join(home, 'node_modules'), 'junction');
  const script = join(base, 'scripts/apply-usage-budget.py');
  execFileSync(python, [script, '--archive', stage], { stdio: 'inherit' });
  const patched = readFileSync(join(packageRoot, 'lib/index.js'), 'utf8');
  execFileSync(python, [script, '--archive', stage], { stdio: 'inherit' });
  assert.equal(readFileSync(join(packageRoot, 'lib/index.js'), 'utf8'), patched, 'patch is idempotent');
  assert.equal(readFileSync(livePath, 'utf8'), liveBefore, 'source was never patched');
  assert.equal(existsSync(join(home, 'credentials.yaml')), false);
  const { Context } = await load('cordis');
  const llmModule = await import(pathToFileURL(join(packageRoot, 'lib/index.js')).href);
  const { installUsageBudget } = await import(pathToFileURL(join(stage, 'dsh/node_modules/@qcoderi/team/usage-budget.js')).href);
  ctx = new Context();
  await ctx.plugin(llmModule.default, {});
  assert(ctx.get('llm'));
  let adapterCalls = 0, mode = 'normal'; const seen = [];
  class FixtureAdapter extends llmModule.LlmAdapter {
    // Ordinary function, not lazy generator: proves rejection before the adapter
    // stream ENTRY, not just before its first next()/wire operation.
    stream(options) {
      adapterCalls++; seen.push(options);
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: 'fixture summary' };
        if (mode !== 'missing') {
          yield { type: 'usage', usage: { inputTokens: 6, outputTokens: 1, cacheReadTokens: 2, reasoningTokens: 1 } };
          yield { type: 'usage', usage: { inputTokens: 6, outputTokens: 1, cacheReadTokens: 2, reasoningTokens: 1 } };
          yield { type: 'usage', usage: { inputTokens: 6, outputTokens: 4, cacheReadTokens: 2, reasoningTokens: 2 } };
        }
        yield { type: 'finish', reason: { kind: mode === 'aborted' ? 'aborted' : 'stop' } };
      })();
    }
  }
  ctx.llm.registerAdapter(['fixture'], new FixtureAdapter());
  const human = Object.freeze({}), project = join(home, 'project'); mkdirSync(project);
  const prices = [{ provider: 'fixture', model: 'budget-fixture', currency: 'USD', inputPerMillion: '1', outputPerMillion: '2', cacheReadPerMillion: '0.1', cacheWritePerMillion: '3', maxTokensIncludesReasoning: true }];
  const config = (extra = {}) => ({ scope: 'global', callsEnabled: true, moneyCapUsd: '1', tokenCap: 1000, prices, ...extra });
  let trusted = true;
  budget = installUsageBudget(ctx.llm, { home, authorizeHuman: value => value === human, resolveProject: () => project,
    getTrustedBounds: () => trusted ? ({ inputTokens: 20, maxOutputTokens: 10, coversEntireRequest: true, outputCapEnforced: true, singleAttempt: true }) : undefined });
  const req = extra => ({ provider: 'fixture', model: 'budget-fixture', messages: [llmModule.createUserMessage({ content: [{ type: 'text', text: 'fixture' }] })], maxTokens: 8000, sessionId: 'parent', ...extra });
  const collect = async (options, prepared) => {
    const result = []; for await (const chunk of (prepared ? prepared.stream(options) : ctx.llm.stream(options))) result.push(chunk); return result;
  };
  const refused = (chunks, error) => assert(chunks.some(c => c.type === 'finish' && c.reason.kind === 'error' && c.reason.failure.code === error), JSON.stringify(chunks));
  // Disabled is truly legacy: no enforced cap and no required usage contract.
  await collect(req()); assert.equal(adapterCalls, 1); assert.equal(seen[0].maxTokens, 8000);
  budget.handle('configure', config({ tokenCap: 29 }), human);
  refused(await collect(req()), 'BUDGET_TOKEN_LIMIT'); assert.equal(adapterCalls, 1);
  // Real prepared route (agent loop uses this path), plus unknown price/bound.
  const prepared = await ctx.llm.prepareCall({ provider: 'fixture', model: 'budget-fixture', maxTokens: 8000 });
  refused(await collect(req({ sessionId: 'child' }), prepared), 'BUDGET_TOKEN_LIMIT'); assert.equal(adapterCalls, 1);
  budget.handle('configure', config(), human);
  refused(await collect(req({ model: 'unknown' })), 'BUDGET_UNKNOWN_PRICE'); assert.equal(adapterCalls, 1);
  trusted = false; refused(await collect(req()), 'BUDGET_TRUSTED_BOUND_REQUIRED'); assert.equal(adapterCalls, 1); trusted = true;
  budget.handle('configure', { scope: 'project', project, callsEnabled: true, moneyCapUsd: null, tokenCap: 200 }, human);
  const acceptedPrepared = await ctx.llm.prepareCall({ provider: 'fixture', model: 'budget-fixture', maxTokens: 8000 });
  await collect(req()); await collect(req({ sessionId: 'child', purpose: 'quality-review' }), acceptedPrepared);
  assert.equal(adapterCalls, 3); assert(seen.slice(1).every(r => r.maxTokens === 10));
  let scopes = budget.modelStatus().scopes;
  assert(scopes.every(s => s.spent.tokens === 24));
  assert(scopes.every(s => s.spent.costNanoUsd === '28400')); // 2 * (6 + .2 + 8) microUSD
  assert(scopes.every(s => s.held.tokens === 0));
  // Call the ACTUAL compaction implementation's summarize hook: it assembles
  // its own options and uses ctx.llm.stream(), not this test's purpose imitation.
  const { BasicCompactionEngine } = await load('dsh-compaction-basic');
  const owner = { session: { id: 'parent', requestHeader: () => undefined }, options: { provider: 'fixture', model: 'budget-fixture' } };
  const engine = { ctx, config: { summarizationProvider: 'fixture', summarizationModel: 'budget-fixture', maxTokens: 100, modelPolicies: [] } };
  const summary = await BasicCompactionEngine.prototype.summarize.call(engine, { messages: req().messages }, owner);
  assert(summary.summary.some(c => c.text.includes('fixture summary')));
  assert.equal(seen.at(-1).purpose, 'compaction'); assert.equal(seen.at(-1).maxTokens, 10);
  assert.equal(adapterCalls, 4);
  budget.handle('configure', config({ tokenCap: 36 }), human);
  await assert.rejects(BasicCompactionEngine.prototype.summarize.call(engine, { messages: req().messages }, owner), error => error.code === 'BUDGET_TOKEN_LIMIT');
  assert.equal(adapterCalls, 4, 'actual compaction rejected before adapter');
  budget.handle('configure', config(), human);
  mode = 'aborted'; refused(await collect(req()), 'BUDGET_UNCERTAIN_USAGE');
  assert.equal(adapterCalls, 5); assert.equal(budget.modelStatus().pending.length, 1);
  assert.equal(budget.modelStatus().pending[0].status, 'uncertain');
  refused(await collect(req({ sessionId: 'other-child' })), 'BUDGET_UNCERTAIN_USAGE'); assert.equal(adapterCalls, 5);
  budget.close(); budget = undefined;
  // New independent controller / connection, same durable home.
  const { createUsageBudget } = await import(pathToFileURL(join(stage, 'dsh/node_modules/@qcoderi/team/usage-budget.js')).href);
  budget = createUsageBudget({ home });
  assert.equal(budget.modelStatus().pending.length, 1);
  assert(budget.modelStatus().scopes.every(s => s.held.tokens === 18));
  assert.equal(readFileSync(livePath, 'utf8'), liveBefore);
  console.log('PASS: staged idempotent final-boundary patch; actual LlmRuntime direct/prepared and compaction routes; rejection BEFORE adapter entry; cumulative usage no double-charge; shared scopes; durable cancellation uncertainty; no network/credentials');
} finally {
  budget?.close();
  if (ctx) await ctx.fiber.dispose();
  globalThis.fetch = oldFetch;
  if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
  rmSync(home, { recursive: true, force: true });
}
