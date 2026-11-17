import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';

export function mediaCachePath(directory,key,index,source) {
  return join(directory,key+'-'+index+'-'+createHash('sha256').update(source).digest('hex').slice(0,12)+'.mp4');
}
export async function cachedMediaResponse(file,request) {
  let info;try{info=await stat(file);}catch(error){if(error.code==='ENOENT')return;throw error;}
  if(!info.isFile()||!info.size)return;
  const range=request.headers.get('range');let start=0,end=info.size-1;
  const headers=new Headers({'Content-Type':'video/mp4','Accept-Ranges':'bytes','Cache-Control':'private, max-age=3600','X-QCoderI-Cache':'HIT'});
  if(range){
    const match=/^bytes=(\d*)-(\d*)$/.exec(range);
    if(!match||!match[1]&&!match[2])return new Response(null,{status:416,headers:{'Content-Range':'bytes */'+info.size}});
    if(!match[1])start=Math.max(0,info.size-Number(match[2]));
    else {start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=info.size||end<start)return new Response(null,{status:416,headers:{'Content-Range':'bytes */'+info.size}});
    headers.set('Content-Range',`bytes ${start}-${end}/${info.size}`);
  }
  headers.set('Content-Length',String(end-start+1));
  return new Response(request.method==='HEAD'?null:Readable.toWeb(createReadStream(file,{start,end})),{status:range?206:200,headers});
}

// Cache only a complete response beginning at byte zero. The file becomes
// visible atomically after the declared byte count is received. Partial and
// cancelled streams never masquerade as playable local videos.
export async function cacheMediaStream(body,headers,status,file,{maxBytes=536870912}={}) {
  const length=Number(headers.get('content-length'));
  const range=headers.get('content-range');
  const type=headers.get('content-type')??'';
  if(!body||!Number.isSafeInteger(length)||length<=0||length>maxBytes||!/^video\/mp4(?:;|$)|^application\/octet-stream(?:;|$)/i.test(type)||(status!==200||range)&&range!==`bytes 0-${length-1}/${length}`)return body;
  const temporary=file+'.'+randomUUID()+'.tmp';let handle;
  try{await mkdir(dirname(file),{recursive:true});handle=await open(temporary,'wx');}catch{return body;}
  const reader=body.getReader();let count=0,finished=false;
  const discard=async()=>{await handle?.close().catch(()=>{});handle=undefined;await unlink(temporary).catch(()=>{});};
  return new ReadableStream({
    async pull(controller){
      try{
        const {done,value}=await reader.read();
        if(done){
          finished=true;
          if(handle&&count===length){await handle.close();handle=undefined;await rename(temporary,file).catch(()=>unlink(temporary).catch(()=>{}));}
          else await discard();
          controller.close();return;
        }
        count+=value.byteLength;
        if(handle){try{if(count>length)throw Error('Invalid media size');await handle.writeFile(value);}catch{await discard();}}
        controller.enqueue(value);
      }catch(error){await discard();controller.error(error);}
    },
    async cancel(reason){if(!finished){await reader.cancel(reason).catch(()=>{});await discard();}},
  });
}
