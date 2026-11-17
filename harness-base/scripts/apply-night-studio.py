"""Install the reference-inspired Moonlight Studio chrome and real shortcuts."""
from pathlib import Path
import re
import shutil

BASE=Path(__file__).resolve().parents[1]
PACKAGES=BASE/'source/dsh/node_modules/@deepseek-ai'
def save(path,text):path.write_text(text,encoding='utf-8',newline='\n')
def original(path):
    backup=BASE/'backups/before-moonlight-source'/path.relative_to(BASE/'source')
    if not backup.exists():
        backup.parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(path,backup)
    return backup.read_text(encoding='utf-8')

p=PACKAGES/'dsh-client-ui-layout/lib/client.js';s=original(p)
start=s.index('\t\tfunction CenterColumn(')
end=s.index('\t\t/** Subscribe to the main key',start)
s=s[:start]+(BASE/'assets/night-navigation.js').read_text(encoding='utf-8')+'\n'+s[end:]
s=s.replace('(CenterColumn, { children: main })','(CenterColumn, { children: main, useSessions })')
save(p,s)

p=PACKAGES/'dsh-client-ui-conversation/lib/client.js';s=original(p)
start=re.search(r'^[ \t]*function HeroShell\(',s,re.M).start();end=s.index('\t\t//#endregion',start)
s=s[:start]+(BASE/'assets/night-hero.js').read_text(encoding='utf-8')+'\n'+s[end:]
s=s.replace('function ConversationContent({ sessionId,','function ConversationContent({ inputActions, sessionId,',1)
marker='\t\t\tconst inputBar = renderSlot("conversation.composer.bar", {'
assert s.count(marker)==1
s=s.replace(marker,'''            const [suggestedPrompt, setSuggestedPrompt] = (0, react.useState)(null);
            (0, react.useEffect)(() => {
                if (!suggestedPrompt || inert || !inputActions) return;
                inputActions.setDraft(inputState?.draft ? inputState.draft + "\\n\\n" + suggestedPrompt : suggestedPrompt);
                setSuggestedPrompt(null);
                requestAnimationFrame(() => document.querySelector('[contenteditable="true"]')?.focus());
            }, [suggestedPrompt, inert, inputActions]);
            const onSuggest = prompt => {
                setSuggestedPrompt(prompt);
                if (inert) requestAnimationFrame(() => pickerAnchor.current?.click());
            };
''' + marker,1)
s=s.replace('''hero && (0, react_jsx_runtime.jsx)(HeroShell, {
						t,
						renderSlot
''','''hero && (0, react_jsx_runtime.jsx)(HeroShell, {
                        onSuggest,
						t,
						renderSlot
''',1)
marker='''					inputBar
				]
			});
			const composer ='''
assert s.count(marker)==1
s=s.replace(marker,'''					inputBar,
                    hero && (0, react_jsx_runtime.jsx)(NightQuickCards, { onSuggest })
				]
			});
			const composer =''',1)
save(p,s)

p=PACKAGES/'dsh-client-ui-sidebar/lib/client.js';s=original(p)
marker='\t\tfunction SidebarRoot('
start=s.index(marker)
s=s[:start]+(BASE/'assets/night-sidebar.js').read_text(encoding='utf-8')+'\n'+s[start:]
marker='''					(0, react_jsx_runtime.jsx)("div", {
						className: SidebarRoot_module_css_default.regionArea,'''
assert s.count(marker)==1
s=s.replace(marker,'''                    (0, react_jsx_runtime.jsx)(NightSidebarShortcuts, { wide }),
'''+marker,1)
marker='''children: [(0, react_jsx_runtime.jsx)("div", {
							className: SidebarRoot_module_css_default.footerActions,'''
assert s.count(marker)==1
s=s.replace(marker,'''children: [(0, react_jsx_runtime.jsx)(NightProfile, { wide }), (0, react_jsx_runtime.jsx)("div", {
							className: SidebarRoot_module_css_default.footerActions,''',1)
save(p,s)

p=PACKAGES/'dsh-client-ui-settings-general/lib/client.js';s=original(p)
marker='\t\t\tconst rows = useSections((s) => s);'
assert s.count(marker)==1
s=s.replace(marker,'''            (0, react.useEffect)(() => {
                const openRequested = event => { if (typeof event.detail?.id === "string") openSection(event.detail.id); };
                window.addEventListener("qcoderi:open-settings", openRequested);
                return () => window.removeEventListener("qcoderi:open-settings", openRequested);
            }, [openSection]);
'''+marker,1)
save(p,s)

p=PACKAGES/'dsh-client-ui-brand-official/lib/client.js';s=original(p)
s=s.replace('const inject = ["slots"];','const inject = ["slots", "layout", "sidebarRight"];')
marker='\t\tfunction apply(ctx) {'
assert s.count(marker)==1
s=s.replace(marker,marker+'''
            ctx.effect(() => {
                const navigate = event => {
                    const kind = event.detail?.kind;
                    if (kind === "agents" || kind === "tools" || kind === "resources") {
                        const id = { agents:"agent-presets", tools:"plugins", resources:"models" }[kind];
                        window.dispatchEvent(new CustomEvent("qcoderi:open-settings", { detail:{id} }));
                    } else if (kind === "chat") {
                        ctx.layout.selectPanel(null);
                        if (ctx.sidebarRight.isExpanded()) ctx.sidebarRight.toggleExpanded();
                    } else if (kind === "search") {
                        document.querySelector('button[aria-label="Поиск диалогов"]')?.click();
                    } else if (kind === "workspaces" || kind === "projects") {
                        document.querySelector('[role="tree"]')?.scrollIntoView({ block:"nearest" });
                        document.querySelectorAll('[role="treeitem"][aria-expanded="false"]').forEach(row => row.click());
                    } else if (kind === "files" || kind === "code" || kind === "terminal") {
                        try { ctx.sidebarRight.openTab(kind === "terminal" ? "terminal" : "files"); }
                        catch { document.querySelector('button[aria-label="Выбрать рабочую область"]')?.click(); }
                    }
                };
                window.addEventListener("qcoderi:navigate", navigate);
                return () => window.removeEventListener("qcoderi:navigate", navigate);
            }, "qcoderi: studio navigation");
''',1)
save(p,s)

p=BASE/'source/lib/main.js';s=original(p)
marker='''		minHeight: 600,
		show,'''
assert s.count(marker)==1
s=s.replace(marker,'''		minHeight: 600,
        ...(process.platform === "win32" ? {
            titleBarStyle: "hidden",
            titleBarOverlay: { color: "#080713", symbolColor: "#ded7ff", height: 40 },
            autoHideMenuBar: true
        } : {}),
		show,''',1)
save(p,s)

frontend=PACKAGES/'dsh-web-frontend/dist'
shutil.copy2(BASE/'assets/moonlight.css',frontend/'qcoderi-moonlight.css')
art = BASE/'assets/qcoderi-moonlit-elf.png'
if art.exists(): shutil.copy2(art, frontend/art.name)
p=frontend/'index.html';s=p.read_text(encoding='utf-8')
if 'qcoderi-moonlight.css' not in s:s=s.replace('</head>','  <link rel="stylesheet" href="./qcoderi-moonlight.css">\n  </head>')
save(p,s)
print('Moonlight Studio navigation, prompt suggestions and profile chrome installed')
