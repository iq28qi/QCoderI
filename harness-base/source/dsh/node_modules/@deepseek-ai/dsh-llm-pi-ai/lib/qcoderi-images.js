// Resolve input capabilities before the LLM service projects images to text.
export const qcImageModelKey = value => String(value ?? '').trim().toLowerCase().replace(/[ ._-]+/g, '-');

export function qcImageDefaults(id, catalogLookup) {
  const full=qcImageModelKey(id);
  const key=full.split('/').at(-1).replace(/:free$/,'').replace(/^(?:openai|anthropic|google|moonshotai)[-:]/,'');
  const exact=catalogLookup(full) ?? catalogLookup(key);
  if(exact)return [...exact];
  // Provider aliases often change punctuation, minor versions or tier suffixes.
  // Each family fallback is anchored in an installed vision model, not the API.
  let canonical;
  if(/^kimi-k3(?:-|$)/.test(key))canonical='kimi-k3';
  else if(/^kimi-k2-[567](?:-|$)/.test(key))canonical=key.match(/^kimi-k2-[567]/)[0];
  else if(/^gpt-[56](?:-|$)/.test(key))canonical=key.startsWith('gpt-6') ? 'gpt-6-astra' : 'gpt-5';
  else {
    const claude=key.match(/^(?:claude-)?(opus|sonnet|haiku|fable|mythos)-([345])(?:-|$)/);
    if(claude)canonical=`claude-${claude[1]}-${claude[2]}`;
  }
  const input=canonical && catalogLookup(canonical);
  return input ? [...input] : undefined;
}

function inputList(value) {
  if(!Array.isArray(value) || !value.length)return undefined;
  const aliases={text:'text',image:'image',images:'image',image_url:'image',input_image:'image'};
  const input=[...new Set(value.flatMap(item=>typeof item === 'string' && aliases[item.toLowerCase()] ? [aliases[item.toLowerCase()]] : []))];
  return input.length ? input : undefined;
}

export function qcImageInputFromMetadata(model, rows, catalogLookup) {
  const row=rows.find(row=>[row.alias,row.id,row.model].some(id=>qcImageModelKey(id)===qcImageModelKey(model.id)));
  // Generic gateway catalogs often mark every model text-only. A positive
  // installed/model capability must not be removed by that negative default.
  // Explicit per-model input is handled first by the adapter, outside this helper.
  const identities=[model.id,...row?[row.canonical_model,row.upstream_model,row.canonical_slug,row.id,row.name,row.display_name,row.model]:[]];
  let known;
  for(const id of identities.filter(Boolean)){
    const input=qcImageDefaults(id,catalogLookup);
    if(input?.includes('image'))return input;
    known ??= input;
  }
  if(model.input?.includes('image'))return [...model.input];
  if(!row)return known;
  let negative;
  for(const value of [row.input,row.input_modalities,row.inputModalities,row.architecture?.input_modalities,row.modalities?.input,row.capabilities?.input_modalities,row.capabilities?.inputModalities]) {
    const input=inputList(value);
    if(input?.includes('image'))return input;
    negative ??= input;
  }
  if(typeof row.architecture?.modality === 'string') {
    const input=inputList(row.architecture.modality.split('->')[0].split('+'));
    if(input?.includes('image'))return input;
    negative ??= input;
  }
  for(const value of [row.vision,row.supports_vision,row.supports_images,row.image_input,row.capabilities?.vision,row.capabilities?.image_vision,row.capabilities?.image,row.capabilities?.image_input,row.capabilities?.images]) {
    if(value === true)return ['text','image'];
    if(value === false)negative ??= ['text'];
  }
  if(Array.isArray(row.capabilities)&&row.capabilities.some(value=>['vision','image','image_vision'].includes(String(value).toLowerCase())))return ['text','image'];
  return negative ?? known;
}
