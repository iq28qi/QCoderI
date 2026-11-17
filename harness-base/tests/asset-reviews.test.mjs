import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, mkdir, writeFile, readFile, symlink, link, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, basename} from 'node:path';
import {deflateSync} from 'node:zlib';
import {createAssetReviewService, canonicalJSON} from '../assets/team/asset-reviews.js';
import {normalizeAssetSpecification} from '../assets/team/asset-specification.js';
import {fingerprintArtifact, buildAssetQualityReport} from '../assets/team/asset-quality.js';
import {prepareBlender, startBlender, blenderStatus} from '../assets/team/blender-runner.js';

// Deterministic containers test transport, NOT visual beauty or model judgement.
const crc32=data=>{let c=0xffffffff;for(const b of data){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;};
const chunk=(kind,data)=>{const tag=Buffer.from(kind),n=Buffer.alloc(4),c=Buffer.alloc(4);n.writeUInt32BE(data.length);c.writeUInt32BE(crc32(Buffer.concat([tag,data])));return Buffer.concat([n,tag,data,c]);};
const png=color=>{
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(64);ihdr.writeUInt32BE(64,4);ihdr[8]=8;ihdr[9]=2;
  const pixels=Buffer.alloc(64*(64*3+1));for(let y=0;y<64;y++)for(let x=0;x<64*3;x++)pixels[y*193+x+1]=(color+x+y)%256;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
};
const geometry=()=>({vertices:8,faces:6,triangles:12,non_finite_vertices:0,non_finite_transform:0,non_manifold_edges:0,inconsistent_winding_edges:0,degenerate_faces:0,loose_vertices:0,wire_edges:0,duplicate_faces:0,uv_layers:1,non_finite_uvs:0,degenerate_uv_triangles:0,bounds_m:{min:[-1,-1,-1],max:[1,1,1]}});
const inspection=()=>({blender:'deterministic fixture only',warnings:[],technical_measurements:{schema_version:1,min_face_area_m2:1e-12},scene:{units:'METRIC',unit_scale:1,fps:24,frame_range:[1,24],actions:[]},objects:[{name:'Asset',scale:[1,1,1],quality_geometry:{base:geometry(),evaluated:geometry()},unassigned_material_faces:0,evaluated_unassigned_material_faces:0,quality_materials:{defects:[],pending:[]},evaluated_quality_materials:{defects:[],pending:[]}}]});
const route={provider:'deterministic-fixture',model:'not-a-real-selected-model',reasoningEffort:'none',image_input:true};
const gate=(report,id)=>report.gates.find(g=>g.id===id);
async function fixture({animation=false,reference=false,export_format='obj'}={}) {
  const home=await mkdtemp(join(tmpdir(),'qcoderi-reviews-')),cwd=join(home,'project'),trusted=join(home,'trusted');await mkdir(cwd);
  let count=0,service;
  async function run() {
    const out=join(cwd,'QCoderI-3D','run-'+(++count));await mkdir(out,{recursive:true});
    const spec=normalizeAssetSpecification({subjects:['Asset'],export_format,requirements:{reference,animation}});
    const audit=inspection();audit.run={run_id:basename(out),scene:join(out,'scene.blend')};
    if(animation)audit.scene.actions=[{name:'Move',frames:[1,24]}];
    const write=(name,value)=>writeFile(join(out,name),typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value));
    await write('scene.blend','deterministic scene bytes v'+count);await write('inspection.json',audit);await write('asset-specification.json',spec);
    const paths=[['scene.blend','scene'],['inspection.json','inspection'],['asset-specification.json','specification']];
    await write('render.png',png(10+count));paths.push(['render.png','render']);
    const views=[];
    for(const [i,name]of ['front','side','back'].entries()){await write('render-'+name+'.png',png(40+i));paths.push(['render-'+name+'.png','view']);views.push({path:join(out,'render-'+name+'.png'),view:name});}
    await write('views.json',views);
    if(animation){const frames=[];for(const frame of [1,12,24]){const name=`frame-${frame}.png`;await write(name,png(frame+100));paths.push([name,'frame']);frames.push({frame,path:join(out,name)});}await write('frames.json',frames);}
    const artifacts=await Promise.all(paths.map(([name,kind])=>fingerprintArtifact(join(out,name),kind)));
    const manifest={run_id:basename(out),scene:join(out,'scene.blend'),inspection:join(out,'inspection.json'),process_status:'completed',exit_code:0,timed_out:false,specification:join(out,'asset-specification.json'),evidence:join(out,'evidence.json')};
    await write('evidence.json',{schema_version:1,...manifest,artifacts});await write('run.json',manifest);
    await write('asset.obj','o Asset\nv -1 -1 -1\nv 1 -1 -1\nv 1 1 -1\nf 1 2 3\n');
    if(service)await service.sealRun({run_directory:out});
    return {out,spec,audit,manifest,artifacts};
  }
  const first=await run();await writeFile(join(cwd,'reference.png'),png(230));
  const request={run_directory:first.out,task:'fixture task',criteria:'deterministic response plumbing only',references:reference?[join(cwd,'reference.png')]:[]};
  let response='pass',calls=0,lastInput;
  const reviewer=async input=>{calls++;lastInput=input;return {status:'completed',output:JSON.stringify({schema_version:1,verdicts:input.gates.map(gate=>({gate,status:response,reasons:[response==='fail'?'Concrete fixture defect: material contrast requires repair':'Fixture transport response only; no beauty claim']}))})};};
  const imported=async (_exe,args)=>{
    const script=await readFile(args.at(-1),'utf8'),cfg=JSON.parse(script.split('\n')[0].slice('# QCODERI_IMPORT '.length));
    await writeFile(cfg.output,JSON.stringify({schema_version:1,nonce:cfg.nonce,source_sha256:cfg.source_sha256,blender:'fixture subprocess seam',objects:[{name:'Asset',vertices:8,faces:6,triangles:12,finite:true,bounds_m:geometry().bounds_m,uv_layers:1,material_slots:1,unassigned_material_faces:0}],images:[]}));
    return {stdout:'fixture imported',stderr:''};
  };
  const options={cwd,trustedDirectory:trusted,reviewer,reviewerRoute:route,discoverBlender:async()=>process.execPath,processRunner:imported};
  service=await createAssetReviewService(options);await service.sealRun({run_directory:first.out});
  return {home,cwd,trusted,first,request,run,service,options,imported,setResponse:v=>{response=v;},get calls(){return calls;},get lastInput(){return lastInput;}};
}
async function accepted(f) {
  const review=await f.service.review(f.request);
  const imported=await f.service.validateExport({...f.request,export_file:join(f.first.out,'asset.obj')});
  const args={...f.request,review_ids:[review.id],import_ids:[imported.id],export_file:join(f.first.out,'asset.obj')};
  return {review,imported,args,report:await f.service.accept(args)};
}

