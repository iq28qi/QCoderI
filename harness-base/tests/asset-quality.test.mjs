import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, readFile, writeFile, mkdir, link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {normalizeAssetSpecification, assetSpecificationParameter} from '../assets/team/asset-specification.js';
import {buildAssetQualityReport, fingerprintArtifact, QUALITY_STATUSES} from '../assets/team/asset-quality.js';
import {prepareBlender, startBlender, blenderStatus} from '../assets/team/blender-runner.js';

const base = fileURLToPath(new URL('..', import.meta.url));
const geometry = () => ({vertices:8, faces:6, triangles:12, non_finite_vertices:0, non_finite_transform:0,
  non_manifold_edges:0, inconsistent_winding_edges:0, degenerate_faces:0, loose_vertices:0,
  wire_edges:0, duplicate_faces:0, uv_layers:1, non_finite_uvs:0, degenerate_uv_triangles:0,
  bounds_m:{min:[-1,-1,-1],max:[1,1,1]}});
const inspected = () => ({blender:'fixture', warnings:[], technical_measurements:{schema_version:1,min_face_area_m2:1e-12},
  scene:{units:'METRIC',unit_scale:1}, objects:[{name:'Asset',studio_helper:false,scale:[1,1,1],
    quality_geometry:{base:geometry(),evaluated:geometry()},unassigned_material_faces:0,evaluated_unassigned_material_faces:0,
    quality_materials:{defects:[],pending:[]},evaluated_quality_materials:{defects:[],pending:[]}}]});
const evidence = ['scene','inspection','specification'].map(kind=>({kind,status:'pass',sha256:'fixture-only'}));
const report = (inspection=inspected(), specification={}) => buildAssetQualityReport({inspection,specification,
  run:{process_status:'completed',run_id:'test'},evidence});
const gate = (result,id) => result.gates.find(item=>item.id===id);

test('optional specification is compatible, strict, normalized and non-mutating', () => {
  const defaults = normalizeAssetSpecification();
  assert.equal(defaults.schema_version,1);
  assert.equal(defaults.requirements.reference,true);
  assert.equal(defaults.requirements.closed_manifold,false);
  assert.equal(normalizeAssetSpecification({purpose:'print'}).requirements.closed_manifold,true);
  assert.equal(normalizeAssetSpecification({purpose:'character'}).requirements.rig,true);
  assert.equal(assetSpecificationParameter.type,'object');
  const input={subjects:['Asset'],requirements:{uv:true},limits:{dimensions_m:{max:[2,2,2]}}};
  const before=structuredClone(input);normalizeAssetSpecification(input);assert.deepEqual(input,before);
  for(const invalid of [null,[],true,'{}',{schema_version:2},{purpose:null},{units:{system:null}},{units:{meters_per_unit:null}},{purpose:'auto-retopology'},
    {requirements:{uv:'true'}},{requirements:{visual:false}},{units:{meters_per_unit:0}},
    {units:{meters_per_unit:NaN}},{units:{system:'CENTIMETERS'}},{subjects:[]},{subjects:['a','a']},
    {limits:{max_triangles:1.5}},{limits:{max_triangles:Infinity}},{limits:{min_face_area_m2:-1}},
    {limits:{dimensions_m:{max:[1,2]}}},{limits:{dimensions_m:{min:[2,0,0],max:[1,1,1]}}},
    {ready_for_export:true},{export_format:'blend'},{name:'a\u0000b'}]) assert.throws(()=>normalizeAssetSpecification(invalid),TypeError);
});

test('saved scene and even multiple images cannot pass unperformed reviews', () => {
  const result=report();
  assert.equal(result.technical_status,'pass');
  assert.equal(result.status,'pending');assert.equal(result.ready_for_export,false);
  for(const id of ['visual_review','reference_review','export_validation'])assert.equal(gate(result,id).status,'pending');
  for(const id of ['rig_structure','animation_review','deformation_review','closed_manifold'])assert.equal(gate(result,id).status,'not_applicable');
  assert(result.gates.every(g=>QUALITY_STATUSES.includes(g.status)));
  assert.equal(evidence.length,3,'report construction must not mutate shared evidence');
  const images=buildAssetQualityReport({inspection:inspected(),run:{process_status:'completed'},
    evidence:[...evidence,...['render','view','frame','export'].map(kind=>({kind,status:'pass'}))]});
  assert.equal(images.ready_for_export,false);assert.equal(gate(images,'visual_review').status,'pending');
  assert.equal(gate(images,'export_validation').status,'pending');
});

