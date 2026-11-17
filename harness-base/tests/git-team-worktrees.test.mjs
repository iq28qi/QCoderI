import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GitTeamWorkspace } from '../assets/team/git-team-worktrees.js';

test('worktrees integrate independent edits, reject conflicts and preserve the original checkout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qcoderi-git-team-'));
  const repo = join(directory, 'repo');
  await mkdir(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  try {
    git('init', '--quiet');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@localhost');
    await writeFile(join(repo, 'a.txt'), 'original-a\n');
    await writeFile(join(repo, 'b.txt'), 'original-b\n');
    git('add', '.');
    git('commit', '-qm', 'fixture');
    const initial = git('rev-parse', 'HEAD');
    const batch = await GitTeamWorkspace.open({ cwd: repo, storageDirectory: join(directory, 'tasks'), id: 'fixture' });
    const [left, right, conflicting] = await Promise.all(['left', 'right', 'conflicting'].map(taskId=>batch.createTask({taskId})));
    await writeFile(join(left.cwd, 'a.txt'), 'new-a\n');
    await writeFile(join(right.cwd, 'b.txt'), 'new-b\n');
    await writeFile(join(conflicting.cwd, 'a.txt'), 'conflict\n');
    assert.equal((await batch.integrateTask(left, ['a.txt'])).status, 'integrated');
    const result = await batch.integrateTask(right, ['b.txt']);
    assert.equal(git('show', result.branch + ':a.txt'), 'new-a');
    assert.equal(git('show', result.branch + ':b.txt'), 'new-b');
    await assert.rejects(batch.integrateTask(conflicting, ['a.txt']), /Конфликт/);
    assert.equal(await readFile(join(conflicting.cwd, 'a.txt'), 'utf8'), 'conflict\n');
    assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'original-a\n');
    assert.equal(git('rev-parse', 'HEAD'), initial);
    assert.equal(git('status', '--porcelain'), '');
    const restored = await GitTeamWorkspace.resume(batch.metadata);
    assert.equal((await restored.lookupTask('right')).commit, result.commit);
    assert.equal((await restored.createTask({taskId: 'conflicting'})).cwd, conflicting.cwd);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
