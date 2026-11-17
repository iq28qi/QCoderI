"""Package the built Windows release and write its signed update manifest."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tomllib
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / 'harness-base'
NODE = BASE / 'app/resources/runtime/node/node.exe'
SIGN = """
const { createPrivateKey, sign } = require('node:crypto');
const { readFileSync } = require('node:fs');
const key = createPrivateKey(readFileSync(process.argv[1]));
if (key.asymmetricKeyType !== 'ed25519') throw Error('An Ed25519 private key is required');
process.stdout.write(sign(null, Buffer.from(process.argv[2]), key).toString('base64'));
"""


def package(output, key, root=ROOT, version=None, executable=None):
    if version is None:
        version = tomllib.loads((BASE / 'native/Cargo.toml').read_text(encoding='utf-8'))['package']['version']
    if not re.fullmatch(r'(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})', version):
        raise ValueError('Use a numeric major.minor.patch version.')
    output.mkdir(parents=True, exist_ok=True)
    exe = executable or root / 'QCoderI.exe'
    # Cargo embeds this value, which also selects the matching staged runtime.
    if version.encode() not in exe.read_bytes():
        raise ValueError('Build QCoderI at the requested version before packaging.')
    archive = output / f'QCoderI-{version}-windows-x64.zip'
    pending = archive.with_suffix('.zip.pending')
    files = [
        root / 'harness-base/native/desktop-server.mjs',
        root / 'harness-base/native/updates.mjs',
    ]
    for directory in ['harness-base/source/dsh', 'harness-base/app/resources/runtime']:
        paths = root / directory
        if not paths.is_dir():
            raise FileNotFoundError(paths)
        files.extend(sorted(path for path in paths.rglob('*') if path.is_file()))
    try:
        with ZipFile(pending, 'w', compression=ZIP_DEFLATED, compresslevel=3) as bundle:
            bundle.write(exe, 'QCoderI.exe')
            for path in files:
                if path.is_symlink():
                    raise ValueError(f'Release contains a symbolic link: {path.relative_to(root)}')
                bundle.write(path, path.relative_to(root).as_posix())
        with pending.open('rb') as file:
            digest = hashlib.file_digest(file, 'sha256').hexdigest()
        fields = [1, 'windows-x64', version, archive.name, pending.stat().st_size, digest]
        payload = json.dumps(fields, separators=(',', ':'))
        signature = subprocess.check_output([NODE, '-e', SIGN, key.resolve(), payload], text=True)
        manifest = dict(zip(('schema', 'platform', 'version', 'file', 'bytes', 'sha256'), fields, strict=True))
        manifest['signature'] = signature
        staged_manifest = output / 'latest.json.pending'
        staged_manifest.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
        pending.replace(archive)
        staged_manifest.replace(output / 'latest.json')
    finally:
        pending.unlink(missing_ok=True)
    return archive


if __name__ == '__main__':
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('--key', type=Path, required=True, help='Ed25519 private PEM key')
    cli.add_argument('--out', type=Path, default=ROOT / 'dist')
    cli.add_argument('--exe', type=Path)
    cli.add_argument('--version')
    args = cli.parse_args()
    print(package(args.out, args.key, version=args.version, executable=args.exe))
