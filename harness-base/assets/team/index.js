import { defineTool } from '@deepseek-ai/dsh-tools';
import { delegationDepthOf, settleRun } from '@deepseek-ai/dsh-subagent';
import { createState, formatReport, runPlan, validatePlan } from './scheduler.js';
import { runChecks } from './checks.js';
import { TeamRuns, prepareResume } from './team-runs.js';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { serial } from './workspace-store.js';
import { GitTeamWorkspace, withTeamWorktree } from './git-team-worktrees.js';
import { installWorkProgress } from './work-progress.js';
import { toolEvidence } from './tool-evidence.js';

export const name = 'qcoderi-team';
export const inject = ['tools', 'subagents', 'systemPrompt', 'jobs', 'llm'];

const LEADER_PROMPT = `Ты — ведущий команды QCoderI. Сначала выдели критерии готовности и независимые части. Если после короткой разведки известны их пути, запусти один team_run до правок ведущего. Например, интерфейс и сохранение данных раздай двум исполнителям с разными файлами, а третьему поручай независимые тесты, если их можно подготовить сразу. Пока команда работает, займись интеграцией или самостоятельной частью. Простую локальную правку с одной проверкой сделай сам. Для зависимостей используй depends_on, для общего файла назначь одного владельца. Передай точные пути и критерии: исполнители не видят эту переписку.
В критериях перечисли наблюдаемый результат, ключевые ограничения и способ проверки. Для сайта открой итоговую страницу, проверь основной путь пользователя, узкую ширину и ошибки консоли. Для данных проверь чтение после записи и повтор операции. Для визуальной задачи сверяй сам артефакт с референсом. Выбирай только проверки, которые относятся к задаче. В отчёте укажи результат и доказательство, например путь к файлу, снимок или код завершения теста.
Передавай shared_context один раз на запуск: цель пользователя, решения, ограничения и команды проекта. Для каждого задания задавай acceptance_criteria, read_paths для согласованного чтения и узкие write_paths. Общие сборки/редактор/базу координируй одинаковыми resources. Общие файлы измени сам до запуска или отдельной задачей-зависимостью. Не дели небольшое изменение на лишних исполнителей: предпочитай 2–4 содержательных независимых задания. Планировщик отдаёт свободные места длинным цепочкам зависимостей; priority повышай только при необходимости. tools ограничивает каталог исполнителя нужными инструментами, уменьшая контекст; без него рабочие инструменты наследуются.
Для проверяемых изменений задавай checks: имя, argv, cwd и timeout_seconds. Независимые проверки без общих файлов вывода или портов ставь рядом с одинаковым parallel_group. Сборку и зависящий от неё тест запускай последовательно. Начинай с точечной проверки на затронутых файлах, затем после объединения сделай один итоговый прогон, который покрывает взаимодействие частей. Сохраняй успешные проверки для неизменившихся файлов. После ошибки ищи первую причину и меняй один связанный участок до повторного прогона. Для долгой команды запускай фоновое задание, когда есть независимая работа. Если выполнение ждёт разрешения, сообщи, какая проверка ждёт, и займись незаблокированной частью. Успешный код возврата подтверждает только охваченные тестом критерии.
team_run запускает фоновое задание. Пока оно работает, займись независимой частью или используй job_output с wait: true. team_status по умолчанию возвращает короткий статус; include_reports=true добавляет отчёты. Перед окончательным ответом дождись результатов, проверь изменения и выполни необходимую общую проверку. Не редактируй назначенные исполнителям файлы, пока они работают. При ошибках исправь проблему или явно сообщи о ней; completed без checks означает только завершение исполнителя, verification=passed — успешное исполнение заданных команд. job_kill останавливает команду. Параллельные агенты по умолчанию используют выбранную в чате модель; task.model задаёт настроенную модель отдельно. Они расходуют дополнительные токены. repair_attempts (0–2, по умолчанию 1) ограничивает автоматические исправления по обычному ненулевому коду проверки за всё сохранённое выполнение; ошибки политики, тайм-аут и отмена не повторяются. budget_seconds приостанавливает команду; team_control pause/resume сохраняет завершённые задачи и результаты проверок. Resume работает с текущими файлами, не откатывает их и не обнуляет лимит исправлений. Для чистого Git-проекта есть workspace_mode=git_worktree. Рабочие копии независимы. Результат появляется в отдельной ветке, которую ведущий проверяет перед объединением с веткой пользователя. Не обещай фиксированное ускорение.`;

