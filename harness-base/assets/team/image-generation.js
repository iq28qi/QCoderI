import {createHash} from 'node:crypto';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {dshHomePath} from '@deepseek-ai/dsh-home-paths';
import {createJournal,niceAiBase} from './media.js';

export const name='qcoderi-image-generation';
export const inject=['tools','attachments','systemPrompt','settings','credentials'];
export const IMAGE_MODELS=['seedream-5.0-pro','krea-k3-edit'];
const LIMIT=20*1024*1024;

export function imageRequest(args) {
  if(typeof args.prompt!=='string'||!args.prompt.trim()||args.prompt.length>12000)throw Error('Опишите изображение: от 1 до 12000 символов');
  const references=args.reference_images ?? [];
  if(!Array.isArray(references)||references.some(id=>typeof id!=='string'||!id.trim())||references.length>14)throw Error('reference_images: до 14 идентификаторов изображений из этого диалога');
  const model=args.model ?? (references.length===1 ? 'krea-k3-edit' : 'seedream-5.0-pro');
  if(!IMAGE_MODELS.includes(model))throw Error('Доступны только seedream-5.0-pro и krea-k3-edit');
  if(model==='krea-k3-edit' && references.length!==1)throw Error('Для krea-k3-edit нужно ровно одно исходное изображение; для создания с нуля используйте seedream-5.0-pro');
  const resolution=args.resolution ?? (model==='seedream-5.0-pro' ? '2K' : '1K');
  if(!['1K','2K'].includes(resolution))throw Error('resolution: 1K или 2K');
  if(args.caption!==undefined&&(typeof args.caption!=='string'||args.caption.length>240))throw Error('Подпись: не более 240 символов');
  return {model,prompt:args.prompt.trim(),resolution,references,caption:args.caption?.trim()||'Созданное изображение'};
}

async function boundedBytes(response,max=LIMIT) {
  if(Number(response.headers.get('content-length'))>max){await response.body?.cancel();throw Error('Ответ с изображением слишком большой');}
  const reader=response.body?.getReader();
  if(!reader)throw Error('Пустой ответ сервера изображений');
  const chunks=[];let total=0;
  try {for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>max)throw Error('Ответ с изображением слишком большой');chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});}
  return Buffer.concat(chunks,total);
}

function sessionImages(session) {
  const images=new Map();
  const visit=content=>{for(const block of content ?? []){if(block.type==='image'&&block.attachment)images.set(String(block.attachment.attachmentId),block.attachment);else if(block.type==='tool-result')visit(block.content);}};
  for(const event of session.snapshotEvents()) {
    if(event.type==='user/message')visit(event.data.content);
    else if(event.type==='assistant/message'||event.type==='tool/result')visit(event.data.message.content);
  }
  return images;
}

function imageType(bytes) {
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return 'image/webp';
  throw Error('Сервер не вернул PNG, JPEG или WebP');
}

