// Host-only integration for the FINAL dsh-llm adapter boundary. No SDK or network.
import { UsageLedger, BudgetError, projectBudgetKey } from './usage-ledger.js';
export { UsageLedger, BudgetError, projectBudgetKey } from './usage-ledger.js';

const fail = code => { throw new BudgetError(code); };
const positive = value => Number.isSafeInteger(value) && value > 0;
const normalFinish = new Set(['stop', 'tool-calls', 'max-tokens']);
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function snapshot(options) {
  // Detach caller-owned message/schema arrays before any await. Keep the real
  // signal, not structuredClone(AbortSignal), which loses its cancellation API.
  const { signal, ...data } = options;
  return Object.freeze({ ...freeze(structuredClone(data)), ...(signal ? { signal } : {}) });
}

/**
 * No global policy => legacy pass-through. The first authenticated human global
 * configure persists activation; callsEnabled:false then means DENY, not bypass.
 * Host callbacks are authority, never model options, role strings or tool JSON.
 */
export function createUsageBudget({ home, authorizeHuman = () => false, getTrustedBounds, resolveProject } = {}) {
  const ledger = new UsageLedger(home, { authorizeHuman });
  let closed = false;
  const check = () => { if (closed) fail('BUDGET_CONTROLLER_CLOSED'); };
  const modelStatus = () => { check(); return ledger.status(); };
  const handle = (action, args = {}, principal) => {
    check();
    if (action === 'status') return ledger.status();
    // Re-check the trusted authority at the boundary, including unsupported
    // mutation actions. A JSON {role:'human'} does not confer authority.
    if (authorizeHuman(principal) !== true) fail('BUDGET_HUMAN_ONLY');
    switch (action) {
      case 'configure': return ledger.configure(args, principal);
      case 'reset': return ledger.reset(args, principal);
      case 'reconcile': return ledger.reconcile(args, principal);
      case 'audit': return ledger.audit(args);
      default: return fail('BUDGET_UNKNOWN_ACTION');
    }
  };
  async function* intercept(options, dispatch, context = {}) {
    check();
    // Reads are durable on every admission; a sibling process can change policy.
    if (!ledger.status().configured) { yield* dispatch(options); return; }
    const request = snapshot(options);
    request.signal?.throwIfAborted();
    if (typeof getTrustedBounds !== 'function') fail('BUDGET_TRUSTED_BOUND_REQUIRED');
    const bound = await getTrustedBounds(request, context);
    // This contract includes system/tool schema/replay overhead, hidden provider
    // tokens and media. No chars/4, token-meter estimate, request-provided bound,
    // model catalog context window or guessed tokenizer is accepted here.
    if (!bound || bound.coversEntireRequest !== true || bound.outputCapEnforced !== true || bound.singleAttempt !== true ||
        !Number.isSafeInteger(bound.inputTokens) || bound.inputTokens < 0 || !positive(bound.maxOutputTokens) ||
        !['cumulative', 'incremental'].includes(bound.usageMode ?? 'cumulative')) fail('BUDGET_TRUSTED_BOUND_REQUIRED');
    if (request.maxTokens !== undefined && !positive(request.maxTokens)) fail('BUDGET_INVALID_BOUND');
    const maxTokens = Math.min(request.maxTokens ?? bound.maxOutputTokens, bound.maxOutputTokens);
    const finalRequest = Object.freeze({ ...request, maxTokens });
    // Resolver must derive the ORIGINAL project from trusted host/session state,
    // propagating it across worktrees, children, compaction and quality calls.
    const project = typeof resolveProject === 'function' ? await resolveProject(request, context) : undefined;
    const projectKey = project === undefined ? undefined : projectBudgetKey(project);
    request.signal?.throwIfAborted();
    const receipt = ledger.reserve({ provider: request.provider, model: request.model, projectKey,
      inputTokens: bound.inputTokens, maxTokens, sessionId: request.sessionId, purpose: request.purpose,
      mediaCovered: bound.mediaCovered === true });
    let finished = false, finishKind, terminalChunk, invalid = false;
    // Reservation commits BEFORE dispatch(), iterator creation or iterator.next().
    // Every exit after that point is potentially billable, including sync throws.
    try {
      for await (const chunk of dispatch(finalRequest)) {
        if (!chunk || typeof chunk !== 'object' || finished) { invalid = true; fail('BUDGET_INVALID_STREAM'); }
        if (chunk.type === 'usage') {
          try {
            const observed = ledger.observe(receipt.id, chunk.usage, { mode: bound.usageMode ?? 'cumulative' });
            if (observed.boundExceeded) fail('BUDGET_BOUND_EXCEEDED');
          } catch (error) { invalid = true; throw error; }
        } else if (chunk.type === 'finish') {
          // Do not forward a successful terminal before EOF/accounting: an
          // unknown usage error must not appear only AFTER a visible success.
          finished = true; finishKind = chunk.reason?.kind; terminalChunk = chunk;
          continue;
        }
        yield chunk;
      }
      // A valid terminal event + usage is necessary but not sufficient: consume
      // EOF as well. Closing a consumer at a yielded chunk remains uncertain.
      const result = ledger.finish(receipt.id, { complete: finished && normalFinish.has(finishKind) && !request.signal?.aborted,
        uncertain: invalid, reason: invalid ? 'invalid-usage' : finishKind ?? 'missing-finish' });
      if (result.status !== 'settled') fail(result.status === 'overrun' ? 'BUDGET_BOUND_EXCEEDED' : 'BUDGET_UNCERTAIN_USAGE');
      yield terminalChunk;
      return;
    } finally {
      // finish() itself may have persisted an uncertain/overrun result above.
      // Do not replace a valid error with an INVALID_RESERVATION error.
      const current = ledger.status().pending.find(r => r.id === receipt.id);
      if (current?.status === 'pending') ledger.finish(receipt.id, { uncertain: true,
        reason: invalid ? 'invalid-usage' : request.signal?.aborted ? 'aborted' : finished ? finishKind : 'consumer-closed' });
    }
  }
  return Object.freeze({ ledger, intercept, handle, modelStatus,
    close() { if (!closed) { closed = true; ledger.close(); } } });
}

/** Install ONLY against the stage-patched final boundary, never the waterfall. */
export function installUsageBudget(llmOrContext, options) {
  const llm = llmOrContext?.llm ?? llmOrContext;
  if (llm?.usageBudgetBoundaryVersion !== 1) fail('BUDGET_FINAL_BOUNDARY_REQUIRED');
  if (llm.qcUsageBudgetDispatch !== undefined) fail('BUDGET_ALREADY_INSTALLED');
  const controller = createUsageBudget(options);
  llm.qcUsageBudgetDispatch = controller.intercept;
  // No automatic detach on cancellation/disposal: the live runtime must not
  // silently revert to unbudgeted calls after enforcement has been activated.
  return controller;
}
