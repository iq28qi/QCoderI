import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const base = resolve(fileURLToPath(new URL('..', import.meta.url)));
const archive = resolve(process.env.HARNESS_ARCHIVE ?? join(base, 'source'));
const load = name => import(pathToFileURL(join(archive, 'dsh/node_modules/@deepseek-ai', name, 'lib/index.js')).href);
const packageUrl = path => pathToFileURL(join(archive, 'dsh/node_modules/@qcoderi/team', path)).href;
const {discoverPresets} = await load('dsh-agent-presets');
const presets = await discoverPresets([{path:join(archive,'dsh/node_modules/@deepseek-ai/dsh-agent-presets/presets'),trust:'system'}],
  pathToFileURL(join(archive,'dsh/node_modules/@deepseek-ai/dsh/lib/index.js')).href);
const hacker = presets.find(preset => preset.id === 'qcoder-hacker');
assert(hacker && !hacker.broken, JSON.stringify(hacker));

const FIXTURE_C = `#include <stdio.h>
const char *qcoderi_settings_key = "QCoderI-settings-v1";
int parse_value(const char *text){ return text && text[0] ? text[0] : 0; }
int load_settings(void){ return parse_value(qcoderi_settings_key); }
int square(int x){ return x*x; }
int main(void){ printf("%d %d\\n", square(3), load_settings()); return 0; }
`;

