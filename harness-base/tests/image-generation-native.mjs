import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,chmodSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const base=resolve(fileURLToPath(new URL('..',import.meta.url)));
const archive=resolve(process.env.HARNESS_ARCHIVE??join(base,'source'));
const load=name=>import(pathToFileURL(join(archive,'dsh/node_modules/@deepseek-ai',name,'lib/index.js')).href);
const {createImageGenerator,installImageGeneration,imageRequest}=await import(pathToFileURL(join(archive,'dsh/node_modules/@qcoderi/team/image-generation.js')).href);
const {createJournal}=await import(pathToFileURL(join(archive,'dsh/node_modules/@qcoderi/team/media.js')).href);
const {Context}=await load('cordis');
const {LlmAdapter,createUserMessage}=await load('dsh-llm');
for(const args of [{prompt:''},{prompt:'x',model:'other'},{prompt:'x',model:'krea-k3-edit'},{prompt:'x',resolution:'4K'}])assert.throws(()=>imageRequest(args));
const ctx=new Context(),home=mkdtempSync(join(tmpdir(),'qcoderi-generation-'));
writeFileSync(join(home,'credentials.yaml'),'version: 1\nrefs:\n  IMAGE_KEY: fixture-only\n');
let handle,ref,calls=0,posts=0,mode='b64',downloads=0;
const png=readFileSync(join(base,'assets/qcoderi.png'));
const journal=createJournal(join(home,'jobs'));
const fetchImpl=async(url,init)=>{
  url=String(url);
  assert(url.startsWith('https://api.niceai.rest/')||url.startsWith('https://cdn.example/'));
  if(url.endsWith('/images/models'))return Response.json({data:[{id:'seedream-5.0-pro',modes:[{inputs:{reference_images:{max:14}}}]},{id:'krea-k3-edit',modes:[{inputs:{reference_images:{max:1}}}]}]});
  if(url.endsWith('/images/generations')) {
    posts++;
    assert.equal(init.headers.Authorization,'Bearer fixture-only');
    const body=JSON.parse(init.body);
    assert.equal(body.response_format,'b64_json');assert.equal(body.n,1);
    if(body.model==='krea-k3-edit') {assert.equal(body.resolution,'1K');assert.equal(body.reference_images.length,1);assert.match(body.reference_images[0],/^data:image\/png;base64,/);}
    else {assert.equal(body.model,'seedream-5.0-pro');assert.equal(body.resolution,'2K');}
    if(mode==='ambiguous')throw Error('Network disconnected after POST');
    if(mode==='rejected')return Response.json({error:{message:'fixture-only rejected'}},{status:400});
    return Response.json({data:[mode==='url' ? {url:'https://api.niceai.rest/v1/media/img-fixture/0'} : {b64_json:png.toString('base64')}]});
  }
  if(url.includes('/v1/media/')){
    assert.equal(init.headers.Authorization,'Bearer fixture-only');
    if(downloads++===0)return new Response('',{status:503});
    return new Response('',{status:302,headers:{location:'https://cdn.example/result.png'}});
  }
  assert.deepEqual(init.headers,{},'provider credentials never reach the image CDN');
  return new Response(png);
};
const watchdog=setTimeout(()=>{console.error('Image generation test timed out');process.exit(1)},40000);
try {
  for(const name of ['dsh-session','dsh-session-projection','dsh-llm','dsh-system-prompt','dsh-tools','dsh-agent','dsh-agent-loop'])await ctx.plugin((await load(name)).default??await load(name),{});
  await ctx.plugin((await load('dsh-settings-file')).default,{path:join(home,'settings.yaml'),watch:false});
  await ctx.plugin((await load('dsh-credentials-local')).default,{path:join(home,'credentials.yaml'),watch:false});
  await ctx.plugin((await load('dsh-attachment-local')).default,{dshHome:home});
  await ctx.plugin((await load('dsh-fs-local')).default,{});
  await ctx.plugin(await load('dsh-llm-pi-ai'),{providers:{niceai:{api:'openai-completions',baseURL:'https://api.niceai.rest/v1',apiKeyEnv:'IMAGE_KEY',models:[{id:'kimi-k3-1-pro'}]}}});
  for(let i=0;i<100&&(!ctx.get('agentLoop')||!ctx.get('attachments')||!ctx.get('fs')||!ctx.settings.get('llm-pi-ai'));i++)await delay(10);
  installImageGeneration(ctx,{fetchImpl,journal});
  class ImageAdapter extends LlmAdapter {
    resolveModel(provider,id){return Promise.resolve({provider,id,name:id,inputModalities:['text','image']});}
    async *stream(options){
      calls++;
      if(calls===1||calls===3){
        assert(options.tools.some(tool=>tool.name==='generate_image'));
        const args=calls===1?{prompt:'Фотография горного озера',caption:'Иллюстрация для проекта'}:{prompt:'Замени фон исходного изображения',reference_images:[ref.attachmentId]};
        yield {type:'block-end',index:0,block:{type:'tool-call',id:'generated-'+calls,name:'generate_image',arguments:JSON.stringify(args)}};
      }else{
        const results=options.messages.flatMap(message=>message.content).filter(block=>block.type==='tool-result');
        const result=results.at(-1);assert(!result.isError,JSON.stringify(result));
        assert(result.content.some(block=>block.type==='image'&&block.attachment.bytes>100),'image pixels are available to the working model');
        assert(result.content.some(block=>block.type==='text'&&block.text.includes(calls===2?'seedream-5.0-pro':'krea-k3-edit')));
        yield {type:'text-delta',index:0,text:'Изображение создано и приложено к чату.'};
      }
      yield {type:'finish',reason:{kind:'stop'}};
    }
  }
  ctx.llm.registerAdapter(['fixture'],new ImageAdapter());
  handle=await ctx.agents.create({sessionId:'image-generation-project',meta:{cwd:home},agentOptions:{provider:'fixture',model:'vision'}});
  handle.agent.followup(createUserMessage({content:[{type:'text',text:'Добавь подходящую иллюстрацию к проекту'}],source:{kind:'user'}}));await handle.agent.whenIdle();
  const end=()=>handle.agent.session.snapshotEvents().findLast(event=>event.type==='turn/end')?.data.reason;
  assert.equal(end().kind,'completed',JSON.stringify(end()));assert.equal(posts,1);
  const result=await createImageGenerator(ctx,{fetchImpl,journal})({prompt:'Фотография горного озера'},{agent:handle.agent,signal:new AbortController().signal,callId:'repeat'});
  assert.equal(posts,1,'a repeated tool call in the same turn reuses the stored image');assert(existsSync(result.path));
  const relabelled=await createImageGenerator(ctx,{fetchImpl,journal})({prompt:'Фотография горного озера',caption:'Новая подпись'},{agent:handle.agent,signal:new AbortController().signal,callId:'relabel'});
  assert.equal(relabelled.caption,'Новая подпись');assert.equal(posts,1,'changing caption reuses paid result');
  ref=await ctx.attachments.saveImage({data:png,mediaType:'image/png',name:'source.png'});
  handle.agent.followup(createUserMessage({content:[{type:'text',text:'Измени фон'}, {type:'image',attachment:ref}],source:{kind:'user'}}));await handle.agent.whenIdle();
  assert.equal(end().kind,'completed',JSON.stringify(end()));assert.equal(posts,2);assert.equal(calls,4);
  const exec=id=>({agent:{session:{header:{id,cwd:home},snapshotEvents:()=>[{type:'turn/start',data:{turn:1}}],requestHeader:()=>undefined},options:{provider:'fixture'}},signal:new AbortController().signal,callId:id});
  const generate=createImageGenerator(ctx,{fetchImpl,journal});
  await assert.rejects(generate({prompt:'Edit',reference_images:['not-in-this-session']},exec('invalid-reference')),/отсутствует/);assert.equal(posts,2);
  mode='url';
  await assert.rejects(generate({prompt:'URL image'},exec('download-retry')),/загрузить/);
  const before=posts;const recovered=await generate({prompt:'URL image'},exec('download-retry'));assert(recovered.image.attachmentId);assert.equal(posts,before,'media retries do not create another paid image');
  mode='ambiguous';await assert.rejects(generate({prompt:'Ambiguous'},exec('ambiguous')),/disconnected/);
  const ambiguousPosts=posts;await assert.rejects(createImageGenerator(ctx,{fetchImpl,journal})({prompt:'Ambiguous'},exec('ambiguous')),/неизвестен/);assert.equal(posts,ambiguousPosts);
  mode='rejected';await assert.rejects(generate({prompt:'Rejected'},exec('rejected')),/ключ скрыт/);
  const rejectedPosts=posts;await assert.rejects(generate({prompt:'Rejected'},exec('rejected')),/ключ скрыт/);assert.equal(posts,rejectedPosts);
  mode='b64';
  const configured=ctx.settings.get('llm-pi-ai').providers;
  const fallbackContext={settings:{get:()=>({providers:{broken:{...configured.niceai,apiKeyEnv:'MISSING_FIXTURE_KEY'},...configured}})},credentials:ctx.credentials,attachments:ctx.attachments,get:name=>ctx.get(name)};
  const fallbackExec=exec('route-fallback');fallbackExec.agent.options.provider='broken';
  const beforeFallback=posts;
  const fallback=await createImageGenerator(fallbackContext,{fetchImpl,journal})({prompt:'Connection fallback'},fallbackExec);
  assert.equal(fallback.model,'seedream-5.0-pro');assert.equal(posts,beforeFallback+1,'a missing key in the preferred route falls back before any generation is sent');
  console.log('PASS: native working agent creates with Seedream, edits with Krea and receives stored image pixels; local project path; session-bound references; durable paid-request deduplication, ambiguous failure protection and download-only recovery; CDN auth isolation');
}finally{
  await handle?.dispose();await ctx.fiber.dispose();clearTimeout(watchdog);
  assert(home.startsWith(join(tmpdir(),'qcoderi-generation-')));
  const writable=path=>{for(const item of readdirSync(path,{withFileTypes:true})){const child=join(path,item.name);if(item.isDirectory())writable(child);else chmodSync(child,0o600);}chmodSync(path,0o700);};
  writable(home);rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
