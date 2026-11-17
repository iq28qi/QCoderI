import { promises as fs } from 'node:fs';
import { join, dirname, resolve, extname, parse, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const ACTIONS = ['describe', 'scene_list', 'scene_inspect', 'animation_inspect', 'actor_spawn', 'actor_transform', 'actor_delete', 'asset_list', 'asset_import', 'material_create', 'mesh_set_material', 'object_inspect', 'object_set', 'blueprint_create', 'blueprint_inspect', 'blueprint_variable', 'blueprint_node', 'blueprint_connect', 'blueprint_pin', 'blueprint_compile', 'widget_create', 'widget_add', 'widget_tree', 'widget_text', 'widget_font', 'widget_layout', 'asset_save', 'level_save'];
const source = fileURLToPath(new URL('./QCoderIBridge/', import.meta.url));
const ASSET_ACTIONS = new Set(['asset_import', 'material_create', 'mesh_set_material']);
const SCENE_ACTIONS = new Set(['scene_inspect', 'animation_inspect', 'viewport_capture']);
export async function pluginFingerprint() {
  const hash = createHash('sha256');
  for (const name of ['QCoderIBridge.uplugin', 'Source/QCoderIBridge/QCoderIBridge.Build.cs', 'Source/QCoderIBridge/Private/QCoderIBridge.cpp']) hash.update(await fs.readFile(join(source, name)));
  return hash.digest('hex');
}
async function installPrebuilt(project, target, engineDirectory) {
  const engine = engineDirectory || await findEngine(project);
  if (!engine) return false;
  const version = await readJson(join(engine, 'Engine/Build/Build.version'));
  const tag = `${version.MajorVersion}.${version.MinorVersion}.${version.PatchVersion}`;
  const association = (await readJson(project)).EngineAssociation;
  if (/^5\.\d+$/.test(association) && association !== `${version.MajorVersion}.${version.MinorVersion}`) return false;
  const bundled = fileURLToPath(new URL(`./prebuilt/${tag}/`, import.meta.url));
  let manifest;
  try { manifest = await readJson(join(bundled, 'manifest.json')); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const engineModules = await readJson(join(engine, 'Engine/Binaries/Win64/UnrealEditor.modules'));
  if (manifest.build_id !== engineModules.BuildId || manifest.source_sha256 !== await pluginFingerprint()) return false;
  const bytes = await fs.readFile(join(bundled, 'bridge.bin'));
  if (createHash('sha256').update(bytes).digest('hex') !== manifest.binary_sha256) throw new Error('Повреждён готовый мост Unreal');
  const binaries = join(target, 'Binaries/Win64'); await fs.mkdir(binaries, { recursive: true });
  await fs.writeFile(join(binaries, 'UnrealEditor-QCoderIBridge.dll'), bytes);
  await fs.copyFile(join(bundled, 'UnrealEditor.modules'), join(binaries, 'UnrealEditor.modules'));
  return true;
}
export async function projectFile(cwd, explicit) {
  if (!cwd && !explicit) throw new Error('Выбери папку Unreal-проекта в режиме «Проекты».');
  if (explicit) {
    const path = resolve(cwd || '.', explicit);
    if (extname(path).toLowerCase() !== '.uproject') throw new Error('Нужен файл .uproject');
    await fs.access(path); return path;
  }
  const path = resolve(cwd);
  if (extname(path).toLowerCase() === '.uproject') { await fs.access(path); return path; }
  const files = (await fs.readdir(path)).filter(name => name.endsWith('.uproject'));
  if (files.length !== 1) throw new Error('В рабочей папке должен быть один .uproject. Иначе передай project_file явно.');
  return join(path, files[0]);
}
export const mailbox = project => join(dirname(project), 'Saved', 'QCoderI', 'Bridge');
export async function atomicJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, JSON.stringify(value), { flag: 'wx' }); await fs.rename(temp, path); }
  finally { await fs.rm(temp, { force: true }); }
}
async function readJson(path) { return JSON.parse(await fs.readFile(path, 'utf8')); }
// Electron's fs.cp does not recursively extract directories from app.asar.
// readdir/copyFile use its supported virtual-filesystem operations.
async function copyTree(from, to) {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const input = join(from, entry.name), output = join(to, entry.name);
    if (entry.isDirectory()) await copyTree(input, output);
    else if (entry.isFile()) await fs.copyFile(input, output);
    else throw new Error(`Неожиданный тип файла плагина: ${entry.name}`);
  }
}
export async function findEngine(project) {
  const version = (await readJson(project)).EngineAssociation;
  if (!/^5\.\d+$/.test(version)) return null;
  const roots = [join(parse(project).root, 'UE'), join(process.env.ProgramFiles || 'C:/Program Files', 'Epic Games')];
  for (const root of roots) {
    const engine = join(root, `UE_${version}`);
    try { await fs.access(join(engine, 'Engine/Build/BatchFiles/RunUAT.bat')); return engine; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return null;
}
export async function status(project) {
  let state;
  try { state = await readJson(join(mailbox(project), 'status.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const canonical = path => process.platform === 'win32' ? path.toLowerCase() : path;
  const actual = typeof state?.project === 'string' ? await fs.realpath(state.project).catch(() => null) : null;
  const live = state?.protocol === 1 && typeof state.instance === 'string' && actual && canonical(actual) === canonical(await fs.realpath(project)) && Math.abs(Date.now() / 1000 - state.updated_at) < 15;
  const descriptor = await readJson(project);
  const exists = path => fs.access(path).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; });
  const plugin = join(dirname(project), 'Plugins/QCoderIBridge');
  return { project, engine: descriptor.EngineAssociation, engine_directory: await findEngine(project),
    plugin_installed: await exists(join(plugin, 'QCoderIBridge.uplugin')),
    plugin_enabled: Boolean(descriptor.Plugins?.find(p => p.Name === 'QCoderIBridge')?.Enabled),
    binary_present: await exists(join(plugin, 'Binaries/Win64/UnrealEditor-QCoderIBridge.dll')),
    connected: Boolean(live), asset_pipeline: Boolean(live && state.asset_pipeline),
    scene_preview: Boolean(live && state.scene_preview), editor: state ?? null,
    message: live ? 'Редактор подключён' : 'Мост не отвечает. После установки/сборки перезапусти этот проект в UE. Не повторяй команды изменения вслепую.' };
}
export async function install(project, { engineDirectory } = {}) {
  const root = dirname(project), target = join(root, 'Plugins', 'QCoderIBridge');
  // Refuse to overwrite another plugin or follow a redirected Plugins directory.
  await fs.mkdir(join(root, 'Plugins'), { recursive: true });
  for (const path of [join(root, 'Plugins'), target]) {
    const info = await fs.lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (info?.isSymbolicLink()) throw new Error(`Каталог плагина перенаправлен: ${path}`);
  }
  try {
    const existing = await readJson(join(target, 'QCoderIBridge.uplugin'));
    if (existing.CreatedBy !== 'QCoderI') throw new Error('Плагин с таким именем уже существует и принадлежит другому автору');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const descriptor = await readJson(project);
  const backup = `${project}.qcoderi-${randomUUID()}.bak`;
  await fs.copyFile(project, backup, 1);
  await copyTree(source, target);
  const prebuilt = await installPrebuilt(project, target, engineDirectory);
  descriptor.Plugins ??= [];
  const entry = descriptor.Plugins.find(plugin => plugin.Name === 'QCoderIBridge');
  if (entry) entry.Enabled = true;
  else descriptor.Plugins.push({ Name: 'QCoderIBridge', Enabled: true, TargetAllowList: ['Editor'] });
  await atomicJson(project, descriptor);
  return { project, plugin: target, backup, engine: descriptor.EngineAssociation, prebuilt_installed: prebuilt,
    message: prebuilt ? 'Готовый мост под эту сборку UE установлен. Открой проект в Unreal и проверь unreal_status.' : 'Исходники моста установлены. Закрой UE, собери плагин unreal_build_bridge и снова открой проект. C++ код игры писать не требуется.' };
}
export async function command(project, action, args = {}, { signal, timeoutMs = 45000 } = {}) {
  if (!ACTIONS.includes(action) && action !== 'viewport_capture') throw new Error('Неизвестная команда Unreal');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments_json должен содержать JSON-объект');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) throw new Error('Тайм-аут: 100–120000 мс');
  signal?.throwIfAborted();
  if (action === 'asset_import') {
    if (typeof args.source !== 'string' || !args.source.trim()) throw new Error('Укажи путь source к FBX или текстуре внутри Unreal-проекта');
    const projectDir = dirname(await fs.realpath(project));
    const sourcePath = await fs.realpath(resolve(projectDir, args.source));
    const subpath = relative(projectDir, sourcePath);
    if (!subpath || subpath === '..' || subpath.startsWith('..' + sep) || isAbsolute(subpath) || !(await fs.stat(sourcePath)).isFile()) {
      throw new Error('Импортируй обычный файл из папки Unreal-проекта');
    }
    args = { ...args, source: subpath.replaceAll(sep, '/') };
  }
  const state = await status(project);
  if (!state.connected) throw new Error(state.message);
  if (ASSET_ACTIONS.has(action) && !state.asset_pipeline) {
    throw new Error('Запущена старая версия QCoderIBridge. Закрой редактор, обнови плагин через unreal_setup (при необходимости unreal_build_bridge) и снова открой проект.');
  }
  if (SCENE_ACTIONS.has(action) && !state.scene_preview) {
    throw new Error('Чтобы проверить сцену и освещение, обнови QCoderIBridge через unreal_setup при закрытом редакторе.');
  }
  const id = randomUUID(), dir = mailbox(project), request = join(dir, `${id}.request.json`), response = join(dir, `${id}.response.json`);
  const payload = { protocol: 1, id, instance: state.editor.instance, expires_at: (Date.now() + timeoutMs) / 1000, action, args };
  if (Buffer.byteLength(JSON.stringify(payload)) > 262144) throw new Error('Запрос больше 256 КБ');
  await atomicJson(request, payload);
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      try {
        const result = await readJson(response);
        if (result.id !== id || result.instance !== state.editor.instance) throw new Error('Неверный ответ редактора');
        if (!result.ok) throw new Error(`Unreal: ${result.error}`);
        return result.result;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await delay(100, undefined, { signal });
    }
    throw new Error(`Редактор не ответил за ${timeoutMs / 1000} с. Результат операции неизвестен. Сначала проверь сцену/ассет; не повторяй изменение автоматически.`);
  } finally {
    // A claimed .processing file is owned by UE. Removing an unclaimed request
    // prevents queued edits from running after the user cancels the turn.
    await fs.rm(request, { force: true }); await fs.rm(response, { force: true });
  }
}
