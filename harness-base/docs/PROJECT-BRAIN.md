# Persistent local Project Brain

## Scope and method

`assets/team/project-brain.js` continues the saved on-demand implementation. It performs **no indexing on import/startup**, downloads nothing, makes no network/model calls and consumes no model tokens. It imports only Node built-ins and `project-context.js`; neither module imports/re-exports `workspace-store.js`, so `workspace-store -> project-context` remains acyclic.

The semantic representation is actually learned and persisted, not a label for substring search:

1. Split eligible UTF-8 source into bounded, line-addressed chunks. Tokenization splits camelCase, underscores and hyphens, filters a small English/Russian stop list and applies conservative English suffix normalization. At most 512 tokens are read per chunk including its path.
2. Learn a corpus vocabulary and smoothed IDF: `idf(t) = 1 + log((1 + documents) / (1 + df(t)))`. Each sparse row uses `(1 + log(tf)) * idf` and L2 normalization.
3. Approximate the leading eigenvectors of `A^T A` using deterministic seeded power iteration (18 iterations/axis), orthogonal deflation and event-loop yields for cancellation. Rank is bounded by `min(24, vocabulary, max(1, documents - 1), ceil(sqrt(documents)))`.
4. Persist vocabulary, IDF, low-rank basis and normalized projected chunk vectors. Queries use the **same saved transform**. Positive cosine similarity in the learned space can retrieve a chunk without the query's literal words if the local corpus supplies a co-occurrence bridge.
5. Hybrid ranking: `3 * pathFraction + 3 * textFraction + 2 * exactSymbol + max(0, semanticCosine)`. Fractions use legacy `words(query)` terms. Exact symbols/import provenance are heuristic, not a compiler/call graph. Exact code concepts retain priority.

This is **local TF-IDF/truncated LSA**, not a neural embedding, pretrained language understanding, general synonym dictionary or multilingual translation model. Tiny corpora, out-of-vocabulary queries, poorly connected concepts and approximate singular vectors can produce weak/spurious matches. `retainedEnergy` is a numerical diagnostic, not semantic accuracy. Binary assets are path inventory only (`inspected: false`), never scene/animation inspection. No full or unlimited project coverage is claimed.

## Exact integration API

Import relatively inside the team package (no package-export-map change is required):

```js
import { searchSemanticProject, manageProjectBrain, BRAIN_LIMITS } from './project-brain.js';
// Preserved legacy API, still a bounded live lexical search:
import { words, matchScore, searchProject } from './project-context.js';
```

Store input is structural: `{ cwd: string, directory: string }`; an existing `WorkspaceStore` instance works. `cwd` must be an actual project directory, not a filesystem root, symlink/junction, excluded directory or a descendant of an excluded directory. `directory` must be a trusted application-owned state directory **outside** the project, not a filesystem root, and contain no symlink/junction component. No real credentials or session database are needed.

```ts
type BrainOptions = {
  signal?: AbortSignal;
  scope?: string[]; // TRUSTED caller allowlist, default ['']; [] means no source access
};
type IndexArgs = {
  operation: 'index'; paths?: string[];
  maxEntries?: number; // integer 1..12000, default 400
  maxBytes?: number;   // integer 131073..8388608, default 2097152
  rebuild?: boolean;  // reset this scope's corpus/cursor in this transaction
};
type SearchArgs = {
  operation: 'search'; query: string; paths?: string[];
  limit?: number;     // integer 1..20, default 20
  autoIndex?: boolean; // default true: exactly ONE finite index batch, never drain all batches
  maxEntries?: number; maxBytes?: number;
};
manageProjectBrain(store, args: IndexArgs | SearchArgs |
  { operation: 'status' | 'clear'; paths?: string[] }, options?: BrainOptions): Promise<object>;

searchSemanticProject(store, query, options?: BrainOptions & {
  paths?: string[]; limit?: number; autoIndex?: boolean; maxEntries?: number; maxBytes?: number;
}): Promise<object>;
```

