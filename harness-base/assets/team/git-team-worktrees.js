import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { atomic, json, protectedPath, serial } from './workspace-store.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const workspaceKey = Symbol.for('qcoderi.internal.team-worktree');

export function withTeamWorktree(request, cwd) {
  return { ...request, [workspaceKey]: cwd };
}

function git(cwd, args, { signal, input, index, merge = false } = {}) {
  signal?.throwIfAborted();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_ALLOW_PROTOCOL: '',
    GIT_AUTHOR_NAME: 'QCoderI', GIT_AUTHOR_EMAIL: 'qcoderi@localhost',
    GIT_COMMITTER_NAME: 'QCoderI', GIT_COMMITTER_EMAIL: 'qcoderi@localhost',
    GIT_LFS_SKIP_SMUDGE: '1',
  });
  if (index) env.GIT_INDEX_FILE = index;
  const disabledHooks = join(cwd, '.git', 'qcoderi-disabled-hooks');
  const opts = ['--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=' + disabledHooks, '-c', 'commit.gpgSign=false',
    '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', cwd];
  return new Promise((resolve, reject) => {
    const child = execFile('git', [...opts, ...args],
      { env, windowsHide: true, encoding: 'utf8', signal, timeout: 180000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return resolve({ stdout });
        if (merge && error.code === 1) return resolve({ stdout, conflict: true });
        if (signal?.aborted) return reject(signal.reason);
        reject(Error((stderr || error.message).trim().slice(0, 1800), { cause: error }));
      });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

async function output(cwd, args, options) {
  return (await git(cwd, args, options)).stdout.trim();
}

async function exists(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function pathKey(path) {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function within(root, target) {
  const rel = relative(pathKey(root), pathKey(target));
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
}

function samePath(left, right) {
  return pathKey(left) === pathKey(right);
}

function gitMatches(path, allowed) {
  const compare = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const target = compare(path);
  return allowed.some(path => {
    const prefix = compare(path);
    return prefix === '.' || target === prefix || target.startsWith(prefix + '/');
  });
}

function validWritePath(path) {
  return typeof path === 'string' && path.length > 0 && !/[:\\\x00-\x1f]/.test(path) &&
    (path === '.' || path.split('/').every(part => part && part !== '.' && part !== '..' &&
      !part.endsWith('.') && !part.endsWith(' '))) && !protectedPath(path);
}

function assertTaskId(id) {
  if (typeof id !== 'string' || !ID.test(id)) throw Error('Неверный идентификатор рабочей копии.');
}

function taskKey(taskId) {
  assertTaskId(taskId);
  return createHash('sha256').update(taskId).digest('hex').slice(0, 24);
}

async function resolveRef(repo, ref, signal) {
  try {
    return await output(repo, ['show-ref', '--verify', '--hash', ref], { signal });
  } catch (error) {
    if (error.cause?.code === 128 && /not a valid ref/iu.test(error.message)) return;
    if (error.cause?.code === 1) return;
    throw error;
  }
}

async function branchUnchecked(repo, branch, signal) {
  const { stdout } = await git(repo, ['worktree', 'list', '--porcelain', '-z'], { signal });
  if (stdout.split('\0').includes('branch ' + branch)) throw Error('Закройте рабочую копию ветки результата перед интеграцией.');
}

export class GitTeamWorkspace {
  constructor(metadata) { this.metadata = Object.freeze(metadata); }

  static async open({ cwd, storageDirectory, id = randomUUID(), signal }) {
    assertTaskId(id);
    cwd = await realpath(cwd);
    const repo = await realpath(await output(cwd, ['rev-parse', '--show-toplevel'], { signal }));
    await mkdir(storageDirectory, { recursive: true });
    const storage = await realpath(storageDirectory);
    const directory = join(storage, id);
    if (within(repo, directory)) throw Error('Каталог рабочих копий должен находиться за пределами репозитория.');
    return serial(directory, async () => {
      const branch = 'codex/qcoderi-team-' + id;
      const saved = await json(join(directory, 'batch.json'), null);
      if (saved) {
        if (!samePath(cwd, saved.cwd) || !samePath(repo, saved.repo)) throw Error('Рабочая копия относится к другому проекту.');
        return GitTeamWorkspace.resume(saved, { signal });
      }
      const { stdout } = await git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], { signal });
      if (stdout) throw Error('Для запуска Git worktree сохраните изменения проекта в коммите. Незакоммиченные файлы не копируются.');
      const baseCommit = await output(repo, ['rev-parse', '--verify', 'HEAD^{commit}'], { signal });
      const metadata = { id, cwd, repo, directory, branch, baseCommit };
      await mkdir(directory);
      await atomic(join(directory, 'batch.json'), JSON.stringify(metadata));
      return GitTeamWorkspace.resume(metadata, { signal });
    });
  }

  static async resume(metadata, { signal } = {}) {
    if (!metadata) throw Error('Рабочая копия команды не сохранена.');
    const { id, cwd, repo, directory, branch, baseCommit } = metadata;
    assertTaskId(id);
    const stored = await json(join(directory, 'batch.json'), null);
    if (!stored || !samePath(directory, await realpath(directory)) || within(repo, directory) ||
      !within(repo, cwd) || branch !== 'codex/qcoderi-team-' + id || !OID.test(baseCommit) ||
      ['id', 'cwd', 'repo', 'directory', 'branch', 'baseCommit'].some(key => stored[key] !== metadata[key])) {
      throw Error('Метаданные рабочей копии команды не совпадают.');
    }
    if (!samePath(repo, await realpath(await output(repo, ['rev-parse', '--show-toplevel'], { signal })))) {
      throw Error('Исходный путь перестал быть корнем Git-репозитория.');
    }
    const batch = new GitTeamWorkspace(stored);
    if (!(await resolveRef(repo, batch.ref, signal))) {
      const ref = await resolveRef(repo, batch.ref, signal);
      if (!ref) await git(repo, ['update-ref', '--no-deref', batch.ref, baseCommit, '0'.repeat(baseCommit.length)], { signal });
    }
    return batch;
  }

  get ref() { return 'refs/heads/' + this.metadata.branch; }
  taskRef(taskId) { return 'refs/qcoderi/team/' + this.metadata.id + '/' + taskKey(taskId); }

  async lookupTask(taskId, { signal } = {}) {
    const commit = await resolveRef(this.metadata.repo, this.taskRef(taskId), signal);
    return commit ? { commit, branch: this.metadata.branch } : null;
  }

  async createTask({ taskId, signal }) {
    const key = taskKey(taskId);
    const { repo, cwd, directory } = this.metadata;
    const root = join(directory, 'worktree-' + key);
    const file = join(directory, 'task-' + key + '.json');
    return serial(root, async () => {
      signal?.throwIfAborted();
      let task = await json(file, null);
      if (!task) {
        const baseCommit = await output(repo, ['rev-parse', '--verify', this.ref + '^{commit}'], { signal });
        task = { taskId, root, cwd: join(root, relative(repo, cwd)), baseCommit };
        await atomic(file, JSON.stringify(task));
      }
      if (task.taskId !== taskId || task.root !== root || !OID.test(task.baseCommit)) {
        throw Error('Метаданные рабочей копии исполнителя повреждены.');
      }
      if (!(await exists(root))) {
        await git(repo, ['worktree', 'add', '--detach', root, task.baseCommit]);
      }
      await this.checkTask(task, signal);
      return task;
    });
  }

  async checkTask(task, signal) {
    const { repo, cwd, directory } = this.metadata;
    const expected = join(directory, 'worktree-' + taskKey(task.taskId));
    const { stdout } = await git(repo, ['worktree', 'list', '--porcelain', '-z'], { signal });
    const own = stdout.split('\0').filter(field => field.startsWith('worktree '))
      .some(field => samePath(field.slice(9), expected));
    if (!own || !samePath(task.root, expected) || !samePath(expected, await realpath(expected)) ||
      !samePath(task.cwd, join(expected, relative(repo, cwd))) || !within(expected, await realpath(task.cwd))) {
      throw Error('Рабочая копия исполнителя больше не связана с этим репозиторием.');
    }
    const head = await output(expected, ['rev-parse', '--verify', 'HEAD^{commit}'], { signal });
    if (head !== task.baseCommit) throw Error('Исполнитель переключил HEAD или создал коммит. Рабочая копия сохранена для проверки.');
  }

  async integrateTask(task, writePaths, { signal } = {}) {
    const { repo, branch, cwd, directory } = this.metadata;
    return serial(directory, async () => {
      const previous = await this.lookupTask(task.taskId, { signal });
      if (previous) return { status: 'integrated', ...previous };
      await this.checkTask(task, signal);
      if (!Array.isArray(writePaths) || writePaths.some(path => !validWritePath(path))) {
        throw Error('Недопустимые пути для интеграции изменений.');
      }
      const prefix = relative(repo, cwd).split(sep).join('/');
      const allowed = writePaths.map(path => path === '.' ? prefix || '.' : prefix ? prefix + '/' + path : path);
      const status = await git(task.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], { signal });
      const changed = status.stdout.split('\0').filter(Boolean).map(entry => entry.slice(3));
      const violations = changed.filter(path => !validWritePath(path) || !gitMatches(path, allowed));
      if (violations.length) throw Error('Изменены файлы вне назначенных путей: ' + violations.slice(0, 20).join(', '));
      let candidate;
      if (changed.length) {
        const index = join(directory, 'index-' + randomUUID());
        try {
          await git(task.root, ['read-tree', task.baseCommit], { signal, index });
          await git(task.root, ['add', '--all', '--pathspec-from-file=-', '--pathspec-file-nul'],
            { signal, index, input: changed.join('\0') + '\0' });
          const affected = (await git(task.root, ['diff', '--cached', '--raw', '-z', '--no-renames'], { signal, index }))
            .stdout.split('\0').filter(Boolean);
          for (let offset = 0; offset < affected.length; offset += 2) {
            if (/(120000|160000)/.test(affected[offset].slice(0, 15)) ||
              !validWritePath(affected[offset + 1]) || !gitMatches(affected[offset + 1], allowed)) {
              throw Error('Изменение затрагивает ссылки, подмодули или файлы вне назначения: ' + affected[offset + 1]);
            }
          }
          if (affected.length) {
            const tree = await output(task.root, ['write-tree'], { signal, index });
            candidate = await output(repo, ['commit-tree', tree, '-p', task.baseCommit, '-m', 'QCoderI task ' + task.taskId], { signal });
          }
        } finally {
          await unlink(index).catch(() => {});
        }
      }
      await branchUnchecked(repo, this.ref, signal);
      const head = await output(repo, ['rev-parse', '--verify', this.ref + '^{commit}'], { signal });
      let commit = head;
      if (candidate) {
        const merged = await git(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', head, candidate],
          { signal, merge: true });
        const [tree, ...paths] = merged.stdout.split('\0').filter(Boolean);
        if (merged.conflict) throw Error('Конфликт интеграции: ' + (paths.slice(0, 20).join(', ') || task.taskId) +
          '. Рабочая копия сохранена: ' + task.root);
        if (!OID.test(tree)) throw Error('Git вернул неполный результат интеграции.');
        commit = await output(repo, ['commit-tree', tree, '-p', head, '-m', 'QCoderI: ' + task.taskId], { signal });
      }
      signal?.throwIfAborted();
      await git(repo, ['update-ref', '--stdin'], {
        input: `start\noption no-deref\nupdate ${this.ref} ${commit} ${head}\n` +
          `option no-deref\ncreate ${this.taskRef(task.taskId)} ${commit}\nprepare\ncommit\n`,
      });
      return { status: 'integrated', commit, branch };
    });
  }

  async closeTask(task) {
    // Integration writes a result ref, not the worker HEAD. Its dirty files may
    // include later user edits or ignored outputs: never force-delete this tree.
    return serial(this.metadata.directory, async () => {
      await this.checkTask(task);
      if (!(await this.lookupTask(task.taskId))) throw Error('Изменения рабочей копии ещё не интегрированы.');
      const { stdout } = await git(task.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored']);
      if (stdout) throw Error('Рабочая копия содержит изменения или игнорируемые файлы и сохранена: ' + task.root);
      return git(this.metadata.repo, ['worktree', 'remove', task.root]);
    });
  }
}
