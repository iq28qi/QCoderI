// QCODERI_REASONING_ADAPTER_BEGIN
let qcCatalogIndex;
function qcCatalogReasoning(id, api) {
  const normalize=value=>String(value ?? '').trim().toLowerCase().replace(/[ _]/g,'-').replace(/^[^/]+\//,'');
  if(!qcCatalogIndex) {
    qcCatalogIndex=new Map();
    const preferred=['openai','anthropic','deepseek','moonshotai','zai','google'];
    for(const provider of [...new Set([...preferred,...getBuiltinProviders()])]) {
      for(const model of getBuiltinModels(provider)) {
        const key=normalize(model.id);
        if(!qcCatalogIndex.has(key))qcCatalogIndex.set(key,model);
      }
    }
  }
  const model=qcCatalogIndex.get(normalize(id));
  if(!model?.reasoning)return {};
  const reasoningEfforts=Object.fromEntries(getSupportedThinkingLevels(model).map(level=>[level,model.thinkingLevelMap?.[level] ?? (level === 'off' ? 'none' : level)]));
  const compat={};
  if(api === 'openai-completions')Object.assign(compat,{thinkingFormat:model.compat?.thinkingFormat ?? 'openai',supportsReasoningEffort:model.compat?.supportsReasoningEffort ?? true});
  if(api === 'anthropic-messages' && model.api === api && model.compat?.forceAdaptiveThinking !== undefined)compat.forceAdaptiveThinking=model.compat.forceAdaptiveThinking;
  return {reasoningEfforts,compat};
}
// QCODERI_REASONING_ADAPTER_END
