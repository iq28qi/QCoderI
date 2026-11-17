import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assets = join(base, 'assets/aether');
const standardPreset = join(base, 'source/dsh/node_modules/@deepseek-ai/dsh-agent-presets/presets/standard/agent.cordis.yml');

async function readPackage(directory) {
  const files = [];
  async function visit(path) {
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`AETHER package contains a linked path: ${path}`);
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(path)).sort()) await visit(join(path, name));
      return;
    }
    if (!stat.isFile()) throw new Error(`AETHER package contains a non-file entry: ${path}`);
    files.push({ path: relative(directory, path).replaceAll('\\', '/'), bytes: await fs.readFile(path) });
  }
  await visit(directory);
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(`${Buffer.byteLength(file.path)}:${file.path}\0${file.bytes.length}:`);
    hash.update(file.bytes);
  }
  return { files, fingerprint: hash.digest('hex') };
}

async function readOptionalFile(path) {
  try {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular profile file: ${path}`);
    return await fs.readFile(path);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function ensureDirectory(path) {
  await fs.mkdir(path, { recursive: true });
  const stat = await fs.lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Expected a regular profile directory: ${path}`);
}

async function removeStaging(directory, parent) {
  const actualDirectory = await fs.realpath(directory);
  const actualParent = await fs.realpath(parent);
  if (dirname(actualDirectory) !== actualParent || !basename(actualDirectory).startsWith('.aether-install-')) {
    throw new Error(`Unexpected AETHER staging directory: ${directory}`);
  }
  await fs.rm(actualDirectory, { recursive: true });
}

async function installPackage(packageRoot, target, snapshot) {
  try {
    const existing = await readPackage(target);
    if (existing.fingerprint !== snapshot.fingerprint) throw new Error(`Existing versioned AETHER package differs: ${target}`);
    return false;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const staging = join(packageRoot, `.aether-install-${randomUUID()}`);
  await fs.mkdir(staging);
  try {
    for (const file of snapshot.files) {
      const path = join(staging, file.path);
      await fs.mkdir(dirname(path), { recursive: true });
      await fs.writeFile(path, file.bytes, { flag: 'wx' });
    }
    try {
      await fs.rename(staging, target);
      return true;
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
      const existing = await readPackage(target);
      if (existing.fingerprint !== snapshot.fingerprint) throw new Error(`Concurrent AETHER package installation differs: ${target}`);
      return false;
    }
  } finally {
    try { await removeStaging(staging, packageRoot); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

async function atomicWrite(path, bytes) {
  const staging = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  await fs.writeFile(staging, bytes, { flag: 'wx' });
  try { await fs.rename(staging, path); }
  finally {
    try { await fs.unlink(staging); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export async function installAetherProfile({ home = join(base, 'data') } = {}) {
  const snapshot = await readPackage(assets);
  const manifestFile = snapshot.files.find(file => file.path === 'package.json');
  const manifest = JSON.parse(manifestFile?.bytes.toString('utf8') ?? '{}');
  if (manifest.name !== '@qcoderi/aether' || manifest.type !== 'module') throw new Error('Invalid source AETHER package manifest');
  for (const name of ['index.js', 'bridge.js', 'preset.yml']) {
    if (!snapshot.files.some(file => file.path === name)) throw new Error(`AETHER package is missing ${name}`);
  }
  const standard = await fs.readFile(standardPreset);
  const metadata = snapshot.files.find(file => file.path === 'preset.yml').bytes;
  home = resolve(home);
  const packageRoot = join(home, 'profiles/desktop/node_modules/@qcoderi');
  await ensureDirectory(packageRoot);
  const packageDirectory = join(packageRoot, `aether-${snapshot.fingerprint.slice(0, 12)}`);
  const packageInstalled = await installPackage(packageRoot, packageDirectory, snapshot);
  const composition = Buffer.concat([standard, Buffer.from(
    '\n- id: qcoderi-team\n  name: "@qcoderi/team"\n' +
    `\n- id: qcoderi-aether\n  name: ${JSON.stringify(pathToFileURL(join(packageDirectory, 'index.js')).href)}\n`,
  )]);
  const presetDirectory = join(home, '.agent-presets/qcoder-aether');
  await ensureDirectory(presetDirectory);
  const compositionPath = join(presetDirectory, 'agent.cordis.yml');
  const metadataPath = join(presetDirectory, 'preset.yml');
  const ownershipPath = join(presetDirectory, '.qcoderi-aether-profile.json');
  const ownership = Buffer.from(JSON.stringify({
    schemaVersion: 1, owner: 'qcoderi-aether-profile', preset: 'qcoder-aether',
    fingerprint: snapshot.fingerprint, packageDirectory,
  }, null, 2) + '\n');
  const previousComposition = await readOptionalFile(compositionPath);
  const previousMetadata = await readOptionalFile(metadataPath);
  const previousOwnership = await readOptionalFile(ownershipPath);
  let previousPresetOwnership = previousComposition === undefined && previousMetadata === undefined && previousOwnership === undefined ? 'new' : 'unmanaged';
  if (previousOwnership !== undefined) {
    try {
      const marker = JSON.parse(previousOwnership.toString('utf8'));
      if (marker.schemaVersion === 1 && marker.owner === 'qcoderi-aether-profile' && marker.preset === 'qcoder-aether') previousPresetOwnership = 'managed';
    } catch { /* Preserve an unrecognized marker in the preset backup. */ }
  }
  const compositionChanged = !previousComposition?.equals(composition);
  const metadataChanged = !previousMetadata?.equals(metadata);
  const ownershipChanged = !previousOwnership?.equals(ownership);
  let backupDirectory;
  if ((compositionChanged || metadataChanged || ownershipChanged) && previousPresetOwnership !== 'new') {
    const backupRoot = join(home, '.agent-presets/.backups');
    await ensureDirectory(backupRoot);
    backupDirectory = join(backupRoot, `qcoder-aether-${Date.now()}-${randomUUID()}`);
    await fs.cp(presetDirectory, backupDirectory, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
  }
  if (metadataChanged) await atomicWrite(metadataPath, metadata);
  if (ownershipChanged) await atomicWrite(ownershipPath, ownership);
  // The composition becomes discoverable only after its complete immutable package.
  if (compositionChanged) await atomicWrite(compositionPath, composition);
  return {
    home, preset: 'qcoder-aether', packageVersion: manifest.version,
    fingerprint: snapshot.fingerprint, packageDirectory, presetDirectory,
    changed: packageInstalled || compositionChanged || metadataChanged || ownershipChanged,
    packageInstalled, compositionChanged, metadataChanged, previousPresetOwnership,
    ...(backupDirectory ? { backupDirectory } : {}),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { home: { type: 'string' }, help: { type: 'boolean' } } });
    if (values.help) {
      console.log('Usage: node install-aether-profile.mjs [--home PATH]');
    } else {
      console.log(JSON.stringify(await installAetherProfile({ home: values.home })));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