const {Context} = await load('cordis');
const {LlmAdapter,createUserMessage} = await load('dsh-llm');
const ctx = new Context();
const tempRoot = await realpath(tmpdir());
const workspace = await mkdtemp(join(tempRoot,'qcoderi-analysis-test-'));
let handle;
try {
  for (const name of ['dsh-session','dsh-session-projection','dsh-llm','dsh-system-prompt','dsh-tools',
    'dsh-agent','dsh-agent-loop','dsh-jobs-local','dsh-tool-jobs']) {
    const plugin = await load(name);
    await ctx.plugin(plugin.default ?? plugin,{});
  }
  await ctx.plugin(await import(packageUrl('binary-analysis.js')),{});
  for (let i=0; i<100 && (!ctx.get('agentLoop') || !ctx.get('jobs')); i++) await delay(10);
  let job;
  let turns = 0;
  class FixtureModel extends LlmAdapter {
    resolveModel(provider,id) { return Promise.resolve({provider,id,name:id,inputModalities:['text']}); }
    async *stream(options) {
      turns++;
      assert(options.tools.some(tool=>tool.name==='binary_analyze'));
      assert(options.tools.some(tool=>tool.name==='binary_query'));
      if (turns === 1) {
        yield {type:'block-end',index:0,block:{type:'tool-call',id:'static-analysis',name:'binary_analyze',
          arguments:JSON.stringify({engine:'ghidra',file_path:'fixture.exe',timeout_seconds:180,
            query:{name_query:'load_settings',decompile:true,callgraph_depth:2,instruction_limit:64,
              strings_query:'QCoderI-settings'}})}};
      } else {
        const result = options.messages.flatMap(message=>message.content).findLast(item=>item.type==='tool-result');
        assert(!result.isError, JSON.stringify(result));
        job = JSON.parse(result.content[0].text);
        yield {type:'text-delta',index:0,text:'Статический анализ запущен.'};
      }
      yield {type:'finish',reason:{kind:'stop'}};
    }
  }
  ctx.llm.registerAdapter(['fixture'],new FixtureModel());
  handle = await ctx.agents.create({sessionId:'binary-analysis-fixture',meta:{cwd:workspace},
    agentOptions:{provider:'fixture',model:'test'}});
  const {agent} = handle;
  const signal = AbortSignal.timeout(300000);
  const call = (name,args) => ctx.tools.execute({name,arguments:args,agent,signal,callId:name});
  const available = await call('binary_analyzer_status',{engine:'ghidra'});
  assert(!available.isError,JSON.stringify(available));
  if (!JSON.parse(available.content[0].text)[0].available) {
    assert.notEqual(process.env.QCODERI_REQUIRE_GHIDRA_TEST,'1',available.content[0].text);
    console.log('SKIP: Ghidra and a compatible JDK are required for live static analysis.');
  } else {
    const input = join(workspace,'fixture.exe');
    await writeFile(join(workspace,'fixture.c'),FIXTURE_C);
    const compiled = spawnSync('gcc.exe',['-g','-o',input,join(workspace,'fixture.c')],
      {windowsHide:true, stdio:'inherit'});
    assert.equal(compiled.status,0,'gcc.exe must build the fixture');
    const hash = createHash('sha256').update(await readFile(input)).digest('hex');
    agent.followup(createUserMessage({content:[{type:'text',text:'Проанализируй fixture.exe'}],source:{kind:'user'}}));
    await agent.whenIdle();
    assert.equal(turns,2);
    assert(job?.job_id);
    await ctx.jobs.wait(job.job_id,240000,agent,signal);
    const finished = ctx.jobs.get(job.job_id,agent);
    assert.equal(finished.status,'completed',await readFile(job.log,'utf8'));
    const report = JSON.parse(await readFile(job.report,'utf8'));
    assert(report.functions.some(fn=>fn.name==='square'),JSON.stringify(report.functions.slice(0,5)));
    assert.equal(report.analysis_complete,true);

    // Query evidence: instructions, callers/callees, a call graph and pseudocode.
    const settings = report.function_details?.[0];
    assert(settings,JSON.stringify(report.query));
    assert.equal(settings.name,'load_settings');
    assert.equal(settings.matched_by,'name_query');
    assert(settings.instructions.length>0,JSON.stringify(settings));
    assert(settings.callers.some(caller=>caller.function==='main'),JSON.stringify(settings.callers));
    assert(settings.callees.some(callee=>callee.name==='parse_value'),JSON.stringify(settings.callees));
    assert(settings.callgraph.nodes.length>=2,JSON.stringify(settings.callgraph));
    assert.equal(settings.decompiled.available,true,JSON.stringify(settings.decompiled));
    assert(settings.decompiled.code.includes('parse_value'),settings.decompiled.code.slice(0,400));
    assert(report.string_matches.some(match=>String(match.value).includes('QCoderI-settings')),
      JSON.stringify(report.string_matches));
    const settingsAddress = settings.address;

    // A follow-up query reopens the saved database instead of re-analyzing it.
    const followUp = await call('binary_query',{analysis:job.output,timeout_seconds:180,
      query:{address:settingsAddress,decompile:true,instruction_limit:32}});
    assert(!followUp.isError,JSON.stringify(followUp));
    const followUpJob = JSON.parse(followUp.content[0].text);
    assert(followUpJob.job_id);
    await ctx.jobs.wait(followUpJob.job_id,240000,agent,signal);
    const followUpState = ctx.jobs.get(followUpJob.job_id,agent);
    assert.equal(followUpState.status,'completed',await readFile(followUpJob.log,'utf8').catch(()=>''));
    const answer = JSON.parse(ctx.jobs.read(followUpJob.job_id,agent).text);
    assert.equal(answer.functions[0]?.name,'load_settings',JSON.stringify(answer));
    assert.equal(answer.functions[0]?.matched_by,'address',JSON.stringify(answer.functions[0]));
    const followUpReport = JSON.parse(await readFile(followUpJob.report,'utf8'));
    assert(followUpReport.function_details[0].instructions.length>0,JSON.stringify(followUpReport.function_details[0]));
    assert.equal(followUpReport.function_details[0].decompiled.available,true);

    const journal = JSON.parse(await readFile(job.journal,'utf8'));
    assert.equal(journal.state,'completed');
    assert.equal(journal.input_sha256,hash);
    assert.equal(createHash('sha256').update(await readFile(input)).digest('hex'),hash);
    console.log('PASS: profile discovery, Ghidra inventory, name/address query, callers/callees, '
      +'call graph, pseudocode, string search and database reuse');
  }
} finally {
  await handle?.dispose();
  await ctx.fiber.dispose();
  assert.equal(dirname(await realpath(workspace)), tempRoot);
  await rm(workspace, {recursive:true, force:true, maxRetries:4, retryDelay:150});
}