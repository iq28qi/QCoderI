import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, stat, utimes, rename } from 'node:fs/promises';
import { join, dirname, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { manageProjectBrain, searchSemanticProject, BRAIN_LIMITS } from '../assets/team/project-brain.js';
import { words, matchScore, searchProject } from '../assets/team/project-context.js';

// No actual QCoderI home, workspace data, credentials or model/network services.
async function fixture(fn) {
  const base = await mkdtemp(join(tmpdir(), 'qc-brain-'));
  const store = { cwd: join(base, 'project'), directory: join(base, 'isolated-home', 'brain') };
  await mkdir(store.cwd);
  try { await fn(store, base); } finally { await rm(base, { recursive: true, force: true }); }
}
async function put(root, path, text) {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true }); await writeFile(file, text);
}
async function cacheFile(store) {
  return join(store.directory, (await readdir(store.directory)).find(name => /^project-brain-[a-f0-9]{32}\.json$/.test(name)));
}
async function payload(store) { return JSON.parse(JSON.parse(await readFile(await cacheFile(store), 'utf8')).payload); }
async function finish(store, args = {}, options = {}) {
  for (let i = 0; i <= BRAIN_LIMITS.scanEntries; i++) {
    const result = await manageProjectBrain(store, { operation: 'index', maxEntries: 2, ...args }, options);
    if (result.coverage.scanFinished) return result;
  }
  assert.fail('finite cursor did not finish');
}
const search = (store, query, options = {}) => searchSemanticProject(store, query, { autoIndex: false, ...options });

