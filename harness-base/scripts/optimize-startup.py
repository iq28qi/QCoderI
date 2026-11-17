"""Inline the small, shipped Moonlight SVG symbol table before client mount.

Run apply() after refine-studio.py and sync_design_assets(). No app launch/build,
network, plugin eager imports, theme overrides, or profile reads. Existing SVG
references stay supported; refined SidebarGlyph/QcSessionGlyph use local IDs.
"""
from pathlib import Path
import re
import xml.etree.ElementTree as ET

BASE = Path(__file__).resolve().parents[1]
START = '<!-- QCODERI_STARTUP_ICONS -->'
END = '<!-- /QCODERI_STARTUP_ICONS -->'


def inline_sprite(svg):
    root = ET.fromstring(svg)
    ns = '{http://www.w3.org/2000/svg}'
    if root.tag != ns + 'svg':
        raise ValueError('Startup icon asset must be an SVG document')
    ids = re.findall(r'\bid="([A-Za-z][A-Za-z0-9_-]*)"', svg)
    if len(set(ids)) != len(ids) or not ids:
        raise ValueError('Startup icon IDs must be unique')
    # Source-owned geometry only; reject active/remote content rather than importing
    # a user SVG or silently losing its original gradients and filters.
    allowed = {'svg', 'defs', 'symbol', 'g', 'path', 'rect', 'circle', 'ellipse',
               'linearGradient', 'radialGradient', 'stop', 'filter', 'feGaussianBlur'}
    for element in root.iter():
        if element.tag.removeprefix(ns) not in allowed:
            raise ValueError('Unsupported startup icon element: ' + element.tag)
        for key, value in element.attrib.items():
            if key.lower().startswith('on') or key.endswith('href') or '://' in value:
                raise ValueError('Active/external startup icon content')
    for old in sorted(ids, key=len, reverse=True):
        new = 'qcoderi-glyph-' + old
        svg = svg.replace('id="' + old + '"', 'id="' + new + '"')
        svg = svg.replace('url(#' + old + ')', 'url(#' + new + ')')
    svg = svg.replace('<svg ', '<svg id="qcoderi-startup-icons" aria-hidden="true" focusable="false" width="0" height="0" style="position:absolute;overflow:hidden;pointer-events:none" ', 1)
    return svg.strip()


def apply(base=BASE):
    changed = []
    path = base / 'source/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html'
    html = path.read_text(encoding='utf-8')
    sprite = inline_sprite((base / 'assets/qcoderi-sidebar-glyphs.svg').read_text(encoding='utf-8'))
    block = START + '\n' + sprite + '\n' + END
    if START in html or END in html:
        if html.count(START) != 1 or html.count(END) != 1:
            raise RuntimeError('Ambiguous startup icon block')
        updated = re.sub(re.escape(START) + r'.*?' + re.escape(END), lambda _: block, html, flags=re.S)
    else:
        if html.count('<div id="root"></div>') != 1:
            raise RuntimeError('Frontend root changed; review startup icon placement')
        updated = html.replace('<div id="root"></div>', block + '\n    <div id="root"></div>', 1)
    if updated != html:
        path.write_text(updated, encoding='utf-8', newline='\n')
        changed.append(path)

    path = base / 'source/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js'
    source = path.read_text(encoding='utf-8')
    before = 'const body = resource.body === void 0 ? null : Uint8Array.from(resource.body);'
    after = '''// QCODERI_BUNDLE_RESPONSE: Response snapshots BufferSource bytes itself.
        // Avoid a second full-size allocation for the startup plugin batch.
        const body = resource.body === void 0 ? null : resource.body;'''
    if 'QCODERI_BUNDLE_RESPONSE' not in source:
        if source.count(before) != 1:
            raise RuntimeError('Plugin response changed; review startup buffer ownership')
        path.write_text(source.replace(before, after, 1), encoding='utf-8', newline='\n')
        changed.append(path)
    return changed


if __name__ == '__main__':
    for path in apply():
        print(path)
