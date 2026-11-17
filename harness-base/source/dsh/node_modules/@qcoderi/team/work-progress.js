import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent';

// A small number of checkpoints per turn, with no timer or extra model call.
const checkpoints = new Map([
  [9, 'Сверь текущий результат с запросом. Если осталось несколько независимых частей, передай их команде сейчас. Для ожидания фоновой команды используй её завершение, не опрашивай её циклически.'],
  [17, 'Сузь работу до невыполненных критериев. Повторяй тест после изменения, которое может повлиять на него; на неизменившихся файлах используй уже полученный успешный результат.'],
  [33, 'Перед следующей правкой сформулируй конкретный оставшийся дефект и проверку, которая его подтвердит. Если критерии выполнены, подведи итог. Если остался внешний блокер, покажи его и сохрани проверенный результат.'],
  [65, 'Сверься с исходной целью и запиши, что уже проверено. Продолжай только конкретную обязательную часть. Не расширяй задачу дополнительной полировкой.'],
]);

export function installWorkProgress(ctx) {
  ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
    const decision = await next();
    const reminder = checkpoints.get(step);
    if (!reminder || decision.kind !== 'enter' || signal.aborted || delegationDepthOf(agent) !== 0) return decision;
    return { ...decision, messages: [...decision.messages, createUserMessage({
      source: { kind: 'plugin', plugin: 'qcoderi-team', form: 'notice', summary: 'Сверка прогресса' },
      content: [{ type: 'text', text: reminder }],
    })] };
  });
}
