// Focused actual Workbench + final LlmRuntime budget boundary; fixture adapter only.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const archive=resolve(process.env.HARNESS_ARCHIVE);assert(archive.includes('tests\\.runtime\\')||archive.includes('tests/.runtime/'));
const evidencePath=process.env.QCODERI_BUDGET_EVIDENCE;
const home=await mkdtemp(join(tmpdir(),'qc-workbench-budget-')),project=join(home,'project');await mkdir(project);process.env.DSH_HOME=home;
const load=name=>import(pathToFileURL(join(archive,'dsh/node_modules/@deepseek-ai',name,'lib/index.js')).href);
const {Context}=await load('cordis'),{LlmAdapter,createUserMessage}=await load('dsh-llm'),{installWorkbench}=await import(pathToFileURL(join(archive,'dsh/node_modules/@qcoderi/team/workbench.js')).href);
const ctx=new Context();let handle,adapterCalls=0;const watchdog=setTimeout(()=>process.exit(2),45000);
try{
 for(const name of ['dsh-skill','dsh-session','dsh-session-projection','dsh-llm','dsh-system-prompt','dsh-tools','dsh-agent','dsh-agent-loop','dsh-subagent','dsh-subagent-spawn-in-process'])await ctx.plugin((await load(name)).default??await load(name),{});
 await ctx.plugin((await load('dsh-attachment-local')).default,{dshHome:home});
 const workbench=installWorkbench(ctx,{home:join(home,'workbench'),remote:false});
 class Adapter extends LlmAdapter{resolveModel(provider,id){return Promise.resolve({provider,id,name:id,inputModalities:['text']});}async *stream(){adapterCalls++;yield{type:'text-delta',index:0,text:'fixture'};yield{type:'finish',reason:{kind:'stop'}};}}
 ctx.llm.registerAdapter(['fixture'],new Adapter());handle=await ctx.agents.create({sessionId:'budget-panel',meta:{cwd:project},agentOptions:{provider:'fixture',model:'text'}});const agent=handle.agent;
 const request={provider:'fixture',model:'text',sessionId:agent.id,messages:[createUserMessage({content:[{type:'text',text:'fixture input'}]})]};
 const collect=async()=>{const chunks=[];for await(const chunk of ctx.llm.stream(request))chunks.push(chunk);return chunks;};
 assert.equal(ctx.llm.usageBudgetBoundaryVersion,1);
 const tool=async args=>{const result=await ctx.tools.execute({name:'usage_budget',arguments:args,agent,callId:'budget-status',signal:AbortSignal.timeout(5000)});assert(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text);};
 assert.equal((await tool({role:'human',operation:'configure',tokenCap:9999999})).configured,false,'model JSON cannot configure policy');
 assert((await collect()).some(c=>c.type==='text-delta'));assert.equal(adapterCalls,1,'unconfigured default retains legacy behavior');
 await assert.rejects(workbench.request({sessionId:agent.id,action:'budget',args:{action:'configure',policy:{scope:'project',callsEnabled:true,moneyCapUsd:'1',tokenCap:100}}}), error=>{
  assert.equal(error.code,'BUDGET_GLOBAL_POLICY_REQUIRED');
  assert.match(error.message,/Сначала задайте цены моделей/);
  return true;
 });
 assert.equal((await tool({})).configured,false);
 const policy={scope:'global',callsEnabled:true,moneyCapUsd:'1',tokenCap:100,prices:[{provider:'fixture',model:'text',currency:'USD',inputPerMillion:'1',outputPerMillion:'2',cacheReadPerMillion:'0.1',cacheWritePerMillion:'1',maxTokensIncludesReasoning:true}]};
 await workbench.request({sessionId:agent.id,action:'budget',args:{action:'configure',policy}});
 assert.equal((await tool({})).configured,true);
 let chunks=await collect();assert.equal(adapterCalls,1,'enabled uncertified provider refused before adapter dispatch');assert(chunks.some(c=>c.type==='finish'&&c.reason.kind==='error'&&c.reason.failure.code==='BUDGET_TRUSTED_BOUND_REQUIRED'),JSON.stringify(chunks));
 await workbench.request({sessionId:agent.id,action:'budget',args:{action:'configure',policy:{...policy,callsEnabled:false}}});
 assert.equal((await tool({})).scopes.find(x=>x.policy.scope==='global').policy.callsEnabled,false);
 chunks=await collect();assert.equal(adapterCalls,1);assert(chunks.some(c=>c.type==='finish'&&c.reason.kind==='error'&&['BUDGET_CALLS_DISABLED','BUDGET_TRUSTED_BOUND_REQUIRED'].includes(c.reason.failure.code)),JSON.stringify(chunks));
 if(evidencePath)await writeFile(evidencePath,JSON.stringify({schema_version:1,archive,status:'passed',adapterCalls,read_only_tool:true,human_panel_policy:true,unsupported_route_denied_before_adapter:true,disabled_policy_denied:true,paid_calls:false},null,2));
 console.log('PASS: actual Workbench human policy + read-only tool + unconfigured compatibility + final-boundary typed refusal BEFORE adapter, disabled policy never bypassed');
 if(process.env.QCODERI_TEST_OFFICIAL_BUDGET==='1'){
  const originalFetch=globalThis.fetch;let wireCalls=0;
  try{
   const model='gpt-4o-mini-2024-07-18';
   globalThis.fetch=async(input,init)=>{const method=init?.method??input?.method??'GET';if(method==='GET')return new Response('{"data":[]}',{headers:{'content-type':'application/json'}});wireCalls++;assert.equal(typeof input==='string'?input:input.url,'https://api.openai.com/v1/chat/completions');const body=JSON.parse(init?.body??await input.clone().text());assert.equal(body.max_completion_tokens??body.max_tokens,12);assert.equal(init.redirect,'error');const event=x=>'data: '+JSON.stringify(x)+'\n\n',common={id:'wb_fixture',model,object:'chat.completion.chunk',created:1};return new Response(event({...common,choices:[{index:0,delta:{role:'assistant',content:'OK'},finish_reason:null}]})+event({...common,choices:[{index:0,delta:{},finish_reason:'stop'}]})+event({...common,choices:[],usage:{prompt_tokens:8,completion_tokens:2,total_tokens:10}})+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});};
   await writeFile(join(home,'credentials.yaml'),'version: 1\nrefs:\n  BUDGET_FIXTURE: fixture-not-a-real-key\n');
   await ctx.plugin((await load('dsh-credentials-local')).default,{path:join(home,'credentials.yaml'),watch:false});
   const pi=await load('dsh-llm-pi-ai');await ctx.plugin(pi.default??pi,{providers:{official:{api:'openai-completions',baseURL:'https://api.openai.com/v1',apiKeyEnv:'BUDGET_FIXTURE',models:[{id:model}]}}});
   const officialPolicy={scope:'global',callsEnabled:true,moneyCapUsd:'1',tokenCap:300000,prices:[{provider:'official',model,currency:'USD',inputPerMillion:'0.15',outputPerMillion:'0.6',cacheReadPerMillion:'0.075',cacheWritePerMillion:'0.15',maxTokensIncludesReasoning:true}]};
   const panel=policy=>workbench.request({sessionId:agent.id,action:'budget',args:{action:'configure',policy}});
   await panel(officialPolicy);await panel({scope:'project',callsEnabled:true,tokenCap:300000,moneyCapUsd:'1'});
   const req={...request,provider:'official',model,maxTokens:12};const run=async r=>{const chunks=[];for await(const x of ctx.llm.stream(r))chunks.push(x);return chunks;};
   let actual=await run(req);assert(actual.some(x=>x.type==='text-delta'),JSON.stringify(actual));assert.equal(wireCalls,1);const state=await tool({});assert.equal(state.scopes.length,2);assert(state.scopes.every(s=>s.spent.tokens===10),'global and original project both charged');
   actual=await run({...req,sessionId:'unknown-budget-session',project});assert.equal(wireCalls,1);assert(actual.some(x=>x.reason?.failure?.code==='BUDGET_SESSION_NOT_FOUND'),JSON.stringify(actual));
   await panel({...officialPolicy,moneyCapUsd:'0.000001'});actual=await run(req);assert.equal(wireCalls,1);assert(actual.some(x=>x.reason?.failure?.code==='BUDGET_MONEY_LIMIT'),JSON.stringify(actual));
   if(evidencePath)await writeFile(evidencePath,JSON.stringify({schema_version:1,archive,status:'passed',provider:'official',model,wireCalls,real_sdk:true,read_only_tool:true,human_panel_policy:true,unsupported_route_denied_before_adapter:true,original_project_and_global_charged:true,unknown_session_denied:true,money_limit_denied_before_transport:true,paid_calls:false},null,2));
   console.log('PASS actual Workbench + official SDK wire + human USD/token configuration + original project/global settlement + unknown session/money refusal before transport');
  }finally{globalThis.fetch=originalFetch;}
 }
}finally{await handle?.dispose();await ctx.fiber.dispose();clearTimeout(watchdog);await rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
