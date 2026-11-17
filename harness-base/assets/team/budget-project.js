// Host-only original-project attribution. No request/prompt/cwd fallback and no I/O
// to providers. The caller installs this callback at the final budget boundary.
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, win32 } from 'node:path';
import { BudgetError } from './usage-ledger.js';

// Bound both work and persistence reads, including the initiating session.
const MAX_LINEAGE_SESSIONS = 128;
const fail = (code, message) => { throw new BudgetError(code, message); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sessionId = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 &&
  value === value.trim() && !/[\x00-\x1f\x7f]/u.test(value);

function validatePath(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() ||
      /[\x00-\x1f\x7f]/u.test(value) || !isAbsolute(value)) {
    fail('BUDGET_INVALID_PROJECT_PATH', 'Session project cwd must be an absolute filesystem path');
  }
  if (process.platform === 'win32') {
    // path.isAbsolute("\\project") is true, but that path depends on the
    // process's current drive. Device namespaces are not project identities.
    const normalized = win32.normalize(value);
    const root = win32.parse(normalized).root;
    if (/^\\\\[.?]\\/u.test(normalized) ||
        (!/^[A-Za-z]:\\$/u.test(root) && !/^\\\\[^\\]+\\[^\\]+\\$/u.test(root))) {
      fail('BUDGET_INVALID_PROJECT_PATH', 'Session project cwd must have a drive or UNC share root');
    }
    if (/[<>:"|?*]/u.test(value.replace(/^[A-Za-z]:/u, ''))) {
      fail('BUDGET_INVALID_PROJECT_PATH', 'Session project cwd contains invalid Windows path characters');
    }
    for (const part of normalized.slice(root.length).split('\\')) {
      if (/[ .]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part)) {
        fail('BUDGET_INVALID_PROJECT_PATH', 'Session project cwd contains an ambiguous or reserved Windows path component');
      }
    }
  }
}

function headerSnapshot(header, id) {
  if (!record(header)) fail('BUDGET_INVALID_SESSION_HEADER', 'Session header is unavailable or malformed');
  // Copy only trusted header scalars before any further await. These are the
  // current logical v3 fields returned by SessionStore and persistence.stat;
  // storage-format migration remains the persistence backend's responsibility.
  const { version, id: storedId, createdAt, isSeeded, origin, delegationDepth, parentSession, cwd } = header;
  if (version !== 3 || storedId !== id || !Number.isSafeInteger(createdAt) || createdAt < 0 ||
      typeof isSeeded !== 'boolean' || (origin !== undefined && origin !== 'subagent') ||
      (delegationDepth !== undefined && (!Number.isSafeInteger(delegationDepth) || delegationDepth < 0)) ||
      (parentSession !== undefined && !sessionId(parentSession))) {
    fail('BUDGET_INVALID_SESSION_HEADER', 'Session header identity or lineage is invalid');
  }
  // A removed worktree must not break attribution to an existing original
  // project. Check syntax on every header, but resolve/stat ONLY the root cwd.
  if (cwd !== undefined) validatePath(cwd);
  if (parentSession === undefined && (origin === 'subagent' || delegationDepth > 0 || isSeeded)) {
    fail('BUDGET_PARENT_SESSION_REQUIRED', 'Child/seeded session has no trusted parentSession');
  }
  return { parentSession, cwd };
}

