"""Apply the native-window chat changes to the bundled runtime and clients."""
from pathlib import Path
import shutil

BASE = Path(__file__).resolve().parents[1]
PACKAGES = BASE / 'source/dsh/node_modules/@deepseek-ai'


def patch(name, path, changes):
    target = PACKAGES / name / 'lib' / path
    source = target.read_text(encoding='utf-8')
    for before, after in changes:
        if after in source or (before.startswith('\t\t\tconst showClock =') and 'function QcTurnActivity(' in source):
            continue
        if source.count(before) != 1:
            raise RuntimeError(f'{name} patch anchor changed: {before[:90]!r}')
        source = source.replace(before, after, 1)
    target.write_text(source, encoding='utf-8', newline='\n')


def apply():
    shutil.copyfile(BASE / 'assets/request-context.js', PACKAGES / 'dsh-agent-loop/lib/qcoderi-request-context.js')
    patch('dsh-agent-loop', 'index.js', [
        ('import { isModelIdentityQuestion, modelIdentityStream } from "./qcoderi-model-identity.js";',
         'import { compactRequestContext } from "./qcoderi-request-context.js";\nimport { isModelIdentityQuestion, modelIdentityStream } from "./qcoderi-model-identity.js";'),
        ('const boundaryMessages = session.deriveMessages();',
         'const boundaryMessages = compactRequestContext(session.deriveMessages());'),
        ('\t\tconst assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal));',
         '\t\ttry {\n\t\t\tconst assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal));'),
        ('''\t\tsignal.throwIfAborted();
\t\tconst sections = renderContextSections(assembly);
\t\tconst context = this.runtimeContext.project(joinContextSections(sections), sections);
\t\tconst decision = await this.dispatch.waterfall("agent/pre-step", {
\t\t\tmessages: claimed,
\t\t\t...position,
\t\t\tsignal
\t\t}, () => Promise.resolve({
\t\t\tkind: "enter",
\t\t\tmessages: context === void 0 ? claimed : [...claimed, context]
\t\t}));
\t\tsignal.throwIfAborted();
\t\tif (decision.kind === "reject") return decision;
\t\treturn {
\t\t\t...decision,
\t\t\tassembly
\t\t};''', '''\t\t\tsignal.throwIfAborted();
\t\t\tconst sections = renderContextSections(assembly);
\t\t\tconst context = this.runtimeContext.project(joinContextSections(sections), sections);
\t\t\tconst decision = await this.dispatch.waterfall("agent/pre-step", {
\t\t\t\tmessages: claimed,
\t\t\t\t...position,
\t\t\t\tsignal
\t\t\t}, () => Promise.resolve({
\t\t\t\tkind: "enter",
\t\t\t\tmessages: context === void 0 ? claimed : [...claimed, context]
\t\t\t}));
\t\t\tsignal.throwIfAborted();
\t\t\tif (decision.kind === "reject") this.recordUnsentInput(claimed);
\t\t\treturn decision.kind === "reject" ? decision : { ...decision, assembly };
\t\t} catch (error) {
\t\t\tthis.recordUnsentInput(claimed);
\t\t\tthrow error;
\t\t}'''),
        ('\t/** Whether the assembled tool schemas differ from the logged request header\'s. */',
         '''\t/** Keep consumed input in the transcript when no provider request could start. */
\trecordUnsentInput(messages) {
\t\tconst pending = new Set([...this.inbox.nextStep, ...this.inbox.nextTurn].map(message => message.id));
\t\tfor (const message of messages) if (message.source.kind === "user" && !pending.has(message.id)) {
\t\t\tthis.session.append("user/message", message, { surfaceOp: "append" });
\t\t}
\t}
\t/** Whether the assembled tool schemas differ from the logged request header's. */'''),
        ('''\t\t\tconst { config, preparedCall } = localIdentity
\t\t\t\t? { config: { provider: this.options.provider || "", model: this.options.model || "" } }
\t\t\t\t: await this.prepareRequest(turn, step, signal);''', '''\t\t\tlet config, preparedCall;
\t\t\ttry {
\t\t\t\tif (localIdentity) {
\t\t\t\t\tconst latestRoute = this.session.requestHeader()?.config;
\t\t\t\t\tconfig = await this.dispatch.waterfall("agent/request", { turn, step, signal }, async () => ({
\t\t\t\t\t\tprovider: latestRoute?.provider ?? this.options.provider ?? "",
\t\t\t\t\t\tmodel: latestRoute?.model ?? this.options.model ?? ""
\t\t\t\t\t}));
\t\t\t\t} else ({ config, preparedCall } = await this.prepareRequest(turn, step, signal));
\t\t\t} catch (error) {
\t\t\t\tif (firstAttempt) this.recordUnsentInput(decision.messages);
\t\t\t\tthrow error;
\t\t\t}'''),
    ])

    source = (BASE / 'assets/chat-window.js').read_text(encoding='utf-8').rstrip()
    chat = PACKAGES / 'dsh-client-ui-chat/lib/client.js'
    client = chat.read_text(encoding='utf-8')
    begin = '\t\tconst qcSameModel ='
    end = '\t\t/** Turn-level model activity label retained across first-token, tool, and streaming phases. */'
    if begin in client:
        client = client[:client.index(begin)] + client[client.index(end):]
        chat.write_text(client, encoding='utf-8', newline='\n')
    patch('dsh-client-ui-chat', 'client.js', [
        ('''\t\t\tif (match.event.type !== "turn/end" || match.event.data.reason.kind !== "error") return void 0;
\t\t\tconst failure = match.event.data.reason.error;''', '''\t\t\tif (match.event.type !== "turn/end") return void 0;
\t\t\tif (match.event.data.reason.kind === "interrupted") return {
\t\t\t\tseq: match.event.seq, time: match.event.time, interrupted: true,
\t\t\t\tmessage: "Предыдущий ход прервался. Сохранённые сообщения и результаты инструментов доступны в этом чате."
\t\t\t};
\t\t\tif (match.event.data.reason.kind !== "error") return void 0;
\t\t\tconst failure = match.event.data.reason.error;'''),
        ('''\t\t\t\tif (event.type === "turn/end" && event.data.reason.kind === "error") return {''',
         '''\t\t\t\tif (event.type === "turn/end" && ["error", "interrupted"].includes(event.data.reason.kind)) return {'''),
        ('''\t\t\t\t\tmessage: failure.message,
\t\t\t\t\t...failure.code === void 0 ? {} : { code: failure.code }''',
         '''\t\t\t\t\tmessage: failure.message,
\t\t\t\t\tinterrupted: failure.interrupted,
\t\t\t\t\t...failure.code === void 0 ? {} : { code: failure.code }'''),
        ('''\t\tfunction TurnErrorItem({ node, t }) {
\t\t\treturn''',
         '''\t\tfunction TurnErrorItem({ node, t }) {
\t\t\tif (node.interrupted) {
\t\t\t\treturn react.createElement("div", { className: "qc-interrupted", role: "status" },
\t\t\t\t\treact.createElement("strong", null, "Ход прервался"),
\t\t\t\t\treact.createElement("span", null, node.message));
\t\t\t}
\t\t\treturn'''),
        ('if (!state.hidden || current === void 0 || current === null) return null;',
         'if (current == null) return null; // A retired stream keeps its node key with hidden visibility.'),
        ('''\t\t\t\tif (turn === void 0 || data === void 0) return null;
\t\t\t\tconst current = context.current.get("chat");''', '''\t\t\t\tconst current = context.current.get("chat");
\t\t\t\tif (turn === void 0 || data === void 0) return current == null ? null : { ...current, visibility: "hidden" };'''),
        ('\t\t/** Turn-level model activity label retained across first-token, tool, and streaming phases. */',
         source + '\n\t\t/** Turn-level model activity label retained across first-token, tool, and streaming phases. */'),
        ('''\t\t\tconst showClock = elapsedMs >= 15e3;
\t\t\treturn (0, react_jsx_runtime.jsxs)("div", {
\t\t\t\tclassName: ChatView_module_css_default.turnStatus,
\t\t\t\trole: "status",
\t\t\t\t"aria-live": "polite",
\t\t\t\tchildren: [t("chat.deepDiving"), showClock && (0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\tclassName: ChatView_module_css_default.turnStatusClock,
\t\t\t\t\t"aria-hidden": true,
\t\t\t\t\tchildren: formatRunDuration(elapsedMs, t)
\t\t\t\t})]
\t\t\t});''', '''\t\t\treturn react.createElement("div", { className: "qc-running-status", role: "status" },
\t\t\t\treact.createElement("span", { className: "qc-running-pulse", "aria-hidden": true }),
\t\t\t\treact.createElement("span", null, "Выполняю задачу"),
\t\t\t\treact.createElement("span", { className: "qc-running-elapsed", "aria-hidden": true }, formatRunDuration(elapsedMs, t)));'''),
        ('function TurnStatus({ startTime, t }) {',
         '''function TurnStatus({ startTime, approval, t }) {
\t\t\treturn react.createElement(QcTurnActivity, { key: approval?.key ?? "task", startTime, approval, t });
\t\t}
\t\tfunction QcTurnActivity({ startTime, approval, t }) {'''),
        ('''\t\t\tconst anchor = startTime ?? mountedAt;''',
         '''\t\t\tconst anchor = approval ? mountedAt : startTime ?? mountedAt;'''),
        ('''\t\t\treturn react.createElement("div", { className: "qc-running-status", role: "status" },
\t\t\t\treact.createElement("span", { className: "qc-running-pulse", "aria-hidden": true }),
\t\t\t\treact.createElement("span", null, "Выполняю задачу"),''',
         '''\t\t\tconst showApproval = () => {
\t\t\t\tconst panel = Array.from(document.querySelectorAll("[data-approval-key]")).find(node => node.dataset.approvalKey === approval.key);
\t\t\t\tpanel?.scrollIntoView({ block: "nearest" });
\t\t\t\tpanel?.querySelector("button:not([disabled])")?.focus({ preventScroll: true });
\t\t\t};
\t\t\treturn react.createElement("div", { className: "qc-running-status", role: "status", "data-phase": approval ? "approval" : "working" },
\t\t\t\treact.createElement("span", { className: "qc-running-pulse", "aria-hidden": true }),
\t\t\t\tapproval
\t\t\t\t\t? react.createElement("button", { type: "button", onClick: showApproval }, "Ожидаю разрешения")
\t\t\t\t\t: react.createElement("span", null, "Выполняю задачу"),'''),
        ('useTranscriptView, useProjection, t }) {',
         'useTranscriptView, useProjection, pendingInteractions, t }) {'),
        ('\t\t\tconst openState = useSession((s) => s.openState);',
         '''\t\t\tconst approval = react.useSyncExternalStore(pendingInteractions.subscribe,
\t\t\t\t() => pendingInteractions.getSnapshot().get(sessionId)?.kind === "approval" ? pendingInteractions.getSnapshot().get(sessionId) : undefined);
\t\t\tconst openState = useSession((s) => s.openState);'''),
        ('\t\t\t\t\t\t\t\t\tstartTime: runningTurnStart,',
         '\t\t\t\t\t\t\t\t\tstartTime: runningTurnStart, approval,'),
        ('\t\t\t\t\t\t\thooks: { transcriptView: transcriptView.mode },',
         '\t\t\t\t\t\t\tpendingInteractions: ctx.uiSession.pendingInteractions,\n\t\t\t\t\t\t\thooks: { transcriptView: transcriptView.mode },'),
        ('\t\t\tctx.uiConversation.events.register(messageDefinition);',
         '\t\t\tctx.uiConversation.events.register(messageDefinition);\n\t\t\tctx.uiConversation.events.register(qcModelActivityDefinition);'),
        ('\t\tconst TURN_PROCESS_INDEPENDENT_KINDS = new Set([\n',
         '\t\tconst TURN_PROCESS_INDEPENDENT_KINDS = new Set([\n\t\t\t"qc-model-activity",\n'),
        ('\t\tfunction registerChatNodeRenderers(ctx) {',
         '''\t\tfunction registerChatNodeRenderers(ctx) {
\t\t\tctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
\t\t\t\tname: "conversation.chat.node", key: "qc-model-activity", locale: NS
\t\t\t}, QcModelActivity));'''),
        ('\t\t\tconst assistantActions = messageId === void 0 ? null : renderSlot("conversation.chat.assistant-actions", { messageId });',
         '''\t\t\tconst assistantActions = react.createElement(react.Fragment, null,
\t\t\t\tmessageId === void 0 ? null : renderSlot("conversation.chat.assistant-actions", { messageId }),
\t\t\t\treact.createElement(QcReadAloud, { text: assistantText(closing.blocks) }));'''),
        ('\t\t\tconst visibleSubmissions = (0, react.useMemo)(() => {',
         '''\t\t\tconst queuedMessages = react.useMemo(() => inbox.filter(item => item.placement === "queued"), [inbox]);
\t\t\tconst visibleSubmissions = (0, react.useMemo)(() => {'''),
        ('submission.placement !== "queued" && !observed.has(submission.requestId)',
         '!observed.has(submission.requestId)'),
        ('\t\t\t\t\t\t\t\tpendingSteering.map((item)',
         '''\t\t\t\t\t\t\t\tqueuedMessages.map(item => react.createElement("div", { key: item.id, className: "qc-queued-message" },
\t\t\t\t\t\t\t\t\treact.createElement(PendingSteeringBubble, { content: item.content, renderMessageImages, t }),
\t\t\t\t\t\t\t\t\treact.createElement("span", null, "В очереди"))),
\t\t\t\t\t\t\t\tpendingSteering.map((item)'''),
        ('\t\t\tconst lastSubmissionId = visibleSubmissions[visibleSubmissions.length - 1]?.requestId ?? null;',
         '''\t\t\tconst lastSubmissionId = visibleSubmissions[visibleSubmissions.length - 1]?.requestId
\t\t\t\t?? queuedMessages[queuedMessages.length - 1]?.id ?? null;'''),
    ])

    patch('dsh-client-ui-model-selection', 'client.js', [
        ('}, [sessionId, state.current?.provider, state.current?.model]);',
         '}, [sessionId, state.current?.provider, state.current?.model, state.current?.reasoningEffort]);'),
    ])
    patch('dsh-goal-round-driver', 'index.js', [
        ('''\t\t\t\tcase "turn/end":
\t\t\t\t\tif (event.data.reason.kind === "max-tokens") {''', '''\t\t\t\tcase "turn/end":
\t\t\t\t\tif (event.data.reason.kind === "error" && ["CONTENT_POLICY", "PROVIDER_NO_RETRY"].includes(event.data.reason.error?.code)) {
\t\t\t\t\t\tdisarm(state);
\t\t\t\t\t\treturn;
\t\t\t\t\t}
\t\t\t\t\tif (event.data.reason.kind === "max-tokens") {'''),
    ])
    patch('dsh-client-ui-conversation', 'client.js', [
        ('''\t\t\t\t\t\t\t\t\t\tinterruptible && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {''',
         '''\t\t\t\t\t\t\t\t\t\tsessionId === void 0 ? null : react.createElement("span", {
\t\t\t\t\t\t\t\t\t\t\tclassName: "qc-composer-voice-seat",
\t\t\t\t\t\t\t\t\t\t\t"data-qc-voice-seat": sessionId
\t\t\t\t\t\t\t\t\t\t}),
\t\t\t\t\t\t\t\t\t\tinterruptible && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {'''),
    ])


if __name__ == '__main__':
    apply()