test('host-minted structured review + independent import, then edited scene invalidates acceptance',async()=>{
  const f=await fixture(),result=await accepted(f);
  assert.equal(result.review.verdicts[0].status,'pass');assert.equal(result.imported.verdicts[0].status,'pass');
  assert.equal(result.report.ready_for_export,true);assert.equal(result.report.status,'pass');
  assert.equal(f.calls,1);assert.equal(f.lastInput.images.length,4);assert(f.lastInput.images.every(i=>Buffer.isBuffer(i.data)&&i.sha256.length===64));
  assert.equal(result.review.binding.renders.length,4);assert.equal(result.review.reviewer_route.model,route.model);
  const restarted=await createAssetReviewService(f.options);assert.equal((await restarted.accept(result.args)).ready_for_export,true,'signed store survives host restart');
  await writeFile(join(f.first.out,'scene.blend'),'edited scene');
  const stale=await f.service.accept(result.args);assert.equal(stale.ready_for_export,false);assert.equal(stale.status,'fail');assert(stale.defects.some(d=>d.message.includes('Stale')));
});

test('fail/pending and closed repair loop require fresh version, fresh review and import',async()=>{
  const f=await fixture();f.setResponse('fail');const old=await accepted(f);
  assert.equal(old.report.status,'fail');assert(old.report.defects.some(d=>d.message.includes('material contrast')));
  f.setResponse('pending');const pending=await f.service.review(f.request);
  assert.equal(gate(await f.service.accept({...f.request,review_ids:[pending.id]}),'visual_review').status,'pending');
  const next=await f.run();f.first=next;f.request={...f.request,run_directory:next.out};f.setResponse('pass');
  assert.equal((await f.service.accept({...f.request,review_ids:[old.review.id],import_ids:[old.imported.id],export_file:join(next.out,'asset.obj')})).ready_for_export,false,'old run cannot pass repaired version');
  const repaired=await accepted(f);assert.equal(repaired.report.ready_for_export,true);assert.notEqual(old.review.id,repaired.review.id);assert.notEqual(old.review.run_id,repaired.review.run_id);
  assert.notEqual(old.review.binding.renders[0].sha256,repaired.review.binding.renders[0].sha256,'corrected fixture changes actual bytes, not just verdict');
});

