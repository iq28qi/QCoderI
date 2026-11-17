"""Helpers available as qc in a QCoderI Blender project script."""
import bpy
import bmesh
import math
from collections import Counter
from mathutils import Vector

def material_assignments(obj, mesh=None):
    """Report the surface actually connected to the active material output."""
    mesh = mesh if mesh is not None else obj.data
    face_counts = Counter(face.material_index for face in mesh.polygons)
    slots = []
    for index, slot in enumerate(obj.material_slots):
        material = slot.material
        row = dict(slot=index, material=material.name if material else None,
                   faces=face_counts[index])
        if material and material.use_nodes and material.node_tree:
            output = next((node for node in material.node_tree.nodes
                           if node.type == 'OUTPUT_MATERIAL' and node.is_active_output), None)
            surface = output.inputs.get('Surface') if output else None
            shader = surface.links[0].from_node if surface and surface.is_linked else None
            if shader:
                row['surface_shader'] = shader.type
            if shader and shader.type == 'BSDF_PRINCIPLED':
                for name, key in [('Base Color', 'base_color'), ('Metallic', 'metallic'),
                                  ('Roughness', 'roughness')]:
                    socket = shader.inputs[name]
                    if socket.is_linked:
                        row[key] = dict(linked_from=socket.links[0].from_node.type)
                    else:
                        row[key] = list(socket.default_value) if key == 'base_color' else socket.default_value
        slots.append(row)
    assigned_faces = sum(slot['faces'] for slot in slots if slot['material'] is not None)
    return slots, len(mesh.polygons) - assigned_faces

