# LLM usage budgets: local admission envelope, not an invoice guarantee

## Scope and integration status

Owned modules: `assets/team/usage-budget.js`, `assets/team/usage-ledger.js`.
They are **opt-in**: no global policy exists on a new home, and requests pass
through unchanged. Installing the boundary alone does not activate budgeting.
Once a human configures the global policy, `callsEnabled:false` means **deny**;
it never falls back to legacy unaccounted dispatch. There is no model-callable
operation to remove the policy or bypass enforcement.

The native 1.3.3 staged integration now installs this controller from Workbench
when the versioned final dispatch boundary is present. The authenticated Budget
panel configures policy; `usage_budget` is read-only. The build prepares an
isolated archive and refreshes the runtime descriptor **after** applying the
boundary. No live source/runtime is hot-deployed.

**1.3.3 limitation:** that historical release certifies no ordinary provider
routes; configured calls refuse with `BUDGET_TRUSTED_BOUND_REQUIRED` before
inference dispatch.

**1.3.4 integration:** a reviewed prepared final-wire contract admits ONLY the
exact official `https://api.openai.com/v1` text snapshot
`gpt-4o-mini-2024-07-18`. It reserves the full documented accepted-request input
ceiling (128000 tokens), enforces a capped output (up to16384), permits one
transport request and verifies SDK-serialized body/endpoint before fetch.
The final package also validates raw SSE terminal usage before SDK normalization:
missing/malformed usage cannot silently become a zero-token success; the stream
fails and keeps its uncertain reservation. Final immutable package:
`dist/verified-1.3.4/QCoderI-1.3.4-local-windows-x64.zip`.
No catalog value or caller assertion certifies a route. A128000+output free
reservation is required even for a short input. Other routes remain fail-closed.
See `USAGE-PROVIDER-CONTRACT.md` for external API assumptions, deprecation and
limitations. No paid-provider request was made during verification.

Original-project attribution now traverses trusted persisted parentSession
headers, including worktrees/resume/compaction; missing or cyclic ancestry
refuses rather than falling back to child cwd. The ledger's verified behavior
below is unchanged. This must never be described as universal metering.

## Stage patch ordering

1. Prepare an isolated archive containing `dsh/node_modules`, using the normal
   leader-owned staging/build steps and existing patchers.
2. Run **after all patchers that replace/edit dsh-llm and after copying team
   assets**, before final packaging and the native budget test:
   `C:\Python314\python.exe harness-base/scripts/apply-usage-budget.py --archive <isolated-archive>`.
3. The patch inserts a versioned optional final-dispatch hook into exactly one
   `dsh-llm/lib/index.js` anchor and copies the two owned JS modules to
   `dsh/node_modules/@qcoderi/team/`. No package/index/Workbench files are edited.
   A second invocation is a no-op. Changed/ambiguous anchors cause a hard error.
   A destination under `harness-base/source` is explicitly refused. The leader
   must also ensure the supplied archive is not any other live runtime.
4. In trusted host bootstrap, import the module by its file URL/relative path
   (`@qcoderi/team/usage-budget` is **not** a package export added by this task),
   then install before a conversation, child, title or compaction can dispatch.
5. Run the tests below, then package the staged archive. Do not execute the
   patch against source and do not reload/restart the current app/agent.

The hook is in `LlmRuntime.adapterStream()`, **after** waterfalls, model
preparation, image/offload projection and `forAdapter()` replay filtering, but
**before** `dispatch(request)` / iterator creation. Both ordinary `llm.stream`
and `llm.prepareCall(...).stream` go through it. Real compaction's
`BasicCompactionEngine.summarize` calls `ctx.llm.stream`, so it is also covered.
This runtime exposes streaming generation, not a public `llm.generate()` method;
its adapter's internal generate is reached through the guarded stream dispatch.
The patch does not pretend an ordinary `llm/stream` waterfall is a final guard:
later middleware could otherwise change the request or issue another dispatch.
Metadata `prepareCall/resolveModel` may run before the hook; these are not paid
inference. If an adapter performs billable inference there, it is unsupported.

