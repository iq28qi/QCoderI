"""Validate packaging against a disposable runtime, never the running installation."""
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import unittest

BASE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('qcoderi_build_fixture', BASE / 'scripts/build.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class RuntimePackaging(unittest.TestCase):
    def test_preview_profiles_are_never_shipped(self):
        self.assertFalse(build.release_source_file(BASE / 'source/renderer/.startup-preview-browser/Default/Cache/file'))
        self.assertTrue(build.release_source_file(BASE / 'source/dsh/node_modules/.pnpm/library/index.js'))

    def test_design_sync_and_startup_patch_produce_one_sprite(self):
        import runpy
        startup = runpy.run_path(str(BASE / 'scripts/optimize-startup.py'))
        with tempfile.TemporaryDirectory(prefix='qcoderi-sprite-') as directory:
            source = Path(directory)
            frontend = source / 'dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist'
            frontend.mkdir(parents=True)
            (source / 'renderer').mkdir()
            (frontend / 'manifest.webmanifest').write_text('{}', encoding='utf-8')
            (frontend / 'index.html').write_text('<html><head></head><body><div id="root"></div></body></html>', encoding='utf-8')
            original = build.SOURCE
            try:
                build.SOURCE = source
                for _ in range(2):
                    build.sync_design_assets()
                    html = (frontend / 'index.html').read_text(encoding='utf-8')
                    sprite = startup['START'] + '\n' + startup['inline_sprite']((BASE / 'assets/qcoderi-sidebar-glyphs.svg').read_text(encoding='utf-8')) + '\n' + startup['END']
                    html = re.sub(re.escape(startup['START']) + r'.*?' + re.escape(startup['END']), '', html, flags=re.S)
                    (frontend / 'index.html').write_text(html.replace('<div id="root"></div>', sprite + '<div id="root"></div>'), encoding='utf-8')
                html = (frontend / 'index.html').read_text(encoding='utf-8')
                ids = re.findall(r'id="(qcoderi-glyph-[^"]+)"', html)
                self.assertEqual(len(ids), len(set(ids)))
                self.assertGreater(len(ids), 15)
                self.assertNotIn('QCODERI_GLYPHS_BEGIN', html)
            finally:
                build.SOURCE = original

    def test_owned_plugins_and_their_local_imports_are_delivered(self):
        with tempfile.TemporaryDirectory(prefix='qcoderi-packaging-') as directory:
            source = Path(directory)
            packages = source / 'dsh/node_modules'
            fixtures = {
                'dsh/desktop-runtime.json': json.dumps({'sharedPackages': []}),
                'dsh/package.json': '{}',
                'dsh/node_modules/@deepseek-ai/dsh/package.json': '{}',
                'dsh/node_modules/@deepseek-ai/dsh-agent-presets/presets/standard/agent.cordis.yml':
                    '- id: persona\n  config:\n    prefix: >-\n      You are a coding agent powered by the {{model}} model.\n',
                'dsh/node_modules/@deepseek-ai/dsh-desktop-host/config/desktop.cordis.patch.yml': '[]\n',
            }
            for path, content in fixtures.items():
                target = source / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content, encoding='utf-8')
            original = build.SOURCE
            try:
                build.SOURCE = source
                build.sync_startup_runtime()
                build.sync_team()
                build.sync_team()  # registration remains idempotent
            finally:
                build.SOURCE = original
            self.assertEqual((BASE / 'native/startup-cache.mjs').read_bytes(),
                             (source / 'dsh/qcoderi-startup-cache.mjs').read_bytes())
            self.assertIn("../source/dsh/qcoderi-startup-cache.mjs", (BASE / 'native/desktop-server.mjs').read_text(encoding='utf-8'))
            target = packages / '@qcoderi/team'
            for asset in (BASE / 'assets/team').iterdir():
                if asset.is_file() and (asset.name == 'package.json' or asset.suffix in {'.js', '.py', '.ps1', '.java'}):
                    self.assertEqual(asset.read_bytes(), (target / asset.name).read_bytes(), asset.name)
            for module in target.glob('*.js'):
                for dependency in re.findall(r"(?:from\s+|import\s*\()['\"](\./[^'\"]+)['\"]", module.read_text(encoding='utf-8')):
                    self.assertTrue((target / dependency).is_file(), f'{module.name} -> {dependency}')
            descriptor = json.loads((source / 'dsh/desktop-runtime.json').read_text(encoding='utf-8'))
            self.assertEqual(sum(row['name'] == '@qcoderi/team' for row in descriptor['sharedPackages']), 1)
            self.assertFalse((target / '__pycache__').exists())


if __name__ == '__main__':
    unittest.main()
