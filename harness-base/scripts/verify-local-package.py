"""Independently read and hash EVERY archived release artifact without extraction."""
from pathlib import Path, PurePosixPath
from zipfile import ZipFile
import argparse
import hashlib
import json


def verify(archive, output=None):
    archive=archive.resolve(strict=True)
    with ZipFile(archive) as bundle:
        names=bundle.namelist()
        if len(names)!=len(set(names)):
            raise ValueError('Duplicate archive member')
        manifest=json.loads(bundle.read('release/release-manifest.json'))
        expected={'release/release-manifest.json','Install-QCoderI.ps1','README.md'}
        for item in manifest['files']:
            name=item['path'];path=PurePosixPath(name)
            dependency_data=name.startswith('harness-base/source/dsh/node_modules/') or name.startswith('harness-base/app/resources/runtime/') and '/node_modules/' in name
            if path.is_absolute() or '\\' in name or ':' in name or any(p in ('..','.git','.startup-preview-browser') or p=='data' and not dependency_data for p in path.parts):
                raise ValueError('Unsafe archived artifact: '+name)
            data=bundle.read('release/'+name)
            if len(data)!=item['bytes'] or hashlib.sha256(data).hexdigest()!=item['sha256']:
                raise ValueError('Archived bytes/hash mismatch: '+name)
            expected.add('release/'+name)
        if expected!=set(names):
            raise ValueError('Unexpected or missing archive members')
    with archive.open('rb') as stream:
        sha=hashlib.file_digest(stream,'sha256').hexdigest()
    result={'schema_version':1,'archive':str(archive),'sha256':sha,'version':manifest['version'],'files_independently_read_and_hashed':len(manifest['files']),'archive_members':len(names),'status':'passed','extracted':False,'installation_changed':False}
    if output:
        output.write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive',required=True,type=Path)
    parser.add_argument('--output',type=Path)
    args=parser.parse_args();verify(args.archive,args.output)
