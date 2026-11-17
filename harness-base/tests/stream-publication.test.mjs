import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const implementation = readFileSync(new URL('../assets/stream-publication.js', import.meta.url), 'utf8');
const base = resolve(fileURLToPath(new URL('..', import.meta.url)));
const archive = resolve(process.env.HARNESS_ARCHIVE ?? join(base, 'source'));
assert(readFileSync(join(archive, 'dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js'), 'utf8').includes(implementation.trim()), 'shipped stream publication matches the tested implementation');
function fixture() {
  let now=0, nextId=0; const timers=new Map(); const document={hidden:false};
  const schedule=(fn,delay=0)=>{const id=++nextId;timers.set(id,{at:now+delay,fn});return id};
  const context={document,setTimeout:schedule,clearTimeout:id=>timers.delete(id),requestAnimationFrame:fn=>schedule(fn,4),cancelAnimationFrame:id=>timers.delete(id)};
  const Gate=vm.runInNewContext(`(class { ${implementation} constructor(){this.pending=[];this.delivered=[];this.commits=0} flush(){this.delivered.push(...this.pending);this.pending=[];this.commits++} append(value){this.pending.push(value);this.publish('animation-frame')} })`,context);
  const advance=ms=>{const end=now+ms;while(true){const first=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!first||first[1].at>end)break;now=first[1].at;timers.delete(first[0]);first[1].fn()}now=end};
  return {gate:new Gate(),advance,timers,document};
}

test('high-rate streaming coalesces publication and final settlement preserves every chunk in order',()=>{
  const {gate,advance,timers}=fixture();
  for(let i=0;i<1000;i++){gate.append(i);advance(1)}
  assert(gate.commits<=12,'streaming must not follow a high refresh-rate display');
  gate.publish('immediate');
  assert.deepEqual(Array.from(gate.delivered),Array.from({length:1000},(_,i)=>i));
  assert.equal(timers.size,0,'final settlement cancels delayed publication');
  const committed=gate.commits;advance(1000);assert.equal(gate.commits,committed);
});

test('disposal cancels timer and frame phases; hidden pages publish without a frame clock',()=>{
  for(const delay of [0,80]){
    const {gate,advance,timers}=fixture();gate.append('cancelled');advance(delay);gate.cancelFrame();advance(1000);
    assert.equal(gate.commits,0);assert.equal(timers.size,0);
  }
  const {gate,advance,document}=fixture();document.hidden=true;gate.append('hidden');advance(249);
  assert.equal(gate.commits,0);advance(1);assert.deepEqual(Array.from(gate.delivered),['hidden']);
  gate.append('final');gate.publish('immediate');assert.deepEqual(Array.from(gate.delivered),['hidden','final']);
});
