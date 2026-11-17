import {randomUUID} from 'node:crypto';
// One owner for the physical Windows desktop, shared by all chats and workers.
export class DesktopSession{
  owner='agent';epoch=0;observation=null;preview=null;queue=Promise.resolve();active=null;
  snapshot(){return {owner:this.owner,epoch:this.epoch,observation:this.observation,preview:this.preview};}
  takeover(){this.owner='human';this.epoch++;this.observation=null;this.active?.abort();return this.snapshot();}
  resume(){this.owner='agent';this.epoch++;this.observation=null;return this.snapshot();}
  run(signal,operation){const epoch=this.epoch;const result=this.queue.catch(()=>{}).then(async()=>{signal.throwIfAborted();if(epoch!==this.epoch||this.owner!=='agent')throw Error('Управление у пользователя или изменилось. Обновите наблюдение.');const controller=new AbortController();this.active=controller;try{const result=await operation(AbortSignal.any([signal,controller.signal]));if(epoch!==this.epoch)throw Error('Управление изменилось. Обновите наблюдение.');return result;}finally{this.active=null;}});this.queue=result;return result;}
  observed(sessionId,window,image){this.observation={id:randomUUID(),sessionId,window,at:Date.now(),image};return this.observation;}
  require(sessionId,window,id){const value=this.observation;if(!value||value.id!==id||value.sessionId!==sessionId||value.window!==window||Date.now()-value.at>120000)throw Error('Устаревшее наблюдение. Выполните desktop_inspect и используйте observation_id.');}
}
export const desktopSession=new DesktopSession();