test('specific geometry defects fail gates; unknown measurements stay pending', () => {
  for(const key of ['non_finite_vertices','non_finite_transform','degenerate_faces','wire_edges','loose_vertices','duplicate_faces']){
    const inspection=inspected();inspection.objects[0].quality_geometry.evaluated[key]=1;
    const result=report(inspection);assert.equal(gate(result,'geometry').status,'fail');
    assert(result.defects.some(d=>d.code===`evaluated.${key}`&&d.object==='Asset'&&d.actual===1));
  }
  const inspection=inspected();delete inspection.objects[0].quality_geometry.evaluated;
  assert.equal(gate(report(inspection),'geometry').status,'pending');
  delete inspection.technical_measurements;
  assert.equal(report(inspection).technical_status,'pending');
  assert.equal(buildAssetQualityReport().status,'pending');
  assert.equal(gate(report({...inspected(),objects:[]}),'subject_scope').status,'fail');
  assert.equal(gate(report(inspected(),{limits:{min_face_area_m2:.01}}),'geometry').status,'pending','changed tolerance requires a fresh bpy measurement');
});

test('requirements control manifold, scale, UV and triangle budgets without inferring retopology', () => {
  const inspection=inspected(),obj=inspection.objects[0];
  obj.quality_geometry.base.non_manifold_edges=4;obj.scale=[-1,1,1];
  obj.quality_geometry.evaluated.uv_layers=0;
  obj.quality_geometry.evaluated.triangles=100;
  assert.equal(report(inspection).technical_status,'pass','open surfaces allowed by default');
  const result=report(inspection,{requirements:{closed_manifold:true,applied_scale:true,uv:true},limits:{max_triangles:20}});
  for(const id of ['closed_manifold','applied_scale','uv_integrity','triangle_budget'])assert.equal(gate(result,id).status,'fail');
  obj.quality_geometry.evaluated.uv_layers=1;obj.quality_geometry.evaluated.degenerate_uv_triangles=2;
  assert(report(inspection,{requirements:{uv:true}}).defects.some(d=>d.code==='uv.degenerate_uv_triangles'));
});

test('materials, deform weights and missing subject failures are explicit', () => {
  const inspection=inspected(),obj=inspection.objects[0];
  obj.quality_materials.defects.push({code:'material.image_missing',message:'Missing fixture image'});
  let result=report(inspection,{purpose:'character',requirements:{animation:true}});
  assert.equal(gate(result,'materials').status,'fail');assert.equal(gate(result,'rig_structure').status,'fail');
  assert.equal(gate(report(inspected(),{limits:{max_bone_influences:4}}),'rig_structure').status,'fail','bone limits imply a required rig');
  assert.equal(gate(result,'deformation_review').status,'pending');assert.equal(gate(result,'animation_review').status,'pending');
  obj.rig='Rig';obj.deform_bones=1;obj.unweighted_deform_vertices=2;obj.invalid_bone_weights=1;obj.max_bone_influences=5;
  result=report(inspection,{limits:{max_bone_influences:4}});
  for(const code of ['rig.unweighted_deform_vertices','rig.invalid_bone_weights','rig.influence_budget'])assert(result.defects.some(d=>d.code===code));
  assert.equal(gate(report(inspection,{subjects:['Missing']}),'subject_scope').status,'fail');
  obj.studio_helper=true;
  assert.equal(gate(report(inspection),'subject_scope').status,'fail');
  assert.deepEqual(report(inspection,{subjects:['Asset']}).subjects,['Asset']);
});