function canonicalProject(cwd) {
  let canonical;
  try { canonical = realpathSync.native(cwd); }
  catch { fail('BUDGET_PROJECT_NOT_FOUND', 'Original session project path cannot be resolved'); }
  let directory;
  try { directory = statSync(canonical).isDirectory(); }
  catch { fail('BUDGET_PROJECT_NOT_FOUND', 'Original session project path cannot be inspected'); }
  if (!directory) fail('BUDGET_PROJECT_NOT_DIRECTORY', 'Original session project path is not a directory');
  // Same realpath and Windows case policy as usage-ledger.projectBudgetKey.
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/**
 * Create the host-owned createUsageBudget({ resolveProject }) callback.
 *
 * Uses the installed APIs: ctx.sessions.get(id), and, for cold sessions,
 * ctx.get('sessionPersistence').stat(id) -> { header, revision } | undefined.
 * Does NOT open/resume an agent or take persistence write ownership. A resumed
 * agent retains its persisted session id/header, so the same traversal applies.
 *
 * request.sessionId is a lookup key, not a project claim; request.project,
 * prompt, purpose, cwd and the per-dispatch context are never authority here.
 * The host must supply the correct sessionId at dispatch. This callback is not
 * a cryptographic dispatch capability and must not be exposed as a model tool.
 *
 * No result cache: teardown/resume and missing parents are rechecked per call.
 * An anonymous/unknown call is denied whenever the activated budget invokes us.
 * Only a positively known, top-level session with no cwd returns undefined.
 */
export function createBudgetProjectResolver(ctx) {
  async function readHeader(id, isParent) {
    let header;
    try {
      if (typeof ctx?.sessions?.get !== 'function') {
        fail('BUDGET_SESSION_SERVICE_REQUIRED', 'Trusted SessionStore is required for budget attribution');
      }
      const live = ctx.sessions.get(id);
      if (live !== undefined) {
        if (!record(live) || live.id !== id) {
          fail('BUDGET_INVALID_SESSION_HEADER', 'Live session identity does not match the requested session');
        }
        header = live.header;
        if (header === undefined) fail('BUDGET_INVALID_SESSION_HEADER', 'Live session has no session header');
      } else {
        // Cordis ctx.get is the real optional-service lookup API. Do not invent
        // sessions.load/getHeader, agents.getParent or id-addressed log reads.
        const persistence = ctx.get('sessionPersistence');
        if (persistence !== undefined) {
          if (typeof persistence?.stat !== 'function') {
            fail('BUDGET_SESSION_SERVICE_REQUIRED', 'Trusted session persistence must provide stat(id)');
          }
          const stored = await persistence.stat(id);
          if (stored !== undefined) {
            if (!record(stored)) fail('BUDGET_INVALID_SESSION_HEADER', 'Persistence stat returned an invalid snapshot');
            header = stored.header;
            if (header === undefined) fail('BUDGET_INVALID_SESSION_HEADER', 'Persistence snapshot has no session header');
          }
        }
      }
    } catch (error) {
      if (error instanceof BudgetError) throw error;
      // Backend corruption, unsupported format, absent optional service API,
      // and I/O failures must never turn into a child-cwd/undefined fallback.
      const failure = new BudgetError('BUDGET_SESSION_READ_FAILED', 'Trusted session lineage could not be read');
      failure.cause = error;
      throw failure;
    }
    if (header === undefined) {
      fail(isParent ? 'BUDGET_PARENT_SESSION_NOT_FOUND' : 'BUDGET_SESSION_NOT_FOUND',
        isParent ? 'Original project attribution requires the missing parent session' : 'Budget request has no known trusted session');
    }
    return headerSnapshot(header, id);
  }

  return async function resolveBudgetProject(request, _context) {
    const initialId = request?.sessionId;
    if (initialId === undefined) fail('BUDGET_SESSION_REQUIRED', 'Budget request requires a trusted session id');
    if (!sessionId(initialId)) fail('BUDGET_INVALID_SESSION_ID', 'Budget request session id is invalid');
    const seen = new Set();
    let id = initialId;
    for (;;) {
      if (seen.has(id)) fail('BUDGET_SESSION_CYCLE', 'Budget session parent chain contains a cycle');
      if (seen.size >= MAX_LINEAGE_SESSIONS) fail('BUDGET_SESSION_DEPTH_LIMIT', 'Budget session parent chain exceeds the safety limit');
      seen.add(id);
      const { parentSession, cwd } = await readHeader(id, seen.size > 1);
      if (parentSession !== undefined) {
        id = parentSession;
        continue;
      }
      if (cwd === undefined) {
        if (seen.size > 1) fail('BUDGET_PROJECT_REQUIRED', 'Descendant session has no attributable original project cwd');
        return undefined;
      }
      return canonicalProject(cwd);
    }
  };
}