test('no tool pass flag, arbitrary review JSON or generic completed response can mint acceptance',async()=>{
  const f=await fixture();
  await assert.rejects(f.service.review({...f.request,pass:true}),/unsupported field/);
  const forged=buildAssetQualityReport({specification:f.first.spec,inspection:f.first.audit,run:f.first.manifest,evidence:f.first.artifacts,acceptance:{results:[{gate:'visual',status:'pass'}]},reviews:[{gate:'visual',status:'pass'}]});
  assert.equal(forged.ready_for_export,false);assert.equal(gate(forged,'visual_review').status,'pending');
  for(const output of ['accept','{"status":"completed","pass":true}','{"schema_version":1,"verdicts":[{"gate":"export_import","status":"pass","reasons":["file exists"]}]}']) {
    const service=await createAssetReviewService({...f.options,reviewer:async()=>({status:'completed',output})});await assert.rejects(service.review(f.request));
  }
  const service=await createAssetReviewService({...f.options,reviewer:async()=>({status:'failed',output:'{"schema_version":1,"verdicts":[]}'})});await assert.rejects(service.review(f.request),/did not complete/);
  await assert.rejects(f.service.accept({...f.request,pass:true}),/unsupported field/);
  await assert.rejects(createAssetReviewService({...f.options,trustedDirectory:join(f.cwd,'untrusted')}),/outside project/);
  const nonexistent=await f.service.accept({...f.request,review_ids:['00000000-0000-0000-0000-000000000000']});assert.equal(nonexistent.status,'fail');
});

test('edited signed review, wrong route/criteria/run, manifest or inspection changes fail closed',async()=>{
  for(const change of ['record','route','criteria','run','evidence','inspection']) {
    const f=await fixture(),value=await accepted(f);let args=value.args,service=f.service;
    if(change==='record'){const record=JSON.parse(await readFile(value.review.record_file,'utf8'));record.payload.verdicts[0].reasons=['edited'];await writeFile(value.review.record_file,JSON.stringify(record));}
    if(change==='route')service=await createAssetReviewService({...f.options,reviewerRoute:{...route,model:'other'}});
    if(change==='criteria')args={...args,criteria:'different scope'};
    if(change==='run'){const next=await f.run();args={...args,run_directory:next.out,export_file:join(next.out,'asset.obj')};}
    if(change==='evidence'){const path=join(f.first.out,'evidence.json'),data=JSON.parse(await readFile(path,'utf8'));data.note='edited';await writeFile(path,JSON.stringify(data));}
    if(change==='inspection')await writeFile(join(f.first.out,'inspection.json'),'{}');
    const result=await service.accept(args);assert.equal(result.ready_for_export,false,change);assert.equal(result.status,'fail',change);
  }
});

