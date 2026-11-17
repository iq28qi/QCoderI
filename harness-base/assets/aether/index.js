import { defineTool } from '@deepseek-ai/dsh-tools';
import { promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { storeImage, visualOutput } from '@qcoderi/team/desktop';
import { AetherBridgeError, callSession, discoverSessions } from './bridge.js';

export const name = 'qcoderi-aether';
export const inject = ['tools', 'systemPrompt', 'attachments'];

const PROMPT = `Для работы в AETHER Motion Studio используй aether_status, aether_tools, aether_command и aether_viewport. aether_open запускает установленный AetherMotionStudio.exe. Параметр app_directory выбирает каталог приложения или его исходников, QCODERI_AETHER_HOME задаёт постоянный путь. При нескольких редакторах выбирай session из aether_status и передавай тот же идентификатор всем вызовам одной задачи.
Перед работой получи aether_status и доступные инструменты через aether_tools. Для конкретной операции aether_tools(method) возвращает точную схему аргументов. Вызывай только implemented=true. Версия 0.1 поддерживает сцену, OBJ, трансформ-анимацию, сохранение .aemotion, Undo/Redo и структурную валидацию. Скелет, AutoRig, веса, IK, физика и Unreal зависят от возможностей реально подключённой версии.
GUI и API изменяют общий открытый документ. Используй реальные object_id/clip_id из результатов. Для изменений передавай expected_revision из последнего наблюдения. При REVISION_CONFLICT заново прочитай затронутые объекты. После неоднозначного тайм-аута или отмены сначала проверь сцену и историю. Повтор создания может породить дубликат. system.batch объединяет поддерживаемые обратимые изменения в одну транзакцию и Undo. Для файлов передавай абсолютные пути; импорт и экспорт ограничены схемами редактора.
Получай краткую сводку и выборку объектов. Геометрия в результатах по умолчанию сворачивается до количества вершин и треугольников, include_geometry=true включает её полностью в пределах лимита ответа. Математику выполняет редактор. После визуальных изменений вызови aether_viewport, оцени настоящий кадр и покажи результат пользователю. validation.run сообщает область выполненных проверок. Один кадр подтверждает вид в выбранный момент.
Для нескольких агентов назначай ресурс aether-editor заданиям, которые меняют один документ. Независимый анализ выполняй по снимкам, применяй изменения с проверкой revision. Сохраняй результат проекта через project.save. Выбранная в чате модель и её уровень мышления действуют и для этого профиля.`;

const targetParameters = {
  app_directory: { type: 'string', description: 'Каталог AETHER или его исходников. По умолчанию QCODERI_AETHER_HOME и локальное обнаружение.' },
  session: { type: 'string', description: 'Идентификатор сессии или metadata_path из aether_status. Обязателен при нескольких открытых редакторах.' },
};
const textOutput = { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] };

function checked(response) {
  if (response.error) {
    const data = response.error.data ?? {};
    throw new Error(JSON.stringify({ code: data.code ?? response.error.code, message: response.error.message, ...data }));
  }
  if (!response.result || response.result.ok !== true) throw new Error('AETHER вернул результат без подтверждения операции');
  return response.result;
}

function compact(value, includeGeometry = false) {
  if (Array.isArray(value)) return value.map(item => compact(item, includeGeometry));
  if (!value || typeof value !== 'object') return value;
  const result = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (key === 'mesh' && item && typeof item === 'object' && !includeGeometry) {
      result[key] = { ...item,
        ...(Array.isArray(item.vertices) ? { vertices: item.vertices.length } : {}),
        ...(Array.isArray(item.triangles) ? { triangles: item.triangles.length } : {}),
        ...(Array.isArray(item.vertices) || Array.isArray(item.triangles) ? { geometry_omitted: true } : {}),
      };
    } else result[key] = compact(item, includeGeometry);
  }
  return result;
}

async function sessions(args, exec) {
  const candidates = await discoverSessions({ home: args.app_directory, workspace: exec.agent?.session.header.cwd });
  const matches = args.session ? candidates.filter(candidate =>
    [candidate.id, String(candidate.pid), candidate.metadata_path].includes(args.session)) : candidates;
  if (args.session && !matches.length) throw new Error('Сессия AETHER отсутствует в выбранном каталоге. Обнови aether_status.');
  const inspected = await Promise.all(matches.map(async candidate => {
    try {
      const state = checked(await callSession(candidate, 'bridge.get_session', {}, { signal: exec.signal, timeoutMs: 1500 }));
      if (state.data?.pid !== candidate.pid || state.data?.live_document !== true || state.data?.protocol !== 'aether-jsonrpc-v1') {
        throw new Error('Сессия редактора изменилась');
      }
      return { ...candidate, connected: true, revision: state.revision };
    } catch (error) {
      exec.signal.throwIfAborted();
      return { ...candidate, connected: false, error: { code: error.code ?? 'SESSION_UNAVAILABLE', message: 'Редактор недоступен или сессия изменилась' } };
    }
  }));
  return inspected;
}

