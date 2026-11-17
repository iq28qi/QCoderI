// Actual staged LlmRuntime + PiAiAdapter + OpenAI SDK. fetch is a local fixture,
// never a paid request. No existing credentials or live archive writes.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,cpSync,symlinkSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';

test('actual SDK pinned official budget wire, one attempt, capacity reserve, unsupported routes and tamper refuse', {timeout:90000},async()=>{
 const base=resolve('harness-base'),source=resolve(process.env.HARNESS_ARCHIVE??join(base,'source'));
 const home=mkdtempSync(join(tmpdir(),'qc-provider-budget-')),stage=join(home,'archive'),packages=join(stage,'dsh/node_modules');
 const oldFetch=globalThis.fetch,oldHome=process.env.DSH_HOME;process.env.DSH_HOME=home;
 let ctx,budget;const calls=[];let mode='ok';
 try{
  mkdirSync(join(packages,'@deepseek-ai'),{recursive:true});mkdirSync(join(packages,'@qcoderi'),{recursive:true});
  for(const name of ['dsh-llm','dsh-llm-pi-ai'])cpSync(join(source,'dsh/node_modules/@deepseek-ai',name),join(packages,'@deepseek-ai',name),{recursive:true});
  cpSync(join(base,'assets/team'),join(packages,'@qcoderi/team'),{recursive:true});
  symlinkSync(join(source,'dsh/node_modules'),join(home,'node_modules'),'junction');
  writeFileSync(join(stage,'package.json'),'{"type":"module"}');
  const python='C:\\Python314\\python.exe',patch=join(base,'scripts/apply-usage-provider.py');
  const live=readFileSync(join(source,'dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js'),'utf8');
  execFileSync(python,[join(base,'scripts/apply-usage-budget.py'),'--archive',stage],{stdio:'inherit'});
  execFileSync(python,[patch,'--archive',stage],{stdio:'inherit'});
  const patched=readFileSync(join(packages,'@deepseek-ai/dsh-llm-pi-ai/lib/index.js'),'utf8');
  execFileSync(python,[patch,'--archive',stage],{stdio:'inherit'});assert.equal(readFileSync(join(packages,'@deepseek-ai/dsh-llm-pi-ai/lib/index.js'),'utf8'),patched);
  execFileSync(python,[join(base,'scripts/apply-usage-budget.py'),'--archive',stage],{stdio:'inherit'});execFileSync(python,[patch,'--archive',stage],{stdio:'inherit'});
  assert.equal(readFileSync(join(packages,'@deepseek-ai/dsh-llm-pi-ai/lib/index.js'),'utf8'),patched,'entire patch chain idempotent');
  const load=(name,local=false)=>import(pathToFileURL(join(local?stage:source,'dsh/node_modules/@deepseek-ai',name,'lib/index.js')).href);
  const {Context}=await load('cordis'),llm=await load('dsh-llm',true),pi=await load('dsh-llm-pi-ai',true);
  const owned=name=>import(pathToFileURL(join(packages,'@qcoderi/team',name+'.js')).href);
  const {installUsageBudget}=await owned('usage-budget'),{resolveProviderBudget,createProviderBudgetCall}=await owned('usage-provider-contract');
  assert.throws(()=>resolveProviderBudget({},{providerBudgetCall:{admit:()=>({})}}),/host-issued/);
  ctx=new Context();await ctx.plugin(llm.default,{});
  globalThis.fetch=async(input,init)=>{
   const url=typeof input==='string'?input:input.url??String(input),method=init?.method??input?.method??'GET';
   if(method==='GET')return new Response('{"data":[]}',{headers:{'content-type':'application/json'}});
   const body=JSON.parse(init?.body??await input.clone().text());calls.push({url,body,redirect:init?.redirect});
   assert.equal(url,'https://api.openai.com/v1/chat/completions');assert.equal(init.redirect,'error');
   if(['429','413'].includes(mode))return new Response(JSON.stringify({error:{message:mode==='413'?'payload too large':'rate limit',type:'rate_limit_error'}}),{status:Number(mode),headers:{'content-type':'application/json','retry-after':'0'}});
   const event=data=>'data: '+JSON.stringify(data)+'\n\n';
   const model=body.model,common={id:'chat_fixture',object:'chat.completion.chunk',created:1,model};
   const wire=event({...common,choices:[{index:0,delta:{role:'assistant',content:'OK'},finish_reason:null}]})+event({...common,choices:[{index:0,delta:{},finish_reason:'stop'}]})+(mode==='missing-usage'?'':event({...common,choices:[],usage:{prompt_tokens:7,completion_tokens:2,total_tokens:mode==='malformed-usage'?1:9,prompt_tokens_details:{cached_tokens:0}}}))+'data: [DONE]\n\n';
   // One event per pull, as with a real network stream; do not rely on
    // all bytes being validated in one Response(string) chunk.
    const parts=wire.match(/[^]*?\n\n/g),encoder=new TextEncoder();
    return new Response(new ReadableStream({pull(controller){const next=parts.shift();if(next===undefined)controller.close();else controller.enqueue(encoder.encode(next));}}),{headers:{'content-type':'text/event-stream'}});
  };
  const model='gpt-4o-mini-2024-07-18';
  const profile={api:'openai-completions',baseURL:'https://api.openai.com/v1',apiKeyEnv:'UNUSED_FIXTURE',models:[{id:model}],retryPolicy:{mode:'always'}};
  const providers={official:profile,proxy:{...profile,baseURL:'https://proxy.invalid/v1'},alias:{...profile,models:[{id:'gpt-4o-mini'}]}};
  // Avoid credential infrastructure: construct actual PiAiAdapter via config
  // resolution from the real plugin, fixture credentials only in isolated home.
  writeFileSync(join(home,'credentials.yaml'),'version: 1\nrefs:\n  UNUSED_FIXTURE: fixture-only-not-a-secret\n');
  await ctx.plugin((await load('dsh-credentials-local')).default,{path:join(home,'credentials.yaml'),watch:false});
  await ctx.plugin(pi.default??pi,{providers});
  const human=Object.freeze({});budget=installUsageBudget(ctx,{home:join(home,'ledger'),authorizeHuman:p=>p===human,getTrustedBounds:resolveProviderBudget,resolveProject:()=>undefined});
  const prices=Object.entries(providers).map(([provider,p])=>({provider,model:p.models[0].id,currency:'USD',inputPerMillion:'0.15',outputPerMillion:'0.6',cacheReadPerMillion:'0.075',cacheWritePerMillion:'0.15',maxTokensIncludesReasoning:true}));
  const policy={scope:'global',callsEnabled:true,moneyCapUsd:'1',tokenCap:300000,prices};budget.handle('configure',policy,human);
  const request={provider:'official',model,maxTokens:23,sessionId:'fixture',messages:[llm.createUserMessage({content:[{type:'text',text:'local fixture'}]})]};
  const collect=async req=>{const chunks=[];for await(const x of ctx.llm.stream(req))chunks.push(x);return chunks;};
  let chunks=await collect(request);assert(chunks.some(x=>x.type==='text-delta'),JSON.stringify(chunks));assert.equal(calls.length,1);assert.equal(calls[0].body.max_completion_tokens??calls[0].body.max_tokens,23);assert.equal(calls[0].body.stream_options.include_usage,true);
  assert.equal(budget.modelStatus().scopes[0].spent.tokens,9);assert.equal(budget.modelStatus().pending.length,0);
  const prepared=await ctx.llm.prepareCall({provider:'official',model,maxTokens:11});chunks=[];for await(const x of prepared.stream({...request,...prepared.config}))chunks.push(x);assert(chunks.some(x=>x.type==='text-delta'),JSON.stringify(chunks));assert.equal(calls.length,2);
  const before=calls.length;
  for(const req of [{...request,provider:'proxy'},{...request,provider:'alias',model:'gpt-4o-mini'},{...request,maxTokens:999999,model:'gpt-4o-mini'}]){chunks=await collect(req);assert(chunks.some(x=>x.type==='finish'&&x.reason.kind==='error'));assert.equal(calls.length,before);}
  budget.handle('configure',{...policy,tokenCap:100},human);chunks=await collect(request);assert.equal(calls.length,before);assert(chunks.some(x=>x.reason?.failure?.code==='BUDGET_TOKEN_LIMIT'),JSON.stringify(chunks));
  budget.handle('configure',policy,human);
  for(const failure of ['429','413','missing-usage','malformed-usage']){mode=failure;const n=calls.length;chunks=await collect(request);assert.equal(calls.length,n+1,'failure cannot auto retry');assert.equal(budget.modelStatus().pending.length,1);const pending=budget.modelStatus().pending[0];budget.handle('reconcile',{id:pending.id,chargeReserved:true,acknowledgeUnknown:true},human);budget.handle('reset',{scope:'global'},human);}
  // Standalone issued handle cannot permit redirect, second transport, media or
  // output cap tampering even if the SDK/profile changed after admission.
  for(const mutate of [b=>b.model='gpt-4o-mini',b=>b.max_completion_tokens=999999,b=>b.web_search_options={},b=>b.n=2,b=>b.messages=[{role:'assistant',content:'text',audio:{id:'other-billable'}}],b=>b.messages=[{role:'user',content:[{type:'image_url',image_url:{url:'x'}}]}]]){
   const cap=createProviderBudgetCall({id:model,api:'openai-completions',baseUrl:'https://api.openai.com/v1',reasoning:false},{});resolveProviderBudget(request,{providerBudgetCall:cap});let entered=0;const fetcher=cap.begin(request,async()=>{entered++;});const body={model,messages:[{role:'user',content:'text'}],stream:true,stream_options:{include_usage:true},max_completion_tokens:23};mutate(body);await assert.rejects(fetcher('https://api.openai.com/v1/chat/completions',{method:'POST',body:JSON.stringify(body)}));assert.equal(entered,0);
  }
  const cap=createProviderBudgetCall({id:model,api:'openai-completions',baseUrl:'https://api.openai.com/v1'},{});resolveProviderBudget(request,{providerBudgetCall:cap});let entered=0;const fetcher=cap.begin(request,async()=>{entered++;return new Response('data: '+JSON.stringify({choices:[],usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});});const init={method:'POST',body:JSON.stringify({model,messages:[],stream:true,stream_options:{include_usage:true},max_completion_tokens:23})};await fetcher('https://api.openai.com/v1/chat/completions',init);await assert.rejects(fetcher('https://api.openai.com/v1/chat/completions',init),/second transport/);assert.equal(entered,1);
  assert.equal(readFileSync(join(source,'dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js'),'utf8'),live);
  console.log('PASS actual SDK budget: official pinned route, documented capacity, settled usage, direct/prepared, pre-adapter limit, one transport on429/413, tamper/media/proxy reject; no paid calls');
 }finally{budget?.close();if(ctx)await ctx.fiber.dispose();globalThis.fetch=oldFetch;if(oldHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=oldHome;rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
