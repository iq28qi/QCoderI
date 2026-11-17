// API capabilities only: no prompt changes and no inference probes.
import {createHash} from 'node:crypto';
export const qcReasoningLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const qcReasoningNames = {off:'Выключено', minimal:'Минимальный', low:'Низкий', medium:'Средний', high:'Высокий', xhigh:'Очень высокий', max:'Максимальный'};
const efforts = (...levels) => Object.fromEntries(levels.map(level => [level, level === 'off' ? 'none' : level]));

export function qcConnectionReasoning(hint, baseURL, api) {
  if(api !== 'openai-completions')return hint;
  try {
    const host=new URL(baseURL).hostname;
    if(host === 'openrouter.ai' || host.endsWith('.openrouter.ai'))return {...hint,compat:{...hint.compat,thinkingFormat:'openrouter',supportsReasoningEffort:true}};
  } catch {}
  return hint;
}

// Name hints are a fallback when the endpoint supplies no capability metadata.
export function qcReasoningDefaults(id, api) {
  const model = String(id).trim().toLowerCase().replace(/[ _]/g, '-');
  const chat = api === 'openai-completions';
  const responses = api === 'openai-responses';
  const messages = api === 'anthropic-messages';
  if (!chat && !responses && !messages) return {};
  const openai = reasoningEfforts => ({reasoningEfforts, ...(chat ? {compat:{thinkingFormat:'openai', supportsReasoningEffort:true}} : {})});
  if (!messages && /(?:^|\/)gpt-6(?:[.\-]|$)/.test(model)) {
    const always = /gpt-6(?:\.1|-1)-|gpt-6-astra/.test(model);
    return openai(efforts(...(always ? [] : ['off']), 'low', 'medium', 'high', 'xhigh', 'max'));
  }
  if (!messages && /(?:^|\/)kimi-k3(?:[.\-]|$)/.test(model)) return openai(efforts('low', 'high', 'max'));
  if (!messages && /(?:^|\/)deepseek-(?:v4|flash(?:-|$))/.test(model)) return {
    reasoningEfforts:efforts('off', 'low', 'high', 'max'),
    ...(chat ? {compat:{thinkingFormat:'deepseek', supportsReasoningEffort:true, requiresReasoningContentOnAssistantMessages:true}} : {}),
  };
  if (chat && /(?:^|\/)glm-5[.\-]3(?:-|$)/.test(model)) return {
    reasoningEfforts:efforts('high'),
    compat:{thinkingFormat:'zai', supportsReasoningEffort:false, requiresReasoningContentOnAssistantMessages:true},
  };
  if (/(?:^|\/)claude-(?:opus|sonnet|haiku|fable|mythos)-5(?:[.\-]|$)/.test(model)) return {
    reasoningEfforts:efforts('low', 'medium', 'high', 'xhigh', 'max'),
    ...(messages ? {compat:{forceAdaptiveThinking:true}} : chat ? {compat:{thinkingFormat:'openai', supportsReasoningEffort:true}} : {}),
  };
  return {};
}

// pi-ai's simple API interprets an absent level as "off". The UI's Default
// must instead let the endpoint choose, including endpoints that always think.
export function qcProviderDefaultPayload(payload) {
  const next = {...payload};
  for (const key of ['reasoning_effort', 'reasoning', 'thinking', 'enable_thinking', 'thinking_token_budget', 'thinking_budget', 'thinking_budget_tokens']) delete next[key];
  if (next.output_config?.effort !== undefined) {
    next.output_config = {...next.output_config};
    delete next.output_config.effort;
    if (!Object.keys(next.output_config).length) delete next.output_config;
  }
  return next;
}

const qcCapabilityCache = new Map();
const qcProtocols = new Set(['openai-completions','openai-responses','anthropic-messages']);
const qcFormats = new Set(['openai','deepseek','zai','openrouter','together','baseten','qwen','qwen-chat-template','chat-template','string-thinking','ant-ling']);
const qcNormalize = value => String(value ?? '').trim().toLowerCase().replace(/[ _]/g,'-');
const qcLevel = value => value === 'none' || value === 'disabled' ? 'off' : qcReasoningLevels.includes(value) ? value : undefined;

