// Isolate maintained plugins from the live process. No application launch/reload.
import { cp, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = join(base, 'tests/.runtime');
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, 'next-runtime-'));
const packages = join(root, 'dsh/node_modules');
await mkdir(join(packages, '@qcoderi'), { recursive: true });
// Junctions are read-only inputs by convention; only owned plugins are copied.
for (const scope of ['@deepseek-ai']) await symlink(join(base, 'source/dsh/node_modules', scope), join(packages, scope), 'junction');
await symlink(join(base, 'source/dsh/node_modules/@qcoderi/unreal'), join(packages, '@qcoderi/unreal'), 'junction');
await cp(join(base, 'assets/team'), join(packages, '@qcoderi/team'), { recursive: true, filter: path => !path.includes('__pycache__') });
await cp(join(base, 'assets/aether'), join(packages, '@qcoderi/aether'), { recursive: true });
await cp(join(base, 'source/dsh/package.json'), join(root, 'dsh/package.json'));
// Libraries used by fixtures (e.g. sharp) resolve from the actual installation.
for (const name of ['sharp']) await symlink(join(base, 'source/dsh/node_modules', name), join(packages, name), 'junction');
const tests = process.argv.slice(2);
if (!tests.length) tests.push('team-native.mjs', 'team-checks.test.mjs', 'workbench-native.mjs', 'chat-native.mjs');
const results = [];
for (const test of tests) {
  if (!/^[a-zA-Z0-9.-]+\.mjs$/.test(test)) throw Error('Expected test basename');
  console.log('\nNEXT RUNTIME TEST:', test);
  const exitCode = await new Promise((complete, reject) => {
    const child = spawn(process.execPath, [join(base, 'tests', test)], {
      cwd: base, windowsHide: true, stdio: 'inherit',
      env: { ...process.env, HARNESS_ARCHIVE: root, QCODERI_TEST_NODE: process.execPath },
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => complete(code ?? (signal ? 1 : 0)));
  });
  results.push({ test, exitCode });
}
await writeFile(join(root, 'results.json'), JSON.stringify({ root, tests: results }, null, 2));
console.log('\nIsolated test artifacts:', root);
process.exitCode = results.some(result => result.exitCode !== 0) ? 1 : 0;
