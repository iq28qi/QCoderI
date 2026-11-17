import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { atomic, hash, json, serial } from './workspace-store.js';
import { checksPassed, validatePlan } from './scheduler.js';

function validateRecord(record, cwd) {
  if (![1, 2].includes(record?.schema) || record.cwd !== cwd) throw Error('Сохранённая команда относится к другой рабочей папке или версии');
  if (typeof record.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(record.id)) throw Error('Повреждён id команды');
  const { plan, state } = record;
  if (!plan || !state || !Array.isArray(state.tasks)) throw Error('Повреждена сохранённая команда');
  const normalized = validatePlan({
    tasks: plan.tasks.map(task => ({ ...task, model: task.model && { ...task.model, effort: task.model.reasoningEffort } })),
    concurrency: plan.concurrency, timeout_seconds: plan.timeoutSeconds, shared_context: plan.sharedContext || undefined,
    repair_attempts: plan.repairAttempts ?? 0, budget_seconds: plan.budgetSeconds, workspace_mode: plan.workspaceMode ?? 'shared',
  });
  if (state.tasks.length !== normalized.tasks.length || !['running', 'paused', 'interrupted', 'failed', 'completed', 'cancelled'].includes(state.status)) throw Error('Повреждено состояние команды');
  state.tasks.forEach((task, index) => {
    const definition = normalized.tasks[index];
    if (task.id !== definition.id || !['queued', 'running', 'completed', 'failed', 'cancelled', 'skipped', 'paused'].includes(task.status)) throw Error('Повреждено состояние задачи');
    // Definitions in the plan, not mutable task state, are authoritative on recovery.
    for (const key of new Set([...Object.keys(definition), 'model'])) {
      if (JSON.stringify(task[key]) !== JSON.stringify(definition[key])) throw Error(`Сохранённое задание изменено: ${task.id}.${key}`);
    }
    for (const key of ['attempts', 'repairs_used']) if (task[key] !== undefined && (!Number.isSafeInteger(task[key]) || task[key] < 0)) throw Error(`Повреждён счётчик ${key}`);
    if (record.schema === 1 && task.repairs_used === undefined) task.repairs_used = Math.max(0, (task.attempts ?? 0) - 1);
    if (task.status === 'completed' && task.checks.length && (task.verification !== 'passed' || !checksPassed(task))) throw Error(`Завершённая задача без успешных проверок: ${task.id}`);
  });
  if (state.status === 'completed' && state.tasks.some(task => task.status !== 'completed')) throw Error('Команда завершена с незавершёнными задачами');
  state.shared_context = normalized.sharedContext;
  state.concurrency = normalized.concurrency;
  state.workspace_mode = normalized.workspaceMode;
  record.plan = normalized;
  return record;
}

export class TeamRuns {
  constructor(home, agent) {
    this.cwd = resolve(agent.session.header.cwd);
    this.file = join(home, hash(String(agent.session.id)), 'latest.json');
  }

  async load() {
    let value = await json(this.file, null);
    if (!value) return null;
    // The per-run file is written first. Recover its newer transition if a crash
    // happened between the two atomic writes, rather than rerunning old work.
    if (value.schema === 2 && /^[a-zA-Z0-9_-]{1,80}$/.test(value.id)) {
      const archived = await json(join(dirname(this.file), value.id + '.json'), null);
      if (archived) {
        if (archived.id !== value.id) throw Error('Архив команды не совпадает с latest');
        value = archived;
      }
    }
    const record = validateRecord(value, this.cwd);
    if (record.state.status === 'running') record.state.status = 'interrupted';
    return record;
  }

  create(plan, state) {
    return { schema: 2, id: randomUUID(), cwd: this.cwd, created_at: Date.now(), plan, state };
  }

  save(record) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(record.id)) throw Error('Повреждён id команды');
    record.updated_at = Date.now();
    // Snapshot now, not inside the queue: preserve ordering of concurrent transitions.
    const data = JSON.stringify(record);
    return serial(this.file + '#save', async () => {
      // Keep each run even when latest is replaced by a new batch. Both writes are atomic.
      await atomic(join(dirname(this.file), record.id + '.json'), data);
      await atomic(this.file, data);
    });
  }
}

export function prepareResume(state) {
  if (!['paused', 'interrupted', 'failed'].includes(state.status)) throw Error('Продолжить можно приостановленную, прерванную или неуспешную команду');
  for (const task of state.tasks) {
    if (task.status === 'completed' && task.checks.length && (task.verification !== 'passed' || !checksPassed(task))) throw Error(`Завершённая задача без успешных проверок: ${task.id}`);
    if (task.status !== 'completed' && task.phase === 'integration' && state.workspace_mode !== 'git_worktree') throw Error(`Интеграция ${task.id} прервана; нужна ручная проверка результата перед повторным запуском`);
  }
  for (const task of state.tasks) {
    if (task.status === 'completed') continue;
    // Preserve all evidence and lifetime repair counters; explicit resume does not
    // replenish automatic repairs. Interrupted verification needs no new worker.
    if (task.phase === 'integration' && state.workspace_mode === 'git_worktree') task.resume_phase = 'integration';
    else if (task.worker_completed && task.phase === 'verification' && task.verification !== 'failed') task.resume_phase = 'verification';
    else delete task.resume_phase;
    for (const key of ['waiting_for', 'finished_at']) delete task[key];
    task.status = 'queued';
  }
  state.status = 'running';
  state.resume_count = (state.resume_count ?? 0) + 1;
  state.resumed_at = Date.now();
  delete state.finished_at;
  delete state.pause_reason;
  delete state.detail;
}