// The cache holds model metadata, never keys. Its identity includes the complete
// connection and credential fingerprint so another key/account cannot reuse it.
export async function qcDiscoverReasoning(model, apiKey, headers = {}) {
  if (!qcProtocols.has(model.api)) return [];
  const base=model.baseUrl.replace(/\/+$/,'');
  const url=model.api === 'anthropic-messages' ? `${base.endsWith('/v1') ? base.slice(0,-3) : base}/v1/models?limit=1000` : `${base}/models`;
  const identity=createHash('sha256').update(JSON.stringify([url,model.api,apiKey ?? null,Object.entries(headers).sort()])).digest('hex');
  const cached=qcCapabilityCache.get(identity);
  if (cached && cached.expires > Date.now()) return cached.promise;
  const entry={expires:Date.now()+60000};
  entry.promise=(async()=>{
    try {
      const requestHeaders=new Headers(Object.entries(headers));
      requestHeaders.set('accept','application/json');
      if (model.api === 'anthropic-messages') {
        requestHeaders.set('anthropic-version','2023-06-01');
        if(apiKey && !requestHeaders.has('x-api-key')) requestHeaders.set('x-api-key',apiKey);
      } else if(apiKey && !requestHeaders.has('authorization')) requestHeaders.set('authorization',`Bearer ${apiKey}`);
      const response=await fetch(url,{method:'GET',headers:requestHeaders,redirect:'error',signal:AbortSignal.timeout(2000)});
      if(!response.ok) {await response.body?.cancel();return [];}
      if(Number(response.headers.get('content-length'))>4*1024*1024) {await response.body?.cancel();return [];}
      const reader=response.body?.getReader();
      if(!reader)return [];
      const chunks=[];let size=0;
      try {
        for(;;) {const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4*1024*1024)return [];chunks.push(value);}
      } finally {await reader.cancel().catch(()=>{});}
      const bytes=new Uint8Array(size);let offset=0;
      for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
      const body=JSON.parse(new TextDecoder().decode(bytes));
      let rows;
      if(Array.isArray(body.data))rows=body.data;
      else if(Array.isArray(body.models))rows=body.models;
      else if(body.models && typeof body.models === 'object')rows=Object.entries(body.models).map(([alias,raw])=>({...raw,alias}));
      else return [];
      entry.expires=Date.now()+10*60000;
      return rows.filter(row=>row && typeof row === 'object');
    } catch {return [];}
  })();
  qcCapabilityCache.set(identity,entry);
  if(qcCapabilityCache.size>128)qcCapabilityCache.delete(qcCapabilityCache.keys().next().value);
  return entry.promise;
}

// A route label, display name or built-in catalog match is not an upstream declaration.
export function qcUpstreamModel(id, rows) {
  const matches = rows.filter(row => [row.alias, row.id, row.model].includes(id));
  const valid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,159}$/.test(value)
    && value.toLowerCase() !== id.toLowerCase();
  const declared = new Set(matches.map(row => [row.upstream_model, row.canonical_model, row.canonical_slug].find(valid)).filter(Boolean));
  return declared.size === 1 ? declared.values().next().value : undefined;
}

// Accept enumerated capabilities for opaque aliases too. Identity-only model
// listings are useful for resolving an alias, but do not prove effort support.
export function qcReasoningFromMetadata(model, rows, catalogLookup = () => ({})) {
  const row=rows.find(row=>[row.alias,row.id,row.model].some(id=>qcNormalize(id)===qcNormalize(model.id)));
  if(!row)return {};
  if(row.reasoning === false || row.capabilities?.reasoning === false || row.reasoningEfforts === false)return {reasoningEfforts:false};
  const identities=[row.canonical_model,row.upstream_model,row.canonical_slug,row.id,row.name,row.display_name,row.model,model.id];
  let hint={};
  for(const id of identities) {
    hint=qcReasoningDefaults(id,model.api);
    if(hint.reasoningEfforts)break;
    hint=catalogLookup(id,model.api);
    if(hint.reasoningEfforts)break;
  }
  const candidates=[row.reasoningEfforts,row.reasoning_efforts,row.supported_reasoning_efforts,row.effort?.supported_levels,row.reasoning?.supported_levels,row.capabilities?.reasoning?.supported_levels,row.parameters?.reasoning_effort?.enum,row.parameters?.reasoning?.properties?.effort?.enum];
  let declared;
  for(const candidate of candidates) {
    if(Array.isArray(candidate)) {
      const pairs=candidate.flatMap(value=>typeof value === 'string' && qcLevel(value) ? [[qcLevel(value),value === 'off' ? 'none' : value]] : []);
      if(pairs.some(([level])=>level !== 'off')) {declared=Object.fromEntries(pairs);break;}
    } else if(candidate && typeof candidate === 'object') {
      const pairs=Object.entries(candidate).filter(([key,value])=>qcLevel(key) && typeof value === 'string' && value.length>0 && value.length<128).map(([key,value])=>[qcLevel(key),value]);
      if(pairs.some(([level])=>level !== 'off')){declared=Object.fromEntries(pairs);break;}
    }
  }
  if(!declared && !hint.reasoningEfforts)return {};
  // A server's explicit list narrows a catalog hint. Off is added only when
  // declared by the server, or established by the recognized model family.
  if(declared && hint.reasoningEfforts?.off !== undefined && row.reasoning?.can_disable !== false)declared.off ??= hint.reasoningEfforts.off;
  const compat={...qcConnectionReasoning(hint,model.baseUrl,model.api).compat};
  const format=row.thinking_format ?? row.compat?.thinkingFormat;
  if(model.api === 'openai-completions' && qcFormats.has(format))compat.thinkingFormat=format;
  if(model.api === 'openai-completions' && declared)compat.supportsReasoningEffort=true;
  if(model.api === 'anthropic-messages' && (row.thinking?.type === 'adaptive' || row.capabilities?.thinking?.adaptive === true))compat.forceAdaptiveThinking=true;
  return {reasoningEfforts:declared ?? hint.reasoningEfforts,compat};
}