test('real multi-view/ref/frame bytes required, including all actual images',async()=>{
  const ref=await fixture({reference:true});await assert.rejects(ref.service.review({...ref.request,references:[]}),/requires actual reference/);
  const value=await accepted(ref);assert.equal(value.report.ready_for_export,true);assert.equal(ref.lastInput.images[0].kind,'reference');
  await writeFile(join(ref.cwd,'reference.png'),png(231));assert.equal((await ref.service.accept(value.args)).ready_for_export,false);
  const f=await fixture();await writeFile(join(f.first.out,'surprise.png'),png(213));await assert.rejects(f.service.review(f.request),/Unreviewed actual/);await rm(join(f.first.out,'surprise.png'));
  await writeFile(join(f.first.out,'render-back.png'),'fabricated-image-flag');await assert.rejects(f.service.review(f.request),/Stale/);
  const a=await fixture({animation:true});const reviewed=await a.service.review(a.request);assert.equal(a.lastInput.images.length,7);assert.deepEqual(reviewed.verdicts.map(v=>v.gate),['visual','deformation','animation']);
  const imported=await a.service.validateExport({...a.request,export_file:join(a.first.out,'asset.obj')});assert.equal(imported.verdicts[0].status,'pending','static import cannot substitute for animation import');
  const report=await a.service.accept({...a.request,review_ids:[reviewed.id],import_ids:[imported.id],export_file:join(a.first.out,'asset.obj')});assert.equal(gate(report,'animation_review').status,'pass');assert.equal(report.ready_for_export,false);
  await rm(join(a.first.out,'frame-12.png'));assert.equal((await a.service.accept({...a.request,review_ids:[reviewed.id]})).status,'fail');
  const missing=await fixture({animation:true});await writeFile(join(missing.first.out,'frames.json'),JSON.stringify([{frame:1,path:join(missing.first.out,'frame-1.png')},{frame:24,path:join(missing.first.out,'frame-24.png')}]));await assert.rejects(missing.service.review(missing.request),/Unreviewed actual|selected start/);
});

test('image decoder failure, duplicate views, refs substituted by result, and concurrent mutation never mint pass',async()=>{
  const f=await fixture();
  const throwing=await createAssetReviewService({...f.options,reviewer:async()=>{throw Error('actual attachment decoder failed');}});await assert.rejects(throwing.review(f.request),/decoder failed/);
  await assert.rejects(f.service.review({...f.request,references:[join(f.first.out,'render.png')]}),/cannot substitute/);
  const mutate=await createAssetReviewService({...f.options,reviewer:async input=>{await writeFile(join(f.first.out,'scene.blend'),'changed during reviewer');return {status:'completed',output:JSON.stringify({schema_version:1,verdicts:input.gates.map(gate=>({gate,status:'pass',reasons:['fixture']}))})};}});await assert.rejects(mutate.review(f.request),/Stale|changed/);
  const d=await fixture();const path=join(d.first.out,'render-back.png');await writeFile(path,await readFile(join(d.first.out,'render-side.png')));
  const evidenceFile=join(d.first.out,'evidence.json'),e=JSON.parse(await readFile(evidenceFile,'utf8'));e.artifacts=e.artifacts.map(a=>a.path===path?null:a);e.artifacts=e.artifacts.filter(Boolean);e.artifacts.push(await fingerprintArtifact(path,'view'));await writeFile(evidenceFile,JSON.stringify(e));await assert.rejects(d.service.review(d.request),/duplicate image bytes/);
});

test('path escape and symlink evidence rejected (Windows privilege may skip symlink only)',async t=>{
  const f=await fixture();await assert.rejects(f.service.review({...f.request,run_directory:f.home}),/escapes scope/);
  await assert.rejects(f.service.review({...f.request,references:[join(f.home,'outside.png')]}),/escapes scope/);
  const target=join(f.first.out,'render-back.png'),outside=join(f.home,'outside.png');await writeFile(outside,png(200));await rm(target);
  try{await symlink(outside,target,'file');}catch(error){if(error.code==='EPERM'){t.diagnostic('Symlink privilege unavailable; lexical escape assertions passed');return;}throw error;}
  await assert.rejects(f.service.review(f.request),/Symlink/);
});