export function createImageGenerator(ctx,{fetchImpl=globalThis.fetch,journal=createJournal(dshHomePath('image-jobs'))}={}) {
  const catalogs=new Map(),active=new Set();
  const request=async(base,path,key,signal,body)=>{
    const response=await fetchImpl(base+path,{method:body===undefined?'GET':'POST',redirect:'error',headers:{Accept:'application/json',Authorization:'Bearer '+key,...body===undefined?{}:{'Content-Type':'application/json'}},...body===undefined?{}:{body:JSON.stringify(body)},signal:AbortSignal.any([signal,AbortSignal.timeout(body===undefined?20000:180000)])});
    let data;
    try{data=JSON.parse((await boundedBytes(response,30*1024*1024)).toString('utf8'));}catch(error){if(signal.aborted)throw error;throw Error(`NiceAI: некорректный ответ HTTP ${response.status}`);}
    if(!response.ok){const error=Error(`NiceAI: ${String(data.error?.message??data.message??response.statusText).replaceAll(key,'[ключ скрыт]').slice(0,500)} (HTTP ${response.status})`);error.definite=response.status>=400&&response.status<500;throw error;}
    return data;
  };
  async function catalog(base,key,signal) {
    const identity=createHash('sha256').update(base+'\0'+key).digest('hex');
    const old=catalogs.get(identity);if(old&&old.expires>Date.now())return old.data;
    const body=await request(base,'/images/models',key,signal);
    if(!Array.isArray(body.data))throw Error('NiceAI не вернул каталог изображений');
    catalogs.set(identity,{data:body.data,expires:Date.now()+60000});return body.data;
  }
  async function download(entry,base,key,signal) {
    if(typeof entry.b64_json==='string') {
      if(entry.b64_json.length>Math.ceil(LIMIT/3)*4)throw Error('Изображение превышает 20 МБ');
      const bytes=Buffer.from(entry.b64_json,'base64');
      if(bytes.toString('base64')!==entry.b64_json)throw Error('Некорректное кодирование изображения');
      return bytes;
    }
    let url;
    try{url=new URL(entry.url);}catch{throw Error('NiceAI не вернул ссылку на изображение');}
    for(let hop=0;hop<4;hop++) {
      if(url.protocol!=='https:'||url.username||url.password)throw Error('NiceAI вернул недопустимую ссылку изображения');
      const authenticated=url.origin===new URL(base).origin&&url.pathname.startsWith('/v1/media/');
      const response=await fetchImpl(url.href,{headers:authenticated?{Authorization:'Bearer '+key}:{},redirect:'manual',signal:AbortSignal.any([signal,AbortSignal.timeout(30000)])});
      if([301,302,303,307,308].includes(response.status)){const location=response.headers.get('location');await response.body?.cancel();if(!location)break;url=new URL(location,url);continue;}
      if(!response.ok){await response.body?.cancel();throw Error(`Не удалось загрузить готовое изображение (HTTP ${response.status}); повторите тот же вызов для загрузки без новой генерации`);}
      return boundedBytes(response);
    }
    throw Error('Слишком много перенаправлений при загрузке изображения');
  }
  return async function generate(args,exec) {
    if(!exec.agent?.session.header.cwd)throw Error('Создание изображений доступно в режиме «Проекты»');
    const config=imageRequest(args),signal=exec.signal;
    signal.throwIfAborted();
    const routes=Object.entries(ctx.settings.get('llm-pi-ai')?.providers??{}).filter(([,profile])=>niceAiBase(profile));
    const selected=exec.agent.session.requestHeader()?.config?.provider??exec.agent.options.provider;
    routes.sort(([a],[b])=>Number(b===selected)-Number(a===selected));
    if(!routes.length)throw Error('Добавьте подключение NiceAI с API-ключом в настройках моделей');
    let connection;const failures=[];
    for(const [provider,profile] of routes){
      signal.throwIfAborted();
      try{
        const base=niceAiBase(profile),key=(await ctx.credentials.resolve(profile.apiKeyEnv))?.value;
        if(!key){failures.push(`${provider}: нет ключа`);continue;}
        const available=await catalog(base,key,signal),model=available.find(row=>row.id===config.model);
        if(model){connection={provider,base,key,model};break;}
        failures.push(`${provider}: модель недоступна`);
      }catch(error){if(signal.aborted)throw signal.reason;failures.push(`${provider}: каталог недоступен`);}
    }
    if(!connection)throw Error(`Не найдено подключение NiceAI для ${config.model}. ${failures.join('; ')}`);
    const {provider,base,key,model}=connection;
    const max=model.modes?.[0]?.inputs?.reference_images?.max;
    if(Number.isInteger(max)&&config.references.length>max)throw Error(`${config.model}: максимум исходных изображений — ${max}`);
    const images=sessionImages(exec.agent.session),references=[];
    for(const id of config.references) {
      const ref=images.get(id);if(!ref)throw Error('Исходное изображение отсутствует в этом диалоге; сначала прочитайте файл через read_image или используйте идентификатор вложения');
      const stored=await ctx.attachments.readImage(ref,signal);
      references.push(`data:${ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`);
    }
    const body={model:config.model,prompt:config.prompt,resolution:config.resolution,n:1,response_format:'b64_json',...references.length?{reference_images:references}:{}};
    const turn=exec.agent.session.snapshotEvents().findLast(event=>event.type==='turn/start')?.data.turn??0;
    const id=createHash('sha256').update(JSON.stringify([exec.agent.session.header.id,turn,provider,base,createHash('sha256').update(key).digest('hex'),body])).digest('hex');
    if(active.has(id))throw Error('Это изображение уже создаётся; дождитесь текущего вызова');
    active.add(id);
    try {
      let record=await journal.read(id);
      if(record?.state==='completed')return {...record.result,caption:config.caption};
      if(record?.state==='submitting')throw Error('Результат предыдущей отправки неизвестен. Новая платная генерация в этом ходе не запущена');
      if(record?.state==='rejected')throw Error(record.error);
      if(!record) {
        await journal.write(id,{state:'submitting',model:config.model});
        let response;
        try{response=await request(base,'/images/generations',key,signal,body);}
        catch(error){if(error.definite)await journal.write(id,{state:'rejected',error:error.message});throw error;}
        if(!response.data?.[0])throw Error('NiceAI не вернул созданное изображение; повторная генерация в этом ходе не запущена');
        record={state:'received',entry:response.data[0]};await journal.write(id,record);
      }
      const bytes=await download(record.entry,base,key,signal);
      const mediaType=imageType(bytes),extension=mediaType.split('/')[1];
      const image=await ctx.attachments.saveImage({data:bytes,mediaType,name:`QCoderI-${config.model}-${id.slice(0,8)}.${extension}`});
      signal.throwIfAborted();
      const host=ctx.attachments.imageHostPath(image),path=host&&ctx.get('fs')?.processPathFromHostPath(host);
      const result={image,caption:config.caption,model:config.model,...path?{path}:{}};
      await journal.write(id,{state:'completed',result});return result;
    }finally{active.delete(id);}
  };
}

