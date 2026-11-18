import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { registerHooks } from 'node:module';

const base=resolve(fileURLToPath(new URL('..',import.meta.url)));
const archive=resolve(process.env.HARNESS_ARCHIVE??join(base,'source'));
const moduleUrl=name=>pathToFileURL(join(archive,'dsh/node_modules',name)).href;
// Test maintained modules by default; an explicit archive still tests the packaged modules.
const team=process.env.HARNESS_ARCHIVE ? new URL('./',moduleUrl('@qcoderi/team/media.js')) : new URL('../assets/team/',import.meta.url);
const hooks=process.env.HARNESS_ARCHIVE ? undefined : registerHooks({resolve(specifier,context,next){
  if(specifier.startsWith('@deepseek-ai/')&&context.parentURL?.startsWith(team.href))return next(moduleUrl(specifier+'/lib/index.js'),context);
  return next(specifier,context);
}});
const [{createVideoRouting,createJournal},{createMediaLibrary},{createMediaOptions},{createMediaPlayback}]=await (async()=>{
  try {return await Promise.all(['media','media-library','media-options','media-playback'].map(name=>import(new URL(name+'.js',team).href)));}
  finally {hooks?.deregister();}
})();
const {createUserMessage,markAgentLoopRequest}=await import(moduleUrl('@deepseek-ai/dsh-llm/lib/index.js'));
const key='fixture-video-key';
const catalog={data:[{id:'seedance-2.5'},{id:'kling-3.0-pro'}]};
const completed={id:'video-fixture',status:'completed',urls:['https://cdn.example/video.mp4']};
const options=()=>markAgentLoopRequest({provider:'niceai',model:'seedance-2.5',sessionId:'video-session',messages:[createUserMessage({content:[{type:'text',text:'Волны на закате'}],source:{kind:'user'}})],signal:new AbortController().signal});
const collect=async iterable=>{const chunks=[];for await(const chunk of iterable)chunks.push(chunk);return chunks;};
const content=chunks=>chunks.filter(chunk=>chunk.type==='text-delta').map(chunk=>chunk.text).join('');
const failure=chunks=>chunks.find(chunk=>chunk.type==='finish')?.reason;
function setup(handler,extra={}) {
  const records=new Map(),requests=[];
  const ctx={settings:{get:()=>({providers:{niceai:{baseURL:'https://api.niceai.rest/v1',apiKeyEnv:'FIXTURE'}}})},credentials:{resolve:async()=>({value:key})}};
  const fetchImpl=async(url,init)=>{requests.push({url,init});assert.equal(init.headers.Authorization,'Bearer '+key);assert.equal(init.redirect,'error');const answer=await handler(new URL(url).pathname,init,requests);return new Response(JSON.stringify(answer.body??answer),{status:answer.http??200,headers:{'content-type':'application/json'}});};
  const journal={read:async id=>records.get(id),write:async(id,value)=>records.set(id,structuredClone(value))};
  const middleware=createVideoRouting(ctx,{fetchImpl,journal,mediaOptions:{get:async()=>({seconds:5})},wait:async()=>{},pollMs:1,...extra});
  return {middleware,records,requests,run:input=>collect(middleware(input,()=>assert.fail('video must not use the chat transport')))};
}

for (const model of ['seedance-2.5', 'kling-3.0-pro']) test(`${model} uses the video catalog, POST /videos, status polling and a usable result link`,async()=>{
  let polls=0;
  const fixture=setup((path,init)=>{
    if(path.endsWith('/models'))return catalog;
    if(init.method==='POST'){assert.deepEqual(JSON.parse(init.body),{model,prompt:'Волны на закате',seconds:5});return{id:'video-fixture'};}
    return ++polls===1?{status:'queued'}:polls===2?{status:'in_progress'}:completed;
  });
  const input=options();input.model=model;
  const result=await fixture.run(input);
  assert.equal(failure(result).kind,'stop');
  assert.match(content(result),/В очереди NiceAI/);
  assert.match(content(result),/Создаётся видео/);
  assert.match(content(result),/\[Открыть видео\]\(<https:\/\/cdn.example\/video.mp4>\)/);
  assert(!fixture.requests.some(request=>request.url.includes('chat/completions')));
});

test('ordinary text routes pass through without fetching a video catalog',async()=>{
  const fixture=setup(()=>assert.fail('no video request expected'));
  const input=options();input.model='deepseek-v4-1-flash-1017';
  assert.equal(fixture.middleware(input,()=>42),42);
  assert.equal(fixture.requests.length,0);
});