async function selectSession(args, exec) {
  const connected = (await sessions(args, exec)).filter(session => session.connected);
  if (!connected.length) throw new Error('AETHER недоступен. Запусти aether_open или укажи app_directory открытого редактора.');
  if (connected.length > 1) throw new Error(`Открыто несколько редакторов AETHER. Выбери session через aether_status: ${connected.map(session => session.id).join(', ')}`);
  return connected[0];
}

function executableCandidates(appDirectory, cwd) {
  const roots = appDirectory ? [appDirectory] : [process.env.QCODERI_AETHER_HOME, cwd, 'G:\\IAAnimeshAETHER'].filter(Boolean);
  return [...new Set(roots.flatMap(root => [join(resolve(root), 'AetherMotionStudio.exe'), join(resolve(root), 'dist/AetherMotionStudio/AetherMotionStudio.exe')]))];
}

async function findExecutable(appDirectory, cwd) {
  for (const file of executableCandidates(appDirectory, cwd)) {
    try { if ((await fs.stat(file)).isFile()) return file; }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  throw new Error('AetherMotionStudio.exe не найден. Укажи app_directory с полной папкой приложения.');
}

async function openEditor(args, exec) {
  const existing = (await sessions(args, exec)).filter(session => session.connected);
  if (existing.length) return { connected: true, already_running: true, sessions: existing,
    message: args.project_file ? 'Выбери сессию и открой проект командой project.load с expected_revision.' : 'Редактор уже доступен.' };
  if (process.platform !== 'win32') throw new Error('Запуск AetherMotionStudio.exe поддерживается в Windows');
  const executable = await findExecutable(args.app_directory, exec.agent?.session.header.cwd);
  const launchArgs = [];
  if (args.project_file) {
    const project = resolve(exec.agent?.session.header.cwd ?? process.cwd(), args.project_file);
    if (!project.toLowerCase().endsWith('.aemotion') || !(await fs.stat(project)).isFile()) throw new Error('Нужен существующий файл .aemotion');
    launchArgs.push('--project', project);
  }
  exec.signal.throwIfAborted();
  const child = spawn(executable, launchArgs, { cwd: dirname(executable), windowsHide: true, shell: false, stdio: 'ignore', detached: true });
  await new Promise((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', reject); });
  child.on('error', () => {});
  child.unref();
  const deadline = Date.now() + 30000;
  const target = { app_directory: dirname(executable) };
  while (Date.now() < deadline) {
    if (exec.signal.aborted) throw new AetherBridgeError('LAUNCH_INTERRUPTED', 'Запуск уже запрошен. Проверь aether_status перед повтором.', { ambiguous: true });
    const connected = (await sessions(target, exec)).filter(session => session.connected);
    if (connected.length) return { connected: true, executable, sessions: connected };
    try { await delay(250, undefined, { signal: exec.signal }); }
    catch (error) {
      if (exec.signal.aborted) throw new AetherBridgeError('LAUNCH_INTERRUPTED', 'Запуск уже запрошен. Проверь aether_status перед повтором.', { ambiguous: true });
      throw error;
    }
  }
  return { connected: false, executable, launch_requested: true, message: 'Запуск запрошен. API пока недоступен. Проверь aether_status перед повторным запуском.' };
}

export function apply(ctx) {
  ctx.systemPrompt.section({ name: 'qcoderi:aether', order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'), text: PROMPT, interpolate: false });
  const register = (toolName, description, parameters, execute, concurrencySafe = false) => ctx.tools.register(defineTool({
    name: toolName, description, parameters, output: textOutput, isConcurrencySafe: () => concurrencySafe,
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      try { return JSON.stringify(await execute(args, exec), null, 2); }
      catch (error) {
        if (error instanceof AetherBridgeError) throw new Error(JSON.stringify({ code: error.code, message: error.message, ambiguous: error.ambiguous }));
        throw error;
      }
    },
  }));

  register('aether_status', 'Обнаружить открытые AETHER и проверить живое соединение с общим документом. Возвращает ID сессий и возможности. Чтение.', targetParameters, async (args, exec) => {
    const inspected = await sessions(args, exec);
    const connected = inspected.filter(session => session.connected);
    let scene;
    if (connected.length === 1) scene = checked(await callSession(connected[0], 'scene.get_summary', {}, { signal: exec.signal }));
    return { connected: connected.length > 0, selection_required: connected.length > 1, sessions: inspected, ...(scene ? { scene } : {}),
      ...(!connected.length ? { message: 'Запусти aether_open. Для другой установки укажи app_directory или QCODERI_AETHER_HOME.' } : {}) };
  }, true);

  register('aether_tools', 'Получить возможности AETHER. Без method возвращает краткий каталог, с method — точную схему операции.', {
    ...targetParameters, method: { type: 'string', description: 'Точное имя API-операции, например scene.set_transform или system.batch' },
  }, async (args, exec) => {
    const session = await selectSession(args, exec);
    const result = checked(await callSession(session, 'system.list_tools', {}, { signal: exec.signal }));
    const tools = result.data.tools;
    if (args.method) {
      const tool = tools.find(tool => tool.name === args.method);
      if (!tool) throw new Error(`Неизвестная операция AETHER: ${args.method}`);
      return { session: session.id, revision: result.revision, tool };
    }
    return { session: session.id, revision: result.revision, capabilities: result.data.capabilities,
      tools: tools.map(({ name, implemented, description, mutation, reversible }) => ({ name, implemented, description, mutation, reversible })) };
  }, true);

  register('aether_command', 'Выполнить доступную операцию в открытом документе AETHER. Схему получи через aether_tools(method). Поддерживает system.batch и expected_revision. Геометрия по умолчанию свёрнута. После неоднозначной ошибки сначала проверь сцену.', {
    ...targetParameters,
    method: { type: 'string', required: true },
    arguments: { type: 'object', additionalProperties: true, description: 'Аргументы операции из aether_tools. Пути файлов абсолютные.' },
    expected_revision: { type: 'integer', description: 'Версия из последнего наблюдения. При пропуске используется версия перед вызовом.' },
    include_geometry: { type: 'boolean', description: 'Включить полные массивы геометрии в ответ. По умолчанию false.' },
  }, async (args, exec) => {
    const session = await selectSession(args, exec);
    const catalog = checked(await callSession(session, 'system.list_tools', {}, { signal: exec.signal }));
    const tool = catalog.data.tools.find(tool => tool.name === args.method);
    if (!tool || !tool.implemented) throw new Error(`Операция ${args.method} недоступна в подключённой версии AETHER`);
    const params = { ...(args.arguments ?? {}) };
    if (args.expected_revision !== undefined && params.expected_revision !== undefined && args.expected_revision !== params.expected_revision) {
      throw new Error('expected_revision в аргументах и параметрах вызова должны совпадать');
    }
    if (tool.mutation) params.expected_revision = args.expected_revision ?? params.expected_revision ?? catalog.revision;
    const result = checked(await callSession(session, args.method, params, { signal: exec.signal }));
    return { session: session.id, ...compact(result, args.include_geometry === true) };
  });

  register('aether_open', 'Запустить установленное настольное AETHER и дождаться API. Существующие редакторы сохраняются. Для открытия другого проекта используй project.load в выбранной сессии.', {
    app_directory: targetParameters.app_directory,
    project_file: { type: 'string', description: 'Существующий .aemotion для нового окна' },
  }, openEditor);

  ctx.tools.register(defineTool({
    name: 'aether_viewport', description: 'Получить настоящий кадр текущего viewport AETHER и показать его в чате. Возвращает пиксели для визуальной проверки.',
    parameters: { ...targetParameters, caption: { type: 'string', description: 'Краткая подпись изображения' } },
    output: visualOutput(), isConcurrencySafe: () => false,
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      if (args.caption !== undefined && (typeof args.caption !== 'string' || args.caption.length > 400)) throw new Error('Подпись должна быть строкой до 400 символов');
      const session = await selectSession(args, exec);
      const result = checked(await callSession(session, 'viewport.capture', {}, { signal: exec.signal }));
      const captureRoot = await fs.realpath(join(session.app_directory, 'artifacts/captures'));
      const file = await fs.realpath(result.data.path);
      const local = relative(captureRoot, file);
      if (!local || isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`) || !file.toLowerCase().endsWith('.png')) throw new Error('Путь кадра выходит за каталог изображений AETHER');
      const handle = await fs.open(file, 'r');
      let pixels;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('Кадр AETHER должен быть PNG до 20 МиБ');
        pixels = await handle.readFile();
      } finally { await handle.close(); }
      if (pixels.length > 20 * 1024 * 1024 || !pixels.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('AETHER вернул некорректный PNG');
      const image = await storeImage(ctx, pixels, 'image/png', basename(file), exec.signal);
      return { text: `${args.caption?.trim() || 'AETHER Motion Studio'}\nСессия ${session.id}, версия сцены ${result.revision}\n${result.data.path}\n${result.data.scope ?? ''}`, image };
    },
  }));
}
