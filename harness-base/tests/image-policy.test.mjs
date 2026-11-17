import assert from 'node:assert/strict';
import {qcImageInputFromMetadata,qcImageDefaults} from '../assets/image-policy.js';
const catalog=id=>({ 'gpt-6-astra':['text','image'],'claude-sonnet-5':['text','image'],'kimi-k3':['text','image'],'deepseek-v4-flash':['text'],'gemini-3-8-flash':['text','image'] })[id];
for(const id of ['gpt-6-astra','gpt-6.1-sol','openai.gpt-6-astra','openai/gpt-6-astra:free','anthropic/claude-sonnet-5.5','kimi-k3-1-pro','google/gemini-3.8-flash']){
  const model={id,input:qcImageDefaults(id,catalog)??['text']};
  const rows=[{id,input_modalities:['text'],capabilities:{vision:false,image:false,image_vision:false}}];
  assert.deepEqual(qcImageInputFromMetadata(model,rows,catalog),['text','image'],id);
}
for(const id of ['unknown','deepseek-v4-flash'])assert.deepEqual(qcImageInputFromMetadata({id,input:['text']},[{id,input_modalities:['text'],vision:false}],catalog),['text']);
assert.deepEqual(qcImageInputFromMetadata({id:'alias',input:['text']},[{id:'alias',canonical_model:'gpt-6-astra',input:['text']}],catalog),['text','image']);
assert.deepEqual(qcImageInputFromMetadata({id:'alias',input:['text']},[{id:'alias',input:['text'],capabilities:{image_vision:true}}],catalog),['text','image']);
assert.equal(qcImageInputFromMetadata({id:'unknown',input:['text']},[],catalog),undefined);
console.log('PASS: multiple model families, vendor prefixes, free aliases and opaque canonical IDs retain known vision against false gateway metadata; unknown/text models stay text');
