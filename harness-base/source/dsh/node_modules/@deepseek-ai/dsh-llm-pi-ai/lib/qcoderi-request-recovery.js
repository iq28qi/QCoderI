// Retry only an explicit pre-generation request-body rejection. Never replay
// a partially published answer, tool call, cancellation or an ambiguous failure.
import { classifyTaskFailure, providerPolicyFailure, terminalProviderRateLimit } from './model-task-adapter.js';

export async function* qcRecoverRequest(createStream,snapshot,compact,signal,route){
  for(let attempt=0;attempt<2;attempt++){
    signal?.throwIfAborted();let published=false,retry=false;const pending=[];
    for await(const chunk of createStream(snapshot)){
      if(chunk.type==='usage'&&!published&&!Object.values(chunk.usage??{}).some(value=>typeof value==='number'&&value>0)){pending.push(chunk);continue;}
      if(chunk.type==='usage'&&Object.values(chunk.usage??{}).some(value=>typeof value==='number'&&value>0))published=true;
      const failure=chunk.type==='finish'&&chunk.reason?.kind==='error'?chunk.reason.failure:undefined;
      const terminal=terminalProviderRateLimit(failure);
      if(terminal){
        for(const item of pending)yield item;
        yield {...chunk,reason:{...chunk.reason,failure:terminal}};
        return;
      }
      const category=failure&&classifyTaskFailure(failure);
      if(category==='request_size'){
        const message=failure.message;
        if(!published&&!signal?.aborted&&attempt===0){snapshot=compact(snapshot);retry=true;break;}
        for(const item of pending)yield item;pending.length=0;
        yield {...chunk,reason:{...chunk.reason,failure:{...chunk.reason.failure,code:'INVALID_REQUEST',message:(attempt===0?'Провайдер отклонил тело запроса после начала ответа; автоматический повтор запрещён. ':'Провайдер отклонил тело запроса. Уменьшение изображений и один повтор не помогли. ')+'Исходники и история сохранены. Попробуйте новый чат с нужными референсами или другое подключение. Ответ сервера: '+message}}};continue;
      }
      if(category==='provider_policy'){
        for(const item of pending)yield item;pending.length=0;
        yield {...chunk,reason:{...chunk.reason,failure:providerPolicyFailure(failure,route)}};
        return;
      }
      for(const item of pending)yield item;pending.length=0;
      yield chunk;if(chunk.type!=='usage'&&chunk.type!=='finish')published=true;
    }
    if(!retry)return;
  }
}
