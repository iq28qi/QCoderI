// Real adapter + SDK serializers + AgentLoop; HTTP is intercepted, no paid calls.
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const base=resolve(fileURLToPath(new URL('..',import.meta.url)));
const archive=resolve(process.env.HARNESS_ARCHIVE??join(base,'source'));
const load=name=>import(pathToFileURL(join(archive,'dsh/node_modules/@deepseek-ai',name,'lib/index.js')).href);
const {Context}=await load('cordis');
const {createUserMessage}=await load('dsh-llm');
const home=mkdtempSync(join(tmpdir(),'qcoderi-reasoning-'));
writeFileSync(join(home,'credentials.yaml'),'version: 1\nrefs:\n  FIXTURE_KEY: fixture-only\n  FIXTURE_KEY_B: fixture-other\n');
const originalFetch=globalThis.fetch;
const requests=[];
const catalogRequests=[];
let scriptedFailure;
const event=(name,data)=>`${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
globalThis.fetch=async(input,init)=>{
  const url=typeof input === 'string' ? input : input.url ?? String(input);
  assert(url.startsWith('https://reasoning.invalid/'), 'all HTTP must target the intercepted fixture');
  if(init?.method === 'GET') {
    const auth=new Headers(init.headers).get('authorization');
    catalogRequests.push({url,auth});
    const supported=url.includes('/other/') ? ['medium'] : auth === 'Bearer fixture-other' ? ['high'] : ['low','max'];
    return new Response(JSON.stringify({data:[{id:'opaque-alias',effort:{supported_levels:supported}},{id:'friendly-alias',canonical_model:'kimi-k3.1-pro'},{id:'gpt-6-sol-muted',reasoning:false}]}),{headers:{'content-type':'application/json'}});
  }
  const body=JSON.parse(init?.body ?? await input.text());
  const path=new URL(url).pathname;
  requests.push({url,body});
  if (scriptedFailure?.remaining > 0) {
    scriptedFailure.remaining--;
    return new Response(JSON.stringify(scriptedFailure.body),{status:scriptedFailure.status??429,headers:{'content-type':'application/json',...scriptedFailure.headers}});
  }
  let wire;
  if(path.endsWith('/messages')) {
    wire=event('message_start',{type:'message_start',message:{id:'msg_fixture',type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:0}}})
      +event('content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}})
      +event('content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'OK'}})
      +event('content_block_stop',{type:'content_block_stop',index:0})
      +event('message_delta',{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:1}})
      +event('message_stop',{type:'message_stop'});
  } else if(path.endsWith('/responses')) {
    const message={type:'message',id:'msg_fixture',role:'assistant',status:'completed',content:[{type:'output_text',text:'OK',annotations:[]}]};
    const response={id:'resp_fixture',object:'response',model:'actual-responses-fixture',created_at:1,status:'in_progress',output:[]};
    wire=event('response.created',{type:'response.created',response})
      +event('response.output_item.added',{type:'response.output_item.added',output_index:0,item:{...message,status:'in_progress',content:[]}})
      +event('response.content_part.added',{type:'response.content_part.added',item_id:message.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}})
      +event('response.output_text.delta',{type:'response.output_text.delta',item_id:message.id,output_index:0,content_index:0,delta:'OK'})
      +event('response.output_item.done',{type:'response.output_item.done',output_index:0,item:message})
      +event('response.completed',{type:'response.completed',response:{...response,status:'completed',output:[message],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});
  } else {
    assert(path.endsWith('/chat/completions'));
    const reported=body.model==='friendly-alias'?'actual-chat-fixture':body.model;
    wire=event('',{id:'chat_fixture',object:'chat.completion.chunk',created:1,model:reported,choices:[{index:0,delta:{role:'assistant',content:'OK'},finish_reason:null}]})
      +event('',{id:'chat_fixture',object:'chat.completion.chunk',created:1,model:reported,choices:[{index:0,delta:{},finish_reason:'stop'}]})+'data: [DONE]\n\n';
  }
  return new Response(wire,{headers:{'content-type':'text/event-stream'}});
};
const ctx=new Context();
const watchdog=setTimeout(()=>{console.error('Reasoning integration timed out');process.exit(1)},30000);
const chatModels=[{id:'kimi-k3-1-pro'},{id:'deepseek-v4.1-flash-1017'},{id:'gpt-6.1-sol'},{id:'cx/gpt-6-luna'},{id:'glm-5.3'},{id:'seedance-2.5'},{id:'kling-3.0-pro'},{id:'unknown'},{id:'opaque-alias'},{id:'friendly-alias'},{id:'gpt-6-sol-muted'},{id:'gpt-6-sol',reasoningEfforts:false},{id:'custom',reasoningEfforts:{off:'none',low:'fast',high:'careful'},compat:{thinkingFormat:'openai',supportsReasoningEffort:true}}];
const providers={chat:{api:'openai-completions',models:chatModels},responses:{api:'openai-responses',models:[{id:'gpt-6.1-sol'}]},claude:{api:'anthropic-messages',models:[{id:'anthropic/claude-sonnet-5.5'}]}};
for(const mode of ['normal','always']) {
  providers['retry-'+mode]={api:'openai-completions',models:[{id:'retry-fixture'}],
    retryPolicy:{mode,backoff:{initialDelayMs:1,maxDelayMs:10,jitterRatio:0}}};
}
for(const provider of Object.values(providers)) Object.assign(provider,{baseURL:'https://reasoning.invalid/v1',apiKeyEnv:'FIXTURE_KEY'});
const info=(provider,model)=>ctx.llm.resolveModelInfo(provider,model);
let serial=0;
try {
  for(const name of ['dsh-session','dsh-session-projection','dsh-llm','dsh-system-prompt','dsh-tools','dsh-agent','dsh-agent-loop','dsh-llm-retry']) await ctx.plugin((await load(name)).default??await load(name),{});
  await ctx.plugin((await load('dsh-settings-file')).default,{path:join(home,'settings.yaml'),watch:false});
  await ctx.plugin((await load('dsh-credentials-local')).default,{path:join(home,'credentials.yaml'),watch:false});
  await ctx.plugin((await load('dsh-agent-default-model')).default,{provider:'chat',model:'kimi-k3-1-pro'});
  await ctx.plugin(await load('dsh-llm-pi-ai'),{providers});
  for(let i=0;i<100&&(!ctx.get('agentLoop')||!ctx.llm.listProviders().some(p=>p.id==='chat'));i++)await delay(10);
  assert.deepEqual((await info('chat','kimi-k3-1-pro')).reasoning.efforts.map(e=>e.id),['low','high','max']);
  assert.deepEqual((await info('chat','deepseek-v4.1-flash-1017')).reasoning.efforts.map(e=>e.id),['off','low','high','max']);
  assert.deepEqual((await info('chat','gpt-6.1-sol')).reasoning.efforts.map(e=>e.id),['low','medium','high','xhigh','max']);
  for(const model of ['seedance-2.5','kling-3.0-pro','unknown','gpt-6-sol','gpt-6-sol-muted']) assert.equal((await info('chat',model)).reasoning,undefined);
  assert.deepEqual((await info('chat','opaque-alias')).reasoning.efforts.map(e=>e.id),['low','max']);
  assert.equal((await info('chat','friendly-alias')).upstreamModel,'kimi-k3.1-pro');
  assert.equal((await info('chat','opaque-alias')).upstreamModel,undefined);
  assert.deepEqual((await info('chat','friendly-alias')).reasoning.efforts.map(e=>e.id),['low','high','max']);
  assert.equal(catalogRequests.length,1,'parallel and repeated model lookups share a connection-scoped catalog');
  const {qcDiscoverReasoning}=await import(pathToFileURL(join(archive,'dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/qcoderi-reasoning.js')).href);
  const customAuth=await qcDiscoverReasoning({api:'openai-completions',baseUrl:'https://reasoning.invalid/header/v1'},'fixture-only',{Authorization:'Bearer fixture-other'});
  assert.deepEqual(customAuth[0].effort.supported_levels,['high'],'explicit provider auth headers take precedence over ambient keys');
  assert.equal((await info('chat','glm-5.3')).reasoning.efforts[0].name,'Включено');
  for(const mode of ['normal','always']) {
    for(const blocked of [false,true]) {
      const before=requests.length;
      scriptedFailure={remaining:1,body:blocked
        ? {message:'Обнаружено одновременное использование ключа с нескольких IP.',type:'rate_limit_error',code:'resale_multi_ip_detected',outcome:'not_executed',do_not_auto_retry:true}
        : {error:{message:'Slow down',type:'rate_limit_error',code:'rate_limit'}}};
      const handle=await ctx.agents.create({sessionId:`rate-limit-${mode}-${blocked}`,
        agentOptions:{provider:'retry-'+mode,model:'retry-fixture'}});
      try {
        handle.agent.followup(createUserMessage({content:[{type:'text',text:'Верни OK'}],source:{kind:'user'}}));
        await handle.agent.whenIdle();
        const events=handle.agent.session.snapshotEvents();
        const reason=events.findLast(event=>event.type==='turn/end').data.reason;
        assert.equal(requests.length-before,blocked?1:2,JSON.stringify({mode,reason,retries:events.filter(event=>event.type==='llm/retry').map(event=>event.data.failure)}));
        assert.equal(events.filter(event=>event.type==='llm/retry').length,blocked?0:1);
        if(blocked){
          assert.equal(reason.error.code,'PROVIDER_NO_RETRY');
          assert.match(reason.error.message,/нескольких IP-адресов/);
        }else assert.equal(reason.kind,'completed',JSON.stringify(reason));
      } finally {scriptedFailure=undefined;await handle.dispose();}
    }
  }
  console.log('PASS: provider 429 veto stops real agent retries in both modes; ordinary 429 still retries');
  const policyStart=requests.length;
  scriptedFailure={remaining:1,status:403,headers:{'x-request-id':'req-policy-fixture'},
    body:{error:{code:'content_policy_violation',message:'Provider refusal'}}};
  const policyHandle=await ctx.agents.create({sessionId:'policy-always',
    agentOptions:{provider:'retry-always',model:'retry-fixture'}});
  try {
    const question='Что в Blender нужно для реалистичного портрета, рига лица и анимации?';
    policyHandle.agent.followup(createUserMessage({content:[{type:'text',text:question}],source:{kind:'user'}}));
    await policyHandle.agent.whenIdle();
    const events=policyHandle.agent.session.snapshotEvents();
    const {error}=events.findLast(event=>event.type==='turn/end').data.reason;
    assert.equal(error.code,'CONTENT_POLICY');
    assert.match(error.message,/retry-always \/ retry-fixture.*HTTP 403.*content_policy_violation.*req-policy-fixture/);
    assert.equal(requests.length-policyStart,1,'policy response must halt even the always retry mode');
    assert(!events.some(event=>event.type==='llm/retry'));
    assert(JSON.stringify(requests.at(-1).body.messages).includes(question),'the user question reaches the provider unchanged');
  } finally {scriptedFailure=undefined;await policyHandle.dispose();}
  console.log('PASS: live request pipeline preserves structured policy diagnostics and stops always retry');
  const run=async(provider,model,reasoningEffort)=>{
    const before=requests.length;
    const handle=await ctx.agents.create({sessionId:`reasoning-${++serial}`,agentOptions:{provider,model,...reasoningEffort === undefined ? {} : {reasoningEffort}}});
    try {
      handle.agent.followup(createUserMessage({content:[{type:'text',text:'Верни OK'}],source:{kind:'user'}}));
      await handle.agent.whenIdle();
      const events=handle.agent.session.snapshotEvents();
      assert.equal(events.findLast(e=>e.type==='turn/end')?.data.reason.kind,'completed',JSON.stringify(events.filter(e=>e.type==='step/end'||e.type==='turn/end')));
      assert.equal(requests.length,before+1);
      assert(events.some(e=>e.type==='assistant/message'&&e.data.message.content.some(b=>b.type==='text'&&b.text==='OK')));
      if(provider==='responses') {
        assert.equal(events.findLast(e=>e.type==='assistant/message').data.message.source.replayState.response.responseModel,'actual-responses-fixture');
        handle.agent.followup(createUserMessage({content:[{type:'text',text:'Кто ты на самом деле?'}],source:{kind:'user'}}));
        await handle.agent.whenIdle();
        assert.match(handle.agent.session.snapshotEvents().findLast(e=>e.type==='assistant/message').data.message.content[0].text,/последнему ответу провайдера — actual-responses-fixture/);
        assert.equal(requests.length,before+1);
      }
      const {body}=requests.at(-1);
      assert.equal(body.model,model);
      assert(JSON.stringify(body.messages??body.input).includes('Верни OK'));
      return body;
    } finally {await handle.dispose();}
  };
  const catalogIdentity=await ctx.agents.create({sessionId:'catalog-identity',agentOptions:{provider:'chat',model:'friendly-alias'}});
  try {
    const before=requests.length;
    catalogIdentity.agent.followup(createUserMessage({content:[{type:'text',text:'Какая модель стоит за этим алиасом?'}],source:{kind:'user'}}));
    await catalogIdentity.agent.whenIdle();
    assert.match(catalogIdentity.agent.session.snapshotEvents().findLast(e=>e.type==='assistant/message').data.message.content[0].text,
      /По каталогу провайдера за friendly-alias стоит модель kimi-k3\.1-pro/);
    assert.equal(requests.length,before);
    catalogIdentity.agent.followup(createUserMessage({content:[{type:'text',text:'Верни OK'}],source:{kind:'user'}}));
    await catalogIdentity.agent.whenIdle();
    catalogIdentity.agent.followup(createUserMessage({content:[{type:'text',text:'Что ты за модель на самом деле?'}],source:{kind:'user'}}));
    await catalogIdentity.agent.whenIdle();
    assert.match(catalogIdentity.agent.session.snapshotEvents().findLast(e=>e.type==='assistant/message').data.message.content[0].text,
      /последнему ответу провайдера — actual-chat-fixture/);
    assert.equal(requests.length,before+1);
  } finally {await catalogIdentity.dispose();}
  const high=await run('chat','kimi-k3-1-pro','high');
  assert.equal(high.reasoning_effort,'high'); assert.equal(high.thinking,undefined);
  const max=await run('chat','kimi-k3-1-pro','max');
  assert.equal(max.reasoning_effort,'max'); assert.deepEqual(max.messages,high.messages,'effort never modifies the prompt');
  const defaultKimi=await run('chat','kimi-k3-1-pro');
  assert.equal(defaultKimi.reasoning_effort,undefined); assert.equal(defaultKimi.thinking,undefined); assert.deepEqual(defaultKimi.messages,high.messages);
  const deepseek=await run('chat','deepseek-v4.1-flash-1017','max');
  assert.equal(deepseek.reasoning_effort,'max'); assert.deepEqual(deepseek.thinking,{type:'enabled'});
  const off=await run('chat','deepseek-v4.1-flash-1017','off');
  assert.deepEqual(off.thinking,{type:'disabled'}); assert.equal(off.reasoning_effort,undefined);
  const providerDefault=await run('chat','deepseek-v4.1-flash-1017');
  assert.equal(providerDefault.thinking,undefined); assert.equal(providerDefault.reasoning_effort,undefined);
  assert.equal((await run('chat','gpt-6.1-sol','xhigh')).reasoning_effort,'xhigh');
  assert.equal((await run('chat','cx/gpt-6-luna','off')).reasoning_effort,'none');
  assert.equal((await run('chat','custom','high')).reasoning_effort,'careful');
  const glm=await run('chat','glm-5.3','high');
  assert.equal(glm.thinking.type,'enabled'); assert.equal(glm.reasoning_effort,undefined);
  assert.equal((await run('chat','glm-5.3')).thinking,undefined);
  const claude=await run('claude','anthropic/claude-sonnet-5.5','max');
  assert.equal(claude.thinking.type,'adaptive'); assert.equal(claude.output_config.effort,'max');
  const defaultClaude=await run('claude','anthropic/claude-sonnet-5.5');
  assert.equal(defaultClaude.thinking,undefined); assert.equal(defaultClaude.output_config,undefined);
  assert.equal((await run('responses','gpt-6.1-sol','high')).reasoning.effort,'high');
  assert.equal((await run('responses','gpt-6.1-sol')).reasoning,undefined);
  assert.equal((await run('chat','opaque-alias','max')).reasoning_effort,'max','opaque alias is configured from server metadata');
  const before=requests.length;
  for(const [model,reasoningEffort] of [['kimi-k3-1-pro','medium'],['gpt-6.1-sol','off'],['glm-5.3','low'],['seedance-2.5','high']]) await assert.rejects(ctx.llm.resolveCallConfig({provider:'chat',model,reasoningEffort}),/does not support reasoning effort/);
  assert.equal(requests.length,before,'unsupported levels fail before HTTP');
  await ctx.agentDefaultModel.saveSelection({provider:'chat',model:'kimi-k3-1-pro',reasoningEffort:'max'});
  assert.equal(ctx.agentDefaultModel.currentSelection().reasoningEffort,'max');
  assert.match(readFileSync(join(home,'settings.yaml'),'utf8'),/reasoningEffort: max/);
  await ctx.agentDefaultModel.saveSelection({provider:'chat',model:'kimi-k3-1-pro'});
  assert.equal(ctx.agentDefaultModel.currentSelection().reasoningEffort,undefined);
  const customModels=chatModels.map(model=>model.id === 'kimi-k3-1-pro' ? {...model,reasoningEfforts:{low:'quick',max:'deep'}} : model);
  await ctx.settings.replace('llm-pi-ai',{providers:{...providers,chat:{...providers.chat,models:customModels}}});
  assert.deepEqual((await info('chat','kimi-k3-1-pro')).reasoning.efforts.map(e=>e.id),['low','max']);
  assert.equal((await run('chat','kimi-k3-1-pro','max')).reasoning_effort,'deep','edited capability map applies without restarting');
  await ctx.settings.replace('llm-pi-ai',{providers:{...providers,chat:{...providers.chat,apiKeyEnv:'FIXTURE_KEY_B',models:customModels}}});
  assert.deepEqual((await info('chat','opaque-alias')).reasoning.efforts.map(e=>e.id),['high'],'a different key cannot reuse another account capability cache');
  await ctx.settings.replace('llm-pi-ai',{providers:{...providers,chat:{...providers.chat,apiKeyEnv:'FIXTURE_KEY_B',baseURL:'https://reasoning.invalid/other/v1',models:customModels}}});
  assert.deepEqual((await info('chat','opaque-alias')).reasoning.efforts.map(e=>e.id),['medium'],'a different base URL refreshes capabilities');
  assert.equal((await run('chat','opaque-alias','medium')).reasoning_effort,'medium');
  for(const name of ['dsh-subagent','dsh-subagent-spawn-in-process']) await ctx.plugin((await load(name)).default??await load(name),{});
  for(let i=0;i<100&&!ctx.get('subagents');i++)await delay(10);
  const leader=await ctx.agents.create({sessionId:'reasoning-parent',agentOptions:{provider:'chat',model:'kimi-k3-1-pro',reasoningEffort:'max'}});
  try {
    const child=await ctx.subagents.start('spawn',{parent:leader.agent,maxDepth:1,signal:new AbortController().signal,prompt:[{type:'text',text:'Верни OK'}]});
    const result=await (await load('dsh-subagent')).settleRun(child);
    assert.equal(result.status,'completed',JSON.stringify(result));
    assert.equal(requests.at(-1).body.reasoning_effort,'deep','native children inherit the parent effort');
  } finally {await leader.dispose();}
  console.log(`PASS: ${requests.length} native streamed API requests; automatic server capabilities and opaque aliases; key/base URL cache isolation; Kimi, DeepSeek, GPT, GLM, Claude and Responses; default/off; unchanged prompts; persistence; native child inheritance`);
} finally {
  await ctx.fiber.dispose(); globalThis.fetch=originalFetch; clearTimeout(watchdog);
  assert.equal(home,resolve(home)); assert(home.startsWith(join(tmpdir(),'qcoderi-reasoning-')));
  rmSync(home,{recursive:true,force:true});
}
