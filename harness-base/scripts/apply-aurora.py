"""Apply the source-owned Aurora presentation to this Harness snapshot."""
from pathlib import Path
import shutil
import re

BASE = Path(__file__).resolve().parents[1]
ROOT = BASE / 'source'
PACKAGES = ROOT / 'dsh/node_modules/@deepseek-ai'
frontend = PACKAGES / 'dsh-web-frontend/dist'
shutil.copy2(BASE / 'assets/aurora.css', frontend / 'qcoderi-aurora.css')
path = frontend / 'index.html'
text = path.read_text(encoding='utf-8')
if 'qcoderi-aurora.css' not in text:
    text = text.replace('</head>', '  <link rel="stylesheet" href="./qcoderi-aurora.css">\n  </head>')
path.write_text(text, encoding='utf-8', newline='\n')

path = PACKAGES / 'dsh-client-ui-conversation/lib/client.js'
text = path.read_text(encoding='utf-8')
start = re.search(r'^[ \t]*function HeroShell\(', text, re.M).start()
end = text.index('\t\t//#endregion', start)
hero = '''        function HeroShell({ t, renderSlot, children }) {
            const h = react.createElement;
            const core = h("div", { className: "qc-hero-core" }, h("span", null, "Q"));
            return h("section", { className: HeroShell_module_css_default.root + " qc-hero", "aria-label": "QCoderI — пространство идей" },
                h("div", { className: "qc-hero-scene", "aria-hidden": true },
                    h("span", { className: "qc-orbit" }),
                    h("span", { className: "qc-orbit qc-orbit--second" }),
                    renderSlot("conversation.hero.brand.mark", { size: 66 }, { fallback: core })),
                h("div", { className: "qc-eyebrow" }, h("span", { className: "qc-live-dot" }), "Пространство для больших идей"),
                h("h1", { className: "qc-hero-title" }, "Твои идеи.", h("br"), h("em", null, "Новый масштаб.")),
                h("p", { className: "qc-hero-description" }, "Исследуй, пиши код и решай сложные задачи — в одном пространстве с ИИ."),
                h("div", { className: "qc-hero-tags", "aria-hidden": true },
                    h("span", null, "Разработка"), h("span", null, "Исследования"), h("span", null, "Автоматизация")),
                children);
        }
'''
text = text[:start] + hero + text[end:]
path.write_text(text, encoding='utf-8', newline='\n')

path = PACKAGES / 'dsh-client-ui-brand-official/lib/client.js'
text = path.read_text(encoding='utf-8')
start = re.search(r'^[ \t]*function OfficialBrandMark\(', text, re.M).start()
end = text.index('\t\t//#endregion', start)
text = text[:start] + '''        function OfficialBrandMark({ size = 28 }) {
            return (0, react_jsx_runtime.jsx)("span", {
                className: "qc-brand-mark", "aria-hidden": true,
                style: { width: size, height: size, fontSize: size < 35 ? 19 : 28 }, children: "Q"
            });
        }
        function OfficialBrandName() {
            return (0, react_jsx_runtime.jsxs)("span", { className: "qc-wordmark", children: ["QCoder", (0, react_jsx_runtime.jsx)("em", { children: "I" })] });
        }
''' + text[end:]
path.write_text(text, encoding='utf-8', newline='\n')

path = ROOT / 'renderer/startup.css'
text = path.read_text(encoding='utf-8')
if 'QCODERI_AURORA_STARTUP' not in text:
    text += '''
/* QCODERI_AURORA_STARTUP */
body{background:radial-gradient(ellipse at 70% 0,#26285555,transparent 60%),radial-gradient(ellipse at 10% 100%,#12425044,transparent 60%),#090f1c;color:#e9eefb;font-family:"Segoe UI Variable Text","Segoe UI",sans-serif}
main{border:1px solid #a3b6ec20;border-radius:24px;background:#111c2ba6;padding:40px;box-shadow:0 25px 100px #0004}
button{border:1px solid #91a5f540;border-radius:10px;background:#7c93f51a;color:inherit;padding:10px 16px}
'''
path.write_text(text, encoding='utf-8', newline='\n')
print('Aurora theme, hero scene and branding applied to source')