`query` is 1–300 characters and must contain a legacy `words()` term of at least three characters. Invalid queries/limits are rejected before any scan/write. Paths are relative project paths, with optional slash/backslash separators. Absolute, drive-relative, traversal, colon/ADS and NUL paths are rejected. Duplicates/nested scopes are normalized. `args.paths`/search `options.paths` can only **narrow** the trusted `options.scope`. Never take `scope`, `cwd` or `directory` from model-supplied arguments. Canonical root + normalized effective scope determines a separate cache key: a narrow request never loads a broad cache or post-filters broad learned vectors.

Operations:

- **status**: read/validate only, no scan, directory creation or write. Returns `cache: 'ready' | 'missing' | 'corrupt'`, optional warning, revision, timestamp, semantic summary, coverage and limits. Does not read current source or certify freshness.
- **index**: one finite resumable batch. A new process/caller resumes the persisted cursor. If the last generation finished, the next call starts a new generation; `rebuild: true` discards old state only upon successful publication. Partial commits can contain old and newly visited files; search always revalidates source.
- **search**: defaults to one index batch then validated hybrid search; pass `autoIndex: false` for saved-index-only search. Even with auto-index disabled, it hashes the bounded cached corpus and may atomically purge stale files/vectors. It does not silently return stale cached text or replace stale content with unindexed content. Run the next index generation to discover changed/new source.
- **clear**: delete only this root/scope's cache; returns `{ cleared: true, scope, cache: 'missing', coverage }`. It does not clear sibling scope caches. It requires the normal transaction lock.

Example workbench integration:

```js
const trusted = { signal: exec.signal, scope: allowedProjectPaths }; // from host policy
const state = await manageProjectBrain(store, { operation: 'status' }, trusted);
// User/tool explicitly requests a batch; UI can offer Continue until scanFinished.
const progress = await manageProjectBrain(store, { operation: 'index', maxEntries: 400 }, trusted);
const hits = await searchSemanticProject(store, args.query, {
  ...trusted, paths: args.paths, limit: 10, autoIndex: false,
});
```

### Response shape

Status/index response:

```ts
{
  cache: 'ready' | 'missing' | 'corrupt'; warning?: string;
  revision: number; updatedAt: number | null;
  semantic: { method: 'tfidf-truncated-lsa-v1'; neural: false; localOnly: true;
    dimensions: number; vocabulary: number; retainedEnergy: number };
  coverage: Coverage; limits: typeof BRAIN_LIMITS;
  // only when a transaction committed:
  durability?: { atomicRename: true; fileSynced: true; readAfterWrite: true; directorySynced: boolean };
  recoveredCorruptCache?: boolean;
}
```

Search response:

```ts
{
  results: Array<{
    kind: 'text'; path: string; line: number; endLine: number; excerpt: string;
    hash: string; score: number; match: { exact: number; semantic: number };
    provenance: Provenance[];
  } | { kind: 'asset'; path: string; inspected: false; score: number; hash: null; provenance: [] }>;
  truncated: boolean; coverage: Coverage;
  validation: { files: number; bytes: number; invalidated: number; limited: boolean;
    asOf: 'per-file hash read, not an atomic workspace snapshot' };
  semantic: { method: 'tfidf-truncated-lsa-v1'; neural: false; localOnly: true };
  notice: string; revision: number;
  cache?: 'ready' | 'missing' | 'corrupt'; warning?: string;
  durability?: { atomicRename: true; fileSynced: true; readAfterWrite: true; directorySynced: boolean };
  recoveredCorruptCache?: boolean;
}
type Provenance = {
  kind: 'symbol' | 'import'; name?: string; target?: string;
  line: number; source: string; parser: 'heuristic'; resolvedPath?: string;
};
type Coverage = {
  mode: 'persistent-local-lsa'; files: number; chunks: number; sourceBytes: number;
  scanFinished: boolean; complete: boolean;
  cursor: null | { generation: string; pending: number; examined: number };
  limitsHit: string[]; unreadable: number;
  reuse: null | { hashed: number; reused: number; changed: number; removed: number };
};
```