test('independent subprocess errors/missing report/scope mismatch cannot be file-exists pass',async()=>{
  for(const mode of ['exit','empty','scope','nonce','bounds','uv','materials','texture']) {
    const f=await fixture();
    if(mode==='uv') {
      const sp=join(f.first.out,'asset-specification.json'),spec=JSON.parse(await readFile(sp,'utf8'));spec.requirements.uv=true;await writeFile(sp,JSON.stringify(spec));
      const ep=join(f.first.out,'evidence.json'),e=JSON.parse(await readFile(ep,'utf8'));e.artifacts=e.artifacts.filter(a=>a.path!==sp);e.artifacts.push(await fingerprintArtifact(sp,'specification'));await writeFile(ep,JSON.stringify(e));
      f.options.trustedDirectory=join(f.home,'uv-authority');
      const authority=await createAssetReviewService(f.options);await authority.sealRun({run_directory:f.first.out});
    }
    const service=await createAssetReviewService({...f.options,processRunner:async(exe,args,options)=>{
      if(mode==='exit')throw Error('Blender exit 1');if(mode==='empty')return {stdout:'completed'};
      const result=await f.imported(exe,args,options),cfg=JSON.parse((await readFile(args.at(-1),'utf8')).split('\n')[0].slice('# QCODERI_IMPORT '.length));
      const data=JSON.parse(await readFile(cfg.output,'utf8'));if(mode==='scope')data.objects[0].name='Other';if(mode==='nonce')data.nonce='fabricated';
      if(mode==='bounds')data.objects[0].bounds_m.max[2]=100;
      if(mode==='uv')data.objects[0].uv_layers=0;
      if(mode==='materials')data.objects[0].unassigned_material_faces=1;
      if(mode==='texture')data.images=[{path:join(f.home,'outside.png'),packed:false}];
      await writeFile(cfg.output,JSON.stringify(data));return result;
    }});
    const imported=await service.validateExport({...f.request,export_file:join(f.first.out,'asset.obj')});assert.equal(imported.verdicts[0].status,'fail',mode);
    const review=await service.review(f.request);const result=await service.accept({...f.request,review_ids:[review.id],import_ids:[imported.id],export_file:join(f.first.out,'asset.obj')});assert.equal(result.ready_for_export,false,mode);
  }
});

test('export acceptance rejects changed export bytes, changed proof and external glTF dependencies',async()=>{
  for(const mode of ['export','proof','target']) {
    const f=await fixture(),value=await accepted(f);let args=value.args;
    if(mode==='export')await writeFile(join(f.first.out,'asset.obj'),'edited export');
    if(mode==='proof')await writeFile(value.imported.process.inspection.path,'{}');
    if(mode==='target')args={...args,target:'unreal'};
    assert.equal((await f.service.accept(args)).ready_for_export,false,mode);
  }
  const f=await fixture();await writeFile(join(f.first.out,'asset.gltf'),JSON.stringify({asset:{version:'2.0'},buffers:[{uri:'../../../escape.bin'}]}));
  await assert.rejects(f.service.validateExport({...f.request,export_file:join(f.first.out,'asset.gltf')}),/format differs/);
  await assert.rejects(f.service.validateExport({...f.request,export_file:join(f.home,'outside.obj')}),/escapes scope/);
  const gltf=await fixture({export_format:'gltf'}),file=join(gltf.first.out,'asset.gltf');
  for(const uri of ['../../../escape.bin','%2e%2e/%2e%2e/escape.bin','https://example.invalid/remote.bin']) {
    await writeFile(file,JSON.stringify({asset:{version:'2.0'},buffers:[{uri}]}));
    await assert.rejects(gltf.service.validateExport({...gltf.request,export_file:file}),/escape|Unsafe export/);
  }
  await writeFile(join(gltf.first.out,'buffer.bin'),'bound buffer');await writeFile(file,JSON.stringify({asset:{version:'2.0'},buffers:[{uri:'buffer.bin'}]}));
  const review=await gltf.service.review(gltf.request),proof=await gltf.service.validateExport({...gltf.request,export_file:file});assert.equal(proof.verdicts[0].status,'pass');
  await writeFile(join(gltf.first.out,'buffer.bin'),'edited buffer');assert.equal((await gltf.service.validate({...gltf.request,review_ids:[review.id],import_ids:[proof.id],export_file:file})).ready_for_export,false);
});