## Exact host API

```js
import { installUsageBudget } from './usage-budget.js';

// Host-owned object/capability, not a JSON role string. authorizeHuman must
// verify an authenticated direct user action on the Workbench UI API or CLI.
const controller = installUsageBudget(ctx.llm, {
  home: trustedGlobalDshHome, // identical for parent/children/quality processes
  authorizeHuman(principal) { return isVerifiedHumanHostPrincipal(principal); },
  async resolveProject(finalRequest, { llm, modelInfo }) {
    // Derive from trusted host/session ownership, NOT request.project, prompt,
    // model arguments, arbitrary cwd, a worktree or an unverified sessionId.
    return trustedOriginalProjectFor(finalRequest);
  },
  async getTrustedBounds(finalRequest, { llm, modelInfo }) {
    // Return undefined unless this exact route/envelope has a proven bound.
    return {
      inputTokens: provenUpperBoundForEntireRequest,
      maxOutputTokens: enforcedRouteOutputCeiling,
      coversEntireRequest: true,
      outputCapEnforced: true,
      singleAttempt: true,
      usageMode: 'cumulative', // default; trusted incremental adapters opt in
      mediaCovered: false,
    };
  },
});

// Read-only model tool: expose only this function, never controller/ledger.
const status = controller.modelStatus();

// Authenticated Workbench UI/CLI routes, inaccessible to model tools:
controller.handle('configure', policy, verifiedHumanPrincipal);
controller.handle('reset', { scope: 'global' }, verifiedHumanPrincipal);
controller.handle('reconcile', reconciliation, verifiedHumanPrincipal);
controller.handle('audit', { after: 0, limit: 100 }, verifiedHumanPrincipal);
controller.handle('status'); // read-only; same as modelStatus()
```

`createUsageBudget(options)` exports the same controller independently of a
runtime and exposes `intercept(options, dispatch, context)` as an async generator
for explicit host integration/testing. `installUsageBudget(llmOrContext, options)`
requires `llm.usageBudgetBoundaryVersion === 1`, rejects a second install, and
assigns the controller's interceptor to `llm.qcUsageBudgetDispatch`. Never
uninstall this property while that runtime is alive. `close()` closes the
SQLite handle, and future guarded calls fail rather than bypassing the guard;
it does not automatically detach on cancellation or plugin disposal.

Controller shape: `{ ledger, intercept, handle, modelStatus, close }`. `ledger`
is host-internal only. Ledger methods: `configure(policy, principal)`,
`reset({scope,project}, principal)`, `status()`, `audit({after,limit})`,
`reserve({provider,model,projectKey,inputTokens,maxTokens,sessionId,purpose})`,
`observe(id, usage, {mode:'cumulative'|'incremental'})`,
`finish(id,{complete,reason,uncertain})`,
`reconcile({id,usage,chargeReserved,acknowledgeUnknown}, principal)`, `close()`.
Low-level reserve/observe/finish are for the guard, never user/model tools.
Exports also include `UsageLedger`, `BudgetError`, `projectBudgetKey`.

### Explicit human policy

```js
controller.handle('configure', {
  scope: 'global', callsEnabled: true,
  moneyCapUsd: '2.50', tokenCap: 100000, // explicit null means no cap of that type
  prices: [{
    provider: 'exact-provider-id', model: 'exact-model-id', currency: 'USD',
    inputPerMillion: '1.00', outputPerMillion: '2.00',
    cacheReadPerMillion: '0.10', cacheWritePerMillion: '3.00',
    maxTokensIncludesReasoning: true,
  }],
}, verifiedHumanPrincipal);
controller.handle('configure', {
  scope: 'project', project: trustedOriginalProjectPath, callsEnabled: true,
  moneyCapUsd: '1.00', tokenCap: 50000,
}, verifiedHumanPrincipal);
```