`match.exact` is the sum of path/text fractions and the exact-symbol indicator (range 0–3), not a probability. `resolvedPath` only resolves relative imports to an indexed source; it is omitted from search output if its target was not currently validated. `.js` runtime specifiers may resolve to `.ts`/`.tsx` sources. No transitive dependency closure, type checking or dynamic import resolution is promised. Treat `target` as untrusted source text, not authorization to open another file. Hash is SHA-256 of the **whole file's bytes**, not just the returned chunk. Line numbers are 1-based.

`coverage.complete` only means a finished finite census without reached scan/content limits or unreadable entries, **within the allowed extension/privacy policy**. It is not a claim to index every project file. `scanFinished` can be true with `complete: false`. `truncated` is also true for extra matches, unfinished/limited coverage or exhausted validation bytes. Always show coverage/notice to callers; never relabel this as complete project knowledge.

## Persistence schema and transaction behavior

Cache name: `store.directory/project-brain-<32 hex>.json`, keyed by SHA-256 of JSON `[canonicalRoot, effectiveScopes]`. Schema **version 2** (unsupported version 1 caches are safely ignored/rebuilt on demand).

Envelope: `{ checksum: sha256(payload), payload: '<JSON string>' }`.

Payload:

```ts
{
  version: 2; root: string; scopes: string[]; revision: number; updatedAt: number | null;
  files: Array<{
    path: string; kind: 'text' | 'asset'; hash: string | null; bytes: number;
    seen: string; incomplete?: boolean; inspected?: false;
    chunks: Array<{ line: number; endLine: number; text: string;
      provenance: Provenance[]; vector: number[] }>;
  }>;
  model: null | { method: 'tfidf-truncated-lsa-v1'; vocabulary: string[]; idf: number[];
    basis: number[][]; dimensions: number; documents: number; retainedEnergy: number };
  scan: null | {
    generation: string;
    pending: Array<{ path: string; kind: 'unknown' | 'directory' | 'file' }>;
    examined: number; hashed: number; reused: number; changed: number; removed: number;
    unreadable: number; limitsHit: string[]; finished: boolean;
  };
}
```

Text files have hash/bytes/incomplete/chunks; assets have `hash: null, bytes: 0, inspected: false, chunks: []` and no content read. `seen` is the generation that actually visited the file. Contents, provenance, vocabulary, matrix dimensions, budgets, cursor paths, allowed fields and checksum are validated before use. Corrupt/truncated/unsupported caches return empty `corrupt` status/search rather than exposing malformed data; an explicit/default index batch recovers them. No corrupt backup containing source data is retained. The checksum detects damage, **not malicious modification/authentication/encryption**; application state storage must remain trusted and access-controlled.

Transactions are serialized per scope cache in-process and use a cross-process `*.lock` directory. Contention/orphan locks return `EBUSY`, never steal a potentially live lock. After a crash the host must verify no writer exists before manually removing the orphan lock/temp. The implementation does not auto-recover a dead-process lock.

Publication uses an exclusive random `*.tmp`, mode 0600 where honored, file `fsync`, read-after-write verification, a final abort check and atomic same-directory rename. A directory `fsync` is attempted; Windows/filesystem limitations appear as `directorySynced: false`. Abort/error **before rename** preserves the last committed generation and cleans this attempt's temp/lock. Rename is the commit point: a later abort cannot undo a successful commit. Full power-loss durability on every filesystem is not guaranteed. A process killed without finally-cleanup may leave an orphan; no partial temp is ever loaded as the cache.

## Freshness, finite coverage and privacy

