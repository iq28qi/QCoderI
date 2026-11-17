"""Merge local Harness conversations and provider configuration into QCoderI.

Never prints credential values; original Harness data is left intact.
"""
from pathlib import Path
from datetime import datetime
import hashlib
import json
import os
import shutil
import time
import yaml

BASE = Path(__file__).resolve().parents[1]
SOURCE = Path.home() / '.dsh'
TARGET = BASE / 'data'
BACKUP = BASE / 'backups' / ('before-migration-' + datetime.now().strftime('%Y%m%d-%H%M%S'))

def stable_copy(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(4):
        before = source.stat()
        payload = source.read_bytes()
        after = source.stat()
        if (before.st_size, before.st_mtime_ns) == (after.st_size, after.st_mtime_ns) and len(payload) == after.st_size:
            temporary = target.with_name(target.name + '.migration-tmp')
            temporary.write_bytes(payload)
            os.replace(temporary, target)
            return hashlib.sha256(payload).hexdigest()
        time.sleep(.1)
    raise RuntimeError(f'File is actively changing; retry later: {source}')

def merge(previous, incoming):
    if isinstance(previous, dict) and isinstance(incoming, dict):
        result = dict(previous)
        for key, value in incoming.items():
            result[key] = merge(result[key], value) if key in result else value
        return result
    if isinstance(previous, list) and isinstance(incoming, list):
        if all(isinstance(value, dict) and 'id' in value for value in previous + incoming):
            result = {value['id']: value for value in previous}
            for value in incoming:
                result[value['id']] = merge(result.get(value['id'], {}), value)
            return list(result.values())
        result = list(previous)
        for value in incoming:
            if value not in result:
                result.append(value)
        return result
    return incoming

def load(path):
    return yaml.safe_load(path.read_text(encoding='utf-8')) if path.exists() else {}

def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.migration-tmp')
    text = json.dumps(data, ensure_ascii=False, indent=2) if path.suffix == '.json' else yaml.safe_dump(data, allow_unicode=True, sort_keys=False)
    temporary.write_text(text + '\n', encoding='utf-8')
    os.replace(temporary, path)

def snapshot_target():
    BACKUP.mkdir(parents=True)
    for source in TARGET.rglob('*'):
        if not source.is_file():
            continue
        relative = source.relative_to(TARGET)
        if any(part in {'electron-user-data', 'node_modules', 'desktop'} for part in relative.parts):
            continue
        stable_copy(source, BACKUP / relative)

if __name__ == '__main__':
    snapshot_target()
    source_settings = load(SOURCE / 'settings.yaml')
    target_settings = load(TARGET / 'settings.yaml')
    settings = merge(target_settings, source_settings)
    if 'system-prompt' in target_settings:
        settings['system-prompt'] = target_settings['system-prompt']
    if 'permission' in target_settings:
        settings['permission'] = target_settings['permission']
    else:
        settings.pop('permission', None)
    settings['locale'] = {'preference': 'ru'}
    settings.setdefault('ui-theme', {})['preference'] = 'dark'
    save(TARGET / 'settings.yaml', settings)

    source_credentials = load(SOURCE / '.credentials.yaml')
    target_credentials = load(TARGET / '.credentials.yaml')
    credentials = merge(target_credentials, source_credentials)
    # Preserve this installation's browser-session identity, while merging API refs.
    for name, record in target_credentials.get('records', {}).items():
        if name.startswith('client-connection/'):
            credentials.setdefault('records', {})[name] = record
    save(TARGET / '.credentials.yaml', credentials)

    copied = {}
    hashes = {}
    for directory in ['sessions', 'attachments', 'storages', 'chatgpt-subscription']:
        count = 0
        root = SOURCE / directory
        if not root.exists():
            continue
        for source in root.rglob('*'):
            if not source.is_file():
                continue
            relative = source.relative_to(SOURCE)
            if relative.as_posix() == 'storages/workspace.json':
                continue
            destination = TARGET / relative
            if destination.exists() and source.read_bytes() != destination.read_bytes():
                stable_copy(destination, BACKUP / 'conflicts' / relative)
            hashes[relative.as_posix()] = stable_copy(source, destination)
            count += 1
        copied[directory] = count

    previous = load(TARGET / 'storages/workspace.json')
    incoming = load(SOURCE / 'storages/workspace.json')
    combined = merge(previous, incoming)
    workspaces = combined.setdefault('tables', {}).setdefault('workspaces', {})
    canonical = {}
    remap = {}
    for identifier in incoming.get('global', {}).get('workspaceIds', []) + previous.get('global', {}).get('workspaceIds', []):
        row = workspaces.get(identifier)
        if row is None:
            continue
        key = str(row.get('path', '')).replace('\\', '/').rstrip('/').casefold()
        if key in canonical and canonical[key] != identifier:
            main_id = canonical[key]
            workspaces[main_id] = merge(row, workspaces[main_id])
            remap[identifier] = main_id
            del workspaces[identifier]
        else:
            canonical[key] = identifier
    combined['global']['workspaceIds'] = list(dict.fromkeys(remap.get(value, value) for value in combined['global'].get('workspaceIds', [])))
    save(TARGET / 'storages/workspace.json', combined)

    # Copy plugin code/configuration, not the old runtime cache or running lock files.
    profile = SOURCE / 'profiles/desktop'
    target_profile = TARGET / 'profiles/desktop'
    for source in profile.rglob('*'):
        if not source.is_file() or source.name in {'lock', 'desktop-packages-pending', 'desktop-runtime-state.json'}:
            continue
        stable_copy(source, target_profile / source.relative_to(profile))
    patch_path = target_profile / 'cordis.patch.yml'
    if patch_path.exists():
        patches = load(patch_path)
        for patch in patches or []:
            if patch.get('id') == 'chatgpt':
                patch.setdefault('config', {})['stateDir'] = '../../chatgpt-subscription'
        save(patch_path, patches)

    # Allow the normal desktop runtime reconciler to validate the relocated plugin graph.
    old_state = target_profile / 'desktop-runtime-state.json'
    if old_state.exists():
        backup_state = BACKUP / 'runtime-state-before-reconcile.json'
        stable_copy(old_state, backup_state)

    providers = settings.get('llm-pi-ai', {}).get('providers', {})
    sessions = list((TARGET / 'sessions').rglob('*.zstd'))
    for relative, expected in hashes.items():
        assert hashlib.sha256((TARGET / relative).read_bytes()).hexdigest() == expected, relative
    report = {
        'source_home': str(SOURCE), 'target_home': str(TARGET), 'backup': str(BACKUP),
        'copied_files': copied, 'source_chats': copied.get('sessions', 0), 'total_chat_files': len(sessions),
        'providers': len(providers), 'models': sum(len(p.get('models', [])) for p in providers.values()),
        'workspaces': len(workspaces), 'credential_values_logged': False,
        'copied_content_verified': True
    }
    save(BASE / 'docs/migration-report.json', report)
    print(json.dumps({key: report[key] for key in ['source_chats', 'total_chat_files', 'providers', 'models', 'workspaces', 'copied_content_verified']}, ensure_ascii=False))
    print('Backup:', BACKUP)
