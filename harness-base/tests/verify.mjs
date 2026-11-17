import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, openSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const archive = resolve(process.env.HARNESS_ARCHIVE ?? 'DeepSeek Harness/resources/app.patched.asar');
const packageUrl = name => pathToFileURL(join(archive, 'dsh/node_modules/@deepseek-ai', name, 'lib/index.js')).href;
const { Context } = await import(packageUrl('cordis'));
const { default: FileSettingsProvider } = await import(packageUrl('dsh-settings-file'));
const { default: SystemPrompt, renderPrompt } = await import(packageUrl('dsh-system-prompt'));
const temporary = mkdtempSync(join(tmpdir(), 'harness-verify-'));
try {
  const ctx = new Context();
  await ctx.plugin(FileSettingsProvider, { path: join(temporary, 'settings.yaml'), watch: false });
  await ctx.plugin(SystemPrompt, {});
  // Injection callbacks settle with their fibers.
  for (let i = 0; !ctx.settings.get('system-prompt') && i < 100; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(ctx.settings.get('system-prompt').text, '');
  const first = { session: {} };
  assert(!renderPrompt(await ctx.systemPrompt.assemble({ agent: first })).includes('ПРОВЕРКА'));
  const value = 'ПРОВЕРКА: отвечай по-русски.\n{{literal_placeholder}}';
  await ctx.settings.update('system-prompt', { text: value });
  assert(!renderPrompt(await ctx.systemPrompt.assemble({ agent: first })).includes('ПРОВЕРКА'), 'existing session stays stable');
  const second = { session: {} };
  assert(renderPrompt(await ctx.systemPrompt.assemble({ agent: second })).endsWith(value), 'literal user instructions reach the real rendered prompt');
  assert(readFileSync(join(temporary, 'settings.yaml'), 'utf8').includes('ПРОВЕРКА'), 'settings saved to disk');
  await ctx.settings.update('system-prompt', { text: '' });
  assert(renderPrompt(await ctx.systemPrompt.assemble({ agent: second })).endsWith(value), 'clearing does not mutate existing sessions');
  assert(!renderPrompt(await ctx.systemPrompt.assemble({ agent: { session: {} } })).includes('ПРОВЕРКА'), 'new sessions adopt clearing');
  await ctx.registry.delete(SystemPrompt);
  await ctx.registry.delete(FileSettingsProvider);
  console.log('PASS: actual file settings -> system prompt assembly, literal braces, per-session snapshots and clearing');

  let localeModule;
  const source = readFileSync(join(archive, 'dsh/node_modules/@deepseek-ai/dsh-client-locale/lib/client.js'), 'utf8');
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(module) { localeModule = module.factory(() => ({})); } } },
    navigator: { languages: ['en-US'], language: 'en-US' }, console
  });
  const locale = new localeModule.LocaleRuntime({ emit() {} });
  assert.equal(locale.getSnapshot().active, 'ru');
  const dictionaries = JSON.parse(readFileSync(new URL('./dictionaries.json', import.meta.url)));
  let total = 0;
  const translations = JSON.parse(readFileSync(new URL('./russian.json', import.meta.url)));
  for (const [index, { dict }] of dictionaries.entries()) {
    const ns = 'verify-' + index;
    locale.register(ns, { en: dict });
    for (const [key, text] of Object.entries(dict)) {
      assert.equal(locale.bind(ns)(key), translations[text], `${ns}.${key}`);
      total++;
    }
  }
  locale.register('placeholders', { en: { count: '{count} files' } });
  assert.equal(locale.bind('placeholders')('count', { count: 7 }), 'Файлов: 7');
  locale.setLocale('en');
  assert.equal(locale.bind('placeholders')('count', { count: 7 }), '7 files');
  console.log(`PASS: ${total} locale dictionary entries, Russian default, placeholders and English switching`);

  const native = await import(packageUrl('dsh-win32-process'));
  const api = native.loadWin32ProcessBindings();
  let observedFlags;
  const instrumented = { ...api, createProcessW(...args) { observedFlags = args[5]; return api.createProcessW(...args); } };
  writeFileSync(join(temporary, 'stdin'), '');
  const input = openSync(join(temporary, 'stdin'), 'r');
  const output = openSync(join(temporary, 'stdout'), 'w');
  try {
    const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const script = 'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public class ConsoleProbe { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); }\'; if ([ConsoleProbe]::GetConsoleWindow() -eq [IntPtr]::Zero) { exit 17 } else { exit 99 }';
    const handle = native.spawnCurrentTokenJobProcess(instrumented, {
      applicationName: powershell, command: powershell,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      cwd: temporary, env: process.env,
      stdio: { stdin: input, stdout: output, stderr: output }
    });
    assert(observedFlags & 0x08000000, 'CREATE_NO_WINDOW is passed to the real Windows API');
    let exitCode;
    const deadline = Date.now() + 20000;
    while ((exitCode = native.pollProcessExit(api, handle.process)) === undefined && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    try { assert.equal(exitCode, 17, 'PowerShell confirms GetConsoleWindow() is NULL'); }
    finally { native.closeHandleChecked(api, handle.process, 'process'); native.closeHandleChecked(api, handle.job, 'job'); }
    console.log('PASS: real native Windows Job -> PowerShell, no console window, exit status preserved');
  } finally { closeSync(input); closeSync(output); }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