Configure global first. Prices are exact-route, global-only and all four USD
per-million rates are required, including explicit zero for a genuinely free
category. Model aliases are not price aliases. USD values accept at most six
decimal places, no exponent notation; prefer decimal strings. Configure replaces
the whole policy (and global prices), never silently merges a partial update.
No automatic periodic resets or price fetching. Configure does not erase spent
or pending usage. Reset starts a new local period, preserves lifetime counters
and audit, and refuses unresolved reservations. Human policy changes and reset
are audited. Do not add a new project policy while older in-flight calls could
belong to it; the ledger refuses adding a scope with unresolved exposure.

A model supplying `{role:'human'}`, quoting a user instruction, requesting
larger caps or passing `trustedBound`/`project` fields has no authority. The
host authentication callback defaults to **deny**. Do not expose the generic
handler, SQLite path, policy writes, CLI executor or raw ledger as model tools.
This is an application authorization boundary, **not OS sandboxing**. A process
with arbitrary filesystem/code access to the same home can tamper with its
ledger or replace host code. Human-only enforcement also requires leader-owned
shell/file restrictions protecting the home, UI authorization and process config.
An unauthenticated local HTTP route or a CLI callable unrestrictedly by the model
would violate the contract even if it labels its input `human`.

## Conservative admission and actual usage

The current dsh-llm API has no trustworthy token-counting operation before
inference. A model catalog context window, `tokenMeter` estimate or chars/4
heuristic is **not** accepted as an exact count or proven bound. The trusted
callback must cover the final complete request: messages, system, tool schemas,
serialized/replay overhead, hidden provider input, images/files and any other
billable token input. It must also attest that the adapter/provider actually
honors `maxTokens` over **all** output including reasoning, and that no hidden
billable internal retry occurs. If these facts cannot be established, return
undefined and the paid route is denied before adapter dispatch. The implementation
does not auto-attest any production route or install a guessed tokenizer.

The request is detached/frozen before awaiting host callbacks. Output is capped
to `min(request.maxTokens ?? trusted.maxOutputTokens, trusted.maxOutputTokens)`.
All input is reserved at the **largest input/cache rate**, since the actual cache
partition is unknown before a response. Output is reserved at the output rate.
Both input+output token reserve and money reserve must fit **both** global and
matching project available envelopes. A project key is SHA-256 of canonical
existing path (case-folded on Windows); the host must propagate the original
project across child/worktree/quality calls. Missing project binding while any
project policy exists fails closed. Session IDs are hashed for diagnostics and
are not used to divide budgets. Purpose labels never change the policy.

Actual `StreamChunk {type:'usage', usage}` values use the real TokenUsage API:
`inputTokens`, `outputTokens`, optional `cacheReadTokens`, `cacheWriteTokens`,
`totalTokens`, `reasoningTokens`. Cache buckets are **separate** from input in
this API; reasoning is a **subset** of output. Optional total must agree with
the four charged buckets, and reasoning cannot exceed output. Missing input or
output, non-integer/negative counters, inconsistent totals or regressions fail
closed. Adapters with a different convention require trusted normalization
before this interface, not guessing inside the ledger.

The default is cumulative snapshots: repeated snapshots do not add charges;
only increases of each bucket are charged. Trusted incremental routes explicitly
set `usageMode:'incremental'`: events add to normalized cumulative counters.
There is no automatic inference of mode. Repeated incremental events cannot be
deduplicated without event IDs; the provider adapter must deliver each delta
exactly once. Costs use integer BigInt nanoUSD with a single upward rounding
of the weighted sum. Reservations use conservative upward rounding. Original
price snapshots remain attached to in-flight receipts across policy updates.
An observed bound overrun is recorded and blocks further calls immediately.

## Persistence, concurrency and uncertainty

`<home>/usage-budget/ledger.sqlite` uses SQLite WAL, `synchronous=FULL`, busy
wait and `BEGIN IMMEDIATE` for atomic reserve/check/account operations across
threads/processes. All runtimes must use the same real home; a separate home
is a separate budget. This is a local filesystem design, not distributed quota
coordination; do not put SQLite on an unsupported network filesystem.

