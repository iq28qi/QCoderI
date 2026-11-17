// Exercise real upload storage, model resolution, AgentLoop and SDK serializers.
// Every HTTP request is intercepted; no external inference or credentials.
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,chmodSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const base=resolve(fileURLToPath(new URL('..',import.meta.url)));
const archive=resolve(process.env.HARNESS_ARCHIVE ?? join(base,'source'));
const load=name=>import(pathToFileURL(join(archive,'dsh/node_modules/@deepseek-ai',name,'lib/index.js')).href);
const {Context}=await load('cordis');
const {createUserMessage}=await load('dsh-llm');
const home=mkdtempSync(join(tmpdir(),'qcoderi-images-'));
writeFileSync(join(home,'credentials.yaml'),'version: 1\nrefs:\n  IMAGE_FIXTURE: fixture-only\n');
const requests=[];
let catalogs=0,rejectNextBody=false;
const originalFetch=globalThis.fetch;
const event=(name,data)=>`${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
globalThis.fetch=async(input,init)=>{
  const url=typeof input === 'string' ? input : input.url ?? String(input);
  assert(url.startsWith('https://images.invalid/'),'HTTP must stay in the intercepted fixture');
  if(init?.method === 'GET') {
    catalogs++;
    if(url.includes('/offline/'))return new Response('',{status:503});
    return Response.json({data:[
      {id:'opaque-vision',architecture:{input_modalities:['text','image']}},
      {id:'friendly-vision',canonical_model:'kimi-k3-1-pro'},
      {id:'gpt-6-sol-muted',capabilities:{vision:false}},
      {id:'explicit-vision',input_modalities:['text']},
      {id:'explicit-text',supports_vision:true},
      {id:'plain-alias',architecture:{modality:'text->text'}},
      {id:'gpt-6-astra',input_modalities:['text'],capabilities:{vision:false,image:false,image_vision:false}},
      {id:'kimi-k3-1-pro',input_modalities:['text'],vision:false},
      {id:'gpt-6.1-sol',input_modalities:['text'],vision:false},
      {id:'anthropic/claude-sonnet-5.5',input_modalities:['text'],vision:false},
      {id:'ambiguous-positive',input_modalities:['text'],capabilities:{vision:false,image_vision:true}},
      {id:'opaque-known-alias',canonical_model:'gpt-6-astra',input_modalities:['text'],vision:false},
    ]});
  }
  const body=JSON.parse(init?.body ?? await input.text());
  const path=new URL(url).pathname;
  requests.push({url,body});
  if(rejectNextBody){rejectNextBody=false;return Response.json({error:{message:'Failed to read request body',type:'invalid_request_error'}},{status:400});}
  let wire;
  if(path.endsWith('/messages')) {
    wire=event('message_start',{type:'message_start',message:{id:'msg_image',type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:0}}})
      +event('content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}})
      +event('content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'OK'}})
      +event('content_block_stop',{type:'content_block_stop',index:0})
      +event('message_delta',{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:1}})
      +event('message_stop',{type:'message_stop'});
  } else if(path.endsWith('/responses')) {
    const message={type:'message',id:'msg_image',role:'assistant',status:'completed',content:[{type:'output_text',text:'OK',annotations:[]}]};
    const response={id:'resp_image',object:'response',created_at:1,status:'in_progress',output:[]};
    wire=event('response.created',{type:'response.created',response})
      +event('response.output_item.added',{type:'response.output_item.added',output_index:0,item:{...message,status:'in_progress',content:[]}})
      +event('response.content_part.added',{type:'response.content_part.added',item_id:message.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}})
      +event('response.output_text.delta',{type:'response.output_text.delta',item_id:message.id,output_index:0,content_index:0,delta:'OK'})
      +event('response.output_item.done',{type:'response.output_item.done',output_index:0,item:message})
      +event('response.completed',{type:'response.completed',response:{...response,status:'completed',output:[message],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});
  } else {
    assert(path.endsWith('/chat/completions'));
    wire=event('',{id:'chat_image',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{role:'assistant',content:'OK'},finish_reason:null}]})
      +event('',{id:'chat_image',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{},finish_reason:'stop'}]})+'data: [DONE]\n\n';
  }
  return new Response(wire,{headers:{'content-type':'text/event-stream'}});
};

const chatModels=['kimi-k3-1-pro','cx/gpt-6-luna','gpt-6.1-sol','GPT-6.1 Sol','Opus 5.5','claude-opus-5-5','opaque-vision','friendly-vision','gpt-6-sol-muted','plain-alias','deepseek-v4-flash','unknown'].map(id=>({id}));
chatModels.push({id:'explicit-vision',input:['text','image']},{id:'explicit-text',input:['text']},{id:'kimi-k3-explicit-text',input:['text']});
chatModels.push({id:'gpt-6-astra'},{id:'ambiguous-positive'},{id:'opaque-known-alias'},{id:'openai.gpt-6-astra'},{id:'openai/gpt-6-astra:free'});
const providers={
  chat:{api:'openai-completions',models:chatModels},
  responses:{api:'openai-responses',models:[{id:'gpt-6.1-sol'}]},
  claude:{api:'anthropic-messages',models:[{id:'anthropic/claude-sonnet-5.5'}]},
  offline:{api:'openai-completions',models:[{id:'kimi-k3-1-pro'}],baseURL:'https://images.invalid/offline/v1'},
};
// The built-in route also respects explicit catalog overrides.
providers.openai={modelOverrides:{'gpt-6-astra':{input:['text']}}};
for(const provider of Object.values(providers))Object.assign(provider,{baseURL:provider.baseURL ?? 'https://images.invalid/v1',apiKeyEnv:'IMAGE_FIXTURE'});
const ctx=new Context();
const watchdog=setTimeout(()=>{console.error('Image integration timed out');process.exit(1)},45000);
let serial=0;
try {
  for(const name of ['dsh-session','dsh-session-projection','dsh-llm','dsh-system-prompt','dsh-tools','dsh-agent','dsh-agent-loop'])await ctx.plugin((await load(name)).default ?? await load(name),{});
  await ctx.plugin((await load('dsh-settings-file')).default,{path:join(home,'settings.yaml'),watch:false});
  await ctx.plugin((await load('dsh-credentials-local')).default,{path:join(home,'credentials.yaml'),watch:false});
  await ctx.plugin((await load('dsh-attachment-local')).default,{dshHome:home});
  await ctx.plugin(await load('dsh-llm-pi-ai'),{providers});
  for(let i=0;i<100&&(!ctx.get('agentLoop')||!ctx.get('attachments')||!ctx.llm.listProviders().some(p=>p.id==='chat'));i++)await delay(10);
  const info=(provider,model)=>ctx.llm.resolveModelInfo(provider,model);
  for(const model of chatModels.map(m=>m.id)) {
    const expected=['plain-alias','deepseek-v4-flash','unknown','explicit-text','kimi-k3-explicit-text'].includes(model) ? ['text'] : ['text','image'];
    assert.deepEqual((await info('chat',model)).inputModalities,expected,model);
  }
  const listed=await ctx.llm.listModels('chat');
  assert.deepEqual(listed.find(m=>m.id==='opaque-vision').inputModalities,['text','image'],'list and selected model expose the same capabilities');
  assert.equal(catalogs,1,'vision reuses the connection-scoped capability request');
  assert.deepEqual((await info('openai','gpt-6-astra')).inputModalities,['text'],'catalog overrides win');
  assert.deepEqual((await info('offline','kimi-k3-1-pro')).inputModalities,['text','image'],'failed discovery retains known model capabilities');
  const image=readFileSync(join(base,'assets/qcoderi.png'));
  const content=await ctx.attachments.admitPromptContent([
    {type:'text',text:'Что на фото?'},
    {type:'image',data:image.toString('base64'),mediaType:'image/png',name:'first.png'},
    {type:'image',data:image.toString('base64'),mediaType:'image/png',name:'second.png'},
  ]);
  assert.equal(content.filter(b=>b.type==='image').length,2);
  const imagesIn=body=>{
    const blocks=(body.messages ?? body.input).flatMap(m=>Array.isArray(m.content) ? m.content : []);
    return blocks.filter(b=>['image_url','input_image','image'].includes(b.type)).map(b=>b.type==='image' ? `data:${b.source.media_type};base64,${b.source.data}` : typeof b.image_url === 'string' ? b.image_url : b.image_url.url);
  };
  const run=async(provider,model,expectedCount=2,repeat=false)=>{
    const handle=await ctx.agents.create({sessionId:`image-${++serial}`,agentOptions:{provider,model}});
    try {
      for(let turn=0;turn<(repeat ? 2 : 1);turn++) {
        const before=requests.length;
        handle.agent.followup(createUserMessage({content:turn ? [{type:'text',text:'Опиши эти же фотографии ещё раз'}] : content,source:{kind:'user'}}));
        await handle.agent.whenIdle();
        const events=handle.agent.session.snapshotEvents();
        assert.equal(events.findLast(e=>e.type==='turn/end')?.data.reason.kind,'completed',JSON.stringify(events.filter(e=>e.type==='step/end'||e.type==='turn/end')));
        assert.equal(requests.length,before+1);
        const body=requests.at(-1).body;
        assert.equal(body.model,model);
        const images=imagesIn(body);
        assert.equal(images.length,expectedCount,`${provider}/${model}: actual wire images, turn ${turn}`);
        for(const url of images) {
          assert.match(url,/^data:image\/(?:png|jpeg|webp);base64,/);
          assert(Buffer.from(url.split(',')[1],'base64').length>100,'real request image bytes survive serialization');
        }
        if(expectedCount)assert(!JSON.stringify(body).includes('image omitted'),'vision models receive no text-only placeholders');
        else assert(JSON.stringify(body).includes('image omitted because this model accepts text only'));
      }
      assert.equal(handle.agent.session.snapshotEvents().filter(e=>e.type==='user/message').flatMap(e=>e.data.content).filter(b=>b.type==='image').length,2,'durable history keeps the original attachments');
    } finally {await handle.dispose();}
  };
  for(const model of ['kimi-k3-1-pro','gpt-6.1-sol','opaque-vision','friendly-vision','explicit-vision'])await run('chat',model,2,model==='kimi-k3-1-pro');
  await run('responses','gpt-6.1-sol',2,true);
  await run('claude','anthropic/claude-sonnet-5.5',2,true);
  await run('offline','kimi-k3-1-pro');
  for(const model of ['gpt-6-sol-muted','ambiguous-positive','opaque-known-alias','openai.gpt-6-astra','openai/gpt-6-astra:free'])await run('chat',model,2);
  for(const model of ['deepseek-v4-flash','unknown','explicit-text','kimi-k3-explicit-text'])await run('chat',model,0);
  await ctx.settings.replace('llm-pi-ai',{providers:{...providers,chat:{...providers.chat,models:chatModels.map(m=>m.id==='kimi-k3-1-pro' ? {...m,input:['text']} : m)}}});
  assert.deepEqual((await info('chat','kimi-k3-1-pro')).inputModalities,['text']);
  await run('chat','kimi-k3-1-pro',0);
  await ctx.settings.replace('llm-pi-ai',{providers});
  await run('chat','kimi-k3-1-pro');
  await run('chat','gpt-6-astra',2,true);
  await ctx.settings.replace('llm-pi-ai',{providers:{...providers,chat:{...providers.chat,models:chatModels.map(m=>m.id==='gpt-6-astra'?{id:m.id}:m)}}});
  assert.deepEqual((await info('chat','gpt-6-astra')).inputModalities,['text','image'],'Auto preserves known vision despite a false gateway declaration');
  await ctx.settings.replace('llm-pi-ai',{providers});
  assert.deepEqual((await info('chat','gpt-6-astra')).inputModalities,['text','image'],'explicit vision setting overrides incorrect gateway metadata after live settings update');
  {const before=requests.length;rejectNextBody=true;const recovery=await ctx.agents.create({sessionId:'body-recovery',agentOptions:{provider:'chat',model:'gpt-6-astra'}});try{recovery.agent.followup(createUserMessage({content,source:{kind:'user'}}));await recovery.agent.whenIdle();assert.equal(recovery.agent.session.snapshotEvents().findLast(e=>e.type==='turn/end').data.reason.kind,'completed',JSON.stringify(recovery.agent.session.snapshotEvents().filter(e=>e.type==='turn/end'||e.type==='assistant/attempt')));assert.equal(requests.length,before+2);assert.equal(imagesIn(requests.at(-1).body).length,2);assert.equal(recovery.agent.session.snapshotEvents().filter(e=>e.type==='user/message').flatMap(e=>e.data.content).filter(b=>b.type==='image').length,2);}finally{await recovery.dispose();}console.log('PASS: actual SDK HTTP 400 body rejection -> one compact retry -> completed native turn, original photo history preserved');}
  console.log(`PASS: ${requests.length} native image requests; real uploads; Chat Completions, Responses and Anthropic wire bytes; two-image history; provider metadata, aliases and offline fallback; explicit input and live settings changes`);
} catch(error) {
  console.error(error);
  throw error;
} finally {
  await ctx.fiber.dispose();globalThis.fetch=originalFetch;clearTimeout(watchdog);
  assert(home.startsWith(join(tmpdir(),'qcoderi-images-')));
  const writable=path=>{for(const child of readdirSync(path,{withFileTypes:true})){const target=join(path,child.name);if(child.isDirectory())writable(target);else chmodSync(target,0o600);}chmodSync(path,0o700);};
  writable(home);
  rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
