"""Build the Rust desktop window and prepare the bundled QCoderI engine."""
import argparse
from pathlib import Path
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
from textwrap import indent

BASE = Path(__file__).resolve().parents[1]
SOURCE = BASE / 'source'
APP = BASE / 'app'
ASSETS = BASE / 'assets'
RESOURCES = APP / 'resources'

TEAM_PLUGIN = ('qcoderi-team', '@qcoderi/team')
STUDIO_PLUGIN = ('qcoderi-studio3d', '@qcoderi/team/studio3d')
UNREAL_PLUGIN = ('qcoderi-unreal', '@qcoderi/unreal')
AETHER_PLUGIN = ('qcoderi-aether', '@qcoderi/aether')
BINARY_ANALYSIS_PLUGIN = ('qcoderi-binary-analysis', '@qcoderi/team/binary-analysis')

def write_agent_composition(preset, standard, *plugins):
    rows = ''.join(f'\n- id: {plugin_id}\n  name: "{package}"\n' for plugin_id, package in plugins)
    (preset / 'agent.cordis.yml').write_text(standard + rows, encoding='utf-8', newline='\n')

def sync_team():
    """Install source-owned team orchestration without changing upstream JS."""
    packages = SOURCE / 'dsh/node_modules'
    team = packages / '@qcoderi/team'
    team.mkdir(parents=True, exist_ok=True)
    # Install every source-owned runtime module. Explicit filename lists previously
    # left newly added helpers out of the delivered app although asset tests passed.
    # Keep this shallow: no caches, test fixtures, data or directory traversal.
    for source in sorted((ASSETS / 'team').iterdir()):
        if source.name != 'package.json' and source.suffix not in {'.js', '.py', '.ps1', '.java'}:
            continue
        if source.is_symlink():
            raise ValueError(f'Team runtime source cannot be a symbolic link: {source.name}')
        if source.is_file():
            shutil.copy2(source, team / source.name)
    # Desktop resolves preset packages through its shared-runtime inventory.
    # Copying a package directory alone does not make it visible to the loader.
    descriptor_path = SOURCE / 'dsh/desktop-runtime.json'
    descriptor = json.loads(descriptor_path.read_text(encoding='utf-8'))
    descriptor['sharedPackages'] = [entry for entry in descriptor['sharedPackages']
                                    if entry['name'] != '@qcoderi/team']
    descriptor['sharedPackages'].append({'name': '@qcoderi/team', 'version': '0.1.0',
                                         'path': 'node_modules/@qcoderi/team'})
    descriptor_path.write_text(json.dumps(descriptor, ensure_ascii=False, indent=2) + '\n',
                               encoding='utf-8', newline='\n')
    # The profile resolver builds its fallback graph from the dsh install anchor.
    for manifest_path in [SOURCE / 'dsh/package.json', packages / '@deepseek-ai/dsh/package.json']:
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        manifest.setdefault('dependencies', {})['@qcoderi/team'] = '0.1.0'
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n',
                                  encoding='utf-8', newline='\n')
    presets = packages / '@deepseek-ai/dsh-agent-presets/presets'
    preset = presets / 'qcoder-team'
    preset.mkdir(parents=True, exist_ok=True)
    standard = (presets / 'standard/agent.cordis.yml').read_text(encoding='utf-8')
    write_agent_composition(preset, standard, TEAM_PLUGIN, STUDIO_PLUGIN, UNREAL_PLUGIN, AETHER_PLUGIN, BINARY_ANALYSIS_PLUGIN)
    shutil.copy2(ASSETS / 'team/preset.yml', preset / 'preset.yml')
    chat_preset = presets / 'qcoder-chat'
    chat_preset.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ASSETS / 'team/chat.cordis.yml', chat_preset / 'agent.cordis.yml')
    shutil.copy2(ASSETS / 'team/chat-preset.yml', chat_preset / 'preset.yml')
    studio = presets / 'qcoder-3d'
    studio.mkdir(parents=True, exist_ok=True)
    studio_composition = standard.replace('You are a coding agent powered by the {{model}} model.',
        'You are a professional 3D artist and technical modeler powered by {{model}}. Create, inspect and refine actual editable 3D assets.')
    write_agent_composition(studio, studio_composition, STUDIO_PLUGIN, TEAM_PLUGIN, AETHER_PLUGIN)
    shutil.copy2(ASSETS / 'team/studio3d-preset.yml', studio / 'preset.yml')
    hacker = presets / 'qcoder-hacker'
    hacker.mkdir(parents=True, exist_ok=True)
    hacker_prompt = (
        'Ты — инженер по реверс-инжинирингу и безопасности в QCoderI. Работай практически: '
        'запускай инструменты, читай артефакты, вноси правки, собирай и проверяй результат.\n\n'
        'Порядок работы:\n'
        '1. Определи цель и критерий проверки. Для многошаговой задачи веди todo_write.\n'
        '2. Установи идентичность цели: путь, формат, архитектура, версия, SHA-256; для бинарника — '
        'движок анализа, image base и соглашение об адресах.\n'
        '3. binary_analyzer_status → binary_analyze. Повторные вопросы по той же базе — binary_query '
        'без повторного анализа: имя, regex, адрес, строки, инструкции, callers/callees, граф вызовов, псевдокод.\n'
        '4. Читай отчёты analysis.json и query-*.json через read и grep. Вывод подкрепляй адресом (VA), '
        'именем функции и фрагментом инструкций или псевдокода из отчёта.\n'
        '5. Гипотезу помечай как гипотезу. Скомпилированный код без символов и строк не доказывает назначение функции.\n'
        '6. Изменение считается сделанным после сборки и проверки. Показывай команду и её фактический вывод; '
        'непроверенное называй непроверенным.\n\n'
        'Правила доказательств:\n'
        '- различай файловое смещение, RVA и VA, учитывай image base и ASLR;\n'
        '- не выдумывай смещения, сигнатуры, размеры структур, классовые раскладки и результаты тестов;\n'
        '- значения конкретной сборки держи в одном именованном конфиге или резолвере и проверяй по границам модуля;\n'
        '- частичный или устаревший снимок данных отбрасывай целиком, а не смешивай со свежим.\n\n'
        'Аудит кода и конфигурации (сайт, сервер): укажи конкретное место (файл, строка, параметр), '
        'первопричину, последствия, исправление и проверочный тест. Для сервера достаточно обезличенной '
        'конфигурации и сведений об образе; приватные ключи не нужны.\n\n'
        'Измерения в игре: фиксируй единицы, базу сравнения, число замеров и условия. '
        'Единичный замер без повторяемости не является подтверждением.\n\n'
        'Итог: что проверено, какие команды выполнялись, где артефакты, что осталось гипотезой и какая '
        'следующая проверка. Соблюдай предоставленные разрешения и фактические ограничения инструментов.'
    )
    hacker_composition = standard.replace(
        '    prefix: >-\n      You are a coding agent powered by the {{model}} model.',
        '    prefix: |-\n' + indent(hacker_prompt, '      '))
    write_agent_composition(hacker, hacker_composition, BINARY_ANALYSIS_PLUGIN)
    shutil.copy2(ASSETS / 'team/hacker-preset.yml', hacker / 'preset.yml')
    desktop_patch = packages / '@deepseek-ai/dsh-desktop-host/config/desktop.cordis.patch.yml'
    composition = desktop_patch.read_text(encoding='utf-8')
    if 'default: qcoder-team' not in composition:
        desktop_patch.write_text(composition + '\n- id: agent-presets\n  config:\n    default: qcoder-team\n', encoding='utf-8', newline='\n')
        composition = desktop_patch.read_text(encoding='utf-8')
    if 'qcoderi-niceai-video' not in composition:
        desktop_patch.write_text(composition + '\n- insert:\n    - id: qcoderi-niceai-video\n      name: "@qcoderi/team/media"\n', encoding='utf-8', newline='\n')
    composition = desktop_patch.read_text(encoding='utf-8')
    if 'qcoderi-screenshot' not in composition:
        desktop_patch.write_text(composition + '\n- insert:\n    - id: qcoderi-screenshot\n      name: "@qcoderi/team/screenshot"\n', encoding='utf-8', newline='\n')
    composition = desktop_patch.read_text(encoding='utf-8')
    if 'qcoderi-image-generation' not in composition:
        desktop_patch.write_text(composition + '\n- insert:\n    - id: qcoderi-image-generation\n      name: "@qcoderi/team/image-generation"\n', encoding='utf-8', newline='\n')
    composition = desktop_patch.read_text(encoding='utf-8')
    if 'qcoderi-desktop-control' not in composition:
        desktop_patch.write_text(composition + '\n- insert:\n    - id: qcoderi-desktop-control\n      name: "@qcoderi/team/desktop"\n', encoding='utf-8', newline='\n')
    composition = desktop_patch.read_text(encoding='utf-8')
    if 'qcoderi-workbench' not in composition:
        desktop_patch.write_text(composition + '\n- insert:\n    - id: qcoderi-workbench\n      name: \"@qcoderi/team/workbench\"\n', encoding='utf-8', newline='\n')


