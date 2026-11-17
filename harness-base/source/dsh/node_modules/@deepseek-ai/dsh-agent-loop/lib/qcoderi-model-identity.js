// Exact questions about the active route can be answered without model inference.
const IDENTITY_QUESTION = /^(?:(?:а|ну|так|ку|привет|скажи(?:те)?)\s+)*(?:кто ты|что ты за модель|что ты за модель ии|какая (?:ты модель|у тебя модель|модель|модель у тебя|сейчас модель|модель выбрана|модель отвечает)|какая модель (?:стоит|скрывается) за (?:этим )?алиасом|как называется (?:твоя|выбранная) модель|назови(?:те)? (?:свою |выбранную |настоящую )?модель|who are you|what model are you|which model are you|what(?: is|'s) your model|which model is selected)(?:\s+на самом деле)?$/iu;

export function isModelIdentityQuestion(messages) {
  const userMessages = messages.filter(message => message.role === 'user' && message.source?.kind === 'user');
  if (userMessages.length !== 1) return false;
  const { content } = userMessages[0];
  if (!content.length || content.some(block => block.type !== 'text')) return false;
  const text = content.map(block => block.text).join(' ').toLowerCase().trim()
    .replace(/[?!.,]+$/u, '').replace(/[,،]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return IDENTITY_QUESTION.test(text);
}

export async function* modelIdentityStream({provider, model, session, llm, signal}) {
  let text = 'В этом чате ещё не выбрана модель. Её можно выбрать под полем сообщения.';
  if (provider && model) {
    const last = session.snapshotEvents().findLast(event => {
      if (event.type !== 'assistant/message' || event.data.interrupted) return false;
      const {source} = event.data.message;
      return source.provider === provider && source.model === model && source.replayState?.response?.kind === 'pi-ai';
    });
    const reported = last?.data.message.source.replayState.response.responseModel;
    const explicit = typeof reported === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,159}$/.test(reported)
      && reported.toLowerCase() !== model.toLowerCase();
    if (explicit) {
      text = `Я ассистент QCoderI. Модель по последнему ответу провайдера — ${reported}. Подключение — ${provider}. В настройках выбрано ${model}.`;
    } else {
      let upstream;
      try {
        upstream = (await llm.resolveModelInfo(provider, model, signal)).upstreamModel;
      } catch {
        signal?.throwIfAborted();
      }
      text = upstream
        ? `Я ассистент QCoderI. По каталогу провайдера за ${model} стоит модель ${upstream}. Подключение — ${provider}.`
        : `Я ассистент QCoderI. Подключение — ${provider}, ID в настройках — ${model}. Данных о модели за этим ID провайдер не предоставил.`;
    }
  }
  signal?.throwIfAborted();
  yield {
    type: 'text-delta',
    index: 0,
    text,
  };
  yield {type: 'finish', reason: {kind: 'stop'}};
}
