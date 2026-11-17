import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { createJournal, safeUrls } from './media.js';
import { join } from 'node:path';
import { cachedMediaResponse, cacheMediaStream, mediaCachePath } from './media-cache.js';

// Same-origin streaming keeps remote redirects, range headers and transient
// connection errors under one transport. No remote URL is accepted from the UI.
export function createMediaPlayback({directory=dshHomePath('media-jobs'),cacheDirectory=join(directory,'cache'),fetchImpl=globalThis.fetch}={}) {
  const journal=createJournal(directory);
  return async request=>{
    const url=new URL(request.url),match=/^\/qcoderi-media\/([a-f0-9]{64})\/(\d)$/.exec(url.pathname);
    if(!match)return new Response(null,{status:404});
    if(!['GET','HEAD'].includes(request.method))return new Response(null,{status:405});
    const record=await journal.read(match[1]);
    if(!record||record.state!=='completed'||record.sessionId!==url.searchParams.get('session'))return new Response(null,{status:404});
    const source=safeUrls(record.urls)[Number(match[2])];
    if(!source)return new Response(null,{status:404});
    const range=request.headers.get('range');
    if(range&&!/^bytes=\d*-\d*$/.test(range))return new Response(null,{status:416});
    const cachedFile=mediaCachePath(cacheDirectory,match[1],match[2],source);
    const attachment=response=>{
      if(url.searchParams.get('download')!=='1')return response;
      const name='QCoderI-'+String(record.model??'video').replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,80)+'-'+(Number.isInteger(record.seconds)?record.seconds:5)+'s-'+match[1].slice(0,8)+'.mp4';
      const headers=new Headers(response.headers);headers.set('Content-Disposition','attachment; filename="'+name+'"');
      return new Response(response.body,{status:response.status,headers});
    };
    const cached=await cachedMediaResponse(cachedFile,request);
    if(cached)return attachment(cached);
    let upstream;
    try {
      for(let attempt=0;attempt<3;attempt++){
        try {
          upstream=await fetchImpl(source,{method:request.method,headers:{...(range?{Range:range}:{}),'Accept-Encoding':'identity'},redirect:'follow',signal:AbortSignal.any([request.signal,AbortSignal.timeout(120000)])});
          if(upstream.status<500&&upstream.status!==429)break;
          await upstream.body?.cancel();
          if(attempt===2)return new Response('Видео временно недоступно у NiceAI.',{status:502});
        }catch(error){if(attempt===2||request.signal.aborted)throw error;}
      }
    }catch{return new Response('Не удалось загрузить видео NiceAI. Повтори загрузку.',{status:502});}
    if(![200,206,416].includes(upstream.status)){await upstream.body?.cancel();return new Response('Ссылка NiceAI недоступна. Обнови статус задачи.',{status:502});}
    const headers=new Headers({'Content-Type':upstream.headers.get('content-type')??'video/mp4','Cache-Control':'private, max-age=3600','X-Content-Type-Options':'nosniff','X-QCoderI-Cache':'MISS'});
    for(const name of ['content-length','content-range','accept-ranges'])if(upstream.headers.has(name))headers.set(name,upstream.headers.get(name));
    const body=request.method==='HEAD'?null:await cacheMediaStream(upstream.body,upstream.headers,upstream.status,cachedFile);
    return attachment(new Response(body,{status:upstream.status,headers}));
  };
}