Every visited text file is hashed, including same-size/restored-mtime edits. Unchanged hashes reuse chunks/provenance (the bounded LSA basis is refitted); changed files replace old chunks. Deletions are removed on a complete generation census. A limited/unreadable directory snapshot is never mistaken for proof that all unvisited files were deleted. A persisted directory snapshot cannot discover a name created after its enumeration; the **next generation** discovers it. Directory enumeration is bounded and may use a filesystem-dependent subset in an oversized directory; it is sorted only after taking that subset. There is no watcher or automatic background loop.

Before returning search results the bounded cached corpus is reread/hash-validated (not merely mtime/size checked). Deleted, changed, now-secret, inaccessible or link-replaced source files are removed from the cache and learned model even if they are not query hits; returned excerpts are only from validated files. If validation budget is exhausted, unvalidated files yield **no results**; coverage/`validation.limited` are explicit. Unvalidated old data may remain at rest until the next scan/clear. Source can change after validation: this is per-file evidence, not an atomic workspace snapshot. Recheck the source before editing/executing conclusions. `status` alone never guarantees freshness.

Privacy filters run on project roots, scopes, traversed names, loaded cache paths, whole text before indexing and fresh search reads. Symlinks/junctions are not followed (including ancestor components); no scene or binary contents are read into the index. Hidden paths, credential/secret/key/token/settings names, sessions, storage/profile/attachment trees, backups, generated/dependency trees, `harness-base/data`, and Brain cache names are excluded. Recognized credential assignments, bearer tokens, common provider key formats, private key blocks and credential URLs exclude the **entire file** from chunks, provenance and vocabulary. The legacy live `searchProject` preserves line-level redaction for compatibility, but gains the same root/path/link checks and bounded reads.

Secret detection is conservative pattern matching with false positives and false negatives, **not a guarantee that arbitrary PII or unknown secrets can be recognized**. Use the trusted `scope` allowlist for sensitive workspaces; never index a user's home or credential/session directory as a project. Caches contain allowed source excerpts/vocabulary and are not encrypted. Separate scope caches are separate retained records; clearing one does not erase another. Privacy of already cached data follows explicit reads/index/clear, not a background erasure service. Hostile filesystem races/hard links are not a complete OS sandbox; ordinary concurrent edits/link substitutions are rejected by path, handle identity and stat rechecks, with `O_NOFOLLOW` where available.

### Hard bounds

`BRAIN_LIMITS` is exported and authoritative:

| Resource | Maximum/default |
| --- | --- |
| UTF-8 source file | 128 KiB |
| Stored source bytes / files / chunks | 8 MiB / 1,024 / 2,048 |
| Chunks per file / lines / characters | 12 / 24 / 1,800 |
| Vocabulary / LSA dimensions | 1,024 / 24 |
| Generation entries / directory entries / frontier | 12,000 / 2,048 / 6,000 |
| One batch default entries / bytes read | 400 / 2 MiB |
| Cache envelope | 16 MiB |
| Results / candidate cap / search validation bytes | 20 / 160 / 8 MiB |

Rejected secret/binary/unstable reads still consume the batch/validation read budget. A one-byte growth probe is reserved in byte checks, so the minimum batch byte budget is 131,073. CPU work and memory are bounded by corpus dimensions, not wall-clock deadlines; pass `AbortSignal` for cancellation. A refit may be expensive on the maximum corpus and currently happens once per successful index batch, not a true incremental SVD.

## Focused checks

From `harness-base`:

```powershell
& 'G:\QCoderI\harness-base\app\resources\runtime\node\node.exe' --test tests/project-brain.test.mjs tests/project-context.test.mjs
```

Brain fixtures use a disposable project and isolated temporary state home; no real sessions/credentials are opened. Coverage includes non-exact corpus-linked retrieval, persisted vectors/imports, exact symbols, resumable batches, same-size/restored-mtime edits, delete/non-hit/now-secret purging, cancellation before fit/rename publication, atomic checksums/temp cleanup, corrupt-cache recovery, busy locks, scope isolation including vocabulary/caches, root rejection, junction replacement and explicit content/read bounds. No runtime/application restart, dependency installation, build/deployment or paid call is required.
