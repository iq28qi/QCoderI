// Request-only projection. The session log remains the source of complete tool results.
const compactable = new Set(['read', 'grep', 'glob', 'ls', 'pwsh', 'bash', 'job_output', 'team_status', 'project_context']);
const groupSize = 8;
const recentResults = 4;
const minimum = 3500;
const diagnostic = /\b(?:error|failed|exception|traceback|assertion|exit code|timed out|denied|warning)\b|ошибк|конфликт|тайм.аут/i;

function safePrefix(text, length) {
  const end = text.charCodeAt(length - 1);
  return text.slice(0, end >= 0xd800 && end <= 0xdbff ? length - 1 : length);
}

function compactText(text, name) {
  const head = name === 'read' ? 1100 : 650;
  const tailStart = text.length - 850;
  const tail = text.slice((text.charCodeAt(tailStart) & 0xfc00) === 0xdc00 ? tailStart + 1 : tailStart);
  const evidence = new Set();
  if (name !== 'read') {
    let remaining = 820;
    for (const line of text.slice(head, tailStart).split(/\r?\n/)) {
      if (!diagnostic.test(line)) continue;
      const snippet = safePrefix(line.trim(), 220);
      if (evidence.has(snippet)) continue;
      if (snippet.length + 1 > remaining) break;
      evidence.add(snippet);
      remaining -= snippet.length + 1;
    }
  }
  return [
    safePrefix(text, head),
    `[QCoderI: часть прежнего вывода ${name} свёрнута. При необходимости используй team_evidence с ID вызова, если инструмент доступен, либо открой исходный файл или вывод задания.]`,
    ...evidence,
    tail,
  ].join('\n');
}

export function compactRequestContext(messages) {
  const calls = new Map();
  const candidates = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === 'assistant') {
      for (const block of message.content) if (block.type === 'tool-call') calls.set(block.id, block.name);
      continue;
    }
    if (message.role !== 'user' || message.source?.kind !== 'tool') continue;
    for (const [position, block] of message.content.entries()) {
      if (block.type !== 'tool-result' || block.isError) continue;
      const name = calls.get(block.toolCallId);
      if (!compactable.has(name)) continue;
      if (block.content.length !== 1 || block.content[0].type !== 'text' || block.content[0].text.length <= minimum) continue;
      candidates.push({ index, position, name, block });
    }
  }
  // Advancing in groups keeps older request prefixes stable for provider prompt caches.
  const count = Math.floor((candidates.length - recentResults) / groupSize) * groupSize;
  if (count <= 0) return messages;
  const projected = messages.slice();
  for (const { index, position, name, block } of candidates.slice(0, count)) {
    const message = projected[index];
    const content = message.content.slice();
    content[position] = { ...block, content: [{ ...block.content[0], text: compactText(block.content[0].text, name) }] };
    projected[index] = { ...message, content };
  }
  return projected;
}
