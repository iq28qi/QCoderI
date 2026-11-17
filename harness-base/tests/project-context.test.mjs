import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { searchProject, SEARCH_LIMITS } from '../assets/team/project-context.js';
import { WorkspaceStore } from '../assets/team/workspace-store.js';

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'qc-context-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function put(root, path, text) {
  const file = join(root, path);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, text);
}

test('live context ranks code, references line numbers and marks binary assets uninspected', () => fixture(async root => {
  await put(root, 'src/render.ts', 'first\nexport const characterRig = "jaw controls";\n');
  await put(root, 'art/characterRig.blend', Buffer.from([0, 1, 2]));
  const result = await searchProject(root, 'characterRig');
  assert.equal(result.results.find(x => x.kind === 'text').line, 2);
  assert.equal(result.results.find(x => x.kind === 'asset').inspected, false);
  assert.equal(result.coverage.mode, 'bounded-live-search');
  assert.equal(result.truncated, false);
  await put(root, 'src/render.ts', 'changed implementation');
  assert.equal((await searchProject(root, 'characterRig')).results.filter(x => x.kind === 'text').length, 0, 'never returns stale cached excerpts');
}));

test('private profiles, secrets, dependency trees and links are excluded', () => fixture(async root => {
  for (const path of ['.env', 'settings.yaml', 'credentials.json', 'api-key.txt', 'node_modules/lib/a.ts', 'backups/old.md', 'harness-base/data/storages/chat.json', 'sessions/chat.md']) {
    await put(root, path, 'needle secret');
  }
  await put(root, 'src/config.ts', 'const api_key = "needle-secret";\nconst needleFeature = true;');
  await put(root, 'binary.txt', Buffer.from([0, 110, 101, 101, 100, 108, 101]));
  const outside = await mkdtemp(join(tmpdir(), 'qc-context-link-'));
  try {
    await put(outside, 'needle.md', 'needle outside');
    await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await searchProject(root, 'needle');
    assert.deepEqual(result.results.map(x => x.path), ['src/config.ts']);
    assert.equal(result.results[0].line, 2);
    assert.doesNotMatch(JSON.stringify(result), /needle-secret|needle outside/);
    assert.deepEqual((await searchProject(join(root, 'harness-base'), 'needle')).results, [], 'nested workspace also excludes its private profile');
  } finally { await rm(outside, { recursive: true, force: true }); }
}));

test('validation, cancellation and honest bounds prevent an unbounded project scan', () => fixture(async root => {
  for (const query of ['', 'ab', null, 'x'.repeat(301)]) await assert.rejects(searchProject(root, query));
  const controller = new AbortController(); controller.abort(new Error('fixture stop'));
  await assert.rejects(searchProject(root, 'needle', controller.signal), /fixture stop/);
  await put(root, 'big.md', 'needle'.repeat(SEARCH_LIMITS.fileBytes));
  for (let i = 0; i < 25; i++) await put(root, `file-${i}.md`, 'needle');
  const result = await searchProject(root, 'needle');
  assert.equal(result.results.length, SEARCH_LIMITS.results);
  assert.equal(result.truncated, true);
  assert(result.coverage.bytes <= SEARCH_LIMITS.bytes);
}));

test('project memory persists decisions with provenance, ranks relevance and excludes expired records', () => fixture(async root => {
  const project = join(root, 'project'); await mkdir(project);
  const home = join(root, 'state'), store = new WorkspaceStore(home, project);
  await store.remember({ key: 'architecture', content: 'Use Unreal Blueprint for game logic', kind: 'decision' }, 'Keep game logic in Blueprint.');
  for (let i = 0; i < 6; i++) await store.remember({ key: `other-${i}`, content: 'unrelated '.repeat(240), kind: 'context' }, 'Other project information.');
  await store.update(state => state.memory.push({ id: 'expired', key: 'Unreal', kind: 'context', content: 'stale claim', expiresAt: 1, updatedAt: 1 }));
  const recovered = new WorkspaceStore(home, project), context = await recovered.context('Unreal Blueprint architecture');
  assert(context.memory.startsWith('[decision] architecture:'));
  assert(context.memory.length <= 6500);
  assert.doesNotMatch(context.memory, /stale claim/);
  assert.equal((await recovered.state()).memory.find(x => x.key === 'architecture').source, 'Keep game logic in Blueprint.');
}));
