"""Small deterministic real-bpy regressions. Run via blender_run/prepareBlender.
No rendering, model API, dependencies or live editor. The Node suite opts in with
QCODERI_TEST_BLENDER=1 and retains the final per-run evidence for inspection.
"""
import json
import math
from pathlib import Path
import bmesh

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.context.scene.unit_settings.system = 'METRIC'
bpy.context.scene.unit_settings.scale_length = 1.0
bpy.ops.mesh.primitive_cube_add(size=2)
subject = bpy.context.object
subject.name = 'Asset'
subject.data.materials.append(qc.material('FixtureMaterial', (.2, .3, .4, 1)))
checks = []

def row(name='Asset', specification=None):
    return next(o for o in qc.audit(specification)['objects'] if o['name'] == name)

def checked(name, condition):
    assert condition, name
    checks.append(name)

clean = row()
checked('preserves legacy material audit', clean['material_slots'][0]['surface_shader'] == 'BSDF_PRINCIPLED')
checked('cube base and evaluated triangles', clean['quality_geometry']['base']['triangles'] == 12 and clean['quality_geometry']['evaluated']['triangles'] == 12)
checked('cube closed with consistent winding', clean['quality_geometry']['base']['non_manifold_edges'] == 0 and clean['quality_geometry']['base']['inconsistent_winding_edges'] == 0)
checked('cube has nondegenerate UV', clean['quality_geometry']['evaluated']['degenerate_uv_triangles'] == 0)
checked('material surface checked', clean['quality_materials'] == dict(defects=[], pending=[]))

# Evaluated geometry, not only the editable control cage, drives budgets.
bevel = subject.modifiers.new('FixtureBevel', 'BEVEL')
bevel.width, bevel.segments = .1, 2
checked('evaluated modifier triangles increase', row()['quality_geometry']['evaluated']['triangles'] > 12)
subject.modifiers.remove(bevel)

# World dimensions and area account for parent transforms and scene unit scale.
parent = bpy.data.objects.new('Parent', None)
bpy.context.scene.collection.objects.link(parent)
subject.parent = parent
parent.scale = (2, 3, 4)
bpy.context.scene.unit_settings.scale_length = .01
bpy.context.view_layer.update()
bounds = row()['quality_geometry']['base']['bounds_m']
checked('dimensions converted to world metres', all(abs(bounds['max'][i] - bounds['min'][i] - expected) < 1e-6 for i, expected in enumerate([.04, .06, .08])))
subject.parent = None
bpy.data.objects.remove(parent, do_unlink=True)
bpy.context.scene.unit_settings.scale_length = 1
bpy.context.view_layer.update()
checked('configurable world area tolerance', row(specification={'limits': {'min_face_area_m2': 5}})['quality_geometry']['base']['degenerate_faces'] == 6)

# Loose/wire geometry and open faces are measured without destructive cleanup.
bm = bmesh.new()
bm.from_mesh(subject.data)
v1 = bm.verts.new((5, 5, 5)); v2 = bm.verts.new((6, 5, 5)); bm.edges.new((v1, v2))
bm.verts.new((7, 5, 5))
bm.to_mesh(subject.data); bm.free()
measured = row()['quality_geometry']['base']
checked('loose vertex and wire edge detected', measured['loose_vertices'] == 1 and measured['wire_edges'] == 1)
bm = bmesh.new(); bm.from_mesh(subject.data)
bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
bm.to_mesh(subject.data); bm.free()

# UV omission and collapse remain distinct from clean UVs.
layer = subject.data.uv_layers.active
backup = [item.uv[:] for item in layer.data]
for item in layer.data: item.uv = (0, 0)
checked('collapsed UV triangles detected', row()['quality_geometry']['evaluated']['degenerate_uv_triangles'] == 12)
for item, uv in zip(layer.data, backup): item.uv = uv

