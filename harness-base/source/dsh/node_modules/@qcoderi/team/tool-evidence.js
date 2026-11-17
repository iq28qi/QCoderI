const pageSize = 6000;

export function toolEvidence(session, callId, offset = 0) {
  if (typeof callId !== 'string' || !callId || callId.length > 300 || !Number.isSafeInteger(offset) || offset < 0) {
    throw Error('Нужны ID вызова инструмента и целое смещение от нуля');
  }
  const result = session.snapshotEvents().findLast(event =>
    event.type === 'tool/result' && event.data.message.source?.callId === callId);
  if (!result) throw Error('Результат с этим ID отсутствует в текущем диалоге');
  const text = result.data.message.content.filter(block => block.type === 'tool-result')
    .flatMap(block => block.content.filter(item => item.type === 'text').map(item => item.text)).join('\n');
  let end = Math.min(text.length, offset + pageSize);
  const last = text.charCodeAt(end - 1);
  if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
  return {
    source: 'saved tool output',
    call_id: callId,
    offset,
    total_chars: text.length,
    next_offset: end < text.length ? end : null,
    text: text.slice(offset, end),
  };
}
