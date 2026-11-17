"""Focused staging safety tests; no live files or compiler invocation."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('stage_native', Path(__file__).resolve().parents[1] / 'scripts/stage-native.py')
staging = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(staging)


class StageSafety(unittest.TestCase):
    def test_copy_has_no_aliases_and_excludes_private_profiles(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / 'source'
            source.mkdir()
            (source / 'entry.js').write_text('original', encoding='utf-8')
            (source / 'data').mkdir()
            (source / 'data/private.txt').write_text('private', encoding='utf-8')
            staging.copy_owned(source, root / 'copy')
            (root / 'copy/entry.js').write_text('prepared', encoding='utf-8')
            self.assertEqual((source / 'entry.js').read_text(), 'original')
            self.assertFalse((root / 'copy/data').exists())

    def test_dependency_data_is_retained_but_private_profile_is_not(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / 'source'
            catalog = source / 'node_modules/vendor/dist/data/catalog.json'
            catalog.parent.mkdir(parents=True)
            catalog.write_text('{"models":[]}', encoding='utf-8')
            private = source / 'data/credentials.yaml'
            private.parent.mkdir(parents=True)
            private.write_text('private', encoding='utf-8')
            staging.copy_owned(source, root / 'copy')
            self.assertEqual((root / 'copy/node_modules/vendor/dist/data/catalog.json').read_text(), '{"models":[]}')
            self.assertFalse((root / 'copy/data').exists())

    def test_link_is_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'original').write_text('owned', encoding='utf-8')
            try:
                (root / 'link').symlink_to(root / 'original')
            except OSError:
                # Windows supports junctions without Developer Mode; use one if symlinks denied.
                import subprocess
                (root / 'directory').mkdir()
                subprocess.run(['cmd.exe', '/D', '/C', 'mklink', '/J', str(root / 'link'), str(root / 'directory')], check=True, capture_output=True)
            with self.assertRaisesRegex(ValueError, 'Linked staging input'):
                staging.copy_owned(root / 'link', root / 'copy')

    def test_live_source_and_ancestor_outputs_refused_before_creating_anything(self):
        for path in [staging.ROOT, staging.BASE, staging.BASE / 'source/forbidden-stage', staging.ROOT.parent]:
            with self.subTest(path=path), self.assertRaises(ValueError):
                staging.stage(path)

    def test_default_build_routes_to_stage_before_prepare(self):
        source = (staging.BASE / 'scripts/build.py').read_text(encoding='utf-8')
        main = source[source.index("if __name__ == '__main__':"):]
        self.assertIn("Path(marker).resolve() != BASE.parent.resolve()", main)
        self.assertIn("['stage'](output, build=not args.prepare_only)", main)
        self.assertIn("'QCODERI_STAGED_ROOT': str(output)", (staging.BASE / 'scripts/stage-native.py').read_text(encoding='utf-8'))


if __name__ == '__main__':
    unittest.main()
