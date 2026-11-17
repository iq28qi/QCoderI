// Real UE test. Only an explicitly named throwaway fixture can be edited.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { command, status } from '../assets/unreal/bridge.js';
import { prepareBlender, startBlender } from '../assets/team/blender-runner.js';
const project = resolve(process.argv[2] ?? '');
const root = `/Game/QCoderITest/Run_${Date.now()}`;
assert.equal(basename(project), 'QCoderIBridgeFixture.uproject', 'Use an isolated fixture project, never a user game');
assert((await status(project)).connected, 'Open fixture in Unreal with built QCoderIBridge first');
const call = async (action, args = {}) => {
  const value = await command(project, action, args, { timeoutMs: 120000 });
  console.log(action, JSON.stringify(value).slice(0, 900)); return value;
};
const docs = await call('describe'); assert(docs.widget_font && docs.blueprint_node);
if (process.argv.includes('--scene-preview')) {
  const camera = await call('actor_spawn', {class:'/Script/Engine.CameraActor',label:'QC_ReviewCamera',location:[0,150,120]});
  const light = await call('actor_spawn', {class:'/Script/Engine.PointLight',label:'QC_ReviewLight',location:[0,0,180]});
  const scene = await call('scene_inspect');
  assert(scene.cameras.some(item=>item.actor===camera.path && item.fov_deg>0));
  assert(scene.lights.some(item=>item.actor===light.path && item.radius_cm>0));
  if(process.argv.includes('--null-rhi')){
    await assert.rejects(call('viewport_capture'),/rendered editor/);
    console.log('PASS: real scene camera/light inspection and explicit NullRHI diagnostic');
    process.exit(0);
  }
  const preview = await call('viewport_capture');
  const png = await readFile(join(dirname(project),'Saved/QCoderI/Previews',preview.file));
  assert.equal(png.toString('hex',0,8),'89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16),preview.width);
  assert.equal(png.readUInt32BE(20),preview.height);
  console.log('PASS: real scene camera/light inspection and viewport PNG');
  process.exit(0);
}
if (process.argv.includes('--blender-assets')) {
  const workspace = dirname(project);
  const script = `import os, bpy
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.mesh.primitive_cube_add(size=2)
bpy.context.object.data.materials.append(bpy.data.materials.new('FixtureSurface'))
bpy.ops.export_scene.fbx(filepath=os.path.join(QC_OUTPUT_DIR, 'Mesh.fbx'), use_selection=True)
image = bpy.data.images.new('FixtureColor', width=4, height=4)
image.pixels[:] = [.15, .4, .65, 1] * 16
image.filepath_raw = os.path.join(QC_OUTPUT_DIR, 'Color.png')
image.file_format = 'PNG'
image.save()
`;
  const fixture = join(workspace, 'QCoderITest');
  await mkdir(fixture, { recursive: true });
  await writeFile(join(fixture, 'import_fixture.py'), script);
  const prepared = await prepareBlender(workspace, { script_file: 'QCoderITest/import_fixture.py' });
  const result = await startBlender(prepared).done;
  assert.equal(result.status, 'completed', result.output);
  const source = file => relative(workspace, join(prepared.out, file));
  const meshArgs = { source: source('Mesh.fbx'), path: root + '/SM_Blender' };
  const importedMesh = await call('asset_import', meshArgs);
  assert.match(importedMesh.class, /\.StaticMesh$/);
  assert(importedMesh.material_slots.length > 0);
  assert(importedMesh.size_cm.every(value => Math.abs(value - 200) < 0.1), 'Blender meters become UE centimeters');
  await assert.rejects(call('asset_import', meshArgs), /new valid/);
  const importedTexture = await call('asset_import', { source: source('Color.png'), path: root + '/T_Blender' });
  assert.match(importedTexture.class, /\.Texture2D$/);
  assert.equal(importedTexture.width, 4);
  const linear = await call('asset_import', { source: source('Color.png'), path: root + '/T_Roughness', texture_type: 'linear' });
  const normal = await call('asset_import', { source: source('Color.png'), path: root + '/T_Normal', texture_type: 'normal' });
  const material = await call('material_create', { path: root + '/M_Blender', base_color: importedTexture.path, roughness: linear.path, normal: normal.path });
  assert.equal(material.connected_maps, 3);
  const assignment = await call('mesh_set_material', { path: importedMesh.path, slot: 0, material: material.path });
  assert.equal(assignment.material, material.path);
  for (const asset of [importedTexture, linear, normal, material, importedMesh]) await call('asset_save', { path: asset.path });
  await call('level_save', { path: root + '/L_ImportedAssets' });
  await call('actor_spawn', { class: '/Script/Engine.StaticMeshActor', label: 'QC_Imported', mesh: importedMesh.path });
  await call('level_save');
  console.log('PASS: real Blender FBX/PNG -> UE static mesh, color/linear/normal textures, material, slot assignment and saved actor');
}
await call('level_save', { path: root + '/L_BridgeTest' });
const floor = await call('actor_spawn', { class: '/Script/Engine.StaticMeshActor', label: 'QC_Floor', mesh: '/Engine/BasicShapes/Cube.Cube', location: [0, 0, -50], scale: [10, 10, 1] });
await call('actor_transform', { path: floor.path, location: [100, 0, -50] });
assert((await call('scene_list')).actors.some(a => a.label === 'QC_Floor' && a.location[0] === 100));
await call('object_inspect', { path: floor.path });
await call('level_save');
const actor = await call('blueprint_create', { path: root + '/BP_BridgeActor' });
const bp = actor.path;
await call('blueprint_variable', { blueprint: bp, name: 'Counter', type: 'int', default: '7' });
assert((await call('blueprint_compile', { blueprint: bp })).compiled);
const graph = await call('blueprint_inspect', { blueprint: bp });
let event = graph.graphs.flatMap(g => g.nodes).find(n => n.title.includes('BeginPlay'));
if (!event) event = await call('blueprint_node', { blueprint: bp, kind: 'event', name: 'ReceiveBeginPlay' });
const print = await call('blueprint_node', { blueprint: bp, kind: 'call', class: '/Script/Engine.KismetSystemLibrary', name: 'PrintString', x: 300 });
await call('blueprint_pin', { blueprint: bp, node: print.id, pin: 'InString', value: 'QCoderI native test' });
await call('blueprint_connect', { blueprint: bp, from_node: event.id, from_pin: 'then', to_node: print.id, to_pin: 'execute' });
assert((await call('blueprint_compile', { blueprint: bp })).compiled);
await call('asset_save', { path: bp });
const widget = await call('widget_create', { path: root + '/WBP_Menu' });
const ui = widget.path;
await call('widget_add', { blueprint: ui, class: '/Script/UMG.TextBlock', name: 'Title', parent: 'Root' });
await call('widget_text', { blueprint: ui, widget: 'Title', text: 'Забытый город' });
await call('widget_font', { blueprint: ui, widget: 'Title', size: 48, font: '/Engine/EngineFonts/Roboto.Roboto' });
await call('widget_layout', { blueprint: ui, widget: 'Title', position: [100, 80, 0], size: [600, 100, 0] });
await call('widget_add', { blueprint: ui, class: '/Script/UMG.Button', name: 'PlayButton', parent: 'Root' });
await call('widget_add', { blueprint: ui, class: '/Script/UMG.TextBlock', name: 'PlayLabel', parent: 'PlayButton' });
await call('widget_text', { blueprint: ui, widget: 'PlayLabel', text: 'Играть' });
await call('widget_font', { blueprint: ui, widget: 'PlayLabel', size: 24 });
assert((await call('blueprint_compile', { blueprint: ui })).compiled);
const click = await call('blueprint_node', { blueprint: ui, kind: 'bound_event', widget: 'PlayButton', name: 'OnClicked' });
const clickPrint = await call('blueprint_node', { blueprint: ui, kind: 'call', class: '/Script/Engine.KismetSystemLibrary', name: 'PrintString', x: 350 });
await call('blueprint_pin', { blueprint: ui, node: clickPrint.id, pin: 'InString', value: 'Play clicked' });
await call('blueprint_connect', { blueprint: ui, from_node: click.id, from_pin: 'then', to_node: clickPrint.id, to_pin: 'execute' });
assert((await call('blueprint_compile', { blueprint: ui })).compiled);
const tree = await call('widget_tree', { blueprint: ui });
assert(tree.widgets.some(w => w.name === 'Title' && w.text === 'Забытый город' && w.font_size === 48));
assert(tree.widgets.some(w => w.name === 'PlayLabel' && w.parent === 'PlayButton' && w.font_size === 24));
const wired = await call('blueprint_inspect', { blueprint: ui });
assert(wired.graphs.flatMap(g => g.nodes).some(n => n.id === click.id && n.pins.some(p => p.links.some(l => l.node === clickPrint.id))));
await call('asset_save', { path: ui });
const create = await call('blueprint_node', { blueprint: bp, kind: 'call', class: '/Script/UMG.WidgetBlueprintLibrary', name: 'Create', x: 650 });
await call('blueprint_pin', { blueprint: bp, node: create.id, pin: 'WidgetType', object_path: ui + '_C' });
const show = await call('blueprint_node', { blueprint: bp, kind: 'call', class: '/Script/UMG.UserWidget', name: 'AddToViewport', x: 950 });
await call('blueprint_connect', { blueprint: bp, from_node: print.id, from_pin: 'then', to_node: create.id, to_pin: 'execute' });
await call('blueprint_connect', { blueprint: bp, from_node: create.id, from_pin: 'then', to_node: show.id, to_pin: 'execute' });
await call('blueprint_connect', { blueprint: bp, from_node: create.id, from_pin: 'ReturnValue', to_node: show.id, to_pin: 'self' });
assert((await call('blueprint_compile', { blueprint: bp })).compiled);
await call('asset_save', { path: bp });
console.log('PASS: actual UE scene edits, map save, Actor Blueprint variable and wired graph, UMG menu/font/layout/button event, CreateWidget/AddToViewport chain, clean compilation and .uasset save');