A reservation commits before the adapter entry point. Partial actual charges
reduce the remaining hold, so spent+held exposure remains conservative without
double charging. Final settlement/release needs valid usage, a normal finish
(`stop`, `tool-calls`, `max-tokens`) **and consumed EOF**. The interceptor holds
the terminal chunk until EOF/accounting succeeds, so an unknown usage failure
does not follow an already-forwarded success terminal. Errors, abortion, timeout,
missing/invalid usage, consumer early-return or incomplete streams retain
uncertain exposure. Even cancellation after a usage event is not silently treated
as free or final. Interrupted pending records survive restart without expiry;
no PID/time-based cleanup releases them. Uncertain/overrun records block new
calls in their scopes until human reconciliation. Pending crashed records still
hold their unspent reserve and block reset; they are not presumed free.

After confirming no request is still live, a human can supply actual provider
usage (never lower than already observed), or explicitly acknowledge unknown
billing and charge at least the full reservation locally:

```js
controller.handle('reconcile', {
  id: receiptId,
  acknowledgeUnknown: true,
  chargeReserved: true,
}, verifiedHumanPrincipal);
// OR { id, acknowledgeUnknown:true, usage:actualNormalizedProviderUsage }
```

Acknowledging the reservation is labeled **estimate, not actual usage**. It
cannot establish the provider invoice or rule out a provider billing beyond a
trusted bound. Never automate this action on cancellation/restart. The human
must not reconcile an active stream; the host UI should confirm it is no longer
running before offering the action.

## Limitations and test evidence

* This is a **local admission money envelope**, not a financial invoice guarantee.
  Provider price drift, incorrect host bounds/contracts, taxes, exchange rates,
  external clients, provider bugs and already-started inference can exceed an
  invoice. Exact dollar prices are human configuration, not official billing.
* Every inference attempt through patched LlmRuntime is guarded, including
  prepared, child, quality-review, direct service and compaction routes. SDK
  hidden retries, alternate processes/homes, direct adapter/SDK bypass and
  non-LLM image/video/audio/transcription APIs are **not covered**. Disable such
  routes or wrap them separately. No hard budget claim for those paths.
* Installed-but-unconfigured intentionally preserves legacy behavior. This is
  not an active hard budget until authenticated policy exists. Once active,
  unknown price/bound/usage fails closed, even with both caps explicitly null.
* Workbench UI and CLI registration remain leader integration work; this module
  supplies a host handler, not an unauthenticated endpoint or a new model tool.
* Ledger retains receipt/audit history; no pruning policy is implemented. It
  stores counters, policy, price, hashes and outcomes, not prompts/credentials.

Focused checks (Node 24+, bundled Node supports `node:sqlite`):

```
G:\QCoderI\harness-base\app\resources\runtime\node\node.exe --test harness-base/tests/usage-budget.test.mjs
G:\QCoderI\harness-base\app\resources\runtime\node\node.exe harness-base/tests/usage-budget-native.mjs
```

Unit coverage: disabled legacy behavior, human-only handler, prices/cache/reasoning,
cumulative and incremental usage, output cap, missing price/bound denial, shared
scopes, money/token denials, malformed/missing/regressed usage, cancellation,
consumer-close, overruns, restart-held reservations, reconciliation/reset and
8 concurrent independent SQLite worker connections (only 3 reservations fit).
Native fixture uses an isolated temp home and copied/patched real LlmRuntime;
it invokes a real registered adapter entry (a no-network fixture), actual
prepared service path and actual BasicCompactionEngine summarize hook, checks
rejection **before adapter entry**, streamed repeated/cumulative usage, shared
charges, cancellation persistence and patch idempotency. Live source is read-only
and byte-compared unchanged. It creates no credentials; fetch is forbidden.
Neither test makes paid calls or proves provider-invoice accuracy.
