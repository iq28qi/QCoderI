"""One-time local branding, applied to the extracted application sources."""
from pathlib import Path
import json

BASE = Path(__file__).resolve().parents[1]
SOURCE = BASE / 'source'

def save(path, text):
    path.write_text(text, encoding='utf-8', newline='\n')

for folder, pattern in [(SOURCE / 'lib', '*.js'), (SOURCE / 'renderer', '*'), (SOURCE / 'dsh/node_modules/@deepseek-ai', '*/lib/client.js')]:
    for path in folder.glob(pattern):
        if path.is_file() and path.suffix in {'.js', '.html', '.css'}:
            text = path.read_text(encoding='utf-8')
            next_text = text.replace('DeepSeek Harness', 'QCoderI').replace('<html lang="en">', '<html lang="ru">')
            if text != next_text:
                save(path, next_text)

path = SOURCE / 'package.json'
package = json.loads(path.read_text(encoding='utf-8'))
package.update(name='qcoderi', productName='QCoderI', description='QCoderI — настольный AI-агент на основе DeepSeek Harness', version='0.1.0')
save(path, json.dumps(package, ensure_ascii=False, indent=2) + '\n')

path = SOURCE / 'lib/main.js'
text = path.read_text(encoding='utf-8')
if 'QCODERI_PORTABLE_HOME' not in text:
    marker = '//#region ../../packages/util/home-paths/src/index.ts'
    bootstrap = '''// QCODERI_PORTABLE_HOME: keep this project's state separate from upstream Harness.
app.setName("QCoderI");
app.setAppUserModelId("io.qcoderi.harness");
if (!process.env.DSH_HOME?.trim()) process.env.DSH_HOME = app.isPackaged
    ? join(dirname(process.execPath), "..", "data")
    : join(app.getAppPath(), "..", "data");
const qcoderiUserData = join(resolve(process.env.DSH_HOME), "electron-user-data");
mkdirSync(qcoderiUserData, { recursive: true });
app.setPath("userData", qcoderiUserData);
'''
    assert text.count(marker) == 1
    text = text.replace(marker, bootstrap + marker, 1)
text = text.replace('{ role: "quit" }', '{ role: "quit", label: "Выход" }')
save(path, text)

path = SOURCE / 'dsh/node_modules/@deepseek-ai/dsh-client-ui-brand-official/lib/client.js'
text = path.read_text(encoding='utf-8')
text = text.replace('return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.FishLogo, { size });', '''return (0, react_jsx_runtime.jsx)("span", {
    "aria-hidden": true,
    style: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: size ?? 28, height: size ?? 28, borderRadius: 8, background: "linear-gradient(135deg,#6366f1,#06b6d4)", color: "white", fontWeight: 800, fontSize: 20 },
    children: "Q"
});''')
text = text.replace('return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.BrandWordmark, { includeMark: false });', '''return (0, react_jsx_runtime.jsx)("span", { style: { fontSize: 20, fontWeight: 750, letterSpacing: "-0.6px" }, children: "QCoderI" });''')
save(path, text)

frontend = SOURCE / 'dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist'
for path in [frontend / 'index.html', frontend / 'manifest.webmanifest']:
    if path.exists():
        save(path, path.read_text(encoding='utf-8').replace('DeepSeek Harness', 'QCoderI').replace('<html lang="en">', '<html lang="ru">'))

# Apply the same visible product name to verification fixtures.
for path in (BASE / 'tests').glob('*.json'):
    save(path, path.read_text(encoding='utf-8').replace('DeepSeek Harness', 'QCoderI'))
print('QCoderI branding and isolated portable data directory configured')
