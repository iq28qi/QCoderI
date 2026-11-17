"""Package a verified local native stage; no signing-key fiction or auto-publishing."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import argparse
import hashlib
import json
import shutil
import subprocess

BASE = Path(__file__).resolve().parents[1]


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def package(stage, output):
    stage=stage.resolve(strict=True)
    manifest=json.loads((stage/'release-manifest.json').read_text(encoding='utf-8'))
    if not manifest.get('built') or manifest.get('snapshot'):
        raise ValueError('Built native candidate required')
    subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',str(BASE/'scripts/install-staged-native.ps1'),'-Stage',str(stage),'-InstallRoot',str(BASE.parent),'-VerifyOnly'],check=True)
    output=output.resolve();output.mkdir(parents=True,exist_ok=True)
    archive=output/f"QCoderI-{manifest['version']}-local-windows-x64.zip"
    if archive.exists():
        raise FileExistsError('Never overwrite delivered release: '+str(archive))
    pending=archive.with_suffix('.zip.pending')
    installer=BASE/'scripts/install-staged-native.ps1'
    instructions=f'''# QCoderI {manifest['version']} local release

This is a locally verified unsigned build, NOT a signed production auto-update.
Extract the archive to a NEW directory. Do not unpack over a running installation.
Close the existing QCoderI manually before installing. No script stops or starts it.

PowerShell, from the extracted directory:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\Install-QCoderI.ps1 -Stage "$PWD\\release" -InstallRoot "G:\\QCoderI" -VerifyOnly
# After closing QCoderI manually:
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\Install-QCoderI.ps1 -Stage "$PWD\\release" -InstallRoot "G:\\QCoderI"
```

Installer verifies ALL supplied hashes and requires the installed EXE to match
{manifest['live_exe_before']}. A changed installation must be re-staged.
The runtime is installed in .qcoderi-releases/{manifest['version']}/harness-base,
previous EXE is preserved as QCoderI.before-{manifest['version']}.exe. Private
harness-base/data is never copied or migrated. Next launch is manual.

To roll back with QCoderI closed: replace QCoderI.exe with that backup. Do not
remove user data. Versioned runtime can remain inactive for diagnostics.

Budget limits are opt-in; enabled uncertified provider routes fail closed.
In {manifest['version']} only official api.openai.com/v1 text snapshot
'gpt-4o-mini-2024-07-18' has a reviewed wire contract; model is deprecated and
availability is not promised. It reserves128000 input tokens + output cap even
for a short request. Prices must be explicitly configured by the human. No paid
provider call was made in verification. Standalone image/video/audio outside
LlmRuntime is NOT covered. This is not an invoice or arbitrary-shell guarantee.
Project Brain is bounded local TF-IDF/LSA, not a neural embedding service.
3D evidence verifies static Blender export round trips, not UE skeletal playback.
'''
    try:
        with ZipFile(pending,'w',compression=ZIP_DEFLATED,compresslevel=3) as bundle:
            bundle.write(stage/'release-manifest.json','release/release-manifest.json')
            for item in manifest['files']:
                path=stage/item['path']
                if path.is_symlink() or digest(path)!=item['sha256']:
                    raise ValueError('Artifact changed during packaging: '+item['path'])
                bundle.write(path,'release/'+item['path'])
            bundle.write(installer,'Install-QCoderI.ps1')
            bundle.writestr('README.md',instructions)
        pending.replace(archive)
    finally:
        pending.unlink(missing_ok=True)
    result={'schema_version':1,'version':manifest['version'],'archive':str(archive),'bytes':archive.stat().st_size,'sha256':digest(archive),'files':len(manifest['files']),'production_signed':False,'published':False,'live_installation_changed':False}
    (output/'local-release.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    (output/'README.md').write_text(instructions,encoding='utf-8')
    shutil.copy2(installer,output/'Install-QCoderI.ps1')
    print(json.dumps(result))
    return result


if __name__=='__main__':
    cli=argparse.ArgumentParser(description=__doc__)
    cli.add_argument('--stage',type=Path,required=True)
    cli.add_argument('--out',type=Path,required=True)
    args=cli.parse_args();package(args.stage,args.out)