test('actual subprocess failure is recorded, not a model/human import flag',async()=>{
  const f=await fixture();
  // No mocked process runner: node receives Blender flags and genuinely exits nonzero.
  const service=await createAssetReviewService({...f.options,processRunner:undefined});
  const result=await service.validateExport({...f.request,export_file:join(f.first.out,'asset.obj')});
  assert.equal(result.verdicts[0].status,'fail');assert.equal(result.process.completed,false);assert(result.verdicts[0].reasons.some(r=>r.includes('subprocess failed')));
  await assert.rejects(service.validateExport({...f.request,export_file:join(f.first.out,'asset.obj'),imported:true}),/unsupported field/);
});

test('read-only validate ignores edited quality; recompute replaces it from signed actual files',async()=>{
  const f=await fixture(),value=await accepted(f),path=join(f.first.out,'quality.json');
  await writeFile(path,JSON.stringify({status:'fail',ready_for_export:false,caller:'do not trust'}));
  const original=await readFile(path,'utf8'),before=(await stat(path)).mtimeMs;
  assert.equal((await f.service.validate(value.args)).ready_for_export,true);
  assert.equal(await readFile(path,'utf8'),original);assert.equal((await stat(path)).mtimeMs,before,'validate must not write quality');
  const saved=await f.service.recompute(value.args);assert.equal(saved.quality_report,path);assert.equal(saved.quality.ready_for_export,true);
  assert.equal(JSON.parse(await readFile(path,'utf8')).caller,undefined);
  await writeFile(join(f.first.out,'scene.blend'),'stale scene');await writeFile(path,'{"ready_for_export":true,"status":"pass"}');
  const stale=await f.service.recompute(value.args);assert.equal(stale.quality.ready_for_export,false);assert.equal(JSON.parse(await readFile(path,'utf8')).status,'fail');
  const fresh=await fixture(),emptyTrusted=join(fresh.home,'uncreated-authority');
  const readOnly=await createAssetReviewService({...fresh.options,trustedDirectory:emptyTrusted});
  assert.equal((await readOnly.validate(fresh.request)).ready_for_export,false);
  await assert.rejects(stat(emptyTrusted),{code:'ENOENT'},'read-only validation must not provision key/store');
});

test('technical-only runs recompute measured gates without inventing missing review inputs',async()=>{
  const f=await fixture();
  const noReference=await f.service.validate({...f.request,references:[],gates:['visual']});
  assert.equal(noReference.technical_status,'pass');assert.equal(gate(noReference,'visual_review').status,'pending');assert.equal(noReference.ready_for_export,false);
  // Remove image inventory BEFORE a new authority observes this technical-only
  // fixture; production sealing is exclusively the completed runner hook.
  for(const name of ['render.png','render-front.png','render-side.png','render-back.png','views.json'])await rm(join(f.first.out,name));
  const ep=join(f.first.out,'evidence.json'),e=JSON.parse(await readFile(ep,'utf8'));e.artifacts=e.artifacts.filter(a=>!['render','view'].includes(a.kind));await writeFile(ep,JSON.stringify(e));
  const s=await createAssetReviewService({...f.options,trustedDirectory:join(f.home,'technical-only-authority')});await s.sealRun({run_directory:f.first.out});
  const result=await s.recompute(f.request);assert.equal(result.quality.technical_status,'pass');assert.equal(result.quality.status,'pending');assert.equal(result.quality.ready_for_export,false);
});

