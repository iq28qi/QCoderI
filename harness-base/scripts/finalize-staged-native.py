"""Refresh ONLY declared maintained runtime files in an unlaunched disposable stage.
Rehash descriptor/manifest; never touches live source, EXE or user profile.
"""
from pathlib import Path
import argparse
import hashlib
import json
import shutil
import subprocess
import runpy

BASE = Path(__file__).resolve().parents[1]
ROOT = BASE.parent


def digest(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def finalize(stage, names):
    stage = stage.resolve(strict=True)
    if not stage.is_relative_to(BASE / 'tests/.runtime'):
        raise ValueError('Only disposable test staging roots accepted')
    if any(path.is_symlink() or (hasattr(path, 'is_junction') and path.is_junction()) for path in [stage, stage / 'harness-base/source']):
        raise ValueError('Linked stage refused')
    manifest_path = stage / 'release-manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    if not manifest.get('built') or manifest.get('snapshot'):
        raise ValueError('Must be built candidate')
    if digest(ROOT / 'QCoderI.exe') != manifest['live_exe_before']:
        raise ValueError('Live EXE changed since staging')
    processes = subprocess.run(['powershell.exe','-NoProfile','-Command',"[Diagnostics.Process]::GetProcessesByName('QCoderI') | ForEach-Object { try { $_.MainModule.FileName } catch { 'unverifiable' } }"],capture_output=True,text=True,check=True).stdout
    if 'unverifiable' in processes or str(stage).lower() in processes.lower():
        raise ValueError('Close staged application before refreshing its files')
    for name in names:
        if '/' in name or '\\' in name or not name.endswith('.js'):
            raise ValueError('Exact owned team JS basenames required')
        target = stage / 'harness-base/source/dsh/node_modules/@qcoderi/team' / name
        if not target.is_file() or target.is_symlink():
            raise ValueError('Expected existing owned runtime file')
        shutil.copy2(BASE / 'assets/team' / name, target)
        shutil.copy2(BASE / 'assets/team' / name, stage / 'harness-base/assets/team' / name)
    runpy.run_path(str(stage / 'harness-base/scripts/build.py'))['refresh_runtime_descriptor']()
    manifest['files'] = [{'path':p.relative_to(stage).as_posix(),'bytes':p.stat().st_size,'sha256':digest(p)}
                         for p in sorted(stage.rglob('*')) if p.is_file() and p != manifest_path and not p.relative_to(stage).parts[0].startswith('.qcoderi-')]
    manifest['finalized_owned_modules'] = names
    manifest_path.write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    print('Finalized',stage,'files',len(manifest['files']),'live EXE unchanged',digest(ROOT/'QCoderI.exe')==manifest['live_exe_before'])


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage',required=True,type=Path)
    parser.add_argument('modules',nargs='+')
    args=parser.parse_args()
    finalize(args.stage,args.modules)
