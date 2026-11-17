import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,readdirSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const base=resolve(fileURLToPath(new URL('..',import.meta.url))),archive=resolve(process.env.HARNESS_ARCHIVE??join(base,'source'));
const load=name=>import(pathToFileURL(join(archive,'dsh/node_modules/@deepseek-ai',name,'lib/index.js')).href);
const home=mkdtempSync(join(tmpdir(),'qc-workbench-native-')),project=join(home,'project');mkdirSync(project);process.env.DSH_HOME=home;
const {Context}=await load('cordis'),{LlmAdapter,createUserMessage}=await load('dsh-llm'),{installWorkbench}=await import(pathToFileURL(join(archive,'dsh/node_modules/@qcoderi/team/workbench.js')).href);
const ctx=new Context();let handle;const watchdog=setTimeout(()=>process.exit(2),90000);
try{
  for(const name of ['dsh-skill','dsh-session','dsh-session-projection','dsh-llm','dsh-system-prompt','dsh-tools','dsh-agent','dsh-agent-loop','dsh-subagent','dsh-subagent-spawn-in-process'])await ctx.plugin((await load(name)).default??await load(name),{});
  await ctx.plugin((await load('dsh-attachment-local')).default,{dshHome:home});await ctx.plugin((await load('dsh-fs-local')).default,{});
  await ctx.plugin(await load('dsh-tool-str-replace-editor'),{});await ctx.plugin(await load('dsh-tool-skill'),{});await ctx.plugin(await load('dsh-tool-fs'),{readLimit:2000,readMaxLineLength:2000,readMaxBytes:50000,readStreamMinSize:100000});
  for(let i=0;i<100&&!ctx.get('agentLoop');i++)await delay(10);
  const workbench=installWorkbench(ctx,{home:join(home,'workbench'),remote:false});let hold=false,workerStarted=false,imageReviews=0,assetReviews=0,adapterCalls=0;
  class Adapter extends LlmAdapter{
    resolveModel(provider,id){return Promise.resolve({provider,id,name:id,inputModalities:['text','image']});}
    async *stream(options){
      adapterCalls++;const all=options.messages.flatMap(x=>x.content??[]),text=all.filter(b=>b.type==='text').map(b=>b.text).join('\n');
      if(text.includes('Return ONLY JSON {"schema_version":1,"verdicts"')){assert(all.filter(b=>b.type==='image').length>=4);assetReviews++;yield{type:'text-delta',index:0,text:JSON.stringify({schema_version:1,verdicts:[{gate:'visual',status:'pass',reasons:['Deterministic image transport fixture, NOT an art judgement']}]})};}
      else if(text.includes('Проверь результат задачи:')){assert(all.some(b=>b.type==='image'),'review gets actual image blocks');imageReviews++;yield{type:'text-delta',index:0,text:'revise: исправить силуэт'};}
      else if(text.includes('Задание:')){workerStarted=true;if(hold)await delay(60000,undefined,{signal:options.signal});else yield{type:'text-delta',index:0,text:'Работа проверена'};}
      else yield{type:'text-delta',index:0,text:'Хорошо'};
      yield{type:'finish',reason:{kind:'stop'}};
    }
  }
  ctx.llm.registerAdapter(['fixture'],new Adapter());handle=await ctx.agents.create({sessionId:'workbench-main',meta:{cwd:project},agentOptions:{provider:'fixture',model:'vision'}});const agent=handle.agent,signal=new AbortController().signal;
  agent.followup(createUserMessage({content:[{type:'text',text:'Не открывай тестовые окна. Реалистичная голова.'}],source:{kind:'user'}}));await agent.whenIdle();
  const execute=(name,args)=>ctx.tools.execute({name,arguments:args,agent,callId:Math.random().toString(),signal});
  let result=await execute('project_memory',{operation:'save',key:'windows',kind:'preference',content:'Тесты без видимых окон',quote:'Не открывай тестовые окна.'});assert(!result.isError,JSON.stringify(result));
  result=await execute('project_memory',{operation:'save',key:'fake',kind:'preference',content:'foo',quote:'Цитата, которой не было'});assert(result.isError);
  const assembly=await ctx.systemPrompt.assemble({agent});assert(JSON.stringify(assembly).includes('Тесты без видимых окон'));
  writeFileSync(join(project,'architecture.md'),'# Architecture\nAsset specification uses quality gates.\n');
  result=await execute('project_context',{query:'specification quality gates'});assert(!result.isError,JSON.stringify(result));
  const found=JSON.parse(result.content.find(block=>block.type==='text').text);
  assert(found.results.some(item=>item.path==='architecture.md'&&item.line<=2&&item.endLine>=2&&/^[a-f0-9]{64}$/.test(item.hash)&&Array.isArray(item.provenance)),'context tool returns hash-bound project evidence');
  assert.equal(found.semantic.localOnly,true);assert.equal(found.semantic.neural,false);
  const brainStatus=await workbench.request({sessionId:agent.id,action:'brain',args:{operation:'status'}});assert(brainStatus.coverage);
  const brainBatch=await execute('project_brain',{operation:'index'});assert(!brainBatch.isError,JSON.stringify(brainBatch));
  const brainSearch=await workbench.request({sessionId:agent.id,action:'brain',args:{operation:'search',query:'quality gates'}});assert(brainSearch.results.some(x=>x.path==='architecture.md'));
  const running=await workbench.workers.start(agent,'Сделать проверку');assert.equal(running.status,'running');for(let i=0;i<100&&(await workbench.workers.status(agent)).status==='running';i++)await delay(10);assert.equal((await workbench.workers.status(agent)).status,'completed');
  hold=true;workerStarted=false;await workbench.workers.start(agent,'Долгая проверка');for(let i=0;i<100&&!workerStarted;i++)await delay(10);await workbench.workers.steer(agent,'Сохрани исходник');workbench.workers.stop(agent);for(let i=0;i<100&&(await workbench.workers.status(agent)).status==='running';i++)await delay(10);assert.equal((await workbench.workers.status(agent)).status,'killed');
  result=await execute('str_replace_editor',{command:'create',path:join(project,'versioned.txt'),file_text:'version one'});assert(!result.isError,JSON.stringify(result));const nativeWrite=await execute('write',{file_path:join(project,'native.txt'),content:'original'});assert(!nativeWrite.isError,JSON.stringify(nativeWrite));const nativeEdit=await execute('edit',{file_path:join(project,'native.txt'),old_string:'original',new_string:'edited'});assert(!nativeEdit.isError,JSON.stringify(nativeEdit));const nativeChanges=await workbench.store(agent).changes();assert(nativeChanges.filter(c=>c.files.some(f=>f.path==='native.txt')).length===2);const changes=await workbench.store(agent).changes();assert(changes.some(change=>change.files.some(file=>file.path==='versioned.txt'&&file.before===null&&file.after)));
  const parallel=[];for(let i=0;i<5;i++)parallel.push(await workbench.workers.start(agent,'Параллельная задача '+i,{write_paths:['task-'+i+'.txt']}));
  let board=await workbench.workers.status(agent);assert.equal(board.active,4);assert.equal(board.queued,1);await workbench.workers.stop(agent,parallel[0].id);
  for(let i=0;i<100&&(await workbench.workers.status(agent)).tasks.find(x=>x.id===parallel[4].id).status!=='running';i++)await delay(10);
  assert.equal((await workbench.workers.status(agent)).tasks.find(x=>x.id===parallel[4].id).status,'running');await workbench.workers.stop(agent);for(let i=0;i<100&&(await workbench.workers.status(agent)).active;i++)await delay(10);
  const locked=await workbench.workers.start(agent,'Ресурс A',{resources:['shared-editor']});const waiting=await workbench.workers.start(agent,'Ресурс B',{resources:['shared-editor']});assert.equal(waiting.status,'queued');
  const dependent=await workbench.workers.start(agent,'Зависимая задача',{depends_on:[locked.id]});assert.equal(dependent.status,'queued');await workbench.workers.stop(agent,locked.id);
  for(let i=0;i<100&&(await workbench.workers.status(agent)).tasks.find(x=>x.id===waiting.id).status!=='running';i++)await delay(10);
  assert.equal((await workbench.workers.status(agent)).tasks.find(x=>x.id===dependent.id).status,'skipped');await workbench.workers.stop(agent);for(let i=0;i<100&&(await workbench.workers.status(agent)).active;i++)await delay(10);
  const image=join(project,'render.png');writeFileSync(image,readFileSync(join(base,'assets/qcoderi.png')));
  const reviewArgs={task:'Голова',criteria:'Силуэт как на референсе',images:['render.png']};
  const repeated=await Promise.all([execute('quality_review',reviewArgs),execute('quality_review',reviewArgs)]);
  assert(repeated.every(review=>!review.isError),JSON.stringify(repeated));
  assert.equal(imageReviews,1,'concurrent duplicate consumes one model review');
  assert(repeated.some(review=>review.content.some(block=>block.text?.includes('"reused": true')||block.text?.includes('"reused":true'))));
  const skill=await ctx.skills.get('imagegen',{cwd:home,scope:agent,signal});assert(skill.content.includes('generate_image'));assert(!skill.path);const loadedSkill=await execute('skill',{name:'imagegen'});assert(!loadedSkill.isError,JSON.stringify(loadedSkill));
  writeFileSync(image,readFileSync(join(base,'assets/qcoderi-moonlit-elf.png')));
  const changed=await execute('quality_review',reviewArgs);assert(!changed.isError,JSON.stringify(changed));assert.equal(imageReviews,2,'changed pixels trigger a fresh review');
  const detailed=await execute('quality_review',{...reviewArgs,criteria:'Силуэт и материалы'});assert(!detailed.isError,JSON.stringify(detailed));assert.equal(imageReviews,3);
  const limited=await execute('quality_review',{...reviewArgs,criteria:'Топология'});assert(limited.isError,'persistent three-review budget');
  const cached=await execute('quality_review',reviewArgs);assert(!cached.isError);assert.equal(imageReviews,3);
  result=await execute('interactive_report',{title:'Проверки',html:'<details><summary>Геометрия</summary>Проверена</details>'});assert(!result.isError);assert((await workbench.store(agent).state()).reports.length===1);
  const state=await workbench.request({sessionId:agent.id,action:'state'});assert.equal(state.memory.length,1);assert(state.worker.tasks.length>=9);
  const {prepareBlender,startBlender,blenderStatus}=await import(pathToFileURL(join(archive,'dsh/node_modules/@qcoderi/team/blender-runner.js')).href);
  const blender=await blenderStatus();assert(blender.installed,'Installed Blender required for integrated asset acceptance');
  const {default:sharp}=await import(pathToFileURL(join(archive,'dsh/node_modules/sharp/dist/index.mjs')).href);
  const fixtureImages=await Promise.all([10,60,120,190].map(async r=>(await sharp({create:{width:64,height:64,channels:3,background:{r,g:20,b:30}}}).png().toBuffer()).toString('base64')));
  writeFileSync(join(project,'asset-fixture.py'),`import bpy, json, base64\nfrom pathlib import Path\nbpy.ops.object.select_all(action='SELECT')\nbpy.ops.object.delete(use_global=False)\nbpy.context.scene.unit_settings.system='METRIC'\nbpy.context.scene.unit_settings.scale_length=1\nbpy.ops.mesh.primitive_cube_add(size=2)\nobj=bpy.context.object\nobj.name='Asset'\nobj.data.materials.append(bpy.data.materials.new('Fixture'))\nbpy.ops.wm.obj_export(filepath=str(Path(QC_OUTPUT_DIR)/'asset.obj'),export_selected_objects=True,forward_axis='Y',up_axis='Z')\nfor name,data in zip(['render.png','render-front.png','render-side.png','render-back.png'],${JSON.stringify(fixtureImages)}): (Path(QC_OUTPUT_DIR)/name).write_bytes(base64.b64decode(data))\n(Path(QC_OUTPUT_DIR)/'views.json').write_text(json.dumps([dict(view=v,path=str(Path(QC_OUTPUT_DIR)/('render-'+v+'.png'))) for v in ['front','side','back']]),encoding='utf8')\n`);
  const prepared=await prepareBlender(project,{script_file:'asset-fixture.py',executable:blender.executable,asset_specification:{subjects:['Asset'],export_format:'obj',requirements:{reference:false,uv:true}}});prepared.image=join(prepared.out,'render.png');prepared.views=true;
  const child=await startBlender(prepared).done;assert.equal(child.status,'completed',child.output);
  const assetArgs={run_directory:prepared.out,task:'integrated gate plumbing',criteria:'Deterministic response transport and independent geometry import, not artistic quality'};
  const parse=async(name,args)=>{const value=await execute(name,args);assert(!value.isError,JSON.stringify(value));return JSON.parse(value.content.find(b=>b.type==='text').text);};
  const assetRecord=await parse('asset_review',{...assetArgs,operation:'review'});assert.equal(assetReviews,1);assert.equal(assetRecord.verdicts[0].status,'pass');
  const assetImport=await parse('asset_review',{...assetArgs,operation:'export',export_file:join(prepared.out,'asset.obj')});assert.equal(assetImport.verdicts[0].status,'pass');
  const acceptance={...assetArgs,review_ids:[assetRecord.id],import_ids:[assetImport.id],export_file:join(prepared.out,'asset.obj')};
  const quality=await parse('asset_review',{...acceptance,operation:'recompute'});assert.equal(quality.quality.ready_for_export,true);
  writeFileSync(join(prepared.out,'scene.blend'),'changed scene');const stale=await parse('asset_review',{...acceptance,operation:'validate'});assert.equal(stale.ready_for_export,false);
  console.log('PASS: real AgentLoop asset_review -> selected fixture image response -> signed record -> actual Blender reimport -> recompute, stale scene rejected (not art judgement)');
  const budgetBefore=await execute('usage_budget',{});assert(!budgetBefore.isError,JSON.stringify(budgetBefore));
  if(ctx.llm.usageBudgetBoundaryVersion===1){
    const status=JSON.parse(budgetBefore.content[0].text);assert.equal(status.configured,false);
    const forged=await execute('usage_budget',{operation:'configure',role:'human',tokenCap:999999});assert(!forged.isError);assert.equal(JSON.parse(forged.content[0].text).configured,false,'model JSON cannot configure');
    const policy={scope:'global',callsEnabled:true,moneyCapUsd:'1',tokenCap:100,prices:[{provider:'fixture',model:'vision',currency:'USD',inputPerMillion:'1',outputPerMillion:'2',cacheReadPerMillion:'0.1',cacheWritePerMillion:'1',maxTokensIncludesReasoning:true}]};
    await workbench.request({sessionId:agent.id,action:'budget',args:{action:'configure',policy}});
    const calls=adapterCalls,chunks=[];for await(const part of ctx.llm.stream({provider:'fixture',model:'vision',sessionId:agent.id,messages:[createUserMessage({content:[{type:'text',text:'must not dispatch'}]})]}))chunks.push(part);
    assert.equal(adapterCalls,calls,'configured unsupported route rejected BEFORE adapter');assert(chunks.some(c=>c.type==='finish'&&c.reason.kind==='error'&&c.reason.failure.code==='BUDGET_TRUSTED_BOUND_REQUIRED'),JSON.stringify(chunks));
    assert.equal((await workbench.request({sessionId:agent.id,action:'budget',args:{action:'status'}})).configured,true);
    console.log('PASS: final budget boundary + read-only model tool + human panel + unsupported route fail-closed');
  }
  console.log('PASS: actual AgentLoop + semantic Brain/provenance, memory, native workers, visual reviewer pixels, durable reports and UI service requests');
}finally{await handle?.dispose();await ctx.fiber.dispose();clearTimeout(watchdog);const writable=path=>{for(const item of readdirSync(path,{withFileTypes:true})){const child=join(path,item.name);if(item.isDirectory())writable(child);else chmodSync(child,0o600);}chmodSync(path,0o700);};writable(home);rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
