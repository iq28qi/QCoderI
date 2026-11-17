// Host-only final-wire contract. The single supported snapshot is documented at
// https://developers.openai.com/api/docs/models/gpt-4o-mini.md (2026-11-15).
// Reserve the ENTIRE accepted-request context ceiling, NOT an estimate from a
// configured catalog or text length. This is deliberately conservative.
import {BudgetError} from './usage-ledger.js';
const issued=new WeakSet();
const MODEL='gpt-4o-mini-2024-07-18',ENDPOINT='https://api.openai.com/v1/chat/completions';
const INPUT_BOUND=128000,OUTPUT_BOUND=16384;
const fail=(code,message=code)=>{throw new BudgetError(code,message);};
const positive=n=>Number.isSafeInteger(n)&&n>0;
const only=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>allowed.includes(k));
const integer=n=>Number.isSafeInteger(n)&&n>=0;
function verifiedUsageResponse(response){
 if(!response.ok)return response;
 if(!response.body||!response.headers.get('content-type')?.includes('text/event-stream'))fail('BUDGET_WIRE_USAGE_REQUIRED');
 const decoder=new TextDecoder();let buffer='',usage,done=false,usageFinal=false;
 const line=value=>{
  if(!value.startsWith('data:'))return;
  const text=value.slice(5).trim();if(!text)return;
  if(text==='[DONE]'){if(!usage||!usageFinal)fail('BUDGET_WIRE_USAGE_REQUIRED','Terminal stream marker omitted verifiable usage; reservation remains uncertain');done=true;return;}
  if(done)fail('BUDGET_WIRE_USAGE_INVALID');
  let event;try{event=JSON.parse(text);}catch{fail('BUDGET_WIRE_USAGE_INVALID');}
  if(event.usage!==undefined&&event.usage!==null){
   const u=event.usage,cached=u.prompt_tokens_details?.cached_tokens??0;
   if(!integer(u.prompt_tokens)||!integer(u.completion_tokens)||!integer(u.total_tokens)||u.total_tokens!==u.prompt_tokens+u.completion_tokens||!integer(cached)||cached>u.prompt_tokens||u.completion_tokens_details?.reasoning_tokens>0)fail('BUDGET_WIRE_USAGE_INVALID');
   const next=JSON.stringify(u);if(usage&&usage!==next)fail('BUDGET_WIRE_USAGE_INVALID');usage=next;usageFinal=Array.isArray(event.choices)&&event.choices.length===0;
  }
 };
 const consume=()=>{let i;while((i=buffer.indexOf('\n'))>=0){const value=buffer.slice(0,i).replace(/\r$/,'');buffer=buffer.slice(i+1);line(value);}if(buffer.length>1048576)fail('BUDGET_WIRE_SSE_LIMIT');};
 const body=response.body.pipeThrough(new TransformStream({
  transform(chunk,controller){buffer+=decoder.decode(chunk,{stream:true});consume();controller.enqueue(chunk);},
  flush(){buffer+=decoder.decode();consume();if(buffer.trim())line(buffer.replace(/\r$/,''));if(!done||!usage||!usageFinal)fail('BUDGET_WIRE_USAGE_REQUIRED','Successful stream omitted verifiable final provider usage; reservation remains uncertain');}
 }));
 return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
}
function textOnly(messages){return Array.isArray(messages)&&messages.every(m=>only(m,['role','content','name','tool_calls','tool_call_id','refusal'])&&['system','developer','user','assistant','tool'].includes(m.role)&&(typeof m.content==='string'||m.content===null||m.content===undefined||Array.isArray(m.content)&&m.content.every(b=>only(b,['type','text'])&&b.type==='text'&&typeof b.text==='string'))&&(m.tool_calls===undefined||Array.isArray(m.tool_calls)&&m.tool_calls.every(t=>only(t,['id','type','function'])&&t.type==='function'&&only(t.function,['name','arguments']))));}
export function createProviderBudgetCall(model,profile){
 // Copy only scalars from the PREPARED adapter snapshot; no later current()
 // lookup and no user-supplied contextWindow/maxTokens may certify a route.
 const route={id:model?.id,api:model?.api,base:model?.baseUrl,reasoning:model?.reasoning,profileApi:profile?.api,upstream:model?.upstreamModel};
 let armed=false,used=false,attempted=false,cap;
 const handle=Object.freeze({
  admit(request){
   if(armed||used)fail('BUDGET_CONTRACT_REUSED');
   if(route.id!==MODEL||route.upstream&&route.upstream!==MODEL||route.api!=='openai-completions'||route.base!=='https://api.openai.com/v1'||route.reasoning===true||request.model!==MODEL)fail('BUDGET_TRUSTED_BOUND_REQUIRED','Only the pinned official text GPT-4o-mini snapshot has a reviewed wire budget contract');
   if(request.maxTokens!==undefined&&!positive(request.maxTokens))fail('BUDGET_INVALID_BOUND');
   cap=Math.min(request.maxTokens??OUTPUT_BOUND,OUTPUT_BOUND);armed=true;
   return Object.freeze({inputTokens:INPUT_BOUND,maxOutputTokens:cap,coversEntireRequest:true,outputCapEnforced:true,singleAttempt:true,usageMode:'cumulative',mediaCovered:false,contract:'openai-text-gpt4omini-20240718-v1'});
  },
  get armed(){return armed;},
  begin(request,fetcher){
   if(!armed)return undefined;
   if(used)fail('BUDGET_CONTRACT_REUSED');used=true;
   if(request.model!==MODEL||!positive(request.maxTokens)||request.maxTokens>cap)fail('BUDGET_WIRE_CAP_REQUIRED');
   const enforcedCap=request.maxTokens;
   // This wrapper is below the real SDK serializer and all adapter transforms.
   // Retries, redirect following and alternate endpoints cannot bypass it.
   return async(input,init)=>{
    if(attempted)fail('BUDGET_SINGLE_ATTEMPT','A budgeted dispatch cannot make a second transport request');
    attempted=true;
    const url=typeof input==='string'?input:input instanceof URL?input.href:input?.url;
    const method=(init?.method??input?.method??'GET').toUpperCase();
    if(url!==ENDPOINT||method!=='POST')fail('BUDGET_WIRE_ENDPOINT');
    let raw=init?.body;
    if(raw===undefined&&typeof input?.clone==='function')raw=await input.clone().text();
    if(typeof raw!=='string')fail('BUDGET_WIRE_BODY');
    let body;try{body=JSON.parse(raw);}catch{fail('BUDGET_WIRE_BODY');}
    if(!only(body,['model','messages','stream','stream_options','max_tokens','max_completion_tokens','temperature','tools','tool_choice','parallel_tool_calls','store','prompt_cache_key','n'])||body.model!==MODEL||body.stream!==true||!only(body.stream_options,['include_usage'])||body.stream_options.include_usage!==true||body.n!==undefined&&body.n!==1||body.store!==undefined&&body.store!==false||!textOnly(body.messages))fail('BUDGET_WIRE_UNSUPPORTED');
    const limits=[body.max_tokens,body.max_completion_tokens].filter(v=>v!==undefined);
    if(limits.length!==1||!positive(limits[0])||limits[0]>enforcedCap)fail('BUDGET_WIRE_CAP_REQUIRED');
    if(body.tools!==undefined&&(!Array.isArray(body.tools)||body.tools.some(t=>!only(t,['type','function'])||t.type!=='function'||!only(t.function,['name','description','parameters','strict']))))fail('BUDGET_WIRE_TOOLS');
    const headers=new Headers(init?.headers??input?.headers);
    if(headers.has('openai-beta'))fail('BUDGET_WIRE_UNSUPPORTED');
    return verifiedUsageResponse(await fetcher(input,{...init,redirect:'error'}));
   };
  }
 });issued.add(handle);return handle;
}
export function resolveProviderBudget(request,context){
 const handle=context?.providerBudgetCall;
 if(!handle||!issued.has(handle))fail('BUDGET_TRUSTED_BOUND_REQUIRED','Adapter has no host-issued prepared wire budget contract');
 return handle.admit(request);
}
export const PROVIDER_BUDGET_CONTRACT=Object.freeze({model:MODEL,endpoint:ENDPOINT,inputTokens:INPUT_BOUND,maxOutputTokens:OUTPUT_BOUND,method:'documented accepted-request capacity envelope; not exact tokenization',source:'https://developers.openai.com/api/docs/models/gpt-4o-mini.md',deprecated:true});
