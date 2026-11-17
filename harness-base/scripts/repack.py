"""Quickly package named source edits; full rebuild remains build.py."""
from pathlib import Path
import hashlib
import json
import os
import struct
import sys

BASE = Path(__file__).resolve().parents[1]
SOURCE = BASE / 'source'
ARCHIVE = Path(os.environ.get('QCODERI_REPACK_ARCHIVE', BASE / 'app/resources/app.asar')).resolve()

def digest(data):
    return hashlib.sha256(data).hexdigest()

def package_changes(names):
    payloads = {}
    for name in names:
        relative = Path(name)
        if relative.is_absolute() or '..' in relative.parts:
            raise ValueError('Use paths relative to source')
        path = SOURCE / relative
        if path.suffix.lower() in {'.node', '.dll', '.exe'}:
            raise ValueError('Use the full build for native binary edits')
        payloads[relative.as_posix()] = path.read_bytes()
    descriptor_path = SOURCE / 'dsh/desktop-runtime.json'
    descriptor = json.loads(descriptor_path.read_text(encoding='utf-8'))
    entries = {entry['path']: entry for entry in descriptor['files']}
    for name, data in payloads.items():
        if name.startswith('dsh/') and name != 'dsh/desktop-runtime.json':
            relative = name[4:]
            entry = entries.get(relative)
            if entry is None:
                entry = {'path': relative, 'executable': False}
                descriptor['files'].append(entry)
            entry.update(bytes=len(data), sha256=digest(data))
    descriptor['files'].sort(key=lambda entry: entry['path'])
    descriptor_path.write_text(json.dumps(descriptor, ensure_ascii=False, indent=2)+'\n', encoding='utf-8', newline='\n')
    payloads['dsh/desktop-runtime.json'] = descriptor_path.read_bytes()

    with ARCHIVE.open('rb') as stream:
        sizes = struct.unpack('<4I', stream.read(16))
        header = json.loads(stream.read(sizes[3]))
        old_base = 8 + sizes[1]
        for name, data in payloads.items():
            entry = header
            for part in name.split('/'):
                entry = entry.setdefault('files', {}).setdefault(part, {})
            entry['size'] = len(data)
            entry['integrity'] = {'algorithm':'SHA256', 'hash':digest(data), 'blockSize':4194304,
                                  'blocks':[digest(data[i:i+4194304]) for i in range(0,len(data),4194304)]}
        records = []
        def walk(node, prefix=''):
            for key, entry in node.get('files', {}).items():
                name = prefix + key
                if 'files' in entry:
                    walk(entry, name+'/')
                elif not entry.get('unpacked') and 'link' not in entry:
                    records.append((name, entry, int(entry.get('offset', '0'))))
        walk(header)
        offset = 0
        for name, entry, previous in records:
            entry['offset'] = str(offset)
            offset += entry['size']
        encoded = json.dumps(header, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        padding = (-len(encoded)) % 4
        header_size = 8+len(encoded)+padding
        staging = ARCHIVE.with_name(ARCHIVE.stem + '.next.asar')
        with staging.open('wb') as output:
            output.write(struct.pack('<4I',4,header_size,header_size-4,len(encoded)))
            output.write(encoded)
            output.write(b'\0'*padding)
            for name, entry, previous in records:
                data = payloads.get(name)
                if data is None:
                    stream.seek(old_base+previous)
                    data = stream.read(entry['size'])
                output.write(data)
    os.replace(staging, ARCHIVE)
    print('Packaged', len(payloads), 'edited files')

if __name__ == '__main__':
    if len(sys.argv) < 2:
        raise SystemExit('Usage: python repack.py relative/source/file ...')
    package_changes(sys.argv[1:])
