"""Apply the source-owned chat and Studio UI integration; safe to repeat."""
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
SOURCE = BASE / 'source'
PACKAGES = SOURCE / 'dsh/node_modules/@deepseek-ai'

def once(source, old, new):
    if new in source:
        return source
    if source.count(old) != 1:
        raise RuntimeError('Studio integration anchor changed: ' + old[:90])
    return source.replace(old, new, 1)

def asset(name):
    return (BASE / 'assets' / name).read_text(encoding='utf-8')

def apply():
    changed = []
    def save(path, content):
        if path.read_text(encoding='utf-8') != content:
            path.write_text(content, encoding='utf-8', newline='\n')
            changed.append(path.relative_to(SOURCE).as_posix())

    mode = asset('studio-mode.js')
    path = PACKAGES / 'dsh-client-ui-layout/lib/client.js'
    source = path.read_text(encoding='utf-8')
    start = source.index('function useStudioChat(') if 'function useStudioChat(' in source else source.index('function NightGlyph(')
    end = source.index('\n\t\t/** Subscribe to the main key', start)
    source = source.replace('clampWidth(sidebar, 264, 420)', 'clampWidth(sidebar, 240, 360)').replace('clampWidth(px, 264, 420)', 'clampWidth(px, 240, 360)')
    source = source.replace('sidebar: 280,', 'sidebar: 256,').replace('layoutInfo.sidebar === 0 ? 280 : layoutInfo.sidebar', 'layoutInfo.sidebar === 0 || layoutInfo.sidebar === 280 ? 256 : layoutInfo.sidebar').replace('d.layoutInfo.sidebar === 0 ? 280 : 0', 'd.layoutInfo.sidebar === 0 ? 256 : 0')
    # Recompute anchors after the width migration before inserting the layout asset.
    start = source.index('function useStudioChat(') if 'function useStudioChat(' in source else source.index('function NightGlyph(')
    end = source.index('\n\t\t/** Subscribe to the main key', start)
    save(path, source[:start] + mode + '\n' + asset('studio-navigation.js') + '\n' + source[end:])

    path = PACKAGES / 'dsh-client-ui-sidebar/lib/client.js'
    source = path.read_text(encoding='utf-8')
    start = source.index('function SidebarGlyph(') if 'function SidebarGlyph(' in source else source.index('function NightSidebarShortcuts(')
    end = source.index('\n\t\tfunction SidebarRoot(', start)
    source = source[:start] + asset('studio-sidebar.js') + '\n' + source[end:]
    source = source.replace('(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPanelLeftOutline16, {', '(0, react_jsx_runtime.jsx)(SidebarGlyph, { name: "collapse",')
    save(path, source)

    path = PACKAGES / 'dsh-client-ui-brand-official/lib/client.js'
    source = path.read_text(encoding='utf-8')
    if 'function installStudioActions(' not in source:
        start = source.index('            ctx.effect(() => {')
        end = source.index('}, "qcoderi: studio navigation");', start) + len('}, "qcoderi: studio navigation");')
        source = source[:start] + '            installStudioActions(ctx);' + source[end:]
        source = source.replace('const inject = ["slots", "layout", "sidebarRight"];', 'const inject = ["slots", "layout", "sidebarRight", "uiWorkspace"];')
        source = source.replace('\t\tfunction apply(ctx) {', asset('studio-actions.js') + '\n\t\tfunction apply(ctx) {', 1)
    else:
        start = source.index('function installStudioActions(')
        end = source.index('\n\t\tfunction apply(ctx)', start)
        source = source[:start] + asset('studio-actions.js') + source[end:]
    source=source.replace('const inject = ["slots", "layout", "sidebarRight", "uiWorkspace"];','const inject = ["slots", "layout", "sidebarRight", "uiWorkspace", "connection"];')
    source=once(source,'(0, react_jsx_runtime.jsx)("em", { children: "I" })]','(0, react_jsx_runtime.jsx)("em", { children: "I" }), (0, react_jsx_runtime.jsx)("span", { className: "qc-sidebar-version", title: "Версия оформления Moonlight", children: "v3.2" })]')
    if 'className: "qc-app-mark"' not in source:
        source=once(source,'height: size, fontSize: size < 35 ? 19 : 28 }, children: "Q"','height: size, fontSize: size < 35 ? 19 : 28 }, children: (0, react_jsx_runtime.jsx)("svg", { className: "qc-brand-glyph", viewBox: "0 0 24 24", "aria-hidden": true, children: (0, react_jsx_runtime.jsx)("use", { href: "./qcoderi-sidebar-glyphs.svg#brand" }) })')
    source=source.replace('(0, react_jsx_runtime.jsx)("svg", { className: "qc-brand-glyph", viewBox: "0 0 24 24", "aria-hidden": true, children: (0, react_jsx_runtime.jsx)("use", { href: "./qcoderi-sidebar-glyphs.svg#brand" }) })', '(0, react_jsx_runtime.jsx)("img", { className: "qc-app-mark", src: "./qcoderi-app.svg", alt: "" })')
    save(path, source)

    path = PACKAGES / 'dsh-client-ui-workspace/lib/client.js'
    source = path.read_text(encoding='utf-8')
    start = source.index('\t\t\tstartChat() {') if '\t\t\tstartChat() {' in source else source.index('\t\t\tstartSession(workspaceId) {')
    end = source.index('\n\t\t\tasync archiveSession(', start)
    methods = '''\t\t\tstartChat() {
                if (this.chatCreation) return this.chatCreation;
                const snapshot = this.sessions.list.getSnapshot();
                const current = snapshot.byId[snapshot.current];
                if (current?.blank && current.projectionValues?.agentPreset === 'qcoder-chat') {
                    this.openSession(current.id);
                    if (this.ctx.get('sidebarRight')?.isExpanded()) this.ctx.get('sidebarRight').toggleExpanded();
                    return Promise.resolve(current.id);
                }
                const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal]);
                this.chatCreation = this.sessions.create({ agentPreset: 'qcoder-chat' }).then(id => {
                    if (!navigation.aborted) {
                        document.body.dataset.qcRequestedMode = 'chat';
                        window.dispatchEvent(new CustomEvent('qcoderi:mode', { detail:{mode:'chat'} }));
                        this.openSession(id);
                        if (this.ctx.get('sidebarRight')?.isExpanded()) this.ctx.get('sidebarRight').toggleExpanded();
                    }
                    return id;
                }).finally(() => { this.chatCreation = undefined; });
                return this.chatCreation;
            }
            startProject() {
                document.body.dataset.qcRequestedMode = 'project';
                window.dispatchEvent(new CustomEvent('qcoderi:mode', { detail:{mode:'project'} }));
                const workspace = this.workspaces.list.getSnapshot();
                const sessions = this.sessions.list.getSnapshot();
                const target = workspace.items.find(item => item.sessionIds.includes(sessions.current))?.workspaceId
                    ?? recentWorkspace(workspace.items, sessions.byId);
                if (target !== undefined) this.openWorkspace(target).catch(error => window.dispatchEvent(new CustomEvent('qcoderi:navigation-error', {detail:{message:error.message}})));
                else { this.sessions.clear(); this.ctx.layout.selectPanel(null); }
                if (this.ctx.get('sidebarRight')?.isExpanded()) this.ctx.get('sidebarRight').toggleExpanded();
            }
            startSession(workspaceId) {
                if (workspaceId === undefined) {
                    this.startChat().catch(error => window.dispatchEvent(new CustomEvent('qcoderi:navigation-error', {detail:{message:error.message}})));
                } else this.openWorkspace(workspaceId).catch(reason => console.warn('new project session failed:', reason));
            }'''
    source = source[:start] + methods + source[end:]
    old_start = '\t\t\t\t\tconst target = recentWorkspace(workspace.items, sessions.byId);'
    if old_start in source:
        start = source.index(old_start)
        end = source.index('\n\t\t\t\t};', start)
        source = source[:start] + '''                    initial = "connecting";
                    this.startChat().then(() => { initial = "done"; }, reason => {
                        initial = "done";
                        window.dispatchEvent(new CustomEvent('qcoderi:navigation-error', {detail:{message:reason.message}}));
                    });''' + source[end:]
    if 'function useStudioChat(' not in source:
        marker = '\t\tfunction WorkspaceBrowser('
        source = once(source, marker, mode + '\n' + marker)
    source = once(source, 'const home = useHostInfo((info) => info.home);',
                  'const chatMode = useStudioChat(useSessions);\n            const home = useHostInfo((info) => info.home);')
    source = once(source, 'children: groupBy === "flat" ? t("section.sessions") : t("section.workspaces")',
                  'children: chatMode ? "Диалоги" : groupBy === "flat" ? t("section.sessions") : t("section.workspaces")')
    source = once(source, '}) : groupBy === "flat" ? (0, react_jsx_runtime.jsx)(FlatList, {',
                  '}) : chatMode || groupBy === "flat" ? (0, react_jsx_runtime.jsx)(FlatList, {')
    source = once(source, 'sessionIds: orderedFlatSessionIds,',
                  'sessionIds: chatMode ? orderedFlatSessionIds.filter(id => list.byId[id]?.projectionValues?.agentPreset === "qcoder-chat") : orderedFlatSessionIds,')
    source = once(source, 'children: [wide && (0, react_jsx_runtime.jsx)(ViewOptionsMenu, {',
                  'children: [wide && !chatMode && (0, react_jsx_runtime.jsx)(ViewOptionsMenu, {')
    source = once(source, '}), directoryFlowAvailable && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {',
                  '}), !chatMode && directoryFlowAvailable && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {')
    # Keep the full mixed-mode order when a chat-only list is rearranged.
    source = source.replace('!row.blank && (0, react_jsx_runtime.jsx)("span", {\n\t\t\t\t\t\t\tclassName: Rows_module_css_default.rowActions,', '(0, react_jsx_runtime.jsx)("span", {\n\t\t\t\t\t\t\tclassName: Rows_module_css_default.rowActions,')
    source = once(source, 'setSessionOrder: saveSessionOrder,\n\t\t\t\t\t\t\trevealSessionId,',
                  'setSessionOrder: chatMode ? (key, order) => { const queued = [...order]; const selected = new Set(order); saveSessionOrder(key, orderedFlatSessionIds.map(id => selected.has(id) ? queued.shift() : id)); } : saveSessionOrder,\n\t\t\t\t\t\t\trevealSessionId,')
    helper_start = source.find('function QcSessionGlyph(')
    session_start = source.index('function SessionNodeItem(')
    if helper_start >= 0:
        source = source[:helper_start] + asset('studio-session-glyph.js') + '\n\t\t' + source[session_start:]
    else:
        source = source[:session_start] + asset('studio-session-glyph.js') + '\n\t\t' + source[session_start:]
    source = once(source, '(0, react_jsx_runtime.jsx)("span", {\n\t\t\t\t\t\t\tclassName: Rows_module_css_default.title,\n\t\t\t\t\t\t\tchildren: title', 'react.createElement(QcSessionGlyph, {node}), (0, react_jsx_runtime.jsx)("span", {\n\t\t\t\t\t\t\tclassName: Rows_module_css_default.title,\n\t\t\t\t\t\t\tchildren: title')
    save(path, source)

    path = PACKAGES / 'dsh-client-ui-conversation/lib/client.js'
    source = path.read_text(encoding='utf-8')
    source = source.replace(', react.createElement(WorkbenchPanel,{sessionId,chatMode,onDictation:text=>inputActions.setDraft((inputState?.draft??"")+((inputState?.draft)?"\\n":"")+text)})', '')
    start = source.index('function useStudioChat(') if 'function useStudioChat(' in source else source.index('function NightFeatureIcon(')
    end = source.index('\n\t\t//#endregion', start)
    source = source[:start] + mode + '\n' + asset('studio-hero.js') + '\n' + asset('studio-media-state.js') + '\n' + asset('studio-activity.js') + source[end:]
    if 'const selectedModel = useSessions(state => state.byId[sessionId]' not in source and 'const [selectedModel, setSelectedModel]' not in source:
        source = once(source, 'const pendingInteraction = useSessionPendingInteraction((snapshot) => sessionId === void 0 ? void 0 : snapshot.get(sessionId));',
                      'const chatMode = useStudioChat(useSessions);\n            const pendingInteraction = useSessionPendingInteraction((snapshot) => sessionId === void 0 ? void 0 : snapshot.get(sessionId));')
    if 'const [selectedModel, setSelectedModel]' not in source:
        source = once(source, 'const chatMode = useStudioChat(useSessions);\n            const pendingInteraction',
                      'const chatMode = useStudioChat(useSessions);\n            const selectedModel = useSessions(state => state.byId[sessionId]?.projectionValues?.modelSelection?.next);\n            const videoMode = selectedModel?.provider === "niceai" && /^(?:seedance|kling)(?:[-/]|$)/i.test(selectedModel.model);\n            const pendingInteraction')
        source = once(source, 'const selectedModel = useSessions(state => state.byId[sessionId]?.projectionValues?.modelSelection?.next);', '''const [selectedModel, setSelectedModel] = react.useState(null);
            react.useEffect(() => {
                const receive = event => { if (event.detail?.sessionId === sessionId) setSelectedModel(event.detail.selection); };
                window.addEventListener('qcoderi:model-selection', receive);
                setSelectedModel(window.__qcoderiModelSelections?.get(sessionId) ?? null);
                return () => window.removeEventListener('qcoderi:model-selection', receive);
            }, [sessionId]);''')
    source=once(source,'const videoMode = selectedModel?.provider === "niceai" && /^(?:seedance|kling)(?:[-/]|$)/i.test(selectedModel.model);', '''const videoMode = selectedModel?.provider === "niceai" && /^(?:seedance|kling)(?:[-/]|$)/i.test(selectedModel.model);
            const [videoSeconds,setVideoSeconds]=react.useState(5),[videoSaving,setVideoSaving]=react.useState(false);
            react.useEffect(()=>{
                setVideoSeconds(5);setVideoSaving(false);
                const receive=event=>{if(event.detail?.sessionId===sessionId){setVideoSeconds(event.detail.seconds);setVideoSaving(event.detail.saving);}};
                window.addEventListener('qcoderi:video-options',receive);
                return()=>window.removeEventListener('qcoderi:video-options',receive);
            },[sessionId]);''')
    if 'const heroWorkspaceRow = chatMode ?' not in source:
        source = once(source, 'const heroWorkspaceRow = (0, react_jsx_runtime.jsxs)("div", {',
                      'const heroWorkspaceRow = chatMode ? react.createElement("div", {className:"qc-chat-context"}, react.createElement(NightFeatureIcon, {kind:"chat",size:14}), "Обычный чат", react.createElement("span", null, "Без проекта")) : (0, react_jsx_runtime.jsxs)("div", {')
    if 'videoMode ? "NiceAI · "+videoSeconds+" с"' not in source:
        source = once(source, '"Обычный чат", react.createElement("span", null, "Без проекта"))',
                      'videoMode ? "Генерация видео" : "Обычный чат", react.createElement("span", null, videoMode ? "NiceAI · 5 с" : "Без проекта"))')
    source=source.replace('videoMode ? "NiceAI · 5 с" : "Без проекта"','videoMode ? "NiceAI · "+videoSeconds+" с" : "Без проекта"')
    source = once(source, 'const inert = sessionId === void 0 || hero && chipTitle === void 0;',
                  'const inert = sessionId === void 0 || !chatMode && hero && chipTitle === void 0;')
    if '...(videoMode && videoSaving' not in source:
        source = once(source, 'variant: hero ? "hero" : "composer",',
                      'variant: hero ? "hero" : "composer",\n                ...(chatMode ? { placeholder:"Напиши сообщение…" } : {}),')
    source=source.replace('...(chatMode ? { placeholder:"Напиши сообщение…" } : {}),','...(chatMode ? { placeholder:videoMode ? "Опиши сцену…" : "Напиши сообщение…" } : {}),\n                ...(videoMode && videoSaving ? {disabled:true} : {}),')
    if 'videoMode ? "Опиши видео…"' not in source:
        source = once(source, '} : hero ? { placeholder: t("placeholder.hero") } : {}',
                      '} : hero ? { placeholder: chatMode ? "Напиши сообщение…" : t("placeholder.hero") } : {}')
    if 'onSuggest, chatMode, videoMode,' not in source:
        source = once(source, '                        onSuggest,\n\t\t\t\t\t\tt,', '                        onSuggest, chatMode,\n\t\t\t\t\t\tt,')
    if 'onSuggest, chatMode, videoMode, videoSeconds,' not in source:
        source = once(source, '                        onSuggest, chatMode,\n\t\t\t\t\t\tt,', '                        onSuggest, chatMode, videoMode,\n\t\t\t\t\t\tt,')
    if 'jsx)(NightQuickCards, { onSuggest, chatMode, videoMode })' not in source:
        source = once(source, 'jsx)(NightQuickCards, { onSuggest })', 'jsx)(NightQuickCards, { onSuggest, chatMode })')
    source = once(source, 'jsx)(NightQuickCards, { onSuggest, chatMode })', 'jsx)(NightQuickCards, { onSuggest, chatMode, videoMode })')
    source = source.replace('chatMode ? "Напиши сообщение…" : t("placeholder.hero")', 'videoMode ? "Опиши видео…" : chatMode ? "Напиши сообщение…" : t("placeholder.hero")') if 'videoMode ? "Опиши видео…"' not in source else source
    source = source.replace('placeholder:videoMode ? "Опиши сцену…" : "Напиши сообщение…"', 'placeholder:videoMode ? "Опиши сцену…" : hero ? "Опиши задачу — код, анализ, генерация, проект или идею. Я помогу начать быстро и красиво." : "Напиши сообщение…"')
    source = source.replace('hero ? { placeholder: videoMode ? "Опиши видео…" : chatMode ? "Напиши сообщение…" : t("placeholder.hero") }', 'hero ? { placeholder: videoMode ? "Опиши видео…" : chatMode ? "Опиши задачу — код, анализ, генерация, проект или идею. Я помогу начать быстро и красиво." : t("placeholder.hero") }')
    # Mark the actual conversation subtree, including its permission/model controls.
    source = once(source, 'className: ConversationRoot_module_css_default.body,',
                  'className: ConversationRoot_module_css_default.body,\n                "data-qc-conversation": chatMode ? "chat" : "project",')
    source=source.replace('!hero && react.createElement(StudioActivity,','react.createElement(StudioActivity,')
    if 'renderSlot("conversation.session", {}), composerSeat]' in source:
        source=source.replace('react.createElement(StudioActivity, {sessionId, running:session?.running ?? false, videoMode, chatMode}),','videoMode && react.createElement(VideoOptions, {sessionId,running:session?.running ?? false}),',1)
    source=once(source,'\t\t\t\t\tinputBar,','\t\t\t\t\tvideoMode && react.createElement(VideoOptions, {sessionId,running:session?.running ?? false}),\n\t\t\t\t\tinputBar,')
    if 'QCODERI_INPUT_ISOLATION' not in source:
        source=once(source,'renderSlot("conversation.session", {}), composerSeat]','renderSlot("conversation.session", {}), react.createElement(StudioActivity, {sessionId, running:session?.running ?? false, videoMode, chatMode}), composerSeat]')
    source=source.replace('onSuggest, chatMode, videoMode,\n','onSuggest, chatMode, videoMode, videoSeconds,\n')
    if 'QCODERI_INPUT_ISOLATION' not in source:
        source=once(source,'const inputBar = renderSlot("conversation.composer.bar", {','''const repeatVideo=async job=>{
                if(session?.running)throw Error('Дождись окончания текущего ответа.');
                if(!job.prompt)throw Error('Описание этого видео не найдено в истории.');
                if(!window.__qcoderiPrepareVideoRepeat)throw Error('Параметры видео пока недоступны.');
                await window.__qcoderiPrepareVideoRepeat(sessionId,job);
                inputActions.setDraft(job.prompt);
                requestAnimationFrame(()=>document.querySelector('[contenteditable="true"]')?.focus());
            };
            const inputBar = renderSlot("conversation.composer.bar", {''')
    source=once(source,'return (0, react_jsx_runtime.jsxs)("div", {\n\t\t\t\tclassName: ConversationRoot_module_css_default.body,','''return (0, react_jsx_runtime.jsxs)(StudioMediaRoot, {
                mediaSessionId:sessionId,mediaRunning:session?.running??false,mediaVideoMode:videoMode,mediaModel:selectedModel,mediaSeconds:videoSeconds,mediaOnRepeat:repeatVideo,
\t\t\t\tclassName: ConversationRoot_module_css_default.body,''')
    source=once(source,'exports.Config = Config;','exports.useStudioMedia=useStudioMedia;\n        exports.StudioVideoReply=StudioVideoReply;\n        exports.Config = Config;')
    start=source.index('function TodoPanel({')
    end=source.index('\n\t\t/** Renders the current todo projection',start)
    source=source[:start]+asset('studio-tasks.js')+source[end:]
    save(path, source)

    # Sidebar MCP opens the real plugin inventory with an MCP search applied.
    path = PACKAGES / 'dsh-client-ui-settings-plugins/lib/client.js'
    source = path.read_text(encoding='utf-8')
    source = once(source, 'const [activeId, setActiveId] = (0, react.useState)();', '''const [activeId, setActiveId] = (0, react.useState)(() => window.__qcoderiPluginTarget?.tab);
            react.useEffect(() => {
                const receive = () => setActiveId(window.__qcoderiPluginTarget?.tab);
                window.addEventListener('qcoderi:plugin-target', receive);
                return () => window.removeEventListener('qcoderi:plugin-target', receive);
            }, []);''')
    save(path, source)

    path = PACKAGES / 'dsh-client-ui-settings-plugin-inventory/lib/client.js'
    source = path.read_text(encoding='utf-8')
    source = once(source, 'const [query, setQuery] = (0, react.useState)("");', '''const [query, setQuery] = (0, react.useState)(() => window.__qcoderiPluginTarget?.query ?? '');
            react.useEffect(() => {
                const receive = () => setQuery(window.__qcoderiPluginTarget?.query ?? '');
                window.addEventListener('qcoderi:plugin-target', receive);
                return () => window.removeEventListener('qcoderi:plugin-target', receive);
            }, []);''')
    save(path, source)

    path = PACKAGES / 'dsh-client-ui-model-selection/lib/client.js'
    source = path.read_text(encoding='utf-8')
    source = once(source, 'function ModelSelect({ locked, available, directory, load, select, t }) {',
                  'function ModelSelect({ sessionId, locked, available, directory, load, select, t }) {')
    source = once(source, 'const state = (0, react.useSyncExternalStore)((fn) => directory.subscribe(fn), () => directory.getSnapshot());', '''const state = (0, react.useSyncExternalStore)((fn) => directory.subscribe(fn), () => directory.getSnapshot());
            react.useEffect(() => {
                const selections = window.__qcoderiModelSelections ??= new Map();
                selections.set(sessionId, state.current);
                window.dispatchEvent(new CustomEvent('qcoderi:model-selection', {detail:{sessionId,selection:state.current}}));
                return () => { if (selections.get(sessionId) === state.current) selections.delete(sessionId); };
            }, [sessionId, state.current?.provider, state.current?.model]);''')
    source = once(source, 'available,\n\t\t\t\t\t\t\tdirectory: directory.store,',
                  'available, sessionId,\n\t\t\t\t\t\t\tdirectory: directory.store,')
    save(path, source)

    path = PACKAGES / 'dsh-api-session-controller/lib/client.js'
    source = path.read_text(encoding='utf-8')
    source = once(source, 'const shared = opts.sessionId === void 0 ? {} : { sessionId: opts.sessionId };',
                  'const shared = { ...(opts.sessionId === void 0 ? {} : {sessionId:opts.sessionId}), ...(opts.agentPreset === void 0 ? {} : {agentPreset:opts.agentPreset}) };')
    source = once(source, 'displayTitle: displayTitleOf(entry.title, entry.cwd, entry.sessionId),',
                  'displayTitle: !entry.title && entry.projectionValues?.agentPreset === "qcoder-chat" ? "Новый разговор" : displayTitleOf(entry.title, entry.cwd, entry.sessionId),')
    save(path, source)

    path = PACKAGES / 'dsh-client-ui-chat/lib/client.js'
    source = path.read_text(encoding='utf-8')
    start = source.index('\t\tfunction assistantText(')
    end = source.index('\n\t\t//#endregion', start)
    text_function = '\t\tfunction assistantText(blocks) {\n            return blocks.flatMap(block => block.kind === "text" ? [block.text] : []).join("");\n        }\n'
    source = source[:start] + text_function + asset('video-preview.js') + source[end:]
    source=source.replace('children: [(0, react_jsx_runtime.jsx)(NiceAiVideos, {blocks:closing.blocks}), tail, (0, react_jsx_runtime.jsx)(MessageIconActions, {','children: [tail, (0, react_jsx_runtime.jsx)(MessageIconActions, {')
    source=once(source,'let react = require("react");','let react = require("react");\n        const qcMedia=require("@deepseek-ai/dsh-client-ui-conversation");')
    source=once(source,'kind: "user",\n\t\t\t\t\tseq: event.seq,','kind: "user",\n                    messageId:event.data.id,\n\t\t\t\t\tseq: event.seq,')
    source=once(source,'const order = useChat((s) => s.order);','const mediaContext=qcMedia.useStudioMedia();\n            const order = useChat((s) => s.order);')
    source=once(source,'(0, react_jsx_runtime.jsx)(ChatNodeList, {\n\t\t\t\t\t\t\t\t\torder,','(0, react_jsx_runtime.jsx)(VideoChatNodes, {\n                                    sessionId,nodeStore,\n\t\t\t\t\t\t\t\t\torder,')
    source=source.replace('running && (0, react_jsx_runtime.jsx)(TurnStatus, {','running && !mediaContext.videoMode && (0, react_jsx_runtime.jsx)(TurnStatus, {')
    source=once(source,'const node = useChatNode(nodeKey);','const videoMedia=qcMedia.useStudioMedia();\n            const node = useChatNode(nodeKey);')
    source=once(source,'if (routedNode === void 0 || owner === null) return null;','''if (routedNode === void 0 || owner === null) return null;
            if(videoMedia.videoTurns?.has(turn)){
                if(["system-prompt","turn-tail","turn-process","model-retry"].includes(routedNode.kind))return null;
                if(routedNode.kind==="context"&&routedNode.data.source?.plugin==="model-selection")return null;
                if(routedNode.kind==="assistant-step"&&/^Генерирую видео ·/.test(assistantText(routedNode.data.blocks??[]).trim()))return null;
            }''')
    source = source.replace('["system-prompt","turn-tail","turn-process","model-retry","turn-error"]',
                            '["system-prompt","turn-tail","turn-process","model-retry"]')
    start=source.index('const UserMessageNodeView =')
    end=source.index('/** Injected-context keyed Chat renderer.',start)
    segment=source[start:end]
    if 'qcMedia.StudioVideoReply' not in segment:
        segment=segment.replace('return (0, react_jsx_runtime.jsx)(UserStyleBubble, {','const bubble = (0, react_jsx_runtime.jsx)(UserStyleBubble, {',1)
        segment=segment.replace('\n\t\t\t});\n\t\t});','\n\t\t\t});\n            return react.createElement("div",{className:"qc-video-message","data-qc-message-id":data.messageId},bubble,react.createElement(qcMedia.StudioVideoReply,{messageId:data.messageId,time:data.time}));\n\t\t});',1)
        source=source[:start]+segment+source[end:]
    save(path, source)

    path=PACKAGES/'dsh-desktop-host/lib/index.js'
    source=path.read_text(encoding='utf-8')
    if 'fetchRequest,' not in source:
        source=once(source,'const response = url.pathname === DESKTOP_STREAM_PATH ? await streams.fetch(request)', 'const response = url.pathname.startsWith("/qcoderi-media/") ? await (ctx.get("qcoderMedia")?.fetch(request) ?? Promise.resolve(new Response(null,{status:503}))) : url.pathname === DESKTOP_STREAM_PATH ? await streams.fetch(request)')
    save(path,source)

    path = SOURCE / 'lib/main.js'
    source = path.read_text(encoding='utf-8')
    source = once(source, '\t\tshow,\n\t\twebPreferences:', '\t\tshow,\n        backgroundColor: "#0b0b16",\n\t\twebPreferences:')
    source = once(source, 'const window = createWindow(appPreload, true);\n\t\tmainWindow = window;',
                  'const window = createWindow(appPreload, false);\n        window.once("ready-to-show", () => { if (!window.isDestroyed() && process.env.QCODERI_TEST_HIDDEN !== "1") window.show(); });\n\t\tmainWindow = window;')
    save(path, source)
    return changed

if __name__ == '__main__':
    for path in apply():
        print(path)
