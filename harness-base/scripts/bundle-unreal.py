"""Bundle a tested UE editor DLL only when engine id and plugin sources match."""
from pathlib import Path
import argparse
import hashlib
import json
import shutil

BASE = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--engine', type=Path, required=True)
parser.add_argument('--compiled-plugin', type=Path, required=True)
args = parser.parse_args()
source = BASE / 'assets/unreal/QCoderIBridge'
names = ['QCoderIBridge.uplugin', 'Source/QCoderIBridge/QCoderIBridge.Build.cs',
         'Source/QCoderIBridge/Private/QCoderIBridge.cpp']
parts = []
for name in names:
    data = (source / name).read_bytes()
    if data != (args.compiled_plugin / name).read_bytes():
        raise SystemExit('Compiled project does not contain current source: ' + name)
    parts.append(data)
version = json.loads((args.engine / 'Engine/Build/Build.version').read_text(encoding='utf-8'))
tag = '.'.join(str(version[key]) for key in ['MajorVersion', 'MinorVersion', 'PatchVersion'])
modules = args.compiled_plugin / 'Binaries/Win64/UnrealEditor.modules'
module_data = json.loads(modules.read_text(encoding='utf-8'))
engine_data = json.loads((args.engine / 'Engine/Binaries/Win64/UnrealEditor.modules').read_text(encoding='utf-8'))
if module_data['BuildId'] != engine_data['BuildId']:
    raise SystemExit('Engine and plugin build ids differ')
binary = args.compiled_plugin / 'Binaries/Win64/UnrealEditor-QCoderIBridge.dll'
output = BASE / 'assets/unreal/prebuilt' / tag
output.mkdir(parents=True, exist_ok=True)
shutil.copy2(binary, output / 'bridge.bin')
shutil.copy2(modules, output / 'UnrealEditor.modules')
manifest = {'engine_version': tag, 'build_id': module_data['BuildId'],
            'source_sha256': hashlib.sha256(b''.join(parts)).hexdigest(),
            'binary_sha256': hashlib.sha256(binary.read_bytes()).hexdigest()}
(output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
print('Bundled:', output)