test('observed shape keys and actions require deformation/animation review without explicit specification', () => {
  const inspection=inspected();inspection.objects[0].shape_keys=['Basis','Blink'];
  assert.equal(gate(report(inspection),'deformation_review').status,'pending');
  inspection.objects[0].shape_keys=[];inspection.scene.actions=[{name:'Move',frames:[1,20]}];
  const result=report(inspection);
  assert.equal(gate(result,'animation_review').status,'pending');assert.equal(gate(result,'deformation_review').status,'pending');
});

test('units and combined world metre bounds agree with configurable contract', () => {
  const inspection=inspected();
  let result=report(inspection,{units:{system:'METRIC',meters_per_unit:1},limits:{dimensions_m:{min:[2,2,2],max:[2,2,2]}}});
  assert.equal(gate(result,'units').status,'pass');assert.equal(gate(result,'dimensions').status,'pass');
  result=report(inspection,{units:{system:'METRIC',meters_per_unit:.01},limits:{dimensions_m:{max:[1,1,1]}}});
  assert.equal(gate(result,'units').status,'fail');assert.equal(gate(result,'dimensions').status,'fail');
  assert.equal(gate(report(inspection,{requirements:{reference:false}}),'reference_review').status,'not_applicable');
  assert.equal(gate(report(inspection,{purpose:'print'}),'printability').status,'pending');
});