test('saved learned LSA retrieves a non-exact concept; hybrid exact code and dependency provenance persist', () => fixture(async store => {
  assert.deepEqual(words('FrameGraph framegraph draw-pass'), ['framegraph', 'draw-pass']);
  assert.equal(matchScore('FrameGraph renderer', ['framegraph', 'renderer']), 2);
  await put(store.cwd, 'notes/entry.md', 'login identity session cookie authentication\n');
  await put(store.cwd, 'notes/access.md', 'login identity authentication session cookie\n');
  await put(store.cwd, 'src/handshake.ts', 'export function establishIdentity() { return "identity session cookie handshake"; }\n');
  await put(store.cwd, 'notes/protocol.md', 'identity session cookie handshake authentication\n');
  await put(store.cwd, 'src/frame.ts', 'export function FrameGraph() { return "renderer shader texture pixels lighting"; }\n');
  await put(store.cwd, 'src/draw.ts', 'import { FrameGraph } from "./frame.js";\nexport const DrawPass = FrameGraph;\n');
  await put(store.cwd, 'notes/pixels.md', 'renderer shader texture pixels lighting\n');
  await put(store.cwd, 'notes/climate.md', 'rain cloud weather climate forecast pressure\n');
  await put(store.cwd, 'art/hero.blend', Buffer.from([0, 1, 2]));
  const indexed = await finish(store);
  assert.equal(indexed.coverage.complete, true);
  const saved = await payload(store);
  assert.equal(saved.version, 2);
  assert.equal(saved.model.method, 'tfidf-truncated-lsa-v1');
  assert(saved.model.dimensions > 0 && saved.model.dimensions < saved.model.vocabulary.length);
  assert(saved.model.basis.some(axis => axis.some(n => n !== 0)));
  assert(saved.files.find(f => f.path === 'src/handshake.ts').chunks[0].vector.some(n => n !== 0));
  const recovered = { ...store }; // New caller, persisted representation, no implicit scan.
  const semantic = await search(recovered, 'login');
  const inferred = semantic.results.find(r => r.path === 'src/handshake.ts');
  assert(inferred, JSON.stringify(semantic));
  assert.equal(inferred.match.exact, 0, 'query is absent from source/path/symbol: not renamed substring search');
  assert(inferred.match.semantic > 0.05);
  assert.equal(semantic.semantic.neural, false);
  const exact = await search(recovered, 'DrawPass');
  assert.equal(exact.results[0].path, 'src/draw.ts');
  assert(exact.results[0].match.exact >= 2, 'lexical and exact code-symbol signals');
  assert.match(exact.results[0].hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(exact.results[0].provenance.find(p => p.kind === 'import'), {
    kind: 'import', target: './frame.js', line: 1, parser: 'heuristic', source: 'src/draw.ts', resolvedPath: 'src/frame.ts',
  });
  assert.equal(exact.results[0].line, 1);
  assert.equal((await search(recovered, 'hero')).results.find(r => r.kind === 'asset').inspected, false);
  assert.equal((await manageProjectBrain(recovered, { operation: 'status' })).revision, indexed.revision, 'fresh searches do not rewrite the index');
}));

test('incremental finite batches resume after a new caller, hash same-size/restored-mtime edits and purge deletions', () => fixture(async store => {
  await put(store.cwd, 'src/a.ts', 'export const oldFeature = "oldFeature";\n');
  await put(store.cwd, 'src/b.ts', 'export const stableFeature = 1;\n');
  const first = await manageProjectBrain(store, { operation: 'index', maxEntries: 1 });
  assert.equal(first.coverage.scanFinished, false);
  assert(first.coverage.cursor.pending > 0);
  const completed = await finish({ ...store });
  assert.equal(completed.coverage.cursor.generation, first.coverage.cursor.generation);
  assert(completed.coverage.cursor.examined >= 4);
  const before = await payload(store), info = await stat(join(store.cwd, 'src/a.ts'));
  await put(store.cwd, 'src/a.ts', 'export const newFeature = "newFeature";\n');
  await utimes(join(store.cwd, 'src/a.ts'), info.atime, info.mtime);
  const refreshed = await finish(store);
  assert.equal(refreshed.coverage.reuse.changed, 1);
  assert.equal(refreshed.coverage.reuse.reused, 1);
  assert.notEqual((await payload(store)).files.find(f => f.path === 'src/a.ts').hash, before.files.find(f => f.path === 'src/a.ts').hash);
  assert((await search(store, 'newFeature')).results.some(r => r.path === 'src/a.ts' && /newFeature/.test(r.excerpt)));
  const nextInfo = await stat(join(store.cwd, 'src/a.ts'));
  await put(store.cwd, 'src/a.ts', 'export const altFeature = "altFeature";\n');
  await utimes(join(store.cwd, 'src/a.ts'), nextInfo.atime, nextInfo.mtime);
  const stale = await search(store, 'newFeature');
  assert.equal(stale.results.some(r => r.path === 'src/a.ts'), false);
  assert.equal(stale.validation.invalidated, 1);
  assert.equal((await payload(store)).files.some(f => f.path === 'src/a.ts'), false);
  await finish(store);
  await rm(join(store.cwd, 'src/b.ts'));
  // Query a different feature: even a deleted non-hit is removed from the cache/model.
  const deleted = await search(store, 'altFeature');
  assert.equal(deleted.validation.invalidated, 1);
  assert.equal((await payload(store)).files.some(f => f.path === 'src/b.ts'), false);
  await put(store.cwd, 'src/c.ts', 'export const finalFeature = 1;');
  await finish(store);
  await rm(join(store.cwd, 'src/c.ts'));
  const census = await finish(store);
  assert.equal(census.coverage.reuse.removed, 1);
  assert.equal((await payload(store)).files.some(f => f.path === 'src/c.ts'), false);
}));

test('no startup/status indexing; atomic publication, mid-fit cancellation, busy lock and corrupt cache recovery', () => fixture(async store => {
  const initial = await manageProjectBrain(store, { operation: 'status' });
  assert.equal(initial.cache, 'missing');
  await assert.rejects(stat(store.directory), { code: 'ENOENT' });
  await put(store.cwd, 'one.md', 'alpha saved implementation');
  await finish(store);
  const file = await cacheFile(store), committed = await readFile(file, 'utf8');
  await put(store.cwd, 'one.md', 'bravo modified implementation');
  const controller = new AbortController();
  const indexing = manageProjectBrain(store, { operation: 'index', rebuild: true }, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(new Error('fixture mid-transaction cancellation')), 1);
  try { await assert.rejects(indexing, /fixture mid-transaction cancellation/); } finally { clearTimeout(timer); }
  assert.equal(await readFile(file, 'utf8'), committed, 'cancelled work never publishes half an index');
  assert.deepEqual(await readdir(store.directory), [file.split(/[\\/]/).at(-1)], 'no temporary file or lock leaks');
  const envelope = JSON.parse(committed);
  assert.equal(createHash('sha256').update(envelope.payload).digest('hex'), envelope.checksum);
  await mkdir(file + '.lock');
  try { await assert.rejects(manageProjectBrain(store, { operation: 'index' }), { code: 'EBUSY' }); }
  finally { await rm(file + '.lock', { recursive: true }); }
  await writeFile(file, '{interrupted-write');
  assert.equal((await manageProjectBrain(store, { operation: 'status' })).cache, 'corrupt');
  const empty = await search(store, 'alpha');
  assert.deepEqual(empty.results, []);
  const recovery = await manageProjectBrain(store, { operation: 'index' });
  assert.equal(recovery.recoveredCorruptCache, true);
  assert.equal(recovery.durability.atomicRename, true);
  assert.equal(recovery.durability.readAfterWrite, true);
  assert.equal(recovery.durability.fileSynced, true);
  assert((await search(store, 'bravo')).results.length);
  const beforeWriteCancel = await readFile(file, 'utf8');
  const writeCancel = new AbortController();
  const watcher = watch(store.directory, (_event, name) => {
    if (String(name).endsWith('.tmp')) writeCancel.abort(new Error('fixture cancellation before atomic rename'));
  });
  try { await assert.rejects(manageProjectBrain(store, { operation: 'index' }, { signal: writeCancel.signal }), /before atomic rename/); }
  finally { watcher.close(); }
  assert.equal(await readFile(file, 'utf8'), beforeWriteCancel);
  assert.equal((await readdir(store.directory)).some(name => /\.(?:tmp|lock)$/.test(name)), false);
  // A checksum is not sufficient: structurally invalid caches are rejected too.
  const poisoned = await payload(store); poisoned.scan.pending = [{ path: '../escape', kind: 'directory' }];
  const invalid = JSON.stringify(poisoned);
  await writeFile(file, JSON.stringify({ payload: invalid, checksum: createHash('sha256').update(invalid).digest('hex') }));
  assert.equal((await manageProjectBrain(store, { operation: 'status' })).cache, 'corrupt');
  await manageProjectBrain(store, { operation: 'clear' });
  assert.equal((await manageProjectBrain(store, { operation: 'status' })).cache, 'missing');
}));

test('scoped privacy covers vocabulary/cache/provenance, whole-file secrets, private roots and symlinks', () => fixture(async (store, base) => {
  await put(store.cwd, 'src/allowed.ts', 'export const allowedConcept = "ordinary widget";');
  await put(store.cwd, 'other/restricted.md', 'restrictedCanary unrelated private caller scope');
  for (const path of ['.env', 'settings.yaml', 'credentials.json', 'api-key.txt', 'node_modules/lib/x.ts', 'backups/old.md', 'harness-base/data/storages/chat.json', 'sessions/chat.md', 'profiles/chat.md', 'storages/chat.md', 'project-brain-' + 'a'.repeat(32) + '.json']) {
    await put(store.cwd, path, 'privateCanary excluded source');
  }
  await put(store.cwd, 'src/config.ts', 'const harmlessFeature = "wholeFileCanary";\nconst api_key = "syntheticCanaryNotACredential";');
  await put(store.cwd, 'src/binary.txt', Buffer.from([0, 1, 2]));
  const outside = join(base, 'outside'); await mkdir(outside);
  await put(outside, 'escape.md', 'linkedCanary external content');
  await symlink(outside, join(store.cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await finish(store, {}, { scope: ['src'] });
  const scopedSearch = await search(store, 'allowedConcept', { scope: ['src'] });
  assert.equal(scopedSearch.results[0].path, 'src/allowed.ts');
  const saved = await readFile(await cacheFile(store), 'utf8');
  assert.doesNotMatch(saved, /privateCanary|restrictedCanary|wholeFileCanary|syntheticCanary|linkedCanary/);
  await assert.rejects(manageProjectBrain(store, { operation: 'index', paths: ['other'] }, { scope: ['src'] }), /scope/);
  await assert.rejects(manageProjectBrain(store, { operation: 'index', paths: ['src/../other'] }, { scope: ['src'] }), /scope/);
  await assert.rejects(manageProjectBrain(store, { operation: 'index', paths: ['sessions'] }), /excluded/);
  await assert.rejects(manageProjectBrain(store, { operation: 'index', paths: ['C:escape'] }), /scope/);
  await assert.rejects(manageProjectBrain({ cwd: store.cwd, directory: join(store.cwd, 'cache') }, { operation: 'index' }), /outside/);
  for (const cwd of [join(store.cwd, 'sessions'), join(store.cwd, 'harness-base/data'), parse(store.cwd).root]) {
    await assert.rejects(manageProjectBrain({ ...store, cwd }, { operation: 'index' }), /excluded/);
    await assert.rejects(searchProject(cwd, 'privateCanary'), /excluded/);
  }
  await assert.rejects(manageProjectBrain({ ...store, cwd: join(store.cwd, 'linked') }, { operation: 'index' }), /Links/);
  await assert.rejects(searchProject(join(store.cwd, 'linked'), 'linkedCanary'), /Links/);
  const broad = await finish(store);
  assert.equal(broad.coverage.files, 2, 'only public source and caller-other file in broader separate index');
  const fullCache = await payload(store);
  assert.doesNotMatch(JSON.stringify(fullCache), /privateCanary|wholeFileCanary|syntheticCanary|linkedCanary/);
  await put(store.cwd, 'src/allowed.ts', 'const password = "changedSecretCanary";');
  await search(store, 'restrictedCanary');
  for (const name of await readdir(store.directory)) {
    if (!name.endsWith('.json')) continue;
    const data = JSON.parse(JSON.parse(await readFile(join(store.directory, name), 'utf8')).payload);
    if (data.scopes[0] === '') {
      assert.equal(data.files.some(f => f.path === 'src/allowed.ts'), false, 'newly secret files and their old vectors are purged even for a different query');
      assert.doesNotMatch(JSON.stringify(data), /changedSecretCanary/);
    }
  }
  await search(store, 'allowedConcept', { scope: ['src'] });
  // A directory replaced by a junction must not expose its old cached hits.
  await rename(join(store.cwd, 'src'), join(store.cwd, 'retired'));
  await symlink(outside, join(store.cwd, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual((await search(store, 'allowedConcept', { scope: ['src'] })).results, []);
}));

test('chunk/byte limits and validation are explicit; rejected secret reads still consume batch budget', () => fixture(async store => {
  const padded = 'const password = "fixture";\n' + 'padding '.repeat(12000);
  await put(store.cwd, 'a.md', padded); await put(store.cwd, 'b.md', padded);
  const first = await manageProjectBrain(store, { operation: 'index', maxBytes: BRAIN_LIMITS.fileBytes + 1 });
  assert.equal(first.coverage.scanFinished, false, 'discarded secret bytes are not free');
  assert(first.coverage.cursor.pending > 0);
  await put(store.cwd, 'long.md', Array.from({ length: 400 }, (_, i) => `bounded concept line ${i}`).join('\n'));
  await finish(store); // Existing directory snapshot intentionally cannot see a newly added name.
  const done = await finish(store); // The next finite generation discovers long.md.
  assert(done.coverage.limitsHit.includes('file-chunks'));
  assert.equal(done.coverage.complete, false);
  assert((await payload(store)).files.every(f => f.chunks.length <= BRAIN_LIMITS.chunksPerFile));
  const result = await search(store, 'bounded');
  assert.equal(result.truncated, true);
  assert(result.validation.bytes <= BRAIN_LIMITS.validationBytes);
  const revision = (await manageProjectBrain(store, { operation: 'status' })).revision;
  for (const query of ['', 'ab', null, 'x'.repeat(301)]) await assert.rejects(searchSemanticProject(store, query));
  await assert.rejects(searchSemanticProject(store, 'valid', { autoIndex: 'false' }), /boolean/);
  await assert.rejects(searchSemanticProject(store, 'valid', { limit: 0 }), /limit/);
  assert.equal((await manageProjectBrain(store, { operation: 'status' })).revision, revision, 'invalid queries do not scan/commit');
}));