test('host-sealed run rejects caller rehash of edited inspection, manifests and stale scene',async()=>{
  for(const mode of ['inspection','specification','run','views']) {
    const f=await fixture(),file=join(f.first.out,mode==='specification'?'asset-specification.json':mode+'.json');
    const data=JSON.parse(await readFile(file,'utf8'));
    if(mode==='inspection')data.objects[0].quality_geometry.evaluated.triangles=999;
    if(mode==='specification')data.requirements.materials=false;
    if(mode==='run')data.executable='invented-host';
    if(mode==='views')data[0].view='invented-view';
    await writeFile(file,JSON.stringify(data));
    // Recomputing project hashes is not authority to replace measured evidence.
    const ep=join(f.first.out,'evidence.json'),e=JSON.parse(await readFile(ep,'utf8'));
    e.artifacts=e.artifacts.filter(a=>a.path!==file);
    e.artifacts.push(await fingerprintArtifact(file,mode));await writeFile(ep,JSON.stringify(e));
    await assert.rejects(f.service.review(f.request),/Stale\/edited host-sealed|Missing exact/);
    await assert.rejects(f.service.sealRun({run_directory:f.first.out}),/Stale\/edited host-sealed|Missing exact/,'existing run cannot be resealed');
    assert.equal((await f.service.validate(f.request)).ready_for_export,false);
  }
});

test('hard-linked evidence and linked quality destination are rejected without touching target',async()=>{
  const f=await fixture(),value=await accepted(f),outside=join(f.home,'outside-quality.json'),destination=join(f.first.out,'quality.json');
  await writeFile(outside,'do not overwrite');await link(outside,destination);
  await assert.rejects(f.service.recompute(value.args),/links forbidden/);assert.equal(await readFile(outside,'utf8'),'do not overwrite');
  await rm(destination);const image=join(f.first.out,'render-back.png'),duplicate=join(f.cwd,'hardlink.png');await link(image,duplicate);
  assert.equal((await f.service.validate(value.args)).ready_for_export,false);
  await assert.rejects(f.service.review(f.request),/hard links/);
});

test('selected image route, partial gates, conflicting records and isolated workspaces fail closed',async()=>{
  const f=await fixture({reference:true});
  const textOnly=await createAssetReviewService({...f.options,reviewerRoute:{...route,image_input:false}});await assert.rejects(textOnly.review(f.request),/image-model/);
  const partial=await f.service.review({...f.request,gates:['visual']}),imported=await f.service.validateExport({...f.request,export_file:join(f.first.out,'asset.obj')});
  const partialReport=await f.service.validate({...f.request,review_ids:[partial.id],import_ids:[imported.id],export_file:join(f.first.out,'asset.obj')});
  assert.equal(gate(partialReport,'visual_review').status,'pass');assert.equal(gate(partialReport,'reference_review').status,'pending');assert.equal(partialReport.ready_for_export,false);
  const one=await f.service.review(f.request),two=await f.service.review(f.request);
  assert.equal((await f.service.validate({...f.request,review_ids:[one.id,two.id]})).status,'fail');
  const other=await fixture({reference:true});assert.equal((await other.service.validate({...other.request,review_ids:[one.id]})).status,'fail');
});

test('unchanged frames cannot pass motion/deformation; loop endpoints may legitimately match',async()=>{
  const f=await fixture({animation:true});
  // A different interior image plus identical cycle endpoints is sufficient INPUT,
  // not proof of loop quality (the actual model verdict is still required).
  const ep=join(f.first.out,'evidence.json'),end=join(f.first.out,'frame-24.png');
  await writeFile(end,await readFile(join(f.first.out,'frame-1.png')));
  const e=JSON.parse(await readFile(ep,'utf8'));e.artifacts=e.artifacts.filter(a=>a.path!==end);e.artifacts.push(await fingerprintArtifact(end,'frame'));await writeFile(ep,JSON.stringify(e));
  // This is a new observed fixture run, not an in-place host reseal.
  const trusted=join(f.home,'cycle-authority'),s=await createAssetReviewService({...f.options,trustedDirectory:trusted});await s.sealRun({run_directory:f.first.out});
  assert.equal((await s.review(f.request)).verdicts.find(v=>v.gate==='animation').status,'pass');
  await writeFile(join(f.first.out,'frame-12.png'),await readFile(end));
  await assert.rejects(s.review(f.request),/Stale|do not change/);
});

