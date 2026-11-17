"""Create a self-contained native release without writing the live installation.
No links/hardlinks or private profiles; builds only inside the selected new stage.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import tomllib

BASE = Path(__file__).resolve().parents[1]
ROOT = BASE.parent
EXCLUDED = {'.startup-preview-browser', '__pycache__', '.git', 'node-compile', 'target', 'data', '.credentials.yaml'}


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def copy_owned(source, target):
    """Never follow junctions/symlinks or make writable aliases to live files."""
    if source.is_symlink() or (hasattr(source, 'is_junction') and source.is_junction()):
        raise ValueError('Linked staging input is not allowed: ' + str(source))
    if source.is_dir():
        target.mkdir(parents=True, exist_ok=True)
        for child in source.iterdir():
            # Package-owned model/schema data is runtime code input, not the
            # application's private profile. Never omit dependency data by name.
            dependency_data = child.name == 'data' and 'node_modules' in child.parts
            if child.name not in EXCLUDED or dependency_data:
                copy_owned(child, target / child.name)
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def stage(output, snapshot=False, build=True):
    output = output.resolve()
    if output == ROOT or output.is_relative_to(BASE) or BASE.is_relative_to(output):
        # tests/.runtime is allowed explicitly, but never source/data/native/app.
        safe = ROOT / 'harness-base/tests/.runtime'
        if not output.is_relative_to(safe):
            raise ValueError('Use a new directory outside the installation or tests/.runtime')
    output.mkdir(parents=True, exist_ok=False)
    before = digest(ROOT / 'QCoderI.exe')
    base = output / 'harness-base'
    started = time.time()
    try:
        for relative in ['source/dsh', 'source/lib', 'source/renderer', 'source/package.json',
                         'app/resources/runtime', 'native/src', 'native/Cargo.toml', 'native/Cargo.lock',
                         'native/window.js', 'native/desktop-server.mjs', 'native/startup-cache.mjs', 'native/updates.mjs']:
            copy_owned(BASE / relative, base / relative)
        if snapshot:
            copy_owned(ROOT / 'QCoderI.exe', output / 'QCoderI.exe')
            # Maintained Cargo.toml may describe the NEXT candidate, not the
            # actually deployed EXE. Identify snapshots by observed bytes.
            version = 'baseline-sha256-' + before[:12]
        else:
            copy_owned(BASE / 'scripts', base / 'scripts')
            copy_owned(BASE / 'assets', base / 'assets')
            version = tomllib.loads((base / 'native/Cargo.toml').read_text(encoding='utf-8'))['package']['version']
            (output / 'staging-context.json').write_text(json.dumps({'source_root': str(ROOT), 'source_exe_sha256': before, 'staged_root': str(output)}), encoding='utf-8')
            env = {**os.environ, 'QCODERI_CARGO_TARGET_DIR': str(BASE / 'native/target'), 'QCODERI_BUILD_OFFLINE': '1', 'QCODERI_STAGED_ROOT': str(output), 'PYTHONDONTWRITEBYTECODE': '1'}
            args = [sys.executable, '-B', str(base / 'scripts/build.py'), '--in-place']
            if not build:
                args.append('--prepare-only')
            subprocess.run(args, check=True, env=env)
        files = []
        for path in sorted(output.rglob('*')):
            if path.is_file() and not any(part in EXCLUDED and not (part == 'data' and 'node_modules' in path.relative_to(output).parts[:index]) for index, part in enumerate(path.relative_to(output).parts)):
                files.append({'path': path.relative_to(output).as_posix(), 'bytes': path.stat().st_size, 'sha256': digest(path)})
        if digest(ROOT / 'QCoderI.exe') != before:
            raise RuntimeError('Live EXE changed concurrently during staging; inspect before installing')
        result = {'schema_version': 1, 'version': version, 'snapshot': snapshot, 'built': build and not snapshot,
                  'created_at': time.time(), 'elapsed_seconds': time.time() - started,
                  'live_exe_before': before, 'live_exe_after': digest(ROOT / 'QCoderI.exe'),
                  'files': files, 'network_used': False, 'installation_performed': False}
        (output / 'release-manifest.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
        print(json.dumps({'stage': str(output), 'version': version, 'files': len(files), 'elapsed_seconds': result['elapsed_seconds'], 'live_exe_unchanged': True}))
        return result
    except BaseException:
        (output / 'STAGING-FAILED.txt').write_text('Incomplete release; do not install. See command error.\n', encoding='utf-8')
        raise


if __name__ == '__main__':
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('--out', type=Path, required=True)
    cli.add_argument('--snapshot', action='store_true', help='Capture deployed baseline, no prepare/build')
    cli.add_argument('--prepare-only', action='store_true')
    args = cli.parse_args()
    stage(args.out, args.snapshot, not args.prepare_only)
