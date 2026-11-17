import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,readdirSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createRequire} from 'node:module';
const base=resolve(fileURLToPath(new URL('..',import.meta.url))),archive=resolve(process.env.HARNESS_ARCHIVE??join(base,'source'));
const load=name=>import(pathToFileURL(join(archive,'dsh/node_modules/@deepseek-ai',name,'lib/index.js')).href);
const team=name=>import(pathToFileURL(join(archive,'dsh/node_modules/@qcoderi/team',name)).href);
const {prepareBlender,startBlender,blenderStatus,workspaceFile}=await team('blender-runner.js');
const {installDesktop}=await team('desktop.js');const studio=await team('studio3d.js');
const sharp=createRequire(join(archive,'dsh/package.json'))('sharp');
const home=mkdtempSync(join(tmpdir(),'qcoderi-studio3d-'));
const script=`import bpy, math\nbpy.ops.object.select_all(action='SELECT')\nbpy.ops.object.delete(use_global=False)\nbpy.ops.mesh.primitive_cube_add(size=2)\nsubject=bpy.context.object\nsubject.name='QC_UserObject'\nqc.studio([subject])\nassert subject.name in bpy.data.objects, 'User QC_ objects must be preserved'\nqc.studio([subject])\nassert subject.name in bpy.data.objects, 'Repeated studio setup preserves user geometry'\nassert len([o for o in bpy.context.scene.objects if o.get('qcoderi_studio')])==5\nsubject.name='RoundedProduct'\nsubject.data.materials.append(qc.material('SatinMetal',(.12,.25,.42,1),metallic=.7,roughness=.24))\nbevel=subject.modifiers.new('EdgeHighlights','BEVEL')\nbevel.width=.15\nbevel.segments=4\nqc.studio([subject],quality='preview')\nbpy.context.scene.cycles.samples=8\nbpy.context.scene.render.resolution_x=160\nbpy.context.scene.render.resolution_y=160\n`;
writeFileSync(join(home,'model.py'),script);
writeFileSync(join(home,'broken.py'),"raise RuntimeError('expected-fixture-error')\n");
writeFileSync(join(home,'empty-success.py'),"import os\nos._exit(0)\n");
writeFileSync(join(home,'regress.py'),`import bpy, bmesh
subject = bpy.data.objects['RoundedProduct']
subject.modifiers.remove(subject.modifiers['EdgeHighlights'])
subject.data.materials.append(qc.material('WrongRed', (.8, .02, .012, 1), roughness=.6))
for face in subject.data.polygons:
    face.material_index = 1
mesh = bmesh.new()
mesh.from_mesh(subject.data)
mesh.verts.new((0, 0, 2))
mesh.to_mesh(subject.data)
mesh.free()
`);
writeFileSync(join(home,'repair.py'),`import bpy, bmesh
subject = bpy.data.objects['RoundedProduct']
for face in subject.data.polygons:
    face.material_index = 0
subject.data.materials.pop(index=1)
mesh = bmesh.new()
mesh.from_mesh(subject.data)
bmesh.ops.delete(mesh, geom=[vertex for vertex in mesh.verts if not vertex.link_edges], context='VERTS')
mesh.to_mesh(subject.data)
mesh.free()
bevel = subject.modifiers.new('EdgeHighlights', 'BEVEL')
bevel.width = .15
bevel.segments = 4
`);