test('real Blender factory-startup reimport and runner host seal (no model/network)',{skip:process.env.QCODERI_TEST_BLENDER!=='1',timeout:120000},async()=>{
  const status=await blenderStatus();assert(status.installed,'Opt-in fixture requires installed Blender');
  const home=await mkdtemp(join(tmpdir(),'qcoderi-review-blender-')),cwd=join(home,'project'),trusted=join(home,'trusted');await mkdir(cwd);
  const service=await createAssetReviewService({cwd,trustedDirectory:trusted,reviewerRoute:route,reviewer:async input=>({status:'completed',output:JSON.stringify({schema_version:1,verdicts:input.gates.map(gate=>({gate,status:'pass',reasons:['Deterministic response fixture for transport only, NOT beauty']}))})})});
  // No artist work or costly renders: actual mesh/export/audit, deterministic image
  // fixtures explicitly cover plumbing only and are never a visual-quality claim.
  const images=Object.fromEntries([['render.png',10],['render-front.png',40],['render-side.png',41],['render-back.png',42]].map(([name,color])=>[name,png(color).toString('base64')]));
  const script=`import bpy, base64, json\nfrom pathlib import Path\nbpy.ops.object.select_all(action='SELECT')\nbpy.ops.object.delete(use_global=False)\nbpy.context.scene.unit_settings.system='METRIC'\nbpy.context.scene.unit_settings.scale_length=1\nbpy.ops.mesh.primitive_cube_add(size=2)\nobj=bpy.context.object\nobj.name='Asset'\nmat=bpy.data.materials.new('FixtureMaterial')\nobj.data.materials.append(mat)\nbpy.ops.wm.obj_export(filepath=str(Path(QC_OUTPUT_DIR)/'asset.obj'),export_selected_objects=True,forward_axis='Y',up_axis='Z')\nimages=json.loads(${JSON.stringify(JSON.stringify(images))})\nfor name,data in images.items(): (Path(QC_OUTPUT_DIR)/name).write_bytes(base64.b64decode(data))\nviews=[dict(view=view,path=str(Path(QC_OUTPUT_DIR)/('render-'+view+'.png'))) for view in ['front','side','back']]\n(Path(QC_OUTPUT_DIR)/'views.json').write_text(json.dumps(views),encoding='utf8')\n`;
  await writeFile(join(cwd,'fixture.py'),script);
  const prepared=await prepareBlender(cwd,{script_file:'fixture.py',executable:status.executable,asset_specification:{subjects:['Asset'],export_format:'obj',requirements:{reference:false,uv:true},units:{system:'METRIC',meters_per_unit:1}}},{reviewService:service});
  // Host test seam: wrapper intentionally does not render these deterministic
  // PNGs; declare their expected inventory before observed child completion.
  prepared.image=join(prepared.out,'render.png');prepared.views=true;
  const result=await startBlender(prepared).done;assert.equal(result.status,'completed',result.output);assert.equal(JSON.parse(result.output).quality.technical_status,'pass',result.output);
  const request={run_directory:prepared.out,task:'real import fixture',criteria:'transport and independent geometry metrics only'},review=await service.review(request);
  const imported=await service.validateExport({...request,export_file:join(prepared.out,'asset.obj')});assert.equal(imported.process.completed,true);assert.equal(imported.verdicts[0].status,'pass',JSON.stringify(imported.verdicts));
  const accepted=await service.recompute({...request,review_ids:[review.id],import_ids:[imported.id],export_file:join(prepared.out,'asset.obj')});assert.equal(accepted.quality.ready_for_export,true);
  console.log('Real Blender acceptance fixture (NOT art review):',prepared.out,imported.process.inspection.path);
});

test('canonical JSON is key-order stable, not array-order blind',()=>{
  assert.equal(canonicalJSON({b:2,a:1}),canonicalJSON({a:1,b:2}));assert.notEqual(canonicalJSON([1,2]),canonicalJSON([2,1]));
});
