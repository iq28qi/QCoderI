import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactRequestContext } from '../assets/request-context.js';
import { toolEvidence } from '../assets/team/tool-evidence.js';

const requirements = { role:'user', source:{kind:'user'}, content:[{type:'text',text:'Сохрани настройки и проверь мобильный экран.'}] };
const image = { type:'image', id:'reference-image' };
const log = 'Starting test\n' + 'fixture output for a normal check\n'.repeat(700) +
  'ERROR: failed persistence check at settings.test.js:73\n' + 'more fixture output\n'.repeat(500) + 'Exit code: 2';
function pair(index, { name = 'pwsh', extra = [], error = false } = {}) {
  const id = `call-${index}`;
  return [
    { role:'assistant', content:[{ type:'tool-call', id, name, arguments:'{}' }] },
    { role:'user', source:{kind:'tool',callId:id}, content:[{
      type:'tool-result', toolCallId:id, isError:error,
      content:[{type:'text',text:log}, ...extra],
    }] },
  ];
}

test('older repetitive logs are compacted while requirements, evidence, recent outputs and pairing survive', () => {
  const messages = [requirements, ...Array.from({length:28}, (_, index)=>pair(index)).flat(),
    ...pair('error',{error:true}), ...pair('image',{extra:[image]}), ...pair('unknown',{name:'unreal_command'})];
  const projected = compactRequestContext(messages);
  const before = Buffer.byteLength(JSON.stringify(messages));
  const after = Buffer.byteLength(JSON.stringify(projected));
  assert(after < before * 0.45);
  assert.strictEqual(projected[0],requirements);
  assert.strictEqual(projected.at(-1),messages.at(-1));
  assert.strictEqual(projected.at(-3),messages.at(-3));
  assert.strictEqual(projected.at(-5),messages.at(-5));
  const compact = projected[2].content[0];
  assert.equal(compact.toolCallId,'call-0');
  assert.match(compact.content[0].text,/ERROR: failed persistence check at settings.test.js:73/);
  assert.match(compact.content[0].text,/Exit code: 2/);
  assert.equal(messages[2].content[0].content[0].text,log);
  assert.strictEqual(projected[56],messages[56]);
  console.log(`Request message JSON bytes: ${before} → ${after} (${Math.round((1-after/before)*100)}% less in the fixture)`);
});

test('small transcripts and cache prefixes stay stable between projection boundaries', () => {
  const small = [requirements, ...Array.from({length:11},(_,index)=>pair(index)).flat()];
  assert.strictEqual(compactRequestContext(small),small);
  const large = [...small,...pair(11)];
  const first = compactRequestContext(large);
  assert.deepEqual(compactRequestContext([...large,...pair(12)]).slice(0,large.length),first);
});

test('saved full logs can be read by call ID with bounded pagination', () => {
  const message = pair(7)[1];
  const session = {snapshotEvents:()=>[{type:'tool/result',data:{message}}]};
  const first = toolEvidence(session,'call-7');
  assert.equal(first.text,log.slice(0,6000));
  assert.equal(first.next_offset,6000);
  assert.equal(toolEvidence(session,'call-7',first.next_offset).text,log.slice(6000,12000));
  assert.throws(()=>toolEvidence(session,'another-chat-call'),/текущем диалоге/);
  assert.throws(()=>toolEvidence(session,'call-7',-1),/смещение/);
});