async function centerPixels(input) {
  return sharp(Buffer.from(input)).extract({left:60,top:60,width:40,height:40}).removeAlpha().raw().toBuffer();
}
function pixelComparison(fixture, actual) {
  assert.equal(fixture.length,actual.length);
  let absoluteDifference=0;
  for(let index=0;index<fixture.length;index++) absoluteDifference+=Math.abs(fixture[index]-actual[index]);
  return absoluteDifference/fixture.length;
}
function reportSubject(run) {
  return run.report.objects.find(object=>object.name==='RoundedProduct');
}
let ctx,handle;
const watchdog=setTimeout(()=>{console.error('3D test timed out');process.exit(1)},180000);
try {
  const status=await blenderStatus();if(!status.installed){console.log('SKIP: optional real 3D rendering test requires Blender; application reports it unavailable without installing');process.exit(0);}
  assert.match(status.version,/Blender/);
  const {discoverPresets}=await load('dsh-agent-presets');
  const presets=await discoverPresets([{path:join(archive,'dsh/node_modules/@deepseek-ai/dsh-agent-presets/presets'),trust:'system'}],pathToFileURL(join(archive,'dsh/node_modules/@deepseek-ai/dsh/lib/index.js')).href);
  const studioPreset=presets.find(preset=>preset.id==='qcoder-3d');assert(studioPreset&&!studioPreset.broken,JSON.stringify(studioPreset));assert.equal(studioPreset.name,'3D Studio');
  const hackerPreset=presets.find(preset=>preset.id==='qcoder-hacker');assert(hackerPreset&&!hackerPreset.broken,JSON.stringify(hackerPreset));assert.equal(hackerPreset.name,'Хакер');
  const prepared=await prepareBlender(home,{script_file:'model.py',render:true,views:true,timeout_seconds:120});
  const run=startBlender(prepared),result=await run.done;
  assert.equal(result.status,'completed',result.output);
  assert.equal(run.readOutput(),result.output,'job output retains inspection and paths after completion');
  const output=JSON.parse(result.output);
  assert(existsSync(output.scene)&&existsSync(output.render));
  assert(output.report.objects.some(obj=>obj.name==='RoundedProduct'&&obj.materials.includes('SatinMetal')));
  assert(output.report.camera);assert.equal(readFileSync(output.render).readUInt32BE(16),160);
  assert.equal(output.views.length,3);for(const view of output.views)assert(existsSync(view.path));
  const subject=output.report.objects.find(obj=>obj.name==='RoundedProduct');assert(subject.evaluated_faces>subject.faces,'audit includes evaluated bevel geometry');
  assert.equal(subject.material_slots[0].faces,subject.faces);
  assert.equal(subject.material_slots[0].surface_shader,'BSDF_PRINCIPLED');
  assert(Math.abs(subject.material_slots[0].roughness-.24)<.0001);
  writeFileSync(join(base,'tests/studio3d-render.png'),readFileSync(output.render));
  const animationScript = `import bpy
from pathlib import Path
subject = bpy.data.objects['RoundedProduct']
subject.shape_key_add(name='Basis')
subject.shape_key_add(name='Expression')
subject.keyframe_insert(data_path='location', frame=1)
subject.location.x += 0.8
subject.keyframe_insert(data_path='location', frame=12)
bpy.context.scene.frame_set(4)
qc.export_unreal_fbx(Path(QC_OUTPUT_DIR) / 'preview.fbx', [subject], animation=True)
`;
  writeFileSync(join(home,'animation.py'),animationScript);
  const second=await prepareBlender(home,{blend_file:output.scene,script_file:'animation.py',frames:[1,12,1]});
  assert.notEqual(second.out,prepared.out,'each run preserves the previous result');
  const inspect=await startBlender(second).done;assert.equal(inspect.status,'completed',inspect.output);
  const frames = JSON.parse(inspect.output);
  assert.deepEqual(frames.frames.map(frame=>frame.frame),[1,12]);
  assert.notDeepEqual(readFileSync(frames.frames[0].path),readFileSync(frames.frames[1].path),'animated object changes between real frames');
  assert.equal(frames.report.scene.frame,4);
  assert(existsSync(join(second.out,'preview.fbx')));
  assert(frames.report.scene.actions.some(action=>action.frames[1]===12));
  assert(frames.report.scene.lights.length>=3);
  assert.deepEqual(frames.report.objects.find(object=>object.name==='RoundedProduct').shape_keys,['Basis','Expression']);
  await assert.rejects(prepareBlender(home,{blend_file:output.scene,frames:[1.25]}),/целых/);
  const broken=await startBlender(await prepareBlender(home,{script_file:'broken.py'})).done;
  assert.equal(broken.status,'failed');assert.match(broken.output,/expected-fixture-error/);
  const emptySuccess=await startBlender(await prepareBlender(home,{script_file:'empty-success.py',render:true})).done;
  assert.equal(emptySuccess.status,'failed');
  assert.equal(JSON.parse(emptySuccess.output).exit_code,0);
  assert.match(JSON.parse(emptySuccess.output).verification_error,/inspection\.json/);
  await assert.rejects(workspaceFile(home,join(base,'assets/team/blender-quality.py'),'.py'),/внутри/);
  console.log('PASS: installed '+status.version+', real editable .blend, studio material/lights/camera, CPU render, mesh audit, reinspection, error exit and preserved version directories');
  const {Context}=await load('cordis'),{LlmAdapter,createUserMessage}=await load('dsh-llm');ctx=new Context();
  for(const name of ['dsh-session','dsh-session-projection','dsh-llm','dsh-system-prompt','dsh-tools','dsh-agent','dsh-agent-loop','dsh-jobs-local','dsh-tool-jobs','dsh-commands'])await ctx.plugin((await load(name)).default??await load(name),name==='dsh-tool-jobs'?{completionDelivery:'quiet'}:{});
  await ctx.plugin((await load('dsh-attachment-local')).default,{dshHome:home});await ctx.plugin((await load('dsh-fs-local')).default,{});
  for(let i=0;i<100&&(!ctx.get('agentLoop')||!ctx.get('jobs'));i++)await delay(10);
  installDesktop(ctx);await ctx.plugin(studio,{});
  let visualCalls=0,diagnosis,verified;
  const tool=(id,name,args)=>({type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:JSON.stringify(args)}});
  function resultPart(messages,id,kind){
    const result=messages.flatMap(message=>message.content).find(part=>part.type==='tool-result'&&part.toolCallId===id);
    assert(result&&!result.isError,`Successful ${id} tool result`);
    const part=result.content.find(item=>item.type===kind);
    assert(part,`The ${id} tool returns ${kind}`);
    return part;
  }
  function resultJson(messages,id){
    return JSON.parse(resultPart(messages,id,'text').text.split('\n[status:')[0]);
  }
  async function imagePixels(attachment,signal) {
    return centerPixels((await ctx.attachments.readImage(attachment,signal)).data);
  }
  class VisualAdapter extends LlmAdapter{
    resolveModel(provider,id){return Promise.resolve({provider,id,name:id,inputModalities:['text','image']});}
    async *stream({messages,signal}){
      const reference=messages.find(message=>message.role==='user'&&message.content.some(part=>part.type==='image'))?.content.find(part=>part.type==='image');
      assert(reference,'The agent receives the original visual reference throughout the turn');
      switch(++visualCalls){
        case 1:
          yield tool('create-regression','blender_run',{blend_file:output.scene,script_file:'regress.py',render:true});
          break;
        case 2:
          yield tool('inspect-regression','job_output',{job_id:resultJson(messages,'create-regression').job_id,wait:true,timeout_ms:120000});
          break;
        case 3:
          yield tool('see-regression','share_image',{file_path:resultJson(messages,'inspect-regression').render,caption:'До правки: обнаружение дефекта'});
          break;
        case 4:{
          const run=resultJson(messages,'inspect-regression');
          const before=reportSubject(run);
          const distance=pixelComparison(await imagePixels(reference.attachment,signal),
            await imagePixels(resultPart(messages,'see-regression','image').attachment,signal));
          diagnosis={distance,loose:before.loose_vertices,material:before.material_slots.find(slot=>slot.faces>0).material};
          assert(diagnosis.distance>20,'The defect changes the visible render substantially');
          assert.equal(diagnosis.material,'WrongRed');
          assert.equal(diagnosis.loose,1);
          assert.equal(before.evaluated_faces,before.faces,'The active bevel is absent');
          yield tool('repair-scene','blender_run',{blend_file:run.scene,script_file:'repair.py',render:true});
          break;}
        case 5:
          yield tool('inspect-repair','job_output',{job_id:resultJson(messages,'repair-scene').job_id,wait:true,timeout_ms:120000});
          break;
        case 6:
          yield tool('see-repair','share_image',{file_path:resultJson(messages,'inspect-repair').render,caption:'После правки: контрольный рендер'});
          break;
        case 7:{
          const run=resultJson(messages,'inspect-repair');
          const after=reportSubject(run);
          const distance=pixelComparison(await imagePixels(reference.attachment,signal),
            await imagePixels(resultPart(messages,'see-repair','image').attachment,signal));
          verified={distance,loose:after.loose_vertices,material:after.material_slots.find(slot=>slot.faces>0).material};
          assert(verified.distance<2,'Rendered pixels match the visual reference');
          assert.equal(verified.material,'SatinMetal');
          assert.equal(verified.loose,0);
          assert(after.evaluated_faces>after.faces,'The repaired bevel changes evaluated geometry');
          assert.notEqual(run.scene,resultJson(messages,'inspect-regression').scene);
          yield {type:'text-delta',index:0,text:'Материал, фаска и геометрия исправлены. Контрольный рендер совпадает с референсом.'};
          break;}
        default:assert.fail('Unexpected extra inference in Blender repair fixture');
      }
      yield {type:'finish',reason:{kind:'stop'}};
    }
  }
  ctx.llm.registerAdapter(['fixture'],new VisualAdapter());
  handle=await ctx.agents.create({sessionId:'3d-studio-test',meta:{cwd:home},agentOptions:{provider:'fixture',model:'vision'}});
  const agent=handle.agent,signal=new AbortController().signal;
  const local=await ctx.commands.execute(agent,'/blender',[],signal);
  assert.equal(local.result.kind,'success');
  assert.match(local.result.text,/Blender.*Shape Keys/s);
  assert.equal(visualCalls,0,'local command never sends a model request');
  const call=async(name,args)=>{const r=await ctx.tools.execute({name,arguments:args,agent,signal,callId:name+'-'+Date.now()});assert(!r.isError,JSON.stringify(r));return r;};
  const started=await call('blender_run',{script_file:'model.py',render:true,timeout_seconds:120});
  const job=JSON.parse(started.content[0].text);await ctx.jobs.wait(job.job_id,120000,agent,signal);
  const done=ctx.jobs.get(job.job_id,agent);assert.equal(done.status,'completed',JSON.stringify(done));
  const shared=await call('share_image',{file_path:job.render,caption:'3D Studio · проверенный рендер'});assert(shared.content.some(part=>part.type==='image'));
  const text=JSON.stringify(await ctx.systemPrompt.assemble({agent,scope:agent.ctx}));
  for(const term of ['референс','силуэт','roughness','черновой рендер','share_image'])assert(text.includes(term),term);
  assert(agent.ctx.tools.schemas(agent).some(tool=>tool.name==='desktop_action'));
  const reference=await ctx.attachments.saveImage({data:readFileSync(output.render),mediaType:'image/png',name:'reference.png'});
  const sourceBefore=readFileSync(output.scene);
  agent.followup(createUserMessage({content:[{type:'text',text:'Проверь сцену против референса и исправь найденные дефекты'},{type:'image',attachment:reference}],source:{kind:'user'}}));await agent.whenIdle();
  const turn=agent.session.snapshotEvents().findLast(event=>event.type==='turn/end');
  assert.equal(turn?.data.reason.kind,'completed',JSON.stringify(turn));
  assert.equal(visualCalls,7);
  assert.deepEqual(readFileSync(output.scene),sourceBefore,'The original .blend remains intact after the repair');
  console.log('PASS: native 3D profile tools -> real background Blender job -> mesh report and rendered image -> share_image; quality workflow and desktop capabilities in agent prompt');
  console.log(`PASS: real Blender repair turn, before/after center RGB error ${diagnosis.distance.toFixed(2)} → ${verified.distance.toFixed(2)}, loose vertices ${diagnosis.loose} → ${verified.loose}, material ${diagnosis.material} → ${verified.material}`);
}finally{
  await handle?.dispose();await ctx?.fiber.dispose();clearTimeout(watchdog);
  assert(home.startsWith(join(tmpdir(),'qcoderi-studio3d-')));
  const writable=path=>{for(const item of readdirSync(path,{withFileTypes:true})){const child=join(path,item.name);if(item.isDirectory())writable(child);else chmodSync(child,0o600);}chmodSync(path,0o700);};
  writable(home);rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
