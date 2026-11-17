import { readdir } from 'node:fs/promises';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { createJournal, niceAiBase, safeUrls } from './media.js';
import { createMediaOptions } from './media-options.js';
import { createMediaPlayback } from './media-playback.js';

// Read-only recovery: this service never creates upstream jobs. It continues
// status checks even when the originating model turn stopped or disconnected.
export function createMediaLibrary(ctx,{directory=dshHomePath('media-jobs'),fetchImpl=globalThis.fetch,now=Date.now}={}) {
  const journal=createJournal(directory),cache=new Map(),pending=new Map();
  async function refresh(key,record) {
    if(record.state==='submitting'&&!record.id&&now()-record.createdAt>60000)return {...record,warning:'NiceAI не подтвердил отправку. Чтобы избежать повторного списания, новая задача не создаётся. Проверь список задач в NiceAI.'};
    if(!record.id || ['completed','failed','rejected'].includes(record.state))return record;
    if(pending.has(key))return pending.get(key);
    const work=(async()=>{
      try {
        const profile=ctx.settings.get('llm-pi-ai')?.providers?.[record.provider];
        const base=niceAiBase(profile);
        if(!base)throw Error('Провайдер NiceAI недоступен в настройках.');
        const secret=(await ctx.credentials.resolve(profile.apiKeyEnv))?.value;
        if(!secret)throw Error('Нужен ключ NiceAI.');
        const response=await fetchImpl(base+'/videos/'+encodeURIComponent(record.id),{method:'GET',redirect:'error',headers:{Authorization:'Bearer '+secret,Accept:'application/json'},signal:AbortSignal.timeout(20000)});
        if(!response.ok)throw Error('Не удалось проверить NiceAI (HTTP '+response.status+').');
        const data=await response.json();
        const latest=await journal.read(key);
        // The streaming generator may have finalized while this GET was active.
        if(latest?.state==='completed'||latest?.state==='failed')return latest;
        let next={...latest??record,updatedAt:now(),status:data.status};
        if(typeof data.progress==='number')next.progress=Math.max(0,Math.min(data.status==='completed'?100:99,Math.round(data.progress)));
        if(data.status==='completed') {
          const urls=safeUrls(data.urls);
          if(!urls.length)throw Error('NiceAI завершил задачу, но ссылка ещё недоступна.');
          next={...next,state:'completed',progress:100,urls};
        } else if(data.status==='failed')next={...next,state:'failed',error:String(data.error?.message??data.error??'NiceAI не смог создать видео.').replaceAll(secret,'[ключ скрыт]').slice(0,500)};
        else if(!['queued','in_progress'].includes(data.status))throw Error('Ожидаем корректный статус NiceAI.');
        await journal.write(key,next);return next;
      } catch(error) { return {...record,warning:error.message==='fetch failed'?'Связь с NiceAI прервалась. Проверим снова автоматически.':error.message}; }
    })();
    pending.set(key,work);
    try{return await work;}finally{pending.delete(key);}
  }
  return {
    async list(request) {
      if(!request||typeof request.sessionId!=='string'||request.sessionId.length>200)throw Error('Нужен идентификатор диалога.');
      let files;try{files=await readdir(directory);}catch(error){if(error.code==='ENOENT')return [];throw error;}
      const records=[];
      for(const name of files) {
        if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
        const key=name.slice(0,-5);let record;
        try{record=await journal.read(key);}catch{continue;}
        if(record?.sessionId!==request.sessionId)continue;
        records.push({key,record});
      }
      records.sort((a,b)=>b.record.createdAt-a.record.createdAt);
      return Promise.all(records.map(async({key,record})=>{
        const cached=cache.get(key);
        if(!cached||cached.at+5000<now()) {record=await refresh(key,record);cache.set(key,{at:now(),record});}
        else record=cached.record;
        return {key,id:record.id,sessionId:record.sessionId,messageId:record.messageId,prompt:record.prompt,provider:record.provider,model:record.model,seconds:record.seconds,state:record.state,status:record.status,progress:record.progress,createdAt:record.createdAt,updatedAt:record.updatedAt,urls:safeUrls(record.urls),error:record.error,warning:record.warning};
      }));
    },
  };
}

const initializers=[];
class MediaLibraryService extends TypertRemoteService {
  constructor(ctx) {
    super(ctx,'qcoderMedia');
    for(const init of initializers)init.call(this);
    this.library=createMediaLibrary(ctx);
    this.options=createMediaOptions();
    this.fetch=createMediaPlayback();
  }
  list(request) {return this.library.list(request);}
  getOptions(request) {return this.options.get(request);}
  setOptions(request) {return this.options.set(request);}
}
for(const name of ['list','getOptions','setOptions'])Remote(MediaLibraryService.prototype[name],{kind:'method',name,static:false,private:false,addInitializer:init=>initializers.push(init)});
export function installMediaLibrary(ctx) {new MediaLibraryService(ctx);}