def json_safe(value):
    """Keep inspection JSON strict even when broken meshes contain NaN/Infinity."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {key: json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    return value


def geometry_measurements(mesh, obj, min_face_area_m2):
    """Non-destructive measurements in WORLD metres, for base/evaluated meshes.

    Area tolerance is configurable; no proximity weld, self-intersection test,
    outward-normal inference or automatic retopology is performed here.
    """
    scale = bpy.context.scene.unit_settings.scale_length
    world = obj.matrix_world
    transform_bad = sum(not math.isfinite(n) for row in world for n in row)
    coordinates = [world @ vertex.co * scale for vertex in mesh.vertices]
    finite_points = [point for point in coordinates if all(math.isfinite(n) for n in point)]
    row = dict(vertices=len(mesh.vertices), faces=len(mesh.polygons),
               non_finite_vertices=len(coordinates) - len(finite_points),
               non_finite_transform=transform_bad, uv_layers=len(mesh.uv_layers))
    if finite_points and len(finite_points) == len(coordinates):
        row['bounds_m'] = dict(min=[min(p[i] for p in finite_points) for i in range(3)],
                               max=[max(p[i] for p in finite_points) for i in range(3)])
    bm = bmesh.new()
    try:
        bm.from_mesh(mesh)
        bm.transform(world)
        for vertex in bm.verts:
            vertex.co *= scale
        row.update(non_manifold_edges=sum(not edge.is_manifold for edge in bm.edges),
                   boundary_edges=sum(edge.is_boundary for edge in bm.edges),
                   wire_edges=sum(edge.is_wire for edge in bm.edges),
                   loose_vertices=sum(not vertex.link_edges for vertex in bm.verts),
                   inconsistent_winding_edges=sum(edge.is_manifold and not edge.is_contiguous for edge in bm.edges),
                   degenerate_faces=sum(not math.isfinite(face.calc_area()) or face.calc_area() <= min_face_area_m2 for face in bm.faces))
    finally:
        bm.free()
    # Exact duplicate face index sets, not coincident-position vertices: UV/hard
    # normal splits are legitimate and must not be rejected as duplicate meshes.
    counts = Counter(tuple(sorted(face.vertices)) for face in mesh.polygons)
    row['duplicate_faces'] = sum(count - 1 for count in counts.values() if count > 1)
    mesh.calc_loop_triangles()
    row['triangles'] = len(mesh.loop_triangles)
    row['non_finite_uvs'] = 0
    row['degenerate_uv_triangles'] = 0
    for layer in mesh.uv_layers:
        # data[].uv remains supported in Blender 4.x and 5.x.
        values = [item.uv[:] for item in layer.data]
        row['non_finite_uvs'] += sum(not all(math.isfinite(n) for n in uv) for uv in values)
        for triangle in mesh.loop_triangles:
            a, b, c = [values[index] for index in triangle.loops]
            area2 = (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0])
            if math.isfinite(area2) and abs(area2) <= 1e-12:
                row['degenerate_uv_triangles'] += 1
    return row


def material_measurements(obj, mesh=None):
    """Check only used slots and nodes upstream of the active surface output.

    Groups and sequences/UDIM need specialized validation, so stay pending.
    Unused/disconnected image nodes must not fail a material that does not use them.
    """
    from pathlib import Path
    result = dict(defects=[], pending=[])
    mesh = mesh if mesh is not None else obj.data
    used = {face.material_index for face in mesh.polygons}
    for index in used:
        if index >= len(obj.material_slots) or not obj.material_slots[index].material:
            continue  # The unassigned_material_faces counter reports this.
        material = obj.material_slots[index].material
        def issue(code, message):
            result['defects'].append(dict(code=code, message=f'{material.name}: {message}'))
        if not material.use_nodes or not material.node_tree:
            result['pending'].append(f'{material.name}: non-node surface not validated')
            continue
        output = next((node for node in material.node_tree.nodes if node.type == 'OUTPUT_MATERIAL' and node.is_active_output), None)
        surface = output.inputs.get('Surface') if output else None
        if not surface or not surface.is_linked:
            issue('material.no_surface', 'active material output has no connected surface')
            continue
        visited, stack = set(), [link.from_node for link in surface.links]
        while stack:
            node = stack.pop()
            if node.as_pointer() in visited:
                continue
            visited.add(node.as_pointer())
            if node.type == 'GROUP':
                result['pending'].append(f'{material.name}: nested shader group {node.name} not validated')
            if node.type == 'TEX_IMAGE':
                image = node.image
                if image is None:
                    issue('material.image_unassigned', f'connected texture {node.name} has no image')
                elif image.source in {'TILED', 'SEQUENCE', 'MOVIE'}:
                    result['pending'].append(f'{material.name}: {image.source} image {image.name} dependencies not validated')
                elif image.source == 'FILE' and not image.packed_file and not image.packed_files:
                    path = Path(bpy.path.abspath(image.filepath, library=image.library))
                    if not image.filepath or not path.is_file():
                        issue('material.image_missing', f'connected image {image.name} is missing: {path}')
            for socket in node.inputs:
                if socket.is_linked:
                    for link in socket.links:
                        if not link.is_valid:
                            issue('material.invalid_link', f'invalid node link into {node.name}')
                        else:
                            stack.append(link.from_node)
                elif hasattr(socket, 'default_value'):
                    value = socket.default_value
                    if isinstance(value, (float, int)):
                        values = [value]
                    elif hasattr(value, '__iter__'):
                        values = [n for n in value if isinstance(n, (float, int))]
                    else:
                        values = []
                    if any(not math.isfinite(n) for n in values):
                        issue('material.non_finite_value', f'non-finite input on {node.name}.{socket.name}')
    return result


def audit(specification=None):
    objects = []
    warnings = []
    dependency_graph=bpy.context.evaluated_depsgraph_get()
    min_area = (specification or {}).get('limits', {}).get('min_face_area_m2', 1e-12)
    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH':
            continue
        mesh = obj.data
        bm = bmesh.new()
        bm.from_mesh(mesh)
        non_manifold = sum(not edge.is_manifold for edge in bm.edges)
        loose = sum(not vertex.link_edges for vertex in bm.verts)
        degenerate = sum(face.calc_area() < 1e-10 for face in bm.faces)
        bm.free()
        row = dict(name=obj.name, vertices=len(mesh.vertices), faces=len(mesh.polygons),
                   non_manifold_edges=non_manifold, loose_vertices=loose,
                   degenerate_faces=degenerate, uv_layers=len(mesh.uv_layers),
                   materials=[slot.material.name if slot.material else None for slot in obj.material_slots],
                   scale=list(obj.scale), dimensions=list(obj.dimensions),
                   modifiers=[dict(name=mod.name, type=mod.type) for mod in obj.modifiers])
        row['studio_helper'] = bool(obj.get('qcoderi_studio'))
        row['quality_geometry'] = {}
        try:
            row['quality_geometry']['base'] = geometry_measurements(mesh, obj, min_area)
        except Exception as error:
            row['quality_geometry']['base'] = dict(error=str(error))
        try:
            row['quality_materials'] = material_measurements(obj)
        except Exception as error:
            row['quality_materials'] = dict(defects=[], pending=[str(error)])
        row['material_slots'], row['unassigned_material_faces'] = material_assignments(obj)
        mesh.calc_loop_triangles()
        row['triangles'] = len(mesh.loop_triangles)
        row['shape_keys'] = [key.name for key in mesh.shape_keys.key_blocks][:80] if mesh.shape_keys else []
        rig = obj.find_armature()
        if rig:
            groups = {group.index for group in obj.vertex_groups if group.name in rig.data.bones}
            row['rig'] = rig.name
            row['unweighted_vertices'] = sum(
                not any(weight.group in groups and weight.weight > 1e-6 for weight in vertex.groups)
                for vertex in mesh.vertices)
            deform = {group.index for group in obj.vertex_groups
                      if group.name in rig.data.bones and rig.data.bones[group.name].use_deform}
            row['deform_bones'] = sum(bone.use_deform for bone in rig.data.bones)
            row['unweighted_deform_vertices'] = 0
            row['invalid_bone_weights'] = 0
            row['max_bone_influences'] = 0
            for vertex in mesh.vertices:
                weights = [weight.weight for weight in vertex.groups if weight.group in deform]
                count = sum(math.isfinite(weight) and weight > 1e-6 for weight in weights)
                row['unweighted_deform_vertices'] += count == 0
                row['invalid_bone_weights'] += sum(not math.isfinite(weight) or weight < 0 or weight > 1 for weight in weights)
                row['max_bone_influences'] = max(row['max_bone_influences'], count)
            if row['unweighted_vertices']:
                warnings.append(f"{obj.name}: {row['unweighted_vertices']} vertices have no bone weights")
        objects.append(row)
        evaluated=obj.evaluated_get(dependency_graph)
        try:
            evaluated_mesh=evaluated.to_mesh()
            row['evaluated_vertices']=len(evaluated_mesh.vertices)
            row['evaluated_faces']=len(evaluated_mesh.polygons)
            row['quality_geometry']['evaluated'] = geometry_measurements(evaluated_mesh, evaluated, min_area)
            _, row['evaluated_unassigned_material_faces'] = material_assignments(evaluated, evaluated_mesh)
            row['evaluated_quality_materials'] = material_measurements(evaluated, evaluated_mesh)
        except Exception as error:
            row['quality_geometry']['evaluated'] = dict(error=str(error))
        finally:
            evaluated.to_mesh_clear()
        if non_manifold: warnings.append(f'{obj.name}: {non_manifold} non-manifold edges (may be intentional for an open surface)')
        if loose or degenerate: warnings.append(f'{obj.name}: {loose} loose vertices, {degenerate} degenerate faces')
        if not obj.material_slots: warnings.append(f'{obj.name}: no assigned material')
        elif row['unassigned_material_faces']:
            warnings.append(f"{obj.name}: {row['unassigned_material_faces']} faces have no assigned material")
        if any(abs(value - 1) > .0001 for value in obj.scale): warnings.append(f'{obj.name}: unapplied scale')
        if any(value < 0 for value in obj.scale): warnings.append(f'{obj.name}: mirrored scale; check exported normals')
    scene = bpy.context.scene
    if not scene.camera: warnings.append('No active camera')
    if not any(obj.type == 'LIGHT' for obj in scene.objects): warnings.append('No scene lights; inspect environment illumination')
    return json_safe(dict(blender=bpy.app.version_string, objects=objects, warnings=warnings, scene=scene_details(scene),
                technical_measurements=dict(schema_version=1, length_unit='metre', area_unit='square_metre',
                                            min_face_area_m2=min_area, frame=scene.frame_current),
                camera=scene.camera.name if scene.camera else None, engine=scene.render.engine,
                resolution=[scene.render.resolution_x, scene.render.resolution_y],
                note='Base and evaluated mesh diagnostics at the current frame, not a visual quality guarantee.'))

def scene_details(scene):
    def animation(id_data):
        data = id_data.animation_data if id_data else None
        if not data:
            return {}
        return dict(action=data.action.name if data.action else None,
                    nla=[dict(track=track.name, strips=[strip.name for strip in track.strips][:40])
                         for track in data.nla_tracks][:24])

    lights = [dict(name=obj.name, type=obj.data.type, power=obj.data.energy,
                   color=list(obj.data.color), location=list(obj.matrix_world.translation),
                   rotation=list(obj.matrix_world.to_euler()), enabled=not obj.hide_render)
              for obj in scene.objects if obj.type == 'LIGHT']
    cameras = [dict(name=obj.name, type=obj.data.type, lens_mm=obj.data.lens,
                    location=list(obj.matrix_world.translation), rotation=list(obj.matrix_world.to_euler()),
                    active=obj == scene.camera)
               for obj in scene.objects if obj.type == 'CAMERA']
    rigs = [dict(name=obj.name, bones=len(obj.data.bones),
                 roots=[bone.name for bone in obj.data.bones if bone.parent is None],
                 animation=animation(obj))
            for obj in scene.objects if obj.type == 'ARMATURE']
    actions = [dict(name=action.name, frames=list(action.frame_range)) for action in bpy.data.actions]
    return dict(name=scene.name, units=scene.unit_settings.system, unit_scale=scene.unit_settings.scale_length,
                fps=scene.render.fps / scene.render.fps_base, frame_range=[scene.frame_start, scene.frame_end],
                frame=scene.frame_current, view_transform=scene.view_settings.view_transform,
                exposure=scene.view_settings.exposure, cameras=cameras, lights=lights, rigs=rigs,
                actions=actions, world=scene.world.name if scene.world else None)

def render_frames(output_dir, frames):
    """Render selected animation frames with the active camera and scene lighting."""
    from pathlib import Path
    scene = bpy.context.scene
    if not scene.camera:
        raise ValueError('Animation preview needs an active camera')
    previous_frame, subframe = scene.frame_current, scene.frame_subframe
    previous_path, previous_format = scene.render.filepath, scene.render.image_settings.file_format
    output = Path(output_dir)
    result = []
    try:
        scene.render.image_settings.file_format = 'PNG'
        for frame in frames:
            scene.frame_set(frame)
            path = output / f'frame-{frame}.png'
            scene.render.filepath = str(path)
            bpy.ops.render.render(write_still=True)
            result.append(dict(frame=frame, path=str(path)))
    finally:
        scene.frame_set(previous_frame, subframe=subframe)
        scene.render.filepath = previous_path
        scene.render.image_settings.file_format = previous_format
    return result

def export_unreal_fbx(path, objects, animation=False):
    """Export explicitly chosen meshes and rigs, with the current timeline baked if requested."""
    from pathlib import Path
    destination = Path(path)
    if destination.suffix.lower() != '.fbx':
        raise ValueError('Export destination needs an .fbx suffix')
    if destination.exists():
        raise FileExistsError(str(destination))
    view_layer = bpy.context.view_layer
    selected = list(objects)
    if not selected or any(obj.type not in {'MESH', 'ARMATURE'} or view_layer.objects.get(obj.name) != obj
                           or not obj.visible_get(view_layer=view_layer) for obj in selected):
        raise ValueError('Choose visible meshes and armatures from the active view layer')
    if any(obj.type == 'MESH' and obj.find_armature() and obj.find_armature() not in selected for obj in selected):
        raise ValueError('Include the armature used by each exported mesh')
    previous = list(bpy.context.selected_objects)
    active = view_layer.objects.active
    try:
        for obj in previous:
            obj.select_set(False)
        for obj in selected:
            obj.select_set(True)
        view_layer.objects.active = selected[0]
        if any(not obj.select_get() for obj in selected):
            raise ValueError('An export object cannot be selected in this view layer')
        result = bpy.ops.export_scene.fbx(
            filepath=str(destination), use_selection=True, object_types={'MESH', 'ARMATURE'},
            add_leaf_bones=False, bake_anim=animation, bake_anim_use_nla_strips=False,
            bake_anim_use_all_actions=False, bake_anim_simplify_factor=0.0,
            use_mesh_modifiers=not any(obj.type == 'MESH' and obj.data.shape_keys for obj in selected))
        if 'FINISHED' not in result or not destination.is_file():
            raise RuntimeError('Blender did not write the FBX')
        return str(destination)
    finally:
        for obj in selected:
            obj.select_set(False)
        for obj in previous:
            obj.select_set(True)
        view_layer.objects.active = active

def material(name, color=(.25, .35, .5, 1), metallic=0, roughness=.35):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = color
    shader.inputs['Metallic'].default_value = metallic
    shader.inputs['Roughness'].default_value = roughness
    return mat

def aim(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat('-Z', 'Y').to_euler()

def studio(objects=None, quality='preview'):
    """Frame selected subjects with a floor, camera and three area lights."""
    if quality not in ('preview', 'final'): raise ValueError('quality must be preview or final')
    subjects = list(objects) if objects is not None else [obj for obj in bpy.context.scene.objects if obj.type == 'MESH' and not obj.get('qcoderi_studio')]
    if not subjects: raise ValueError('Studio needs at least one mesh subject')
    bpy.context.view_layer.update()
    points = [obj.matrix_world @ Vector(corner) for obj in subjects for corner in obj.bound_box]
    low = Vector(tuple(min(p[i] for p in points) for i in range(3)))
    high = Vector(tuple(max(p[i] for p in points) for i in range(3)))
    center = (low + high) / 2
    size = max((high-low).length, .1)
    for obj in list(bpy.context.scene.objects):
        if obj.get('qcoderi_studio'): bpy.data.objects.remove(obj, do_unlink=True)
    bpy.ops.mesh.primitive_plane_add(size=size*6, location=(center.x, center.y, low.z-.015*size))
    floor=bpy.context.object; floor.name='QC_StudioFloor'
    floor['qcoderi_studio']=True
    floor.data.materials.append(material('QC_Floor', (.06,.07,.09,1), roughness=.65))
    camera_data=bpy.data.cameras.new('QC_Camera'); camera=bpy.data.objects.new('QC_Camera',camera_data)
    bpy.context.scene.collection.objects.link(camera)
    camera['qcoderi_studio']=True
    camera.location=center+Vector((1.4,-1.8,1.1))*size
    aim(camera,center); camera_data.type='ORTHO'; camera_data.ortho_scale=size*1.3
    camera_data.clip_end=max(1000,size*50);bpy.context.scene.camera=camera
    for label,offset,power,shade in [('Key',(-1,-1.5,2),1100,(1,.86,.74)),('Fill',(1.5,-.4,.7),600,(.7,.83,1)),('Rim',(.2,1.4,1.6),1300,(.82,.9,1))]:
        data=bpy.data.lights.new('QC_'+label,'AREA');data.energy=power*size*size;data.shape='DISK';data.size=size*1.2;data.color=shade
        light=bpy.data.objects.new('QC_'+label,data);bpy.context.scene.collection.objects.link(light);light.location=center+Vector(offset)*size;aim(light,center)
        light['qcoderi_studio']=True
    scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.device='CPU'
    scene.cycles.samples=32 if quality=='preview' else 128;scene.cycles.use_denoising=True
    scene.render.resolution_x=768 if quality=='preview' else 1536;scene.render.resolution_y=scene.render.resolution_x;scene.render.resolution_percentage=100
    scene.world=scene.world.copy() if scene.world else bpy.data.worlds.new('QC_World');scene.world.use_nodes=True
    scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.08,.09,.12,1)
    scene.world.node_tree.nodes['Background'].inputs[1].default_value=.3
    try:scene.view_settings.view_transform='AgX'
    except TypeError:pass
    scene.render.image_settings.file_format='PNG'
    return camera

def render_views(output_dir):
    """Render front, side and back with the active camera; restore scene state."""
    from pathlib import Path
    scene=bpy.context.scene
    if not scene.camera: raise ValueError('Multiple views need an active camera')
    subjects=[obj for obj in scene.objects if obj.type=='MESH' and not obj.get('qcoderi_studio') and not obj.hide_render]
    if not subjects: raise ValueError('No renderable mesh subjects')
    bpy.context.view_layer.update()
    points=[obj.matrix_world @ Vector(corner) for obj in subjects for corner in obj.bound_box]
    center=Vector(tuple((min(p[i] for p in points)+max(p[i] for p in points))/2 for i in range(3)))
    camera=scene.camera
    transform=camera.matrix_world.copy(); previous_path=scene.render.filepath
    distance=max((camera.location-center).length, .5)
    output=Path(output_dir);output.mkdir(parents=True,exist_ok=True)
    result=[]
    try:
        for name,direction in [('front',(0,-1,.25)),('side',(1,0,.25)),('back',(0,1,.25))]:
            camera.location=center+Vector(direction).normalized()*distance
            aim(camera,center)
            scene.render.image_settings.file_format='PNG'
            path=output/('render-'+name+'.png');scene.render.filepath=str(path)
            bpy.ops.render.render(write_still=True)
            result.append(dict(view=name,path=str(path)))
    finally:
        camera.matrix_world=transform;scene.render.filepath=previous_path
    return result
