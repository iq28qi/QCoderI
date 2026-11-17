import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
export async function transcribe(ctx,agent,args,signal=AbortSignal.timeout(180000)){
  if(typeof args.audio!=='string'||args.audio.length>20*1024*1024||!/^[\w+/=\r\n]+$/.test(args.audio))throw Error('Некорректная аудиозапись, лимит 15 МБ');
  const data=Buffer.from(args.audio,'base64');if(data.length<100||data.length>15*1024*1024)throw Error('Аудио от 100 байт до 15 МБ');
  if(args.mode==='local'){
    if(!['tiny','base','small','medium','large-v3-turbo','large-v3'].includes(args.model))throw Error('Выберите модель Whisper');
    const directory=await mkdtemp(join(tmpdir(),'qcoderi-voice-'));
    try{const audio=join(directory,'voice.webm'),output=join(directory,'text.txt');await writeFile(audio,data);const code="import sys\nfrom faster_whisper import WhisperModel\nmodel=WhisperModel(sys.argv[3],device='cpu',compute_type='int8',local_files_only=True)\nsegments,_=model.transcribe(sys.argv[1])\nopen(sys.argv[2],'w',encoding='utf-8').write(' '.join(s.text for s in segments))";await run('python',['-c',code,audio,output,args.model],{windowsHide:true,timeout:180000,signal,maxBuffer:100000});return {text:(await readFile(output,'utf8')).slice(0,18000)};}catch(error){throw Error('Локальная диктовка недоступна. Нужны установленный faster-whisper и заранее загруженная модель. '+String(error.stderr??'').slice(-350));}finally{await rm(directory,{recursive:true,force:true});}
  }
  const route=agent.session.requestHeader()?.config??agent.options;
  const profile=ctx.settings.get('llm-pi-ai')?.providers?.[args.provider||route.provider];
  if(!profile?.baseURL)throw Error('У провайдера не задан Base URL');
  const base=new URL(profile.baseURL);if(base.protocol!=='https:'&&!(base.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(base.hostname)))throw Error('Для API диктовки нужен HTTPS или локальный сервер');if(base.username||base.password||base.search||base.hash)throw Error('Некорректный Base URL');
  const key=(await ctx.credentials.resolve(profile.apiKeyEnv))?.value;if(!key)throw Error('Нет ключа выбранного провайдера');
  const form=new FormData();form.append('file',new Blob([data],{type:'audio/webm'}),'voice.webm');form.append('model',String(args.model||'whisper-1').slice(0,100));
  const response=await fetch(base.href.replace(/\/$/,'')+'/audio/transcriptions',{method:'POST',headers:{Authorization:'Bearer '+key},body:form,redirect:'error',signal});
  if(!response.ok)throw Error('API диктовки: HTTP '+response.status+'. Проверьте поддержку /audio/transcriptions.');
  const result=await response.json();if(typeof result.text!=='string')throw Error('API не вернул текст');return {text:result.text.slice(0,18000)};
}
