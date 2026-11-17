"""Focused archived dependency-data safety, no installation or process launch."""
import importlib.util
from pathlib import Path
import unittest
import tempfile
from zipfile import ZipFile
import hashlib
import json
spec=importlib.util.spec_from_file_location('verify_local_package',Path(__file__).resolve().parents[1]/'scripts/verify-local-package.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class PackageSafety(unittest.TestCase):
    def archive(self,root,path):
        archive=root/'fixture.zip';data=b'{"models":[]}'
        manifest={'version':'fixture','files':[{'path':path,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}]}
        with ZipFile(archive,'w') as bundle:
            bundle.writestr('release/release-manifest.json',json.dumps(manifest));bundle.writestr('release/'+path,data)
            bundle.writestr('Install-QCoderI.ps1','#fixture');bundle.writestr('README.md','fixture')
        return archive
    def test_dependency_catalog_is_valid(self):
        with tempfile.TemporaryDirectory() as tmp:
            module.verify(self.archive(Path(tmp),'harness-base/source/dsh/node_modules/vendor/dist/data/models.json'))
        with tempfile.TemporaryDirectory() as tmp:
            module.verify(self.archive(Path(tmp),'harness-base/app/resources/runtime/pnpm/dist/node_modules/node-gyp/gyp/data/build.ninja'))
    def test_private_data_and_traversal_stay_forbidden(self):
        for path in ['harness-base/data/private.json','harness-base/source/dsh/node_modules/../data/private.json','../escape.json']:
            with self.subTest(path=path),tempfile.TemporaryDirectory() as tmp:
                with self.assertRaisesRegex(ValueError,'Unsafe archived artifact'):
                    module.verify(self.archive(Path(tmp),path))

if __name__=='__main__':unittest.main()
