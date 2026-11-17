"""Install automatic API capability detection and chat-only reasoning controls."""
from pathlib import Path
import re

BASE = Path(__file__).resolve().parents[1]
PACKAGES = BASE / 'source/dsh/node_modules/@deepseek-ai'

def once(source, old, new):
    if new in source:
        return source
    if source.count(old) != 1:
        raise RuntimeError('Reasoning integration anchor changed: ' + old[:100])
    return source.replace(old, new, 1)

def section(source, start, end, content, anchor):
    if start in source:
        begin = source.index(start)
        finish = source.index(end, begin) + len(end)
        return source[:begin] + content + source[finish:]
    return once(source, anchor, content + '\n' + anchor)

def apply():
    changed = []
    def asset(name):
        return (BASE / 'assets' / name).read_text(encoding='utf-8')
    def save(path, content):
        if not path.exists() or path.read_text(encoding='utf-8') != content:
            path.write_text(content, encoding='utf-8', newline='\n')
            changed.append(path.relative_to(BASE / 'source').as_posix())
    adapter = PACKAGES / 'dsh-llm-pi-ai/lib'
    save(adapter / 'qcoderi-reasoning.js', asset('reasoning-policy.js'))
    save(adapter / 'qcoderi-images.js', asset('image-policy.js'))
    path = adapter / 'index.js'
    source = path.read_text(encoding='utf-8')
    image_import = 'import { qcImageModelKey, qcImageDefaults, qcImageInputFromMetadata } from "./qcoderi-images.js";'
    if image_import not in source:
        source = image_import + '\n' + source
    source = re.sub(r'^import \{ qcReasoningDefaults[^\n]+\n', '', source, flags=re.MULTILINE)
    source = 'import { qcReasoningDefaults, qcConnectionReasoning, qcProviderDefaultPayload, qcDiscoverReasoning, qcReasoningFromMetadata, qcUpstreamModel } from "./qcoderi-reasoning.js";\n' + source
    source = section(source, '// QCODERI_REASONING_ADAPTER_BEGIN', '// QCODERI_REASONING_ADAPTER_END', asset('reasoning-adapter.js').rstrip(), '//#region lib/types/catalog.js')
    source = section(source, '// QCODERI_IMAGE_ADAPTER_BEGIN', '// QCODERI_IMAGE_ADAPTER_END', asset('image-adapter.js').rstrip(), '//#region lib/types/catalog.js')
    source = once(source, 'input: declaredInput(entry.input) ?? base?.input ?? [...request.defaultInput],',
        'input: declaredInput(entry.input) ?? base?.input ?? qcImageDefaults(entry.id, qcCatalogInput) ?? [...request.defaultInput],')
    source = once(source, '\t\t\tconfiguredMaxTokens: catalog?.configuredMaxTokens ?? /* @__PURE__ */ new Map(),',
        '\t\t\tconfiguredInput: new Set([...(source.models ?? []).filter(entry => declaredInput(entry.input) !== undefined).map(entry => entry.id), ...Object.entries(source.modelOverrides ?? {}).filter(([, entry]) => declaredInput(entry.input) !== undefined).map(([id]) => id)]),\n'
        '\t\t\tconfiguredMaxTokens: catalog?.configuredMaxTokens ?? /* @__PURE__ */ new Map(),')
    source = re.sub(r'\t\t// QCoderI: custom routes lack catalog capabilities; explicit fields win\.\n\t\tconst hint = [^\n]+\n\t\tentry = [^\n]+\n', '', source)
    source = once(source, '\t\tconst baseUrl = request.baseURL ?? base?.baseUrl ?? providerBaseUrl;',
        '\t\t// QCoderI: custom routes lack catalog capabilities; explicit fields win.\n'
        '\t\tconst hint = base === void 0 ? qcConnectionReasoning((qcReasoningDefaults(entry.id, api).reasoningEfforts === void 0 ? qcCatalogReasoning(entry.id, api) : qcReasoningDefaults(entry.id, api)), request.baseURL ?? providerBaseUrl, api) : {};\n'
        '\t\tentry = { ...entry, reasoningEfforts: entry.reasoningEfforts ?? hint.reasoningEfforts, compat: { ...hint.compat, ...request.compat, ...entry.compat } };\n'
        '\t\tconst baseUrl = request.baseURL ?? base?.baseUrl ?? providerBaseUrl;')
    source = once(source, '\t\t...enabledReasoning === void 0 ? {} : { reasoning: enabledReasoning },',
        '\t\t...enabledReasoning === void 0 ? {} : { reasoning: enabledReasoning },\n'
        '\t\t...reasoning === void 0 ? { onPayload: qcProviderDefaultPayload } : {},')
    source = source.replace('name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`', 'name: model.compat?.thinkingFormat === "zai" && model.compat?.supportsReasoningEffort === false && getSupportedThinkingLevels(model).length === 1 ? "Включено" : `${level.charAt(0).toUpperCase()}${level.slice(1)}`')
    method = '// QCODERI_REASONING_METHOD_BEGIN\n' + asset('reasoning-adapter-method.js').rstrip() + '\n// QCODERI_REASONING_METHOD_END'
    source = section(source, '// QCODERI_REASONING_METHOD_BEGIN', '// QCODERI_REASONING_METHOD_END', method, '\t/** The configured descriptor for one exact route/model pair within one snapshot. */')
    source = source.replace('const resolved = snapshot.models.getModel(provider, model);', 'const resolved = snapshot.detectedModels?.get(`${provider}\\0${model}`) ?? snapshot.models.getModel(provider, model);')
    source = once(source, '''\tlistModels(provider) {
\t\treturn Promise.resolve().then(() => {
\t\t\tconst snapshot = this.current();''', '''\tlistModels(provider) {
\t\treturn Promise.resolve().then(async () => {
\t\t\tconst snapshot = await this.detectReasoning(this.current(), provider);''')
    source = once(source, 'inputModalities: [...model.input]', 'inputModalities: [...this.modelOf(snapshot, provider, model.id).input]')
    source = once(source, 'inputModalities: [...resolvedModel.input],',
        'inputModalities: [...resolvedModel.input],\n\t\t\t...(resolvedModel.upstreamModel ? { upstreamModel: resolvedModel.upstreamModel } : {}),')
    source = re.sub(r'\t(?:async )?resolveModel\(provider, model, _signal\) \{[\s\S]*?\n\tmodelInfo\(', lambda _: '''\tasync resolveModel(provider, model, _signal) {
        const snapshot = await this.detectReasoning(this.current(), provider);
        return this.modelInfo(snapshot, provider, model);
    }
\tmodelInfo(''', source, count=1)
    source = re.sub(r'\t(?:async )?prepareCall\(provider, model, _signal\) \{[\s\S]*?\n\tasync \*streamWithSnapshot', lambda _: '''\tasync prepareCall(provider, model, _signal) {
        const snapshot = await this.detectReasoning(this.current(), provider);
        return {
            model: this.modelInfo(snapshot, provider, model),
            stream: options => this.streamWithSnapshot(options, snapshot)
        };
    }
    async *stream(options) {
        const snapshot = await this.detectReasoning(this.current(), options.provider);
        yield* this.streamWithSnapshot(options, snapshot);
    }
\tasync *streamWithSnapshot''', source, count=1)
    save(path, source)

    path = PACKAGES / 'dsh-llm/lib/index.js'
    source = path.read_text(encoding='utf-8')
    source = once(source, 'name: resolved.name,',
        'name: resolved.name,\n\t\t\t\t...(typeof resolved.upstreamModel === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,159}$/.test(resolved.upstreamModel) && resolved.upstreamModel.toLowerCase() !== model.toLowerCase() ? { upstreamModel: resolved.upstreamModel } : {}),')
    save(path, source)

    path = PACKAGES.parent / '@earendil-works/pi-ai/dist/api/openai-responses-shared.js'
    source = path.read_text(encoding='utf-8')
    source = once(source, 'output.responseId = event.response.id;',
        'output.responseId = event.response.id;\n            output.responseModel = event.response.model;')
    source = once(source, 'finalizeResponse(event.response);',
        'output.responseModel = event.response.model ?? output.responseModel;\n            finalizeResponse(event.response);')
    save(path, source)

    # Remove the discarded configuration form, including existing installations.
    path = PACKAGES / 'dsh-client-ui-settings-models/lib/client.js'
    source = path.read_text(encoding='utf-8')
    start, end = '// QCODERI_REASONING_EDITOR_BEGIN', '// QCODERI_REASONING_EDITOR_END'
    if start in source:
        begin = source.index(start)
        finish = source.index(end, begin) + len(end)
        source = source[:begin] + source[finish:]
    source = source.replace('(0, react_jsx_runtime.jsx)(QcReasoningEditor, { model, api: probe.api, disabled, index, onChange: next => patch(index, next) }), ', '')
    source = section(source, '// QCODERI_IMAGE_INPUT_EDITOR_BEGIN', '// QCODERI_IMAGE_INPUT_EDITOR_END', asset('image-input-editor.js').rstrip(), '\t\tconst CAPACITY_HINT = {')
    image_field = '(0, react_jsx_runtime.jsx)(QcImageInputEditor, {model,index,disabled,onChange:next=>patch(index,next)}), '
    anchor = 'className: ModelsSection_module_css_default["modelAdvanced"],\n\t\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsxs)("label", {'
    source = once(source, anchor, anchor.replace('children: [', 'children: [' + image_field, 1))
    save(path, source)

    path = PACKAGES / 'dsh-client-ui-model-selection/lib/client.js'
    source = path.read_text(encoding='utf-8')
    names = '{off:"Выключено",minimal:"Минимальный",low:"Низкий",medium:"Средний",high:"Высокий",xhigh:"Очень высокий",max:"Максимальный"}'
    source = re.sub(r'\t\t\tconst effortName = [^\n]+\n', '', source)
    source = once(source, '\t\t\tconst effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort;',
        '\t\t\tconst effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort;\n'
        f'\t\t\tconst effortName = effort => effort.name === "Включено" ? effort.name : ({names})[effort.id] ?? effort.name;')
    source = source.replace('reasoning.efforts.find((level) => level.id === effectiveEffort)?.name ?? effectiveEffort', '((level) => level ? effortName(level) : effectiveEffort)(reasoning.efforts.find((level) => level.id === effectiveEffort))')
    source = source.replace('label: effort.name', 'label: effortName(effort)')
    source = source.replace('reasoning !== void 0 && (0, react_jsx_runtime.jsxs)("button", {', '!/^(?:seedance|kling)-/i.test(state.current?.model ?? "") && (0, react_jsx_runtime.jsxs)("button", {')
    source = source.replace('children: t("empty.efforts")', 'children: "Авто · API не сообщает доступные уровни"')
    source = source.replace('children: effortLabel\n', 'children: effortLabel ?? "Авто"\n')
    save(path, source)
    print('Reasoning integration:', ', '.join(changed) if changed else 'already current')
    return changed

if __name__ == '__main__':
    apply()
