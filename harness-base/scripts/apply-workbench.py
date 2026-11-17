"""Install source-owned workspace tools and client surfaces, idempotently."""
from pathlib import Path
import runpy
import shutil

BASE = Path(__file__).resolve().parents[1]
PACKAGES = BASE / 'source/dsh/node_modules/@deepseek-ai'

def replace_region(source, content, begin, end, anchor):
    if begin in source:
        first = source.index(begin)
        last = source.index(end, first) + len(end)
        return source[:first] + content + source[last:]
    if source.count(anchor) != 1:
        raise RuntimeError('Workbench integration anchor changed: ' + anchor)
    return source.replace(anchor, content + '\n' + anchor, 1)

def apply():
    runpy.run_path(str(BASE / 'scripts/build.py'))['sync_team']()
    path = PACKAGES / 'dsh-client-ui-conversation/lib/client.js'
    source = path.read_text(encoding='utf-8')
    view = (BASE / 'assets/workbench-view.js').read_text(encoding='utf-8').replace(
        '// QCODERI_WORKBENCH_BEGIN',
        '// QCODERI_WORKBENCH_BEGIN\n' + (BASE / 'assets/report-view.js').read_text(encoding='utf-8').rstrip(), 1).rstrip()
    source = replace_region(source, view, '// QCODERI_WORKBENCH_BEGIN', '// QCODERI_WORKBENCH_END', 'function VideoOptions(')
    anchor = 'react.createElement(StudioActivity, {sessionId, running:session?.running ?? false, videoMode, chatMode}), composerSeat'
    replacement = 'react.createElement(StudioActivity, {sessionId, running:session?.running ?? false, videoMode, chatMode}), react.createElement(WorkbenchPanel,{sessionId,chatMode,onDictation:text=>inputActions.setDraft((inputState?.draft??"")+((inputState?.draft)?"\\n":"")+text)}), composerSeat'
    if replacement not in source:
        if source.count(anchor) != 1:
            raise RuntimeError('Workbench mount anchor changed')
        source = source.replace(anchor, replacement, 1)
    path.write_text(source, encoding='utf-8', newline='\n')
    path = PACKAGES / 'dsh-client-ui-brand-official/lib/client.js'
    source = path.read_text(encoding='utf-8')
    bridge = '''// QCODERI_WORKBENCH_BRIDGE_BEGIN
    window.__qcoderiWorkbench=async(request,signal)=>{const result=await ctx.connection.rpc.call('/api','qcoderWorkbench/request',{args:{data:request}},signal);if(!result.ok)throw Error(result.error?.message??'Ошибка панели проекта');return result.value;};
    window.__qcoderiWorkbenchImage=(sessionId,image)=>ctx.get('uiConversation').imageUrl(sessionId,image);
// QCODERI_WORKBENCH_BRIDGE_END'''
    source = replace_region(source, bridge, '// QCODERI_WORKBENCH_BRIDGE_BEGIN', '// QCODERI_WORKBENCH_BRIDGE_END', '    window.dispatchEvent(new Event(\'qcoderi:media-ready\'));')
    path.write_text(source, encoding='utf-8', newline='\n')
    frontend = PACKAGES / 'dsh-web-frontend/dist'
    shutil.copy2(BASE / 'assets/workbench.css', frontend / 'qcoderi-workbench.css')
    path = frontend / 'index.html'
    source = path.read_text(encoding='utf-8')
    if 'qcoderi-workbench.css' not in source:
        source = source.replace('</head>', '<link rel="stylesheet" href="./qcoderi-workbench.css">\n</head>')
    path.write_text(source, encoding='utf-8', newline='\n')
    adapter = PACKAGES / 'dsh-llm-pi-ai/lib'
    shutil.copy2(BASE / 'assets/request-recovery.js', adapter / 'qcoderi-request-recovery.js')
    shutil.copy2(BASE / 'assets/model-task-adapter.js', adapter / 'model-task-adapter.js')
    path = adapter / 'index.js'
    source = path.read_text(encoding='utf-8')
    recovery_import = 'import { qcRecoverRequest } from "./qcoderi-request-recovery.js";'
    if recovery_import not in source:
        source = recovery_import + '\n' + source
    old_task_import = 'import { adaptModelTask } from "./model-task-adapter.js";'
    task_import = 'import { adaptModelTask, observeProviderFailures } from "./model-task-adapter.js";'
    source = source.replace(old_task_import + '\n', '', 1)
    source = source.replace('import { adaptModelTask, observeProviderRateLimit } from "./model-task-adapter.js";\n', '', 1)
    if task_import not in source:
        source = task_import + '\n' + source
    stream_model = '\t\t\tconst model = this.modelOf(snapshot, options.provider, options.model);'
    task_adapt = stream_model + '\n\t\t\toptions = adaptModelTask(options, model);'
    if task_adapt not in source:
        if source.count(stream_model) != 1:
            raise RuntimeError('Model Task Adapter stream anchor changed')
        source = source.replace(stream_model, task_adapt, 1)
    source = source.replace(
        'let terminalRateLimit;\n\t\t\t\tconst iterator = toStreamChunks(snapshot.models.streamSimple(model, context, {\n'
        '\t\t\t\t\tfetch: observeProviderRateLimit(failure => { terminalRateLimit = failure; }),',
        'const iterator = toStreamChunks(snapshot.models.streamSimple(model, context, {', 1)
    source = source.replace(
        'const chunk = result.value;\n\t\t\t\t\t\t'
        'yield terminalRateLimit && chunk.type === "finish" && chunk.reason.kind === "error"\n'
        '\t\t\t\t\t\t\t? { ...chunk, reason: { ...chunk.reason, failure: terminalRateLimit } } : chunk;',
        'yield result.value;', 1)
    for anchor, replacement in [
        ('const iterator = toStreamChunks(snapshot.models.streamSimple(model, context, {',
         'let providerResponse;\n\t\t\t\tconst iterator = toStreamChunks(snapshot.models.streamSimple(model, context, {\n'
         '\t\t\t\t\tfetch: observeProviderFailures(info => { providerResponse = info; }),'),
        ('yield result.value;',
         'const chunk = result.value;\n\t\t\t\t\t\t'
         'if (providerResponse && chunk.type === "finish" && chunk.reason.kind === "error") {\n'
         '\t\t\t\t\t\t\tconst failure = providerResponse.terminal ?? { ...chunk.reason.failure,\n'
         '\t\t\t\t\t\t\t\t...(providerResponse.status >= 400 ? { status: providerResponse.status } : {}),\n'
         '\t\t\t\t\t\t\t\t...(providerResponse.requestId ? { requestId: providerResponse.requestId } : {}) };\n'
         '\t\t\t\t\t\t\tyield { ...chunk, reason: { ...chunk.reason, failure } };\n'
         '\t\t\t\t\t\t} else yield chunk;'),
    ]:
        if replacement not in source:
            if source.count(anchor) != 1:
                raise RuntimeError('Provider rate-limit integration anchor changed')
            source = source.replace(anchor, replacement, 1)
    source = source.replace('stream: options => this.streamWithSnapshot(options, snapshot)', 'stream: options => this.qcRecovery(options, snapshot)')
    source = source.replace('yield* this.streamWithSnapshot(options, snapshot);', 'yield* this.qcRecovery(options, snapshot);')
    method = """// QCODERI_REQUEST_RECOVERY_BEGIN
    qcRecovery(options, snapshot) {
        return qcRecoverRequest(current => this.streamWithSnapshot(options,current), snapshot, original => {
            const profiles=new Map(original.profiles),profile=this.profileOf(original,options.provider);
            profiles.set(options.provider,{...profile,requestImagePixelBudget:Math.min(profile.requestImagePixelBudget,1048576),requestImageMaxBytes:Math.min(profile.requestImageMaxBytes,180000)});
            return {...original,profiles};
        }, options.signal, { provider: options.provider, model: options.model });
    }
// QCODERI_REQUEST_RECOVERY_END"""
    source = replace_region(source, method, '// QCODERI_REQUEST_RECOVERY_BEGIN',
                            '// QCODERI_REQUEST_RECOVERY_END', '    async *stream(options) {')
    path.write_text(source, encoding='utf-8', newline='\n')
    # Policy responses and explicit provider vetoes also stop "always" retry.
    loop = PACKAGES / 'dsh-agent-loop/lib/index.js'
    source = loop.read_text(encoding='utf-8')
    shutil.copy2(BASE / 'assets/model-identity.js', loop.parent / 'qcoderi-model-identity.js')
    identity_import = 'import { isModelIdentityQuestion, modelIdentityStream } from "./qcoderi-model-identity.js";'
    if identity_import not in source:
        source = identity_import + '\n' + source
    source = source.replace('modelIdentityStream(request.provider, request.model)', 'modelIdentityStream({ ...request, session: this.session, llm: this.loopCtx.llm, signal })', 1)
    for anchor, replacement in [
        ('const { config, preparedCall } = await this.prepareRequest(turn, step, signal);',
         'const localIdentity = firstAttempt && step === 1 && isModelIdentityQuestion(decision.messages);\n'
         '\t\t\tconst { config, preparedCall } = localIdentity\n'
         '\t\t\t\t? { config: { provider: this.options.provider || "", model: this.options.model || "" } }\n'
         '\t\t\t\t: await this.prepareRequest(turn, step, signal);'),
        ('inHistory: preparedCall?.systemPromptUpdate === "in-history",',
         'inHistory: (localIdentity ? this.session.requestContext()?.systemPromptUpdate : preparedCall?.systemPromptUpdate) === "in-history",'),
        ('const request = this.buildRequest(config, preparedCall, assembly.tools, startsRequestSeries, signal);',
         'const request = localIdentity ? config : this.buildRequest(config, preparedCall, assembly.tools, startsRequestSeries, signal);'),
        ('const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request);',
         'const stream = localIdentity ? modelIdentityStream({ ...request, session: this.session, llm: this.loopCtx.llm, signal })\n'
         '\t\t\t\t\t: preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request);'),
        ('if (wakeup) this.wakeDriver(wakingAfterAbort);',
         'if (wakeup) {\n'
         '\t\t\tif (this.phase.kind === "running" && !this.phase.abort.signal.aborted) this.phase.wakeRequested = true;\n'
         '\t\t\tthis.wakeDriver(wakingAfterAbort);\n\t\t}'),
        ('throw new AggregateError([error, settlementError], "Assistant stream failed and its durable settlement was rejected", { cause: error });\n'
         '\t\t\t\t}\n\t\t\t\tthrow error;',
         'throw new AggregateError([error, settlementError], "Assistant stream failed and its durable settlement was rejected", { cause: error });\n'
         '\t\t\t\t}\n'
         '\t\t\t\tif (!signal.aborted && error instanceof LlmError && ["TIMEOUT", "TRANSPORT", "SERVER"].includes(error.failure.code)) {\n'
         '\t\t\t\t\tconst action = await this.dispatch.waterfall("agent/request-error", {\n'
         '\t\t\t\t\t\tturn, step, provider: request.provider, failure: error.failure, retryPolicy: preparedCall?.retryPolicy, signal\n'
         '\t\t\t\t\t}, () => Promise.resolve(void 0));\n'
         '\t\t\t\t\tsignal.throwIfAborted();\n'
         '\t\t\t\t\tif (action?.kind === "retry") continue;\n'
         '\t\t\t\t}\n\t\t\t\tthrow error;'),
    ]:
        if replacement not in source:
            if anchor.startswith('const { config, preparedCall }') and 'const latestRoute = this.session.requestHeader()?.config;' in source:
                continue
            if source.count(anchor) != 1:
                raise RuntimeError('Model identity integration anchor changed: ' + anchor[:100])
            source = source.replace(anchor, replacement, 1)
    retry = 'const action = await this.dispatch.waterfall("agent/request-error", {'
    source = source.replace(retry.replace('= await', '= finish.failure.code === "PROVIDER_NO_RETRY" ? void 0 : await'), retry, 1)
    guarded_retry = retry.replace('= await', '= ["PROVIDER_NO_RETRY", "CONTENT_POLICY"].includes(finish.failure.code) ? void 0 : await')
    if guarded_retry not in source:
        if source.count(retry) != 1:
            raise RuntimeError('Agent request recovery anchor changed')
        source = source.replace(retry, guarded_retry, 1)
    loop.write_text(source, encoding='utf-8', newline='\n')
    system_prompt = PACKAGES / 'dsh-system-prompt/lib/index.js'
    source = system_prompt.read_text(encoding='utf-8')
    identity = 'text: "You are the assistant in QCoderI. The configured model ID is {{model}}. It may be a provider alias. Do not infer the underlying model from the alias, application name or writing style."'
    source = source.replace('text: "You are an AI agent powered by DeepSeek Harness."', identity)
    source = source.replace('text: "You are the assistant in QCoderI. Your selected model is {{model}}. QCoderI is the application name."', identity)
    system_prompt.write_text(source, encoding='utf-8', newline='\n')
    print('Workbench integration: ready')

if __name__ == '__main__':
    apply()