test('artifact fingerprints hash bytes and report empty/missing files', async () => {
  const home=await mkdtemp(join(tmpdir(),'qcoderi-quality-hash-'));
  const file=join(home,'fixture.txt');await writeFile(file,'abc');
  const first=await fingerprintArtifact(file,'fixture');
  assert.equal(first.sha256,'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  await writeFile(file,'abcd');assert.notEqual((await fingerprintArtifact(file,'fixture')).sha256,first.sha256);
  const linked=join(home,'linked.txt');await link(file,linked);assert.equal((await fingerprintArtifact(linked,'fixture')).reason,'linked_artifact');
  await writeFile(file,'');assert.equal((await fingerprintArtifact(file,'fixture')).status,'fail');
  assert.equal((await fingerprintArtifact(join(home,'absent'),'fixture')).status,'fail');
});

test('failed/empty background process persists evidence and cannot imply readiness', async () => {
  const home=await mkdtemp(join(tmpdir(),'qcoderi-quality-run-'));
  await writeFile(join(home,'fixture.py'),'# only prepared, not executed by Node\n');
  await assert.rejects(prepareBlender(home,{script_file:'fixture.py',executable:process.execPath,asset_specification:{typo:true}}),/unknown field/);
  const prepared=await prepareBlender(home,{script_file:'fixture.py',executable:process.execPath});
  const initial=JSON.parse(await readFile(prepared.quality,'utf8'));assert.equal(initial.status,'pending');
  prepared.args=['-e','process.exit(0)'];
  const result=await startBlender(prepared).done;assert.equal(result.status,'failed');
  const output=JSON.parse(result.output);assert.match(output.verification_error,/inspection.json/);
  const quality=JSON.parse(await readFile(prepared.quality,'utf8'));
  assert.equal(quality.status,'fail');assert.equal(quality.ready_for_export,false);
  assert.equal(quality.run.run_id,prepared.runId);
  const saved=JSON.parse(await readFile(prepared.evidenceFile,'utf8'));
  assert(saved.artifacts.some(a=>a.kind==='input_script'&&a.status==='pass'));
  assert(saved.artifacts.some(a=>a.kind==='scene'&&a.status==='fail'));
  assert.equal(JSON.parse(await readFile(join(prepared.out,'run.json'),'utf8')).process_status,'failed');
  const noSpawn=await prepareBlender(home,{script_file:'fixture.py',executable:process.execPath});
  noSpawn.executable=join(home,'nonexistent-blender');
  const failed=JSON.parse((await startBlender(noSpawn).done).output);
  assert.equal(failed.quality.status,'fail');assert.match(failed.verification_error,/ENOENT/);
});

test('persisted run rejects stale scene binding and edited input evidence', async () => {
  const home=await mkdtemp(join(tmpdir(),'qcoderi-quality-binding-'));
  const script=join(home,'fixture.py');await writeFile(script,'# original\n');
  const prepared=await prepareBlender(home,{script_file:'fixture.py',executable:process.execPath});
  await writeFile(script,'# concurrent edit\n');
  const inspection={...inspected(),run:{run_id:'previous-run',scene:prepared.scene}};
  prepared.args=['-e',`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(prepared.report)},${JSON.stringify(JSON.stringify(inspection))});fs.writeFileSync(${JSON.stringify(prepared.scene)},'fixture scene bytes');`];
  const result=await startBlender(prepared).done;
  // Child succeeded and artifacts exist; separate technical gate must still fail.
  assert.equal(result.status,'completed');
  const output=JSON.parse(result.output);assert.equal(output.quality.technical_status,'fail');
  assert(output.quality.defects.some(d=>d.code==='run.verification_failed'&&d.message.includes('binding mismatch')));
  const persisted=JSON.parse(await readFile(prepared.evidenceFile,'utf8'));
  assert(persisted.artifacts.some(a=>a.reason==='input_changed_during_run'));
});

test('cancelled child persists killed status and never leaves a passed gate', async () => {
  const home=await mkdtemp(join(tmpdir(),'qcoderi-quality-cancel-'));
  await writeFile(join(home,'fixture.py'),'# cancellation fixture\n');
  const prepared=await prepareBlender(home,{script_file:'fixture.py',executable:process.execPath});
  prepared.args=['-e','setInterval(()=>{},1000)'];
  const running=startBlender(prepared);running.cancel();
  const result=await running.done;assert.equal(result.status,'killed');
  const output=JSON.parse(result.output);
  assert.equal(output.quality.run.process_status,'killed');
  assert.equal(output.quality.status,'fail');assert.equal(output.quality.ready_for_export,false);
});

test('isolated real Blender bpy fixtures and retained per-run evidence', {skip:process.env.QCODERI_TEST_BLENDER!=='1',timeout:120000}, async () => {
  const status=await blenderStatus();assert(status.installed,'Opt-in Blender fixture requires an installed Blender');
  const script='tests/asset-quality-blender.py';
  // Keep test outputs in a private deterministic fixture workspace; never touch
  // any open scene or require syncing source/dsh or building the application.
  const home=await mkdtemp(join(tmpdir(),'qcoderi-asset-quality-blender-'));
  await writeFile(join(home,'fixture.py'),await readFile(join(base,script)));
  const prepared=await prepareBlender(home,{script_file:'fixture.py',executable:status.executable,
    asset_specification:{subjects:['Asset'],units:{system:'METRIC',meters_per_unit:1},requirements:{uv:true,closed_manifold:true},limits:{max_triangles:12}},timeout_seconds:60});
  const result=await startBlender(prepared).done;assert.equal(result.status,'completed',result.output);
  const output=JSON.parse(result.output);
  assert.equal(output.quality.technical_status,'pass',JSON.stringify(output.quality,null,2));
  assert.equal(output.quality.status,'pending');assert.equal(output.quality.ready_for_export,false);
  const checks=JSON.parse(await readFile(join(prepared.out,'fixture-results.json'),'utf8'));
  assert(checks.checks.length>=20);
  const persisted=JSON.parse(await readFile(prepared.evidenceFile,'utf8'));
  assert(persisted.artifacts.some(a=>a.kind==='scene'&&a.bytes>0&&a.sha256.length===64));
  // Existing blend inspection leaves the source untouched and binds to its hash.
  const sourceHash=(await fingerprintArtifact(prepared.scene,'scene')).sha256;
  const inspect=await prepareBlender(home,{blend_file:prepared.scene,executable:status.executable});
  const second=JSON.parse((await startBlender(inspect).done).output);
  assert.equal(second.quality.technical_status,'pass');
  assert.notEqual(second.scene,prepared.scene,'inspection saves its own scene snapshot for evidence');
  assert.notEqual(inspect.out,prepared.out);
  assert.equal((await fingerprintArtifact(prepared.scene,'scene')).sha256,sourceHash);
  console.log('Real Blender quality fixture evidence:',prepared.out,inspect.out);
});
