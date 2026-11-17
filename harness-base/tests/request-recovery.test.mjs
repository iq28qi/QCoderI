import assert from 'node:assert/strict';
import {qcRecoverRequest} from '../assets/request-recovery.js';
import {adaptModelTask, classifyTaskFailure, terminalProviderRateLimit} from '../assets/model-task-adapter.js';
const messages=[
  {role:'system',content:[{type:'text',text:'Контекст исследования'}]},
  {role:'system',content:[{type:'text',text:'Разрешения и критерии'}]},
  {role:'user',content:[{type:'text',text:'Проверь локальный файл и сохрани отчёт'}]},
  {role:'user',content:[{type:'tool-result',toolCallId:'check-1',isError:true,content:[{type:'text',text:'Файл отсутствует'}]}]},
];
const tools=[{name:'read',parameters:{type:'object',properties:{path:{type:'string'}}}}];
const options={messages,tools};
for(const api of ['openai-responses','anthropic-messages','google-generative-ai','openai-completions']){
  const adapted=adaptModelTask(options,{api});
  assert.equal(adapted.system,'Контекст исследования\n\nРазрешения и критерии');
  assert.deepEqual(adapted.messages,messages.slice(2));
  assert.strictEqual(adapted.tools,tools);
}
const explicit={...options,system:'Явная системная инструкция'};
assert.strictEqual(adaptModelTask(explicit,{api:'openai-responses'}),explicit);
assert.equal(classifyTaskFailure({code:'RATE_LIMIT'}),'api_limit');
assert.equal(classifyTaskFailure({code:'TIMEOUT'}),'transport');
assert.equal(classifyTaskFailure({code:'INVALID_REQUEST',message:'400: {"message":"The flagged content field is not supported"}'}),'api_limit');
assert.equal(classifyTaskFailure({code:'PI_AI_ERROR',message:'Provider finish_reason: content_filter'}),'provider_policy');
const blockedRateLimit={code:'RATE_LIMIT',message:'429: {"code":"resale_multi_ip_detected","do_not_auto_retry":true,"request_id":"fixture-id"}'};
assert.equal(terminalProviderRateLimit(blockedRateLimit).requestId,'fixture-id');
assert.equal(terminalProviderRateLimit({code:'RATE_LIMIT',message:'429: {"error":{"do_not_auto_retry":true}}'}).code,'PROVIDER_NO_RETRY');
for(const message of ['429: {"do_not_auto_retry":false}','429: {"do_not_auto_retry":"true"}','429: {"message":"slow down"}']){
  assert.equal(terminalProviderRateLimit({code:'RATE_LIMIT',message}),undefined);
}
const failure={type:'finish',reason:{kind:'error',failure:{code:'INVALID_REQUEST',message:'400: {"message":"Failed to read request body","type":"invalid_request_error"}'}}};
let calls=0;const collect=async iterator=>{const result=[];for await(const chunk of iterator)result.push(chunk);return result;};
let result=await collect(qcRecoverRequest(async function*(snapshot){calls++;yield{type:'usage',usage:{inputTokens:0}};if(calls===1)yield failure;else{assert(snapshot.compact);yield{type:'text-delta',index:0,text:'ok'};yield{type:'finish',reason:{kind:'stop'}};}},{},value=>({...value,compact:true})));
assert.equal(calls,2);assert.equal(result.filter(x=>x.type==='finish').length,1);assert.equal(result.filter(x=>x.type==='usage').length,1);
calls=0;result=await collect(qcRecoverRequest(async function*(){calls++;yield{type:'tool-call-delta',name:'generate_image'};yield failure;},{},value=>value));assert.equal(calls,1);
calls=0;result=await collect(qcRecoverRequest(async function*(){calls++;yield failure;},{},value=>value));assert.equal(calls,2);assert(result.at(-1).reason.failure.message.includes('Исходники и история сохранены'));
for(const message of ['400: unsupported parameter','401: invalid key','500: connection closed']){calls=0;await collect(qcRecoverRequest(async function*(){calls++;yield{...failure,reason:{kind:'error',failure:{message}}};},{},value=>value));assert.equal(calls,1);}
calls=0;result=await collect(qcRecoverRequest(async function*(){calls++;yield{...failure,reason:{kind:'error',failure:{code:'PI_AI_ERROR',message:"The upstream provider's content safety policy blocked this request. The flagged content may be in your prompt, in earlier messages of this conversation, or in memory/instruction files.",status:403,requestId:'req-fixture'}}};},{},value=>value,undefined,{provider:'aws',model:'gpt-6-astra'}));
assert.equal(calls,1);
const policy=result.at(-1).reason.failure;
assert.equal(policy.code,'CONTENT_POLICY');
assert.equal(policy.requestId,'req-fixture');
assert.match(policy.message,/aws \/ gpt-6-astra.*HTTP 403.*req-fixture/);
assert(!policy.message.includes('историю текущего диалога'), 'avoid blaming chat history when the provider returned no location');
const controller=new AbortController();controller.abort();await assert.rejects(collect(qcRecoverRequest(async function*(){assert.fail();},{},x=>x,controller.signal)));
console.log('PASS: one compact retry for explicit request-body rejection, no replay after content/tool output, no retries for unrelated 400/auth/network errors, preserved cancellation');
