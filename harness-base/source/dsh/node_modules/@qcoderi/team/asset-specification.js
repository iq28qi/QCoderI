/** Version 1 asset contract. All lengths are metres, areas square metres, and
 * budgets use evaluated triangles (not control-cage polygons). This is a set of
 * requirements, never an attestation that a review or export test took place.
 * Omission preserves legacy blender_run calls; strict validation catches typos.
 * Example: {purpose:'static', subjects:['Product'], units:{system:'METRIC',
 * meters_per_unit:1}, requirements:{uv:true, closed_manifold:true},
 * limits:{max_triangles:50000, dimensions_m:{min:[0,0,0],max:[2,2,2]}}}.
 */
const purposes = ['generic', 'static', 'character', 'print'];
const requirementNames = ['materials', 'uv', 'closed_manifold', 'applied_scale', 'rig', 'animation', 'reference'];
const object = (value, path, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${path}: expected an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new TypeError(`${path}.${key}: unknown field`);
};
const finite = (value, path, min, max = Number.MAX_VALUE) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new TypeError(`${path}: expected a finite number in [${min}, ${max}]`);
  return value;
};
const text = (value, path) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f]/.test(value)) throw new TypeError(`${path}: expected 1–256 non-control characters`);
  return value;
};
export function normalizeAssetSpecification(input) {
  const value = input === undefined ? {} : input;
  object(value, 'asset_specification', ['schema_version', 'name', 'purpose', 'subjects', 'units', 'requirements', 'limits', 'export_format']);
  if (value.schema_version !== undefined && value.schema_version !== 1) throw new TypeError('asset_specification.schema_version: only version 1 is supported');
  const purpose = value.purpose === undefined ? 'generic' : value.purpose;
  if (!purposes.includes(purpose)) throw new TypeError('asset_specification.purpose: expected generic, static, character or print');
  const result = {schema_version: 1, purpose};
  if (value.name !== undefined) result.name = text(value.name, 'asset_specification.name');
  if (value.subjects !== undefined) {
    if (!Array.isArray(value.subjects) || !value.subjects.length || value.subjects.length > 256) throw new TypeError('asset_specification.subjects: expected 1–256 exact mesh object names');
    result.subjects = value.subjects.map(name => text(name, 'asset_specification.subjects'));
    if (new Set(result.subjects).size !== result.subjects.length) throw new TypeError('asset_specification.subjects: duplicate names');
  }
  if (value.units !== undefined) {
    object(value.units, 'asset_specification.units', ['system', 'meters_per_unit']);
    const system = value.units.system === undefined ? 'METRIC' : value.units.system;
    if (!['NONE', 'METRIC', 'IMPERIAL'].includes(system)) throw new TypeError('asset_specification.units.system: expected NONE, METRIC or IMPERIAL');
    result.units = {system, meters_per_unit: finite(value.units.meters_per_unit === undefined ? 1 : value.units.meters_per_unit, 'asset_specification.units.meters_per_unit', 1e-9, 1e9)};
  }
  result.requirements = {materials: true, uv: false, closed_manifold: purpose === 'print', applied_scale: false,
    rig: purpose === 'character', animation: false, reference: true};
  if (value.requirements !== undefined) {
    object(value.requirements, 'asset_specification.requirements', requirementNames);
    for (const [key, flag] of Object.entries(value.requirements)) {
      if (typeof flag !== 'boolean') throw new TypeError(`asset_specification.requirements.${key}: expected boolean`);
      result.requirements[key] = flag;
    }
  }
  result.limits = {min_face_area_m2: 1e-12};
  if (value.limits !== undefined) {
    object(value.limits, 'asset_specification.limits', ['min_face_area_m2', 'max_triangles', 'max_bone_influences', 'dimensions_m']);
    if (value.limits.min_face_area_m2 !== undefined) result.limits.min_face_area_m2 = finite(value.limits.min_face_area_m2, 'asset_specification.limits.min_face_area_m2', 0, 1);
    for (const key of ['max_triangles', 'max_bone_influences']) if (value.limits[key] !== undefined) {
      const count = finite(value.limits[key], `asset_specification.limits.${key}`, 1, Number.MAX_SAFE_INTEGER);
      if (!Number.isSafeInteger(count)) throw new TypeError(`asset_specification.limits.${key}: expected integer`);
      result.limits[key] = count;
    }
    if (value.limits.dimensions_m !== undefined) {
      const bounds = value.limits.dimensions_m;
      object(bounds, 'asset_specification.limits.dimensions_m', ['min', 'max']);
      if (bounds.min === undefined && bounds.max === undefined) throw new TypeError('asset_specification.limits.dimensions_m: min or max is required');
      result.limits.dimensions_m = {};
      for (const key of ['min', 'max']) if (bounds[key] !== undefined) {
        if (!Array.isArray(bounds[key]) || bounds[key].length !== 3) throw new TypeError(`asset_specification.limits.dimensions_m.${key}: expected three XYZ lengths`);
        result.limits.dimensions_m[key] = bounds[key].map(n => finite(n, `asset_specification.limits.dimensions_m.${key}`, 0, 1e12));
      }
      if (bounds.min && bounds.max && bounds.min.some((n, i) => n > bounds.max[i])) throw new TypeError('asset_specification.limits.dimensions_m: min exceeds max');
    }
  }
  if (value.export_format !== undefined) {
    if (!['fbx', 'gltf', 'obj', 'stl'].includes(value.export_format)) throw new TypeError('asset_specification.export_format: expected fbx, gltf, obj or stl');
    result.export_format = value.export_format;
  }
  return result;
}

// dsh-tools parameter schema; runtime validation above remains authoritative.
export const assetSpecificationParameter = {
  type: 'object', additionalProperties: false,
  description: 'Optional v1 asset requirements, not proof of quality. Exact mesh subjects exclude studio helpers by default. Lengths in metres; evaluated triangle budget. Missing visual/reference/deformation/export reviews remain pending in quality.json.',
  properties: {
    schema_version: {type: 'integer', enum: [1]}, name: {type: 'string'},
    purpose: {type: 'string', enum: purposes}, subjects: {type: 'array', items: {type: 'string'}},
    units: {type: 'object', additionalProperties: false, properties: {system: {type: 'string', enum: ['NONE', 'METRIC', 'IMPERIAL']}, meters_per_unit: {type: 'number'}}},
    requirements: {type: 'object', additionalProperties: false, properties: Object.fromEntries(requirementNames.map(name => [name, {type: 'boolean'}]))},
    limits: {type: 'object', additionalProperties: false, properties: {
      min_face_area_m2: {type: 'number'}, max_triangles: {type: 'integer'}, max_bone_influences: {type: 'integer'},
      dimensions_m: {type: 'object', additionalProperties: false, description: 'World-axis-aligned bounds of the combined subjects, after world transforms and scene scale_length.',
        properties: {min: {type: 'array', items: {type: 'number'}}, max: {type: 'array', items: {type: 'number'}}}},
    }},
    export_format: {type: 'string', enum: ['fbx', 'gltf', 'obj', 'stl']},
  },
};