# Only used, connected image nodes count. No real user textures are read.
material = subject.data.materials[0]
node = material.node_tree.nodes.new('ShaderNodeTexImage')
checked('unused image node ignored', row()['quality_materials']['defects'] == [])
material.node_tree.links.new(node.outputs['Color'], material.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])
checked('unassigned connected image detected', any(d['code'] == 'material.image_unassigned' for d in row()['quality_materials']['defects']))
image = bpy.data.images.new('MissingFixtureImage', width=1, height=1)
image.source = 'FILE'; image.filepath = str(Path(QC_OUTPUT_DIR) / 'does-not-exist.png')
node.image = image
checked('missing connected image detected', any(d['code'] == 'material.image_missing' for d in row()['quality_materials']['defects']))
material.node_tree.nodes.remove(node)
bpy.data.images.remove(image)
output = next(n for n in material.node_tree.nodes if n.type == 'OUTPUT_MATERIAL')
link = output.inputs['Surface'].links[0]
material.node_tree.links.remove(link)
checked('disconnected surface detected', any(d['code'] == 'material.no_surface' for d in row()['quality_materials']['defects']))
material.node_tree.links.new(material.node_tree.nodes.get('Principled BSDF').outputs['BSDF'], output.inputs['Surface'])

# Thin/degenerate geometry is tested separately from the closed cube.
mesh = bpy.data.meshes.new('BrokenMesh')
mesh.from_pydata([(0,0,0), (1,0,0), (2,0,0), (0,1,0)], [], [(0,1,2), (0,1,3), (0,1,3)])
broken = bpy.data.objects.new('Broken', mesh)
bpy.context.scene.collection.objects.link(broken)
measured = row('Broken')['quality_geometry']['base']
checked('degenerate and duplicate face detected', measured['degenerate_faces'] >= 1 and measured['duplicate_faces'] == 1)
checked('open mesh boundary measured', measured['boundary_edges'] > 0)
bpy.data.objects.remove(broken, do_unlink=True)

# A control bone is not a deform weight. Preserve legacy unweighted metric too.
bpy.ops.object.armature_add()
armature = bpy.context.object
armature.name = 'FixtureRig'
modifier = subject.modifiers.new('FixtureArmature', 'ARMATURE'); modifier.object = armature
bone = armature.data.bones[0]
group = subject.vertex_groups.new(name=bone.name)
group.add(list(range(len(subject.data.vertices))), 1.0, 'REPLACE')
checked('deform weights counted', row()['unweighted_deform_vertices'] == 0)
bone.use_deform = False
weighted = row()
checked('control-bone weights do not satisfy deformation', weighted['unweighted_vertices'] == 0 and weighted['unweighted_deform_vertices'] == len(subject.data.vertices))
subject.modifiers.remove(modifier)
subject.vertex_groups.clear()
bpy.data.objects.remove(armature, do_unlink=True)

# Studio tagging is evidence, not a name-prefix heuristic.
subject['qcoderi_studio'] = True
checked('studio-helper tag exported', row()['studio_helper'] is True)
del subject['qcoderi_studio']
checked('ordinary asset not a studio helper', row()['studio_helper'] is False)

# Nonfinite coordinates are counted even if Blender's legacy bmesh area is NaN.
previous = subject.data.vertices[0].co.copy()
subject.data.vertices[0].co.x = math.nan
measured = qc.geometry_measurements(subject.data, subject, 1e-12)
checked('nonfinite vertex detected', measured['non_finite_vertices'] >= 1)
json.dumps(qc.audit(), allow_nan=False)
subject.data.vertices[0].co = previous
bpy.context.view_layer.update()

# Strict JSON never emits NaN tokens. Nonfinite geometry remains a defect count.
checked('strict JSON sanitation', qc.json_safe({'a': math.nan, 'b': [math.inf]}) == {'a': None, 'b': [None]})
json.dumps(qc.audit(), allow_nan=False)
Path(QC_OUTPUT_DIR, 'fixture-results.json').write_text(json.dumps({'checks': checks}, indent=2), encoding='utf8')
print('PASS real bpy quality fixtures:', ', '.join(checks))
