// Native PiAi preflight + AgentLoop + credentials + video middleware. All HTTP
// is replaced in this process, so this check cannot create paid upstream jobs.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const base=resolve(fileURLToPath(new URL('..',import.meta.url)));
const archive=resolve(process.env.HARNESS_ARCHIVE??join(base,'source'));
const load=name=>import(pathToFileURL(join(archive,'dsh/node_modules/@deepseek-ai',name,'lib/index.js')).href);
const {Context}=await load('cordis');
const {createUserMessage}=await load('dsh-llm');
const {createVideoRouting,createJournal}=await import(pathToFileURL(join(archive,'dsh/node_modules/@qcoderi/team/media.js')).href);
const home=mkdtempSync(join(tmpdir(),'qcoderi-video-native-'));
mkdirSync(home,{recursive:true});
writeFileSync(join(home,'credentials.yaml'),'version: 1\nrefs:\n  FIXTURE_VIDEO_KEY: fixture-only\n');
const originalFetch=globalThis.fetch;
globalThis.fetch=()=>{throw Error('Unexpected real HTTP request: the video must not enter the chat transport');};
const watchdog=setTimeout(()=>{console.error('FAIL: native video check exceeded 20 seconds');process.exit(1);},20000);
const ctx=new Context();let handle;
try {
  for(const name of ['dsh-session','dsh-session-projection','dsh-llm','dsh-system-prompt','dsh-tools','dsh-agent','dsh-agent-loop']) {
    const module=await load(name);await ctx.plugin(module.default??module,{});
  }
  await ctx.plugin((await load('dsh-settings-file')).default,{path:join(home,'settings.yaml'),watch:false});
  await ctx.plugin((await load('dsh-credentials-local')).default,{path:join(home,'credentials.yaml'),watch:false});
  await ctx.plugin((await load('dsh-session-persistence-jsonl')).default,{root:join(home,'sessions'),compression:'none'});
  await ctx.plugin((await load('dsh-session-title')).default,{fallbackMaxWords:5,fallbackMaxBytes:40,maxTitleBytes:80});
  await ctx.plugin(await load('dsh-llm-pi-ai'),{providers:{niceai:{api:'openai-completions',baseURL:'https://api.niceai.rest/v1',apiKeyEnv:'FIXTURE_VIDEO_KEY',models:[{id:'seedance-2.5'},{id:'kling-3.0-pro'}]}}});
  for(let i=0;i<100&&(!ctx.get('agentLoop')||!ctx.llm.listProviders().some(provider=>provider.id==='niceai')||!ctx.settings.get('llm-pi-ai'));i++)await delay(10);
  let creations=0,polls=0;
  ctx.on('llm/stream',createVideoRouting(ctx,{
    journal:createJournal(join(home,'media-jobs')),pollMs:1,wait:async()=>{},
    fetchImpl:async(url,init)=>{
      assert.equal(init.headers.Authorization,'Bearer fixture-only');
      const path=new URL(url).pathname;
      let data;
      if(path==='/v1/videos/models')data={data:[{id:'seedance-2.5'},{id:'kling-3.0-pro'}]};
      else if(path==='/v1/videos'&&init.method==='POST'){
        creations++;assert.equal(JSON.parse(init.body).model,'seedance-2.5');
        assert.equal(JSON.parse(init.body).prompt,'Море на закате');data={id:'native-video'};
      } else if(path==='/v1/videos/native-video')data=++polls===1?{status:'in_progress'}:{status:'completed',urls:['https://cdn.example/native-video.mp4']};
      else assert.fail('Unexpected route '+path);
      return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
    },
  }));
  handle=await ctx.agents.create({sessionId:'native-video-session',meta:{agentPreset:'qcoder-chat',cwd:home},agentOptions:{provider:'niceai',model:'seedance-2.5'}});
  handle.agent.followup(createUserMessage({content:[{type:'text',text:'Море на закате'}],source:{kind:'user'}}));
  await handle.agent.whenIdle();
  const events=handle.agent.session.snapshotEvents();
  const lastEnd=events.findLast(event=>event.type==='turn/end');
  assert.equal(lastEnd?.data.reason.kind,'completed',JSON.stringify(lastEnd));
  const text=events.filter(event=>event.type==='assistant/message').flatMap(event=>event.data.message.content).filter(block=>block.type==='text').map(block=>block.text).join('');
  assert.match(text,/Видео готово/);assert.match(text,/https:\/\/cdn.example\/native-video.mp4/);
  assert.equal(creations,1);assert.equal(polls,2);
  ctx.sessionTitle.rename(handle.agent.session,'Видео NiceAI — проверка');
  console.log('PASS: configured Seedance -> native PiAi preflight -> AgentLoop video routing -> real credential service -> one video job -> status polling -> completed assistant response; no chat POST and no paid HTTP');
} finally {
  await handle?.dispose();await ctx.fiber.dispose();
  globalThis.fetch=originalFetch;clearTimeout(watchdog);
  rmSync(home,{recursive:true,force:true});
}