test('chosen duration persists per conversation, rejects invalid values, and reaches the video POST',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'qcoderi-video-options-'));
  try {
    const mediaOptions=createMediaOptions(directory);
    assert.equal((await mediaOptions.get({sessionId:'video-session'})).seconds,5);
    await mediaOptions.set({sessionId:'video-session',seconds:13});
    assert.equal((await createMediaOptions(directory).get({sessionId:'video-session'})).seconds,13);
    assert.equal((await mediaOptions.get({sessionId:'other'})).seconds,5);
    for(const seconds of [0,121,5.5,NaN,'10'])await assert.rejects(mediaOptions.set({sessionId:'video-session',seconds}));
    const fixture=setup((path,init)=>{
      if(path.endsWith('/models'))return catalog;
      if(init.method==='POST'){assert.equal(JSON.parse(init.body).seconds,13);return{id:'video-fixture'};}
      return completed;
    },{mediaOptions});
    assert.equal(failure(await fixture.run(options())).kind,'stop');
    assert.equal([...fixture.records.values()][0].seconds,13);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('same-origin playback preserves byte ranges, isolates sessions, and retries reads without leaking credentials',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'qcoderi-video-playback-'));
  try {
    const id='f'.repeat(64);await createJournal(directory).write(id,{sessionId:'my-chat',state:'completed',urls:['https://cdn.example/movie.mp4']});
    let calls=0;
    const playback=createMediaPlayback({directory,fetchImpl:async(url,init)=>{
      calls++;assert.equal(url,'https://cdn.example/movie.mp4');assert.equal(init.headers.Range,'bytes=4-7');assert.equal(init.headers.Authorization,undefined);
      if(calls===1)throw TypeError('fetch failed');
      return new Response(new Uint8Array([4,5,6,7]),{status:206,headers:{'content-type':'video/mp4','content-length':'4','content-range':'bytes 4-7/16','accept-ranges':'bytes'}});
    }});
    const url=`https://app/qcoderi-media/${id}/0?session=my-chat`;
    const result=await playback(new Request(url,{headers:{Range:'bytes=4-7'}}));
    assert.equal(result.status,206);assert.equal(result.headers.get('content-range'),'bytes 4-7/16');assert.deepEqual([...new Uint8Array(await result.arrayBuffer())],[4,5,6,7]);assert.equal(calls,2);
    assert.equal((await playback(new Request(url.replace('my-chat','other-chat')))).status,404);
    assert.equal((await playback(new Request(url,{method:'POST'}))).status,405);
    assert.equal((await playback(new Request(url,{headers:{Range:'bytes=1-2,5-6'}}))).status,416);
    assert.equal(calls,2);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('a fully received video is cached atomically and supports local playback and seeking after restart without network',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'qcoderi-video-local-'));
  try {
    const id='c'.repeat(64),bytes=Uint8Array.from({length:32},(_,i)=>i);
    await createJournal(directory).write(id,{sessionId:'local',state:'completed',urls:['https://cdn.example/local.mp4']});
    let reads=0;
    const playback=createMediaPlayback({directory,fetchImpl:async()=>{reads++;return new Response(bytes,{status:206,headers:{'content-type':'video/mp4','content-length':'32','content-range':'bytes 0-31/32'}});}});
    const url=`https://app/qcoderi-media/${id}/0?session=local`;
    const first=await playback(new Request(url,{headers:{Range:'bytes=0-'}}));
    assert.equal(first.headers.get('X-QCoderI-Cache'),'MISS');assert.equal((await first.arrayBuffer()).byteLength,32);
    const offline=createMediaPlayback({directory,fetchImpl:()=>assert.fail('cached video must not contact NiceAI')});
    const seek=await offline(new Request(url,{headers:{Range:'bytes=5-9'}}));
    assert.equal(seek.headers.get('X-QCoderI-Cache'),'HIT');assert.equal(seek.status,206);assert.equal(seek.headers.get('content-range'),'bytes 5-9/32');
    assert.deepEqual([...new Uint8Array(await seek.arrayBuffer())],[5,6,7,8,9]);
    const tail=await offline(new Request(url,{method:'HEAD',headers:{Range:'bytes=-4'}}));
    assert.equal(tail.headers.get('content-range'),'bytes 28-31/32');assert.equal(tail.headers.get('content-length'),'4');
    assert.equal((await offline(new Request(url,{headers:{Range:'bytes=40-'}}))).status,416);
    assert.equal(reads,1);
    const download=await offline(new Request(url+'&download=1'));
    assert.match(download.headers.get('content-disposition'),/^attachment; filename="QCoderI-/);
    assert.equal((await download.arrayBuffer()).byteLength,32);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('the media library retains every earlier video while a newer generation is pending',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'qcoderi-video-history-'));
  try {
    const journal=createJournal(directory);
    for(let i=0;i<17;i++)await journal.write(i.toString(16).padStart(64,'0'),{sessionId:'history',messageId:'message-'+i,prompt:'Scene '+i,provider:'niceai',model:'seedance-2.5',seconds:5,state:'completed',createdAt:i+1,urls:['https://cdn.example/'+i+'.mp4']});
    await journal.write('b'.repeat(64),{sessionId:'history',messageId:'new-message',state:'created',status:'queued',createdAt:30,progress:0});
    const library=createMediaLibrary({},{directory,fetchImpl:()=>assert.fail('completed videos must not be regenerated or queried')});
    const result=await library.list({sessionId:'history'});
    assert.equal(result.length,18);assert.equal(result.filter(item=>item.state==='completed').length,17);
    assert.equal(result.find(item=>item.messageId==='message-0').prompt,'Scene 0');
    assert.equal(result.find(item=>item.messageId==='message-16').urls[0],'https://cdn.example/16.mp4');
    assert.equal(result.find(item=>item.messageId==='new-message').status,'queued');
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('an interrupted media download never becomes a cached completed video',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'qcoderi-video-partial-'));
  try {
    const id='d'.repeat(64);await createJournal(directory).write(id,{sessionId:'partial',state:'completed',urls:['https://cdn.example/partial.mp4']});
    let calls=0;
    const playback=createMediaPlayback({directory,fetchImpl:async()=>{
      calls++;
      const body=calls===1?new ReadableStream({start(c){c.error(Error('connection dropped'));}}):new Uint8Array(16);
      return new Response(body,{headers:{'content-type':'video/mp4','content-length':'16'}});
    }});
    const url=`https://app/qcoderi-media/${id}/0?session=partial`;
    await assert.rejects((await playback(new Request(url))).arrayBuffer(),/connection dropped/);
    const retry=await playback(new Request(url));assert.equal(retry.headers.get('X-QCoderI-Cache'),'MISS');await retry.arrayBuffer();
    assert.equal(calls,2);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('transient status read errors retry the same job without another paid POST',async()=>{
  let polls=0,posts=0;
  const fixture=setup((path,init)=>{
    if(path.endsWith('/models'))return catalog;
    if(init.method==='POST'){posts++;return{id:'video-fixture'};}
    if(++polls===1)throw TypeError('fetch failed');
    if(polls===2)return{http:503,body:{message:'busy'}};
    return completed;
  });
  assert.equal(failure(await fixture.run(options())).kind,'stop');
  assert.equal(posts,1);assert.equal(polls,3);
});

test('video library recovers a stopped turn, isolates sessions and keeps network failures recoverable',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'qcoderi-video-library-'));
  try {
    const journal=createJournal(directory),id='a'.repeat(64),other='b'.repeat(64);
    await journal.write(id,{sessionId:'original',id:'already-paid',provider:'niceai',model:'seedance-2.5',state:'created',createdAt:1,seconds:5});
    await journal.write(other,{sessionId:'private-other',id:'other',state:'completed',urls:['https://cdn.example/private.mp4'],createdAt:2});
    let now=10,calls=0;
    const ctx={settings:{get:()=>({providers:{niceai:{baseURL:'https://api.niceai.rest/v1',apiKeyEnv:'KEY'}}})},credentials:{resolve:async()=>({value:key})}};
    const library=createMediaLibrary(ctx,{directory,now:()=>now,fetchImpl:async(url,init)=>{
      assert.equal(init.method,'GET');assert(url.endsWith('/videos/already-paid'));calls++;
      if(calls===1)throw TypeError('fetch failed');
      return new Response(JSON.stringify(completed));
    }});
    const first=await library.list({sessionId:'original'});
    assert.equal(first.length,1);assert.match(first[0].warning,/Связь/);assert.equal(first[0].state,'created');
    now+=6000;
    const recovered=await library.list({sessionId:'original'});
    assert.equal(recovered[0].state,'completed');assert.equal(recovered[0].progress,100);assert.deepEqual(recovered[0].urls,completed.urls);
    assert.equal((await journal.read(id)).state,'completed');
    now+=6000;await library.list({sessionId:'original'});assert.equal(calls,2);
    assert(!JSON.stringify(recovered).includes(key));
    assert.deepEqual(await library.list({sessionId:'../escape'}),[]);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('an unavailable video model is rejected before any paid creation',async()=>{
  const fixture=setup(()=>({data:[{id:'kling-3.0-pro'}]}));
  const result=await fixture.run(options());
  assert.equal(failure(result).kind,'error');
  assert.match(failure(result).failure.message,/недоступна/);
  assert.equal(fixture.requests.length,1);
});

test('a completed request is recovered from the journal without creating another video',async()=>{
  const fixture=setup((path,init)=>path.endsWith('/models')?catalog:init.method==='POST'?{id:'video-fixture'}:completed);
  const input=options();
  await fixture.run(input);
  assert.equal(failure(await fixture.run(input)).kind,'stop');
  assert.equal(fixture.requests.filter(request=>request.init.method==='POST').length,1);
});

test('an ambiguous creation failure prevents a second paid POST',async()=>{
  const fixture=setup((path,init)=>{if(path.endsWith('/models'))return catalog;if(init.method==='POST')throw Error('connection lost after send');});
  const input=options();await fixture.run(input);
  const retry=await fixture.run(input);
  assert.match(failure(retry).failure.message,/неизвестен/);
  assert.equal(fixture.requests.filter(request=>request.init.method==='POST').length,1);
});

test('cancellation stops polling and retry resumes the same upstream job',async()=>{
  const controller=new AbortController();let finished=false;
  const fixture=setup((path,init)=>path.endsWith('/models')?catalog:init.method==='POST'?{id:'video-fixture'}:finished?completed:{status:'in_progress'},{wait:async()=>{controller.abort();throw Error('cancelled');}});
  const input=options();input.signal=controller.signal;
  assert.equal(failure(await fixture.run(input)).kind,'aborted');
  finished=true;input.signal=new AbortController().signal;
  assert.equal(failure(await fixture.run(input)).kind,'stop');
  assert.equal(fixture.requests.filter(request=>request.init.method==='POST').length,1);
});

test('cancellation while saving the submission intent leaves the same request safe to retry',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'qcoderi-video-before-post-'));
  try {
    const journal=createJournal(directory),controller=new AbortController();
    let recordKey,posts=0;
    const fixture=setup((path,init)=>{
      init.signal.throwIfAborted(); // Like fetch, an already aborted request is never sent.
      if(path.endsWith('/models'))return catalog;
      if(init.method==='POST'){posts++;return{id:'video-fixture'};}
      return completed;
    },{journal:{...journal,async write(id,value){
      await journal.write(id,value);
      if(value.state==='submitting'){recordKey=id;controller.abort();}
    }}});
    const input=options();input.signal=controller.signal;
    assert.equal(failure(await fixture.run(input)).kind,'aborted');
    assert.equal(posts,0);
    assert.ok(recordKey);
    input.signal=new AbortController().signal;
    const retry=failure(await fixture.run(input));
    assert.equal(retry.kind,'stop',retry.failure?.message);
    assert.equal(posts,1);
    assert.equal((await journal.read(recordKey)).state,'completed');
    assert.equal(fixture.requests.filter(request=>request.init.method==='POST').length,1);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('failed jobs expose a useful error and reject unsafe result URLs',async()=>{
  const failed=setup((path,init)=>path.endsWith('/models')?catalog:init.method==='POST'?{id:'video-fixture'}:{status:'failed',error:{message:'provider failure '+key}});
  const result=await failed.run(options());
  assert.match(failure(result).failure.message,/provider failure/);
  assert(!failure(result).failure.message.includes(key));
  const unsafe=setup((path,init)=>path.endsWith('/models')?catalog:init.method==='POST'?{id:'video-fixture'}:{...completed,urls:['javascript:alert(1)','file:///C:/secret']});
  assert.equal(failure(await unsafe.run(options())).kind,'error');
});

test('service calls and attachments cannot accidentally start video jobs',async()=>{
  const fixture=setup(()=>assert.fail('no request expected'));
  const service={...options()}; // deliberately unmarked auxiliary request
  assert.equal(failure(await fixture.run(service)).kind,'error');
  const image=options();image.messages[0]=createUserMessage({content:[{type:'image',url:'https://example/image.png'}],source:{kind:'user'}});
  assert.equal(failure(await fixture.run(image)).kind,'error');
  assert.equal(fixture.requests.length,0);
});

test('concurrent retries cannot remove another execution lock',async()=>{
  let entered,release;
  const ready=new Promise(resolve=>{entered=resolve;});const blocked=new Promise(resolve=>{release=resolve;});
  const fixture=setup((path,init)=>path.endsWith('/models')?catalog:init.method==='POST'?{id:'video-fixture'}:{status:'queued'},{wait:async()=>{entered();await blocked;throw Error('test finished');}});
  const input=options();const first=fixture.run(input);await ready;
  assert.match(failure(await fixture.run(input)).failure.message,/уже выполняется/);
  assert.match(failure(await fixture.run(input)).failure.message,/уже выполняется/);
  release();await first;
  assert.equal(fixture.requests.filter(request=>request.init.method==='POST').length,1);
});
