import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { UsageLedger, normalizeUsage, projectBudgetKey, usageCostNanoUsd } from '../assets/team/usage-ledger.js';
import { createUsageBudget, installUsageBudget } from '../assets/team/usage-budget.js';

// Independent SQLite connections/threads contend on the same durable home.
if (!isMainThread) {
  const ledger = new UsageLedger(workerData.home);
  parentPort.postMessage('ready');
  parentPort.once('message', () => {
    try { parentPort.postMessage({ ok: true, receipt: ledger.reserve({ provider: 'fixture', model: 'm', inputTokens: 10, maxTokens: 10 }) }); }
    catch (error) { parentPort.postMessage({ ok: false, code: error.code }); }
    finally { ledger.close(); }
  });
} else {
  const human = Object.freeze({});
  const price = { provider: 'fixture', model: 'm', currency: 'USD', inputPerMillion: '1', outputPerMillion: '2', cacheReadPerMillion: '0.1', cacheWritePerMillion: '3', maxTokensIncludesReasoning: true };
  const config = (overrides = {}) => ({ scope: 'global', callsEnabled: true, moneyCapUsd: '1', tokenCap: 1000, prices: [price], ...overrides });
  const usage = (inputTokens = 10, outputTokens = 5, extra = {}) => ({ inputTokens, outputTokens, ...extra });
  const bounds = () => ({ inputTokens: 10, maxOutputTokens: 10, coversEntireRequest: true, outputCapEnforced: true, singleAttempt: true });
  const request = extra => ({ provider: 'fixture', model: 'm', messages: [], ...extra });
  const collect = async stream => { const result = []; for await (const chunk of stream) result.push(chunk); return result; };
  const code = expected => error => error.code === expected;
  const make = () => mkdtempSync(join(tmpdir(), 'qc-budget-unit-'));
  function open(home, extra = {}) { return createUsageBudget({ home, authorizeHuman: principal => principal === human, getTrustedBounds: bounds, ...extra }); }
  const good = async function* (options) { assert.equal(options.maxTokens, 10); yield { type: 'usage', usage: usage() }; yield { type: 'finish', reason: { kind: 'stop' } }; };

  test('disabled-by-default is exact legacy pass-through; human-only activation is persistent', async () => {
    const home = make(); const budget = open(home);
    try {
      let seen; const options = request({ maxTokens: 999 });
      await collect(budget.intercept(options, async function* (arg) { seen = arg; yield { type: 'text-delta', text: 'legacy' }; }));
      assert.equal(seen, options); assert.equal(budget.modelStatus().pending.length, 0);
      for (const action of ['configure', 'reset', 'reconcile', 'audit', 'enable']) assert.throws(() => budget.handle(action, config(), { role: 'human' }), code('BUDGET_HUMAN_ONLY'));
      budget.handle('configure', config({ callsEnabled: false }), human);
      let calls = 0;
      await assert.rejects(collect(budget.intercept(request(), async function* () { calls++; })), code('BUDGET_CALLS_DISABLED'));
      assert.equal(calls, 0);
      assert.equal(budget.modelStatus().scopes[0].policy.callsEnabled, false);
      assert.throws(() => installUsageBudget({}, { home }), code('BUDGET_FINAL_BOUNDARY_REQUIRED'));
    } finally { budget.close(); rmSync(home, { recursive: true, force: true }); }
  });

  test('project policy requires global prices while global money and token caps may be null', async () => {
    const home = make();
    const project = join(home, 'project');
    mkdirSync(project);
    const budget = open(home, { resolveProject: () => project });
    const policy = { scope: 'project', project, callsEnabled: true, moneyCapUsd: '0.5', tokenCap: 20 };
    try {
      assert.throws(() => budget.handle('configure', policy, human), error => {
        assert.equal(error.code, 'BUDGET_GLOBAL_POLICY_REQUIRED');
        assert.match(error.message, /Сначала задайте цены моделей/);
        return true;
      });
      const unchanged = budget.modelStatus();
      assert.equal(unchanged.configured, false);
      assert.equal(unchanged.revision, 0);
      assert.deepEqual(unchanged.scopes, []);
      budget.handle('configure', config({ moneyCapUsd: null, tokenCap: null }), human);
      budget.handle('configure', policy, human);
      const enabled = budget.modelStatus();
      assert.equal(enabled.configured, true);
      assert.equal(enabled.scopes.length, 2);
      assert.equal(enabled.scopes[0].policy.moneyCapNanoUsd, null);
      assert.equal(enabled.scopes[0].policy.tokenCap, null);
      await collect(budget.intercept(request(), good));
      await assert.rejects(collect(budget.intercept(request(), good)), code('BUDGET_TOKEN_LIMIT'));
      assert(budget.modelStatus().scopes.every(scope => scope.spent.tokens === 15));
    } finally { budget.close(); rmSync(home, { recursive: true, force: true }); }
  });

  test('price math: separate cache buckets, reasoning subset, cumulative snapshots and incremental deltas', () => {
    const home = make(); const ledger = new UsageLedger(home, { authorizeHuman: p => p === human });
    try {
      ledger.configure(config(), human);
      assert.throws(() => normalizeUsage(usage(1, 2, { totalTokens: 4 })), code('BUDGET_INVALID_USAGE'));
      assert.throws(() => normalizeUsage(usage(1, 2, { reasoningTokens: 3 })), code('BUDGET_INVALID_USAGE'));
      const r = ledger.reserve({ provider: 'fixture', model: 'm', inputTokens: 20, maxTokens: 10 });
      const first = usage(5, 2, { cacheReadTokens: 3, cacheWriteTokens: 2, reasoningTokens: 1 });
      ledger.observe(r.id, first); ledger.observe(r.id, first);
      const final = usage(5, 4, { cacheReadTokens: 3, cacheWriteTokens: 2, reasoningTokens: 2 });
      ledger.observe(r.id, final);
      assert.equal(ledger.status().scopes[0].spent.tokens, 14);
      assert.equal(ledger.status().scopes[0].spent.costNanoUsd, '19300');
      assert.equal(ledger.finish(r.id, { complete: true, reason: 'stop' }).status, 'settled');
      const next = ledger.reserve({ provider: 'fixture', model: 'm', inputTokens: 20, maxTokens: 10 });
      ledger.observe(next.id, usage(3, 1, { reasoningTokens: 1 }), { mode: 'incremental' });
      ledger.observe(next.id, usage(2, 2, { reasoningTokens: 1 }), { mode: 'incremental' });
      const settled = ledger.finish(next.id, { complete: true });
      assert.equal(settled.usage.totalTokens, 8); assert.equal(settled.usage.reasoningTokens, 2);
      assert.equal(ledger.status().scopes[0].spent.tokens, 22);
      // Single final rounding: splitting input among cache classes cannot exceed
      // the maximum-rate input reservation due to per-bucket rounding artefacts.
      const p = { rates: { input: '1', output: '1', cacheRead: '1', cacheWrite: '1' } };
      assert.equal(usageCostNanoUsd(normalizeUsage(usage(1, 1, { cacheReadTokens: 1, cacheWriteTokens: 1 })), p), '1');
      assert.throws(() => ledger.observe(next.id, final), code('BUDGET_INVALID_RESERVATION'));
    } finally { ledger.close(); rmSync(home, { recursive: true, force: true }); }
  });

  test('admission fails closed on unknown prices/bounds before dispatch; caps output', async () => {
    const home = make(); let count = 0;
    const budget = open(home);
    const dispatch = async function* (arg) { count++; yield* good(arg); };
    try {
      budget.handle('configure', config(), human);
      await assert.rejects(collect(budget.intercept(request({ model: 'unknown' }), dispatch)), code('BUDGET_UNKNOWN_PRICE'));
      const noBound = open(home, { getTrustedBounds: undefined });
      try { await assert.rejects(collect(noBound.intercept(request({ trustedBound: 1 }), dispatch)), code('BUDGET_TRUSTED_BOUND_REQUIRED')); }
      finally { noBound.close(); }
      const guessed = open(home, { getTrustedBounds: () => ({ inputTokens: 1, maxOutputTokens: 10 }) });
      try { await assert.rejects(collect(guessed.intercept(request(), dispatch)), code('BUDGET_TRUSTED_BOUND_REQUIRED')); }
      finally { guessed.close(); }
      budget.handle('configure', config({ tokenCap: 19 }), human);
      await assert.rejects(collect(budget.intercept(request(), dispatch)), code('BUDGET_TOKEN_LIMIT'));
      budget.handle('configure', config({ moneyCapUsd: '0.000049' }), human);
      await assert.rejects(collect(budget.intercept(request(), dispatch)), code('BUDGET_MONEY_LIMIT'));
      assert.equal(count, 0);
      budget.handle('configure', config(), human);
      await collect(budget.intercept(request({ maxTokens: 2000 }), dispatch));
      assert.equal(count, 1); assert.equal(budget.modelStatus().scopes[0].held.tokens, 0);
      assert.equal(budget.modelStatus().scopes[0].spent.tokens, 15);
    } finally { budget.close(); rmSync(home, { recursive: true, force: true }); }
  });

  test('shared project/global policy applies across purpose, session, children; no model project override', async () => {
    const home = make(), project = join(home, 'project'); mkdirSync(project);
    const budget = open(home, { resolveProject: () => project });
    try {
      budget.handle('configure', config(), human);
      budget.handle('configure', { scope: 'project', project, callsEnabled: true, tokenCap: 35, moneyCapUsd: null }, human);
      await collect(budget.intercept(request({ sessionId: 'parent', purpose: 'compaction' }), good));
      await collect(budget.intercept(request({ sessionId: 'child', purpose: 'quality-review', project: home }), good));
      await assert.rejects(collect(budget.intercept(request({ sessionId: 'other', purpose: 'session-title' }), good)), code('BUDGET_TOKEN_LIMIT'));
      const scopes = budget.modelStatus().scopes;
      assert.equal(scopes[0].spent.tokens, 30); assert.equal(scopes[1].spent.tokens, 30);
      assert.equal(scopes[1].policy.key, projectBudgetKey(project));
      const missingProject = open(home);
      try { await assert.rejects(collect(missingProject.intercept(request({ project }), good)), code('BUDGET_PROJECT_REQUIRED')); }
      finally { missingProject.close(); }
    } finally { budget.close(); rmSync(home, { recursive: true, force: true }); }
  });

  test('cancel, consumer-close, missing usage, malformed/regressed usage retain durable exposure', async () => {
    for (const variant of ['cancel', 'close', 'missing', 'invalid', 'regression', 'throw', 'overrun']) {
      const home = make(); let budget = open(home); const abort = new AbortController();
      try {
        budget.handle('configure', config(), human);
        const dispatch = async function* () {
          if (variant === 'throw') throw new Error('transport');
          if (variant !== 'missing') yield { type: 'usage', usage: usage(5, variant === 'overrun' ? 11 : 2) };
          if (variant === 'cancel') abort.abort();
          if (variant === 'invalid') yield { type: 'usage', usage: usage(-1, 3) };
          if (variant === 'regression') yield { type: 'usage', usage: usage(4, 2) };
          yield { type: 'finish', reason: { kind: variant === 'cancel' ? 'aborted' : 'stop' } };
        };
        if (variant === 'close') { for await (const _chunk of budget.intercept(request(), dispatch)) break; }
        else await assert.rejects(collect(budget.intercept(request({ signal: abort.signal }), dispatch)));
        const before = budget.modelStatus();
        assert.equal(before.pending.length, 1, variant);
        assert(['uncertain', 'overrun'].includes(before.pending[0].status), variant);
        assert(before.scopes[0].held.tokens > 0, variant);
        const id = before.pending[0].id;
        budget.close(); budget = open(home);
        assert.equal(budget.modelStatus().pending[0].id, id);
        await assert.rejects(collect(budget.intercept(request(), good)), code('BUDGET_UNCERTAIN_USAGE'));
        assert.throws(() => budget.handle('reset', {}, human), code('BUDGET_UNRESOLVED_RESERVATIONS'));
        assert.throws(() => budget.handle('reconcile', { id, chargeReserved: true }, human), code('BUDGET_RECONCILE_ACK_REQUIRED'));
        budget.handle('reconcile', { id, chargeReserved: true, acknowledgeUnknown: true }, human);
        assert.equal(budget.modelStatus().pending.length, 0);
        assert(budget.modelStatus().scopes[0].spent.tokens >= 20);
        budget.handle('reset', {}, human);
        assert.equal(budget.modelStatus().scopes[0].spent.tokens, 0);
        assert(budget.modelStatus().scopes[0].spent.lifetimeTokens >= 20);
      } finally { budget.close(); rmSync(home, { recursive: true, force: true }); }
    }
  });

  test('request is detached before asynchronous bounds; shared policy updates do not erase pending exposure', async () => {
    const home = make(), project = join(home, 'new-project'); mkdirSync(project);
    let release, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const ready = new Promise(resolve => { release = resolve; });
    const budget = open(home, { getTrustedBounds: async options => {
      entered(); await ready; assert.equal(options.messages[0].text, 'original');
      assert(Object.isFrozen(options.messages)); return bounds();
    } });
    try {
      budget.handle('configure', config(), human);
      const options = request({ messages: [{ text: 'original' }] });
      let seen;
      const result = collect(budget.intercept(options, async function* (arg) { seen = arg; yield* good(arg); }));
      await waiting; options.messages[0].text = 'changed'; options.model = 'changed'; release(); await result;
      assert.equal(seen.model, 'm'); assert.equal(seen.messages[0].text, 'original');
      const r = budget.ledger.reserve({ provider: 'fixture', model: 'm', inputTokens: 10, maxTokens: 10 });
      assert.throws(() => budget.handle('configure', { scope: 'project', project, callsEnabled: true, tokenCap: 10, moneyCapUsd: null }, human), code('BUDGET_UNRESOLVED_RESERVATIONS'));
      budget.handle('configure', config({ tokenCap: 1 }), human);
      assert.equal(budget.modelStatus().scopes[0].held.tokens, 20);
      budget.ledger.observe(r.id, usage());
      budget.ledger.finish(r.id, { complete: true });
      assert.equal(budget.modelStatus().scopes[0].spent.tokens, 30);
    } finally { budget.close(); rmSync(home, { recursive: true, force: true }); }
  });

  test('restart leaves interrupted pending reservation held; no timer/owner expiry', () => {
    const home = make(); let ledger = new UsageLedger(home, { authorizeHuman: p => p === human });
    try {
      ledger.configure(config({ tokenCap: 20 }), human);
      const receipt = ledger.reserve({ provider: 'fixture', model: 'm', inputTokens: 10, maxTokens: 10 });
      ledger.close(); ledger = new UsageLedger(home);
      assert.equal(ledger.status().pending[0].id, receipt.id);
      assert.equal(ledger.status().scopes[0].held.tokens, 20);
      assert.throws(() => ledger.reserve({ provider: 'fixture', model: 'm', inputTokens: 1, maxTokens: 1 }), code('BUDGET_TOKEN_LIMIT'));
    } finally { ledger.close(); rmSync(home, { recursive: true, force: true }); }
  });

  test('concurrent SQLite reservations across independent worker connections cannot overspend', async () => {
    const home = make(); const ledger = new UsageLedger(home, { authorizeHuman: p => p === human });
    const workers = [];
    try {
      ledger.configure(config({ tokenCap: 60, moneyCapUsd: '0.00015' }), human);
      const promises = Array.from({ length: 8 }, () => {
        const worker = new Worker(new URL(import.meta.url), { workerData: { home } }); workers.push(worker);
        return new Promise((resolve, reject) => { worker.once('error', reject); worker.once('message', message => {
          assert.equal(message, 'ready'); resolve();
        }); });
      });
      await Promise.all(promises);
      const results = await Promise.all(workers.map(worker => new Promise((resolve, reject) => {
        worker.once('error', reject); worker.once('message', resolve); worker.postMessage('reserve');
      })));
      assert.equal(results.filter(r => r.ok).length, 3);
      assert(results.filter(r => !r.ok).every(r => r.code === 'BUDGET_TOKEN_LIMIT' || r.code === 'BUDGET_MONEY_LIMIT'));
      const status = ledger.status();
      assert.equal(status.scopes[0].held.tokens, 60);
      assert.equal(status.scopes[0].held.costNanoUsd, '150000');
      assert.equal(status.pending.length, 3);
    } finally { await Promise.all(workers.map(w => w.terminate())); ledger.close(); rmSync(home, { recursive: true, force: true }); }
  });
}
