import { createHash } from 'node:crypto';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { createJournal } from './media.js';

export function createMediaOptions(directory=dshHomePath('media-jobs','options')) {
  const journal=createJournal(directory);
  const key=sessionId=>{
    if(typeof sessionId!=='string'||!sessionId||sessionId.length>200)throw Error('Нужен идентификатор диалога.');
    return createHash('sha256').update(sessionId).digest('hex');
  };
  return {
    async get(request){const value=await journal.read(key(request?.sessionId));return {seconds:value?.seconds??5,min:1,max:120};},
    async set(request){
      const id=key(request?.sessionId),seconds=request.seconds;
      if(!Number.isInteger(seconds)||seconds<1||seconds>120)throw Error('Длительность должна быть целым числом от 1 до 120 секунд.');
      await journal.write(id,{seconds});return {seconds,min:1,max:120};
    },
  };
}
