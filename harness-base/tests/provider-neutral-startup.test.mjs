import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
const source = await readFile(new URL('../source/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js', import.meta.url), 'utf8');

test('upstream welcome and vendor-only dialogs are removed, not hidden', () => {
  assert.match(source, /QCODERI_PROVIDER_NEUTRAL_STARTUP/);
  assert.doesNotMatch(source, /WelcomeNotice|DeepSeekOnboardingDialog|onboardingReadiness|welcomeController|WELCOME_NOTICE/);
  assert.doesNotMatch(source, /Internal Testing Notice|Harness developers|DSH plugin ecosystem|Add an API key to get started/);
  assert.doesNotMatch(source, /slots\.inject\("settings\.onboarding"/);
  assert.doesNotThrow(() => new vm.Script(source));
  assert.match(source, /function ModelsSection\(/);
  assert.match(source, /function createModelsOperations\(/);
  assert.match(source, /storeCredential:/);
  assert.match(source, /discoverModels:/);
  assert.match(source, /function CustomProviderCard\(/);
});

test('removed notice text is absent from the shipped locale', async () => {
  const locale = await readFile(new URL('../source/dsh/node_modules/@deepseek-ai/dsh-client-locale/lib/client.js', import.meta.url), 'utf8');
  assert.doesNotMatch(locale, /Internal Testing Notice|Harness developers|DSH plugin ecosystem|Уведомление о тестировании|Добавьте ключ API, чтобы начать/);
  assert.doesNotThrow(() => new vm.Script(locale));
});

test('actual plugin registration keeps Models settings without first-run reads or modal slots', () => {
  const start = source.indexOf('\t\tfunction apply(ctx) {');
  const end = source.indexOf('\n\t\t//#endregion\n\t\texports.apply', start);
  const registrations = [], effects = [], events = [];
  class ModelsSettingsStore { constructor() { this.store = { getSnapshot: () => ({ status: 'idle' }) }; } }
  const ctx = {
    locale: { register() { return () => {}; }, bind: () => key => key },
    settingsSchema: {}, settingsScope: { describe: () => ({}) },
    remote: { $on: event => { events.push(event); return () => {}; } },
    on: event => { events.push(event); return () => {}; },
    effect: (fn, label) => { effects.push(label); return fn(); },
    slots: { inject: (name, fn) => { assert.equal(name, 'settings.section'); fn(); }, register: (spec, component) => { registrations.push({ spec, component }); } },
  };
  const ModelsSection = () => {};
  vm.runInNewContext(source.slice(start, end) + '\napply(ctx);', { ctx, NS: 'settings.models', zh: {}, en: {},
    createSettingsSchemaOperations: () => ({}), createModelsOperations: () => ({}), ModelsSettingsStore, ModelsSection, refreshIfLoaded: () => {} });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].spec.id, 'models');
  assert.equal(registrations[0].component, ModelsSection);
  assert(events.includes('credentials/reference-updated'));
  assert(!effects.some(x => /welcome|onboarding/.test(x)));
});

test('build reapplies the removal idempotently', async () => {
  const build = await readFile(new URL('../scripts/build.py', import.meta.url), 'utf8');
  assert.match(build, /remove-upstream-onboarding\.py/);
  const check = spawnSync('python', ['-B', '-c', `import runpy\nfrom pathlib import Path\np=runpy.run_path('harness-base/scripts/remove-upstream-onboarding.py')\ns=Path('harness-base/source/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js').read_text(encoding='utf-8')\nassert p['transform'](s)==s\nprint('Onboarding removal idempotent')`], { stdio: 'inherit', windowsHide: true });
  assert.ifError(check.error); assert.equal(check.status, 0);
});