def sync_unreal():
    """Install the model-independent Unreal editor profile and bundled bridge."""
    packages = SOURCE / 'dsh/node_modules'
    target = packages / '@qcoderi/unreal'
    shutil.copytree(ASSETS / 'unreal', target, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns('Binaries', 'Intermediate'))
    descriptor_path = SOURCE / 'dsh/desktop-runtime.json'
    descriptor = json.loads(descriptor_path.read_text(encoding='utf-8'))
    descriptor['sharedPackages'] = [entry for entry in descriptor['sharedPackages']
                                    if entry['name'] != '@qcoderi/unreal']
    descriptor['sharedPackages'].append({'name': '@qcoderi/unreal', 'version': '0.1.0',
                                         'path': 'node_modules/@qcoderi/unreal'})
    descriptor_path.write_text(json.dumps(descriptor, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    for manifest_path in [SOURCE / 'dsh/package.json', packages / '@deepseek-ai/dsh/package.json']:
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        manifest.setdefault('dependencies', {})['@qcoderi/unreal'] = '0.1.0'
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    presets = packages / '@deepseek-ai/dsh-agent-presets/presets'
    preset = presets / 'qcoder-unreal'
    preset.mkdir(parents=True, exist_ok=True)
    standard = (presets / 'standard/agent.cordis.yml').read_text(encoding='utf-8')
    write_agent_composition(preset, standard, TEAM_PLUGIN, STUDIO_PLUGIN, UNREAL_PLUGIN, AETHER_PLUGIN)
    shutil.copy2(ASSETS / 'unreal/preset.yml', preset / 'preset.yml')

def sync_aether():
    """Install the AETHER Motion Studio bridge and its dedicated agent profile."""
    packages = SOURCE / 'dsh/node_modules'
    target = packages / '@qcoderi/aether'
    shutil.copytree(ASSETS / 'aether', target, dirs_exist_ok=True)
    descriptor_path = SOURCE / 'dsh/desktop-runtime.json'
    descriptor = json.loads(descriptor_path.read_text(encoding='utf-8'))
    descriptor['sharedPackages'] = [entry for entry in descriptor['sharedPackages']
                                    if entry['name'] != '@qcoderi/aether']
    descriptor['sharedPackages'].append({'name': '@qcoderi/aether', 'version': '0.1.0',
                                         'path': 'node_modules/@qcoderi/aether'})
    descriptor_path.write_text(json.dumps(descriptor, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    for manifest_path in [SOURCE / 'dsh/package.json', packages / '@deepseek-ai/dsh/package.json']:
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        manifest.setdefault('dependencies', {})['@qcoderi/aether'] = '0.1.0'
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    presets = packages / '@deepseek-ai/dsh-agent-presets/presets'
    preset = presets / 'qcoder-aether'
    preset.mkdir(parents=True, exist_ok=True)
    standard = (presets / 'standard/agent.cordis.yml').read_text(encoding='utf-8')
    write_agent_composition(preset, standard, TEAM_PLUGIN, AETHER_PLUGIN)
    shutil.copy2(ASSETS / 'aether/preset.yml', preset / 'preset.yml')

def run(args, cwd=BASE):
    subprocess.run([str(arg) for arg in args], cwd=cwd, check=True,
                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)

def file_hash(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def sync_design_assets():
    frontend = SOURCE / 'dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist'
    for asset, name in [('aurora.css', 'qcoderi-aurora.css'),
                        ('moonlight.css', 'qcoderi-moonlight.css'),
                        ('studio.css', 'qcoderi-studio.css'),
                        ('qcoderi-moonlit-elf.png', 'qcoderi-moonlit-elf.png'),
                        ('qcoderi-observatory.png', 'qcoderi-observatory.png'),
                        ('glass.css', 'qcoderi-glass.css'),
                        ('sidebar-reference.css', 'qcoderi-sidebar-reference.css'),
                        ('qcoderi-sidebar-moon-v1.png', 'qcoderi-sidebar-moon-v1.png'),
                        ('qcoderi-sidebar-glyphs.svg', 'qcoderi-sidebar-glyphs.svg'),
                        ('qcoderi.svg', 'qcoderi-app.svg'),
                        ('qcoderi.svg', 'favicon.svg'),
                        ('qcoderi.png', 'qcoderi-app.png'),
                        *[(f'qcoderi-card-{name}.svg', f'qcoderi-card-{name}.svg') for name in ['book', 'orbit', 'feather', 'moon']]]:
        path = ASSETS / asset
        if path.exists():
            shutil.copy2(path, frontend / name)
    index = frontend / 'index.html'
    html = index.read_text(encoding='utf-8')
    html = html.replace('<link rel="icon" type="image/svg+xml" href="./favicon.svg" />', '<link rel="icon" type="image/png" href="./qcoderi-app.png" />')
    if 'qcoderi-studio.css' not in html:
        html = html.replace('</head>', '  <link rel="stylesheet" href="./qcoderi-studio.css">\n  </head>')
    if 'qcoderi-glass.css' not in html:
        html = html.replace('</head>', '  <link rel="stylesheet" href="./qcoderi-glass.css">\n  </head>')
    if 'qcoderi-sidebar-reference.css' not in html:
        html = html.replace('</head>', '  <link rel="stylesheet" href="./qcoderi-sidebar-reference.css">\n  </head>')
    # Retire the legacy sprite block; optimize-startup owns the single validated
    # symbol table. Keeping both creates duplicate SVG IDs and ambiguous paint.
    html = re.sub(r'\s*<!-- QCODERI_GLYPHS_BEGIN -->.*?<!-- QCODERI_GLYPHS_END -->', '', html, flags=re.DOTALL)
    if html != index.read_text(encoding='utf-8'):
        index.write_text(html, encoding='utf-8', newline='\n')
    for asset in ['qcoderi.svg', 'qcoderi.png', 'qcoderi.ico']:
        path = ASSETS / asset
        if path.exists():
            shutil.copy2(path, SOURCE / 'renderer' / asset)
    manifest_path = frontend / 'manifest.webmanifest'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    manifest['short_name'] = 'QCoderI'
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n', encoding='utf-8', newline='\n')

def refresh_runtime_descriptor():
    path = SOURCE / 'dsh/desktop-runtime.json'
    descriptor = json.loads(path.read_text(encoding='utf-8'))
    old = {entry['path']: entry for entry in descriptor['files']}
    records = []
    for child in sorted((SOURCE / 'dsh').rglob('*')):
        if not child.is_file() or child == path:
            continue
        rel = child.relative_to(SOURCE / 'dsh').as_posix()
        records.append({'path': rel, 'bytes': child.stat().st_size,
                        'sha256': file_hash(child), 'executable': old.get(rel, {}).get('executable', False)})
    descriptor['files'] = records
    path.write_text(json.dumps(descriptor, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')

def release_source_file(path, root=SOURCE):
    """Do not ship disposable browser profiles/caches accidentally left in source."""
    rel = path.relative_to(root)
    return not any(part in {'.startup-preview-browser', '__pycache__', 'node-compile'} for part in rel.parts)


def pack():
    header = {'files': {}}
    payloads = []
    offset = 0
    for path in sorted(SOURCE.rglob('*')):
        if not path.is_file() or not release_source_file(path):
            continue
        rel = path.relative_to(SOURCE)
        entry = header
        for part in rel.parts:
            entry = entry.setdefault('files', {}).setdefault(part, {})
        data = path.read_bytes()
        block_size = 4194304
        entry.update(size=len(data), integrity={'algorithm': 'SHA256', 'hash': hashlib.sha256(data).hexdigest(),
                     'blockSize': block_size, 'blocks': [hashlib.sha256(data[i:i+block_size]).hexdigest() for i in range(0, len(data), block_size)]})
        if path.suffix.lower() in {'.node', '.dll', '.exe'}:
            entry['unpacked'] = True
            target = RESOURCES / 'app.asar.unpacked' / rel
            if not (target.exists() and target.stat().st_size == len(data) and file_hash(target) == entry['integrity']['hash']):
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, target)
        else:
            entry['offset'] = str(offset)
            offset += len(data)
            payloads.append(path)
    encoded = json.dumps(header, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    padding = (-len(encoded)) % 4
    header_size = 8 + len(encoded) + padding
    staging = RESOURCES / 'app.next.asar'
    with staging.open('wb') as target:
        target.write(struct.pack('<4I', 4, header_size, header_size-4, len(encoded)))
        target.write(encoded)
        target.write(b'\0' * padding)
        for path in payloads:
            with path.open('rb') as stream:
                shutil.copyfileobj(stream, target)
    try:
        os.replace(staging, RESOURCES / 'app.asar')
        # A fresh full build supersedes any older local update waiting for restart.
        (RESOURCES / 'app.update.asar').unlink(missing_ok=True)
        print('Packed complete source tree:', len(payloads), 'archive files')
        return False
    except PermissionError:
        os.replace(staging, RESOURCES / 'app.update.asar')
        print('QCoderI is running; staged complete source tree in app.update.asar:', len(payloads), 'archive files')
        return True

def resource_key(data, offset):
    first = struct.unpack_from('<H', data, offset)[0]
    if first == 0xffff:
        return struct.unpack_from('<H', data, offset+2)[0], offset+4
    end = offset
    while struct.unpack_from('<H', data, end)[0]:
        end += 2
    return data[offset:end].decode('utf-16le'), end+2

def brand_executable(executable, resources):
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.BeginUpdateResourceW.argtypes = [wintypes.LPCWSTR, wintypes.BOOL]
    kernel.BeginUpdateResourceW.restype = wintypes.HANDLE
    kernel.UpdateResourceW.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p, wintypes.WORD, ctypes.c_void_p, wintypes.DWORD]
    kernel.UpdateResourceW.restype = wintypes.BOOL
    kernel.EndUpdateResourceW.argtypes = [wintypes.HANDLE, wintypes.BOOL]
    kernel.EndUpdateResourceW.restype = wintypes.BOOL
    handle = kernel.BeginUpdateResourceW(str(executable), False)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    keep_strings = []
    def pointer(value):
        if isinstance(value, int):
            return ctypes.c_void_p(value)
        buffer = ctypes.create_unicode_buffer(value)
        keep_strings.append(buffer)
        return ctypes.cast(buffer, ctypes.c_void_p)
    try:
        data = resources.read_bytes()
        pos = 0
        while pos < len(data):
            size, header_size = struct.unpack_from('<II', data, pos)
            kind, next_pos = resource_key(data, pos+8)
            name, next_pos = resource_key(data, next_pos)
            next_pos = (next_pos+3) & ~3
            language = struct.unpack_from('<H', data, next_pos+6)[0]
            payload = data[pos+header_size:pos+header_size+size]
            if size:
                buffer = ctypes.create_string_buffer(payload)
                if not kernel.UpdateResourceW(handle, pointer(kind), pointer(name), language, buffer, len(payload)):
                    raise ctypes.WinError(ctypes.get_last_error())
            pos = (pos+header_size+size+3) & ~3
    except BaseException:
        kernel.EndUpdateResourceW(handle, True)
        raise
    if not kernel.EndUpdateResourceW(handle, False):
        raise ctypes.WinError(ctypes.get_last_error())

def compile_launchers():
    windres = shutil.which('windres')
    gcc = shutil.which('gcc')
    if not windres or not gcc:
        if (BASE.parent / 'QCoderI.exe').exists():
            print('GCC unavailable; retaining the existing branded launcher')
            return
        raise RuntimeError('GCC and windres are required for the first launcher build')
    try:
        run([windres, 'qcoderi.rc', '-O', 'coff', '-o', 'qcoderi.o'], ASSETS)
        run([windres, 'qcoderi.rc', '-O', 'res', '-o', 'qcoderi.res'], ASSETS)
        run([gcc, '-mwindows', '-O2', '-s', BASE/'scripts/launcher.c', ASSETS/'qcoderi.o', '-o', BASE.parent/'QCoderI.exe'])
        brand_executable(APP/'QCoderI.exe', ASSETS/'qcoderi.res')
        print('Built QCoderI.exe and branded Electron executable')
    except (PermissionError, subprocess.CalledProcessError):
        if (BASE.parent / 'QCoderI.exe').exists() and (APP / 'QCoderI.exe').exists():
            print('QCoderI is running; retaining existing launchers')
            return
        raise

def sync_startup_runtime():
    # Keep the helper inside the existing signed-update source allowlist. Older
    # installers reject new top-level native/*.mjs names during an upgrade.
    shutil.copy2(BASE / 'native/startup-cache.mjs', SOURCE / 'dsh/qcoderi-startup-cache.mjs')


def prepare_source():
    sync_startup_runtime()
    sync_team()
    sync_unreal()
    sync_aether()
    import runpy
    runpy.run_path(str(BASE / 'scripts/refine-studio.py'))['apply']()
    runpy.run_path(str(BASE / 'scripts/optimize-runtime.py'))['apply']()
    runpy.run_path(str(BASE / 'scripts/apply-reasoning.py'))['apply']()
    runpy.run_path(str(BASE / 'scripts/apply-screenshots.py'))['apply']()
    runpy.run_path(str(BASE / 'scripts/apply-workbench.py'))['apply']()
    runpy.run_path(str(BASE / 'scripts/apply-chat-window.py'))['apply']()
    runpy.run_path(str(BASE / 'scripts/apply-team-worktree.py'))['apply']()
    sync_design_assets()
    runpy.run_path(str(BASE / 'scripts/optimize-startup.py'))['apply']()
    runpy.run_path(str(BASE / 'scripts/optimize-native-startup.py'))['apply']()
    runpy.run_path(str(BASE / 'scripts/remove-upstream-onboarding.py'))['apply']()
    # Admission at final adapter dispatch, including compaction/review. Provider
    # contracts are applied afterwards and must preserve the fail-closed boundary.
    runpy.run_path(str(BASE / 'scripts/apply-usage-budget.py'))['apply'](SOURCE)
    runpy.run_path(str(BASE / 'scripts/apply-usage-provider.py'))['apply'](SOURCE)
    refresh_runtime_descriptor()


def build_native():
    native = BASE / 'native'
    target = Path(os.environ.get('QCODERI_CARGO_TARGET_DIR', native / 'target'))
    cargo = ['cargo', 'build', '--locked', '--release', '--manifest-path', native / 'Cargo.toml', '--target-dir', target]
    if os.environ.get('QCODERI_BUILD_OFFLINE') == '1':
        cargo.append('--offline')
    run(cargo)
    staging = BASE.parent / 'QCoderI.native-build.exe'
    output = BASE.parent / 'QCoderI.exe'
    shutil.copy2(target / 'release/qcoderi.exe', staging)
    windres = shutil.which('windres')
    if windres:
        run([windres, 'qcoderi.rc', '-O', 'res', '-o', 'qcoderi.res'], ASSETS)
        brand_executable(staging, ASSETS / 'qcoderi.res')
    try:
        os.replace(staging, output)
    except PermissionError:
        print('QCoderI.exe is in use. The new build is ready at:', staging)
        return
    files = [output, native / 'desktop-server.mjs', native / 'updates.mjs', SOURCE / 'dsh/qcoderi-startup-cache.mjs', APP / 'resources/runtime/node/node.exe']
    (BASE / 'SHA256SUMS.txt').write_text(
        ''.join(f'{file_hash(path)}  {path.relative_to(BASE.parent).as_posix()}\n' for path in files),
        encoding='utf-8',
    )
    print('Ready:', output)


def build_electron():
    refresh_runtime_descriptor()
    pending_update = pack()
    compile_launchers()
    archive_for_hash = (RESOURCES / 'app.update.asar') if pending_update else (RESOURCES / 'app.asar')
    sums_lines = [
        file_hash(BASE.parent/'QCoderI.exe') + '  ' + (BASE.parent/'QCoderI.exe').relative_to(BASE.parent).as_posix(),
        file_hash(APP/'QCoderI.exe') + '  ' + (APP/'QCoderI.exe').relative_to(BASE.parent).as_posix(),
        file_hash(archive_for_hash) + '  ' + (RESOURCES/'app.asar').relative_to(BASE.parent).as_posix(),
    ]
    sums_target = BASE / ('SHA256SUMS.next.txt' if pending_update else 'SHA256SUMS.txt')
    sums_target.write_text('\n'.join(sums_lines) + '\n', encoding='utf-8')
    print('Ready:', archive_for_hash if pending_update else (BASE.parent/'QCoderI.exe'))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--electron', action='store_true', help='Build the legacy Electron window')
    parser.add_argument('--prepare-only', action='store_true', help='Apply runtime and frontend changes without building an EXE')
    parser.add_argument('--out', type=Path, help='New isolated release directory; live files are never prepared in place')
    parser.add_argument('--in-place', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.in_place:
        marker = os.environ.get('QCODERI_STAGED_ROOT')
        if not marker or Path(marker).resolve() != BASE.parent.resolve():
            parser.error('In-place build is allowed only inside an explicitly staged copy')
        if args.electron:
            parser.error('Isolated native release does not support the legacy Electron builder')
        prepare_source()
        if not args.prepare_only:
            build_native()
    else:
        if args.electron:
            parser.error('Legacy live Electron preparation is disabled; use the native isolated release')
        import runpy
        import time
        output = args.out or BASE / 'tests/.runtime' / ('native-release-' + time.strftime('%Y%m%d-%H%M%S'))
        runpy.run_path(str(BASE / 'scripts/stage-native.py'))['stage'](output, build=not args.prepare_only)
