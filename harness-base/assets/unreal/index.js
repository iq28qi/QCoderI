import { defineTool } from '@deepseek-ai/dsh-tools';
import { join, dirname, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { ACTIONS, projectFile, status, install, command, findEngine } from './bridge.js';
import { storeImage, visualOutput } from '@qcoderi/team/desktop';

export const name = 'qcoderi-unreal';
export const inject = ['tools', 'systemPrompt', 'jobs'];
const PROMPT = `Для задач Unreal Engine 5 используй локальный QCoderIBridge и выбранную в чате модель. Для самостоятельных частей одной задачи ведущий запускает team_run. Например, моделлер готовит сетку, UV, редактируемый .blend и FBX; художник материалов готовит отдельные исходники текстур; разработчик UE параллельно выполняет независимую работу над Blueprint или сценой. Согласуй общие имена, масштаб в сантиметрах, UV и слоты материалов до запуска. Назначай отдельные папки/файлы на запись и ресурс unreal-editor всем заданиям, которые используют тот же редактор. Импорт и сборку сцены назначай зависимым заданием после получения геометрии и текстур. Ведущий проверяет собранный результат. Для Blender-работы используй blender_run и дождись job_output; пиши экспорт скриптом bpy только для целевых объектов, без студийной камеры, света и подложки.
Перед обращением к редактору вызови unreal_status. Если плагина нет — unreal_setup. При prebuilt_installed=true готовый мост уже установлен: достаточно открыть проект в UE. Если готовой сборки нет — unreal_build_bridge (нужны закрытый UE, каталог движка и C++ Build Tools). Сборка идёт в фоне: собери результат через job_output(wait:true). Не устанавливай Visual Studio без запроса пользователя. После сборки нужен запуск проекта в UE. При отсутствии редактора всё ещё можно подготовить Blender-модель и текстуры; сообщи, на каком этапе остановилась интеграция.
Для готовых статических моделей импортируй FBX, для текстур — PNG/TGA/JPEG, через asset_import. Используй material_create для подключения карт и mesh_set_material для назначения по слоту. Эти команды требуют asset_pipeline=true в unreal_status. Если редактор подключён без этой возможности, обнови мост после закрытия редактора. Проверь пути/классы ассетов, масштаб, UV и материал на объекте, сохрани изменённые ассеты отдельно. Для уже существующих ассетов используй их пути и инспекцию вместо повторного импорта.
Для визуальной работы сначала scene_inspect: проверь камеры, интенсивность и единицы света, цвет/температуру, непривязанные Post Process Volumes и экспозицию. Если scene_preview=true, снимай изображение настоящего редакторского viewport через unreal_viewport до и после изменений. Для проверки композиции выбери перспективный ракурс или пилотируй нужную камеру в редакторе; проверь кадрирование, читаемость силуэтов, пересвет, контактные тени и контраст. Сравнивай на том же ракурсе и режиме Lit. Кадр редактора проверяет вид в этом ракурсе; для игры отдельно проверь игровую камеру и экспозицию в PIE.
Для анимации заранее согласуй FPS и диапазон кадров, имена костей, корневое движение и необходимость морфов. В Blender открой ключевые кадры через blender_run(frames), проверь деформацию, стык цикла и стопы. Экспортируй только нужный меш и скелет с запечённой анимацией. Импорт Skeletal Mesh и клипов выполняй в редакторе UE. Сверь скелет, длительность, частоту и ключи через animation_inspect, затем просмотри цикл, проверяя Root Motion, переходы в Animation Blueprint либо дорожки Sequencer по назначению. Не утверждай, что движение корректно, только по отчёту или одному кадру.
unreal_command describe возвращает точные аргументы команд. Перед изменением изучи сцену/ассет, затем выполни конкретные команды, проверь итог инспекцией и blueprint_compile. Сохраняй только изменённые ассеты через asset_save, уровень — level_save по намерению пользователя. Все изменения выполняются в редакторе, undo доступен для редактирования объектов. Не изменяй .uasset/.umap как текст и не пересоздавай существующие Blueprint/Widget Blueprint. Создавай меню из именованных UMG-виджетов; шрифты — Font/FontFace ассеты и widget_font. Для кнопок есть bound_event, для логики — event/call/get/set, соединение пинов и значения пинов. Сам дизайн меню не означает, что оно уже показано в игре: проверь цепочку CreateWidget/AddToViewport и режим ввода. Не заявляй, что клики работают, без проверки графа/PIE.
Вызовы жди последовательно. При тайм-ауте/отмене операция могла успеть выполниться: сначала инспекция, никаких автоматических повторов создания. Во время PIE редактирование блокируется. Плагин не запускает Python или произвольный код и не открывает сетевые порты.`;
export function apply(ctx) {
  const building = new Set();
  ctx.systemPrompt.section({ name: 'qcoderi:unreal', order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'), text: PROMPT, interpolate: false });
  const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] };
  const projectParam = { type: 'string', description: 'Путь .uproject; по умолчанию единственный .uproject в рабочей папке' };
  const getProject = (args, exec) => projectFile(exec.agent?.session.header.cwd, args.project_file);
  const register = (toolName, description, parameters, execute) => ctx.tools.register(defineTool({ name: toolName, description, parameters, output, async execute(args, exec) {
    exec.signal.throwIfAborted(); return JSON.stringify(await execute(args, exec), null, 2);
  } }));
  register('unreal_status', 'Check connection to the Unreal Editor for the selected workspace. No edits.', { project_file: projectParam }, async (args, exec) => status(await getProject(args, exec)));
  register('unreal_setup', 'Install and enable QCoderIBridge, backing up .uproject. Installs bundled DLL when exact UE version/build/source match; otherwise build with unreal_build_bridge. Run with UE closed, then open project.', { project_file: projectParam, engine_directory: { type: 'string', description: 'Optional engine installation root if automatic discovery fails' } }, async (args, exec) => {
    const project = await getProject(args, exec);
    if (building.has(project) || (await status(project)).connected) throw new Error('Дождись сборки и закрой UE перед установкой моста');
    return install(project, { engineDirectory: args.engine_directory });
  });
  register('unreal_command', 'Control UE scenes, import static meshes and textures, create and assign materials, edit Widget Blueprints and Blueprint graphs. Call action=describe for exact arguments. Requires a connected editor.', {
    action: { type: 'string', enum: ACTIONS, required: true },
    arguments_json: { type: 'string', description: 'JSON object with command arguments; default {}' }, project_file: projectParam,
  }, async (args, exec) => command(await getProject(args, exec), args.action, JSON.parse(args.arguments_json || '{}'), { signal: exec.signal }));
  ctx.tools.register(defineTool({
    name: 'unreal_viewport',
    description: 'Capture the real active perspective level viewport in Unreal Editor and return the PNG to the chat and visual model. Compare composition, lighting and materials before and after edits. Needs scene_preview and a rendered viewport.',
    parameters: { project_file: projectParam },
    output: visualOutput(),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const attachments = ctx.get('attachments');
      if (!attachments) throw new Error('Хранилище изображений недоступно');
      const project = await getProject(args, exec);
      const result = await command(project, 'viewport_capture', {}, { signal: exec.signal });
      if (!/^[0-9a-f-]{36}\.png$/i.test(result.file)) throw new Error('Неверное имя снимка viewport');
      const projectDir = dirname(await fs.realpath(project));
      const file = await fs.realpath(join(projectDir, 'Saved/QCoderI/Previews', result.file));
      const path = relative(projectDir, file);
      if (path === '..' || path.startsWith('..' + sep) || isAbsolute(path)) throw new Error('Снимок должен находиться внутри проекта');
      if ((await fs.stat(file)).size > 24 * 1024 * 1024) throw new Error('Уменьши размер viewport перед захватом');
      const image = await storeImage(ctx, await fs.readFile(file), 'image/png', result.file, exec.signal);
      return { text: 'Кадр Unreal Editor\n' + JSON.stringify({ ...result, file: path }), image };
    },
  }));
  register('unreal_build_bridge', 'Build and install the native editor plugin using this UE version. UE must be closed. Needs Windows C++ Build Tools; no game C++ needed. Returns background job id: collect with job_output(wait:true).', {
    engine_directory: { type: 'string', description: 'Engine installation root, e.g. G:/UE/UE_5.7; auto-detect when omitted' }, project_file: projectParam,
  }, async (args, exec) => {
    const project = await getProject(args, exec);
    if (building.has(project)) throw new Error('Мост этого проекта уже собирается. Дождись существующего фонового задания.');
    const engine = args.engine_directory || await findEngine(project);
    if (!engine) throw new Error('Не удалось найти движок. Передай engine_directory — папку с Engine/Build/BatchFiles/RunUAT.bat');
    await fs.access(join(dirname(project), 'Plugins/QCoderIBridge/QCoderIBridge.uplugin'));
    await fs.access(join(engine, 'Engine/Build/BatchFiles/RunUAT.bat'));
    const script = fileURLToPath(new URL('./Build-Bridge.ps1', import.meta.url));
    // PowerShell loads scripts from disk, outside Electron's virtual asar.
    const localScript = join(dirname(project), 'Saved/QCoderI/Build-Bridge.ps1');
    await fs.mkdir(dirname(localScript), { recursive: true }); await fs.copyFile(script, localScript);
    const quote = value => "'" + value.replaceAll("'", "''") + "'";
    const code = `& ${quote(localScript)} -ProjectFile ${quote(project)} -EngineDirectory ${quote(engine)}`;
    const jobId = ctx.jobs.start({ kind: 'process', owner: exec.agent, label: 'Сборка моста Unreal Engine', run: () => {
      if (building.has(project)) throw new Error('Мост уже собирается');
      building.add(project);
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let log = '';
      const append = chunk => { log = (log + chunk.toString()).slice(-24000); };
      child.stdout.on('data', append); child.stderr.on('data', append);
      const done = new Promise(resolve => {
        child.once('error', error => { building.delete(project); resolve({ status: 'failed', output: error.message }); });
        child.once('close', code => { building.delete(project); resolve({ status: code === 0 ? 'completed' : 'failed', output: log }); });
      });
      return { done, readOutput: () => log, cancel: () => { if (child.pid) spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill()); } };
    } });
    return { job_id: jobId, message: 'Дождись job_output. После успешной сборки открой проект в UE и вызови unreal_status.' };
  });
}