export function installImageGeneration(ctx,options) {
  ctx.systemPrompt.section({name:'qcoderi:image-generation',order:96,interpolate:false,text:({agent})=>agent.session.header.cwd ? 'Если для текущей задачи нужна созданная фотография, иллюстрация, фон, текстура или другой растровый материал, самостоятельно используй generate_image, не жди отдельного названия инструмента. Для нового изображения основной выбор — seedream-5.0-pro, по умолчанию 2K; для изменения одного существующего изображения — krea-k3-edit. Сложное редактирование и несколько референсов можно явно поручить seedream-5.0-pro. Другие генераторы не используй. Передай подробное описание, нужные надписи, стиль и композицию. Референсы — идентификаторы вложений текущего диалога: локальный файл сначала открой read_image. Результат автоматически появится в чате; если он нужен проекту, скопируй возвращённый path в нужный каталог штатным файловым инструментом. Для показа фактического состояния приложения используй настоящий take_screenshot, а не генерацию изображения.' : ''});
  const generate=createImageGenerator(ctx,options);
  const integer={type:'integer',required:true};
  ctx.tools.register(defineTool({name:'generate_image',timeoutMs:240000,description:'Create a real photo, illustration, background or other raster asset needed for the current project, or edit a reference image. Use proactively when the task needs visual assets. New images use seedream-5.0-pro at 2K by default. One reference defaults to krea-k3-edit; explicit Seedream supports up to 14 references. Only these two models are allowed. Images appear in chat and are returned for inspection; path, when available, is a normalized local file that can be copied into the project. This is image generation, not a screenshot.',parameters:{prompt:{type:'string',required:true,description:'Detailed image description or editing instruction.'},model:{type:'string',enum:IMAGE_MODELS,description:'Optional model override; Seedream for creation, Krea for a single-image edit.'},reference_images:{type:'array',items:{type:'string'},description:'Image attachment IDs already present in this conversation; use read_image for a local source first.'},resolution:{type:'string',enum:['1K','2K'],description:'Default 2K for Seedream and 1K for Krea.'},caption:{type:'string',description:'Brief caption, up to 240 characters.'}},output:{schema:{type:'object',additionalProperties:false,properties:{image:{type:'object',additionalProperties:false,required:true,properties:{attachmentId:{type:'string',required:true},mediaType:{type:'string',required:true},bytes:integer,width:integer,height:integer,name:{type:'string'},originalDimensions:{type:'object',additionalProperties:false,properties:{width:integer,height:integer}}}},caption:{type:'string',required:true},model:{type:'string',required:true},path:{type:'string'}}},render:(_args,result)=>[{type:'text',text:`${result.caption}\nМодель: ${result.model}${result.path?`\nФайл: ${result.path}`:''}`},{type:'image',attachment:result.image}]},isConcurrencySafe:()=>false,execute:generate}));
}
export function apply(ctx){installImageGeneration(ctx);}
