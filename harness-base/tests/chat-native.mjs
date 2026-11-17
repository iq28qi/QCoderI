// Real conversation loop, scripted model transport, no workspace or paid API.
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const base = resolve(fileURLToPath(new URL('..', import.meta.url)));
const archive = resolve(process.env.HARNESS_ARCHIVE ?? join(base, 'source'));
const load = name => import(pathToFileURL(join(archive, 'dsh/node_modules/@deepseek-ai', name, 'lib/index.js')).href);
const { Context } = await load('cordis');
const { LlmAdapter, LlmError, createUserMessage } = await load('dsh-llm');
const { defineTool } = await load('dsh-tools');
const ctx = new Context();
const watchdog = setTimeout(() => { console.error('FAIL: chat loop exceeded 15 seconds'); process.exit(1); }, 15000);
let handle;
try {
  for (const name of ['dsh-session','dsh-session-projection','dsh-llm','dsh-system-prompt','dsh-tools','dsh-agent','dsh-agent-loop']) {
    const module = await load(name);
    await ctx.plugin(module.default ?? module, {});
  }
  for (let i=0;i<100&&!ctx.get('agentLoop');i++) await delay(10);
  ctx.tools.register(defineTool({
    name:'project_tool', description:'Project capability that must not enter chat', parameters:{},
    output:{schema:{type:'string'},render:()=>[]}, execute(){assert.fail('chat cannot execute project tools');},
  }));
  let requests=0;
  class ConversationAdapter extends LlmAdapter {
    async *stream(options) {
      requests++;
      assert.equal(options.tools?.length ?? 0, 0, 'ordinary chat exposes no project tools');
      const messages=options.messages.flatMap(message=>message.content??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n');
      assert(messages.includes('Первое сообщение'));
      if(requests===2) {
        assert(messages.includes('Ответ 1'), 'conversation context survives to the second request');
        assert(messages.includes('Второе сообщение'));
      }
      yield {type:'text-delta',index:0,text:`Ответ ${requests}`};
      yield {type:'finish',reason:{kind:'stop'},replayState:{response:{kind:'pi-ai',responseModel:'actual-fixture-2026'},blocks:[{type:'text'}]}};
    }
  }
  ctx.llm.registerAdapter(['fixture'],new ConversationAdapter());
  const persona=await load('dsh-persona');
  const chat=await import(pathToFileURL(join(archive,'dsh/node_modules/@qcoderi/team/chat.js')).href);
  handle=await ctx.agents.create({sessionId:'ordinary-chat-fixture',agentOptions:{provider:'fixture',model:'fixture'},setup:async scope=>{
    await scope.plugin(persona,{prefix:'Ты полезный собеседник. Это обычный разговор.',suffix:'',includeRuntimeContext:false});
    await scope.plugin(chat);
  }});
  assert.equal(handle.agent.session.header.cwd,undefined,'a native chat does not require a working directory');
  for(const text of ['Первое сообщение','Второе сообщение']) {
    handle.agent.followup(createUserMessage({content:[{type:'text',text}],source:{kind:'user'}}));
    await handle.agent.whenIdle();
  }
  assert.equal(requests,2,JSON.stringify(handle.agent.session.snapshotEvents().filter(event=>event.type==='turn/end'||event.type==='step/end').map(event=>event.data)));
  const replies=handle.agent.session.snapshotEvents().filter(event=>event.type==='assistant/message');
  assert.equal(replies.length,2,JSON.stringify(handle.agent.session.snapshotEvents().filter(event=>event.type==='turn/end'||event.type==='step/end').map(event=>event.data)));
  assert.equal(replies[1].data.message.content[0].text,'Ответ 2');
  const availableText = text => createUserMessage({content:[{type:'text',text}],source:{kind:'user'}});
  const send = text => handle.agent.followup(availableText(text));
  send('что ты за модель?');
  await handle.agent.whenIdle();
  assert.match(handle.agent.session.snapshotEvents().findLast(e=>e.type==='assistant/message').data.message.content[0].text,
    /последнему ответу провайдера — actual-fixture-2026.*Подключение — fixture/);
  assert.equal(requests,2,'model identity does not depend on provider inference');
  const latestPrompt = handle.agent.session.snapshotEvents().findLast(e=>e.type==='system/message').data.message.content[0].text;
  assert.match(latestPrompt,/assistant in QCoderI.*model ID is fixture/);
  assert.doesNotMatch(latestPrompt,/DeepSeek Harness/);
  console.log('PASS: real ordinary chat, second reply and local model identity persist without project tools');

  let releaseFailure, signalStarted;
  const failureSent = new Promise(resolve=>{releaseFailure=resolve;});
  const started = new Promise(resolve=>{signalStarted=resolve;});
  class FailingAdapter extends LlmAdapter {
    async *stream() {
      signalStarted();
      await failureSent;
      yield {type:'text-delta',index:0,text:'Оборванный ответ'};
      yield {type:'finish',reason:{kind:'error',failure:{code:'CONTENT_POLICY',message:'Ошибка тестового провайдера'}}};
    }
  }
  await handle.dispose();
  ctx.llm.registerAdapter(['unavailable'],new FailingAdapter());
  handle=await ctx.agents.create({sessionId:'queued-after-failure',agentOptions:{provider:'unavailable',model:'chosen-test-model'}});
  send('Первый запрос с ошибкой');
  await started;
  send('а какая ты модель?');
  releaseFailure();
  await handle.agent.whenIdle();
  const history=handle.agent.session.snapshotEvents();
  assert.deepEqual(history.filter(e=>e.type==='turn/end').map(e=>e.data.reason.kind),['error','completed']);
  assert.match(history.findLast(e=>e.type==='assistant/message').data.message.content[0].text,/unavailable.*chosen-test-model.*провайдер не предоставил/);
  console.log('PASS: queued follow-up is processed after a failed partial response');
  let attempts=0, recoveries=0;
  class InterruptedAdapter extends LlmAdapter {
    async *stream(options) {
      if (++attempts === 1) {
        yield {type:'text-delta',index:0,text:'частичный текст'};
        throw new LlmError('fixture disconnected', 'TRANSPORT');
      }
      assert.equal(options.messages.filter(message=>message.role==='user'
        && message.content.some(block=>block.text==='Продолжи текущую задачу')).length,1);
      yield {type:'text-delta',index:0,text:'Продолжил после сбоя'};
      yield {type:'finish',reason:{kind:'stop'}};
    }
  }
  await handle.dispose();
  ctx.llm.registerAdapter(['unstable'],new InterruptedAdapter());
  ctx.on('agent/request-error',({failure,step})=>{
    assert.equal(failure.code,'TRANSPORT');
    assert.equal(step,1);
    recoveries++;
    return Promise.resolve({kind:'retry'});
  });
  handle=await ctx.agents.create({sessionId:'transport-resume',agentOptions:{provider:'unstable',model:'fixture'}});
  send('Продолжи текущую задачу');
  await handle.agent.whenIdle();
  assert.equal(recoveries,1);
  assert.equal(attempts,2);
  const recovered=handle.agent.session.snapshotEvents();
  assert.deepEqual(recovered.filter(event=>event.type==='turn/end').map(event=>event.data.reason.kind),['completed']);
  assert.equal(recovered.filter(event=>event.type==='assistant/attempt').length,1);
  console.log('PASS: thrown network failure resumes the same model step and does not duplicate the user message');

  await handle.dispose();
  let rejectPreparation = true;
  handle = await ctx.agents.create({sessionId:'prepare-failure',agentOptions:{provider:'fixture',model:'fixture'},
    setup(scope) {
      scope.on('agent/request', (_payload, next) => {
        if (rejectPreparation) throw new Error('fixture: no request could start');
        return next();
      });
    }});
  send('Этот текст должен сохраниться после ошибки подготовки запроса');
  await handle.agent.whenIdle();
  assert.deepEqual(handle.agent.session.snapshotEvents().filter(e=>e.type==='user/message')
    .map(e=>e.data.content[0].text),['Этот текст должен сохраниться после ошибки подготовки запроса']);
  assert.equal(handle.agent.session.snapshotEvents().findLast(e=>e.type==='turn/end').data.reason.kind,'error');
  rejectPreparation = false;
  send('а какая ты модель?');
  await handle.agent.whenIdle();
  assert.equal(handle.agent.session.snapshotEvents().filter(e=>e.type==='user/message').length,2);
  assert.match(handle.agent.session.snapshotEvents().findLast(e=>e.type==='assistant/message').data.message.content[0].text,/QCoderI/);
  console.log('PASS: a request that failed before contacting the provider still appears once in history');

  await handle.dispose();
  const { installModelSelection } = await load('dsh-agent');
  const selection = {current:{provider:'switch-fixture',model:'first-model'}};
  const toolEntered = Promise.withResolvers();
  const finishTool = Promise.withResolvers();
  let toolRuns = 0;
  ctx.tools.register(defineTool({
    name:'wait_for_selection', description:'Hold one step to test model selection', parameters:{},
    output:{schema:{type:'string'},render:()=>[]},
    async execute() {
      toolRuns++;
      toolEntered.resolve();
      await finishTool.promise;
      return 'tool completed';
    },
  }));
  const routes = [];
  class SwitchAdapter extends LlmAdapter {
    resolveModel(provider, id) {
      return {provider,id,name:id,reasoning:{efforts:[{id:'max',name:'Maximum'}]}};
    }
    async *stream(options) {
      routes.push([options.model,options.reasoningEffort]);
      if (routes.length === 1) {
        yield {type:'block-end',index:0,block:{type:'tool-call',id:'wait-for-selection',
          name:'wait_for_selection',arguments:'{}'}};
        yield {type:'finish',reason:{kind:'stop'}};
      } else {
        yield {type:'text-delta',index:0,text:'Продолжаю работу с новой моделью'};
        yield {type:'finish',reason:{kind:'stop'}};
      }
    }
  }
  ctx.llm.registerAdapter(['switch-fixture'],new SwitchAdapter());
  handle = await ctx.agents.create({sessionId:'switch-mid-turn',agentOptions:selection.current,
    setup(scope) { installModelSelection(scope,selection); }});
  send('Проверка переключения внутри задачи');
  await toolEntered.promise;
  selection.current = {provider:'switch-fixture',model:'second-model',reasoningEffort:'max'};
  finishTool.resolve();
  await handle.agent.whenIdle();
  assert.deepEqual(routes,[['first-model',undefined],['second-model','max']],
    JSON.stringify(handle.agent.session.snapshotEvents().filter(e=>e.type==='turn/end'||e.type==='tool/result').map(e=>e.data)).slice(0,2400));
  assert.equal(toolRuns,1);
  assert.equal(handle.agent.session.snapshotEvents().filter(e=>e.type==='turn/start').length,1);
  assert.equal(handle.agent.session.snapshotEvents().findLast(e=>e.type==='turn/end').data.reason.kind,'completed');
  console.log('PASS: the model and effort change on the next inference inside the same turn, without repeating tools');

  await handle.dispose();
  const emittedLog = 'normal fixture output\n'.repeat(900);
  ctx.tools.register(defineTool({
    name:'pwsh', description:'Read a deterministic build log', parameters:{},
    output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
    async execute() { return emittedLog; },
  }));
  let exchanges = 0;
  class LargeTranscriptAdapter extends LlmAdapter {
    async *stream(options) {
      const step = ++exchanges;
      if (step <= 12) {
        yield {type:'block-end',index:0,block:{type:'tool-call',id:'log-'+step,name:'pwsh',arguments:'{}'}};
      } else {
        const returned = options.messages.flatMap(m=>m.content).filter(b=>b.type==='tool-result');
        assert.equal(returned.length,12);
        assert.match(returned[0].content[0].text,/QCoderI: часть/);
        assert.equal(returned.at(-1).content[0].text,emittedLog);
        assert(options.messages.some(m=>m.content.some(b=>b.text==='Сохрани исходные требования')));
        yield {type:'text-delta',index:0,text:'Проверка завершена'};
      }
      yield {type:'finish',reason:{kind:'stop'}};
    }
  }
  ctx.llm.registerAdapter(['large-history-fixture'],new LargeTranscriptAdapter());
  handle = await ctx.agents.create({sessionId:'compact-inference-only',agentOptions:{provider:'large-history-fixture',model:'fixture'}});
  send('Сохрани исходные требования');
  await handle.agent.whenIdle();
  const compactEvents = handle.agent.session.snapshotEvents();
  assert.equal(compactEvents.findLast(e=>e.type==='turn/end').data.reason.kind,'completed');
  assert(compactEvents.filter(e=>e.type==='tool/result').every(e=>e.data.message.content[0].content[0].text===emittedLog));
  assert.equal(exchanges,13);
  console.log('PASS: actual AgentLoop sends compact historical tool results and keeps complete logs in chat');
} finally {
  await handle?.dispose();
  await ctx.fiber.dispose();
  clearTimeout(watchdog);
}