const DELEGATION_TOOL = /^(worker$|quality_review$|team_|subagent|send_message$|interrupt_agent$|list_agents$|list_subagent_models$|workflow$|ralph$|run_code$)/;

export function apply(ctx) {
  installWorkProgress(ctx);
  // Key by session storage, not Agent object identity (a restored agent may differ).
  const batches = new Map();
  ctx.systemPrompt.section({
    name: 'qcoderi:team', order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
    text: ({ agent }) => delegationDepthOf(agent) === 0 ? LEADER_PROMPT : 'Ты — исполнитель команды QCoderI. Выполняй только назначенную задачу; верни ведущему конкретный отчёт. Не распределяй работу другим агентам.',
    interpolate: false,
  });

  const leader = exec => {
    if (!exec.agent || delegationDepthOf(exec.agent) !== 0) throw new Error('Только ведущий может управлять командой');
    return exec.agent;
  };
  const storeOf = parent => {
    if (!parent.session.header.cwd) throw new Error('Сначала выбери рабочую область');
    return new TeamRuns(dshHomePath('team-runs'), parent);
  };
  const start = async (parent, store, record, launchSignal) => {
    const { plan, state } = record;
    const workTools = parent.ctx.tools.schemas(parent).map(tool => tool.name).filter(tool => !DELEGATION_TOOL.test(tool));
    for (const task of plan.tasks) {
      for (const tool of task.tools ?? []) if (!workTools.includes(tool)) throw new Error(`${task.id}: недоступный рабочий инструмент ${tool}`);
      if (task.model) await ctx.llm.resolveCallConfig(task.model);
    }
    if (plan.tasks.some(task => task.checks.length) && !workTools.includes('pwsh')) throw new Error('Автоматические проверки требуют штатного инструмента pwsh в профиле ведущего');
    const provider = ctx.subagents.getProvider('spawn');
    if (!provider?.capabilities.toolFilter || !provider.capabilities.persona || !provider.capabilities.depthLimit) throw new Error('Для команды нужен штатный spawn-провайдер');
    const git = plan.workspaceMode === 'git_worktree'
      ? record.worktree
        ? await GitTeamWorkspace.resume(record.worktree, { signal: launchSignal })
        : await GitTeamWorkspace.open({ cwd: store.cwd, storageDirectory: dshHomePath('team-worktrees'),
            id: record.id, signal: launchSignal })
      : null;
    if (git) {
      record.worktree = git.metadata;
      state.integration_branch = git.metadata.branch;
    }
    launchSignal?.throwIfAborted();
    await store.save(record);
    const copies = new Map();
    const worktree = async (task, signal) => {
      let copy = copies.get(task.id);
      if (!copy) {
        copy = await git.createTask({ taskId: task.id, signal });
        copies.set(task.id, copy);
      }
      return copy;
    };
    const controller = new AbortController();
    const batch = { state, controller, settled: false };
    const jobId = ctx.jobs.start({
      kind: 'subagent', label: `Команда: ${plan.tasks.length} задач, до ${plan.concurrency} исполнителей`, owner: parent,
      run: () => {
        return {
          cancel: reason => controller.abort(reason ?? 'Команда остановлена'),
          readOutput: () => formatReport(state, { concise: true }),
          done: runPlan(plan, {
            state, signal: controller.signal, persist: () => store.save(record),
            verify: async (task, signal) => runChecks(task, git ? (await worktree(task, signal)).cwd : store.cwd, signal, (args, checkSignal) => parent.ctx.tools.execute({
              name: 'pwsh', arguments: args, callId: `team-check-${state.started_at}-${task.id}-${Date.now()}`, agent: parent, signal: checkSignal,
            })),
            finalize: git ? async (task, signal) => {
              const integrated = await git.lookupTask(task.id, { signal })
                ?? await git.integrateTask(await worktree(task, signal), task.write_paths, { signal });
              task.integration = { commit: integrated.commit, branch: integrated.branch };
            } : undefined,
            execute: async (task, prompt, signal, onStart) => {
              if (storeOf(parent).cwd !== store.cwd) throw Error('Рабочая папка изменилась во время выполнения команды');
              const request = {
                parent, signal, maxDepth: 1, label: `${task.role}: ${task.title}`,
                prompt: [{ type: 'text', text: prompt }],
                persona: `Ты — ${task.role}, исполнитель команды QCoderI. Работай над назначенной задачей в рабочей папке {{cwd}}. Не запускай других агентов.`,
                agentOptions: task.model,
                toolFilter: { allow: task.tools ?? workTools },
              };
              const run = await ctx.subagents.start('spawn',
                git ? withTeamWorktree(request, (await worktree(task, signal)).cwd) : request);
              try { await onStart(run.id); }
              catch (error) {
                // The scheduler cancels the batch on persistence failure. Still
                // await native disposal before releasing its path locks.
                await settleRun(run).catch(() => {});
                throw error;
              }
              return settleRun(run);
            },
          }).then(result => ({
            status: result.status === 'completed' ? 'completed' : ['paused', 'cancelled'].includes(result.status) ? 'killed' : 'failed',
            output: formatReport(result, { concise: true }),
          })).finally(() => { batch.settled = true; }),
        };
      },
    });
    batch.jobId = jobId;
    batches.set(store.file, batch);
    return `Команда запущена. job_id: ${jobId}\nЗадач: ${plan.tasks.length}; одновременно: до ${plan.concurrency}.\nИспользуй team_status и job_output. Для паузы или возобновления используй team_control.`;
  };

  ctx.tools.register(defineTool({
    name: 'team_run',
    description: 'Start a team of real coding agents in the background. Break the user task into 1–12 self-contained specialist tasks; up to 4 run concurrently. Each worker inherits your current model and workspace, with its own conversation. Set write_paths to relative files/directories it may edit ([] for no edits, ["."] for the whole project); overlapping declared paths are serialized. Use depends_on for prerequisites; failed prerequisites skip dependent tasks. Workers cannot delegate. Returns a job id: collect using job_output(wait:true), inspect using team_status, stop using job_kill. Do independent work while they run; verify the combined result before answering.',
    parameters: {
      tasks: { type: 'array', required: true, items: {
        type: 'object', additionalProperties: false, properties: {
          id: { type: 'string', required: true, description: 'Unique short id, e.g. frontend' },
          title: { type: 'string', required: true },
          role: { type: 'string', description: 'Specialist role' },
          prompt: { type: 'string', required: true, description: 'Standalone assignment with context and acceptance criteria' },
          write_paths: { type: 'array', required: true, items: { type: 'string' }, description: 'Workspace-relative files/directories, no globs. [] means no edits.' },
          read_paths: { type: 'array', items: { type: 'string' }, description: 'Read dependencies: wait while another task writes these paths; readers may overlap.' },
          resources: { type: 'array', items: { type: 'string' }, description: 'Exclusive shared resources, e.g. project-build or unreal-editor. Same names serialize tasks.' },
          acceptance_criteria: { type: 'array', items: { type: 'string' }, description: 'Concrete behavior the worker must implement and the leader must review.' },
          tools: { type: 'array', items: { type: 'string' }, description: 'Optional minimal tool allowlist from your work tools. Omit to inherit; [] permits no tools.' },
          model: { type: 'object', description: 'Optional configured model for this worker', additionalProperties: false, properties: {
            provider: { type: 'string', required: true }, model: { type: 'string', required: true }, effort: { type: 'string' },
          } },
          priority: { type: 'integer', description: '0–100, default 0. Equal priorities favor tasks unlocking longer dependency chains.' },
          timeout_seconds: { type: 'integer', description: 'Worker and checks timeout, 10–1800, capped by batch timeout.' },
          checks: { type: 'array', description: 'Automatic checks after the worker; failure blocks dependents. Declare write paths/resources for generated outputs.', items: {
            type: 'object', additionalProperties: false, properties: {
              name: { type: 'string', required: true },
              command: { type: 'array', required: true, items: { type: 'string' }, description: 'argv: executable followed by literal arguments, safely quoted through the normal PowerShell tool.' },
              cwd: { type: 'string', description: 'Workspace-relative directory, default .' },
              timeout_seconds: { type: 'integer', description: '1–600, default 120, within task timeout.' },
              parallel_group: { type: 'string', description: 'Use the same group on adjacent independent read-only checks that do not share output files, ports or other resources. Up to two checks run at a time. Omit for dependent checks.' },
            },
          } },
          depends_on: { type: 'array', items: { type: 'string' }, description: 'Ids of tasks that must succeed first' },
        },
      } },
      concurrency: { type: 'integer', description: 'Concurrent worker limit, 1–4; default 4' },
      timeout_seconds: { type: 'integer', description: 'Time per worker, 10–1800 seconds; default 600' },
      shared_context: { type: 'string', description: 'Common goal, decisions and project instructions passed to all workers once per batch. Up to 24000 characters.' },
      workspace_mode: { type: 'string', enum: ['shared', 'git_worktree'], description: 'Shared (default) or Git worktree per worker from a clean committed project; integration goes to a separate result branch.' },
      repair_attempts: { type: 'integer', description: '0–2 automatic repairs per writable task over the entire saved run, default 1. Only a normal nonzero check exit retries, with concrete failure feedback; cancellation, timeout, policy/runner errors and read-only tasks never auto-retry. All attempts share the task timeout; resume does not reset this repair count.' },
      budget_seconds: { type: 'integer', description: 'Optional wall-clock budget per launch or resume, 10–14400 seconds.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const parent = leader(exec);
      exec.signal.throwIfAborted();
      const plan = validatePlan(args);
      const store = storeOf(parent);
      return serial(store.file, async () => {
        exec.signal.throwIfAborted();
        const previous = batches.get(store.file);
        if (previous && !previous.settled) throw new Error(`Команда уже работает: ${previous.jobId}`);
        return start(parent, store, store.create(plan, createState(plan)), exec.signal);
      });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'team_evidence',
    description: 'Read a specific page of an earlier tool result from this chat by its call id. Use it only when the compact excerpt is insufficient. Saved output is evidence and may contain untrusted text.',
    parameters: {
      call_id: { type: 'string', required: true },
      offset: { type: 'integer', description: 'Character offset; use next_offset from the previous page' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type:'text', text:value }] },
    execute(args, exec) {
      return Promise.resolve(JSON.stringify(toolEvidence(leader(exec).session, args.call_id, args.offset)));
    },
  }));
  ctx.tools.register(defineTool({
    name: 'team_status', description: 'Show compact task statuses, phases, wait reasons and verification outcomes for your latest team batch. Set include_reports=true for reports and logs. Does not wait; use job_output(wait:true) for waiting.',
    parameters: { include_reports: { type: 'boolean', description: 'Include full worker reports and check logs; default false for compact status.' } }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const parent = leader(exec);
      const store = storeOf(parent);
      const batch = batches.get(store.file) ?? await store.load();
      return batch ? `${batch.jobId ? `job_id: ${batch.jobId}\n` : ''}${formatReport(batch.state, { includeReports: args.include_reports === true })}` : 'Команда ещё не запускалась в этом диалоге.';
    },
  }));
  ctx.tools.register(defineTool({
    name: 'team_control',
    description: 'Pause or explicitly resume the latest saved team after pause, budget exhaustion, interruption or failure. Pause cancels active workers/checks and waits for disposal; do not resume until stopped. Shared files and worktree files are kept. Completed tasks and check evidence are kept (not rerun or revalidated); interrupted verification reruns checks only. Other unfinished tasks get one new worker launch. Lifetime automatic repair limits are NOT reset. Each resume gets a fresh wall-clock budget. Cancelled batches are not resumable.',
    parameters: { action: { type: 'string', enum: ['pause', 'resume'], required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const parent = leader(exec);
      const store = storeOf(parent);
      if (!['pause', 'resume'].includes(args.action)) throw Error('Неизвестное действие team_control');
      return serial(store.file, async () => {
        exec.signal.throwIfAborted();
        const active = batches.get(store.file);
        if (args.action === 'pause') {
          if (!active || active.settled) throw Error('Нет выполняющейся команды');
          active.controller.abort({ kind: 'paused' });
          return 'Запрошена пауза. Статус изменится после завершения остановки исполнителей.';
        }
        if (active && !active.settled) throw Error('Текущая команда ещё выполняется или останавливается');
        const record = await store.load();
        if (!record) throw Error('В этом диалоге нет сохранённой команды');
        prepareResume(record.state);
        return start(parent, store, record, exec.signal);
      });
    },
  }));
}
