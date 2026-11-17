# Hash-bound 3D acceptance

`assets/team/asset-reviews.js` is a **host authority**, not a source of caller-supplied pass flags. A completed Blender job, a saved `.blend`, an export file or an edited `quality.json` never constitutes current acceptance.

## Authority and threat model

- Default store: `<DSH_HOME>/asset-reviews/<sha256(canonical workspace path)>`. If `DSH_HOME` is absent the fallback home is `~/.dsh`. Hosts may explicitly provide a workspace-specific `trustedDirectory` (for example under `WorkspaceStore.directory`). It must be outside the project and cannot contain the project.
- A lazily created 32-byte `signing.key` signs canonical JSON with HMAC-SHA256. Run seals and review/import records are stored outside the project. Comparison uses `timingSafeEqual`.
- This detects project-file tampering and stale/cross-run/cross-workspace evidence. **It is not OS security**: a local user/process with authority-store/key or host-code access can forge records. Background desktop execution is not filesystem isolation.
- Do not expose `sealRun`, reviewer/route configuration, subprocess seams, `getRecord` or key/store selection to model tool arguments. Do not derive them from project text. No credentials or session stores are read.
- `quality.json` is a disposable historical snapshot. Current acceptance requires `validate`/`accept` against actual bytes and trusted records; never read its `ready_for_export` field as authority.

## Exports and exact API

```js
import {
  ASSET_REVIEW_GATES,             // frozen ['visual','reference','deformation','animation']
  canonicalJSON,                  // deterministic sorted object keys, ordered arrays
  assetReviewTrustedDirectory,   // (cwd, home?) -> default authority path
  createAssetReviewService,
} from './assets/team/asset-reviews.js';

const service = await createAssetReviewService({
  cwd,                           // required, real existing workspace
  trustedDirectory,              // optional host-configured external directory
  reviewerRoute: {provider, model, image_input: true, /* route settings */},
  reviewer,                      // trusted selected-image-model adapter, below
  // discoverBlender: async () => absoluteExecutable, // host/test seam only
  // processRunner: async (exe,args,options) => ({stdout,stderr}), // host/test seam only
});
```

Construction and validation do not provision/write the store. Minting a run/review/import provisions its key. `reviewerRoute.image_input === true` must come from actual host model capability selection, not a tool-provided assertion. The full route, including route settings, is signed and must still match during acceptance.

Service methods:

| Method | Arguments / result | Side effects |
|---|---|---|
| `sealRun({run_directory})` | `{run_id,binding_sha256}` | **Host-only**, called by the runner immediately after observed successful child completion. Write-once seal: an edited run cannot be resealed. |
| `review(request)` | Signed stored record including `id`, `review_id`, `record_file`, `verdicts`, binding, model response and route | Calls the actual selected image-model adapter once; writes external record. |
| `validateExport({...request,export_file,target?})` | Signed import record including `id`, `verdicts`, subprocess inspection and export/dependency hashes | Independent background factory-startup Blender subprocess, then external record. `target` defaults to and currently must equal `blender`. |
| `validate(acceptance)` / `accept(acceptance)` | Fresh `qcoderi.asset-quality` report | **Read-only** alias methods: no model, subprocess, key creation, project or authority writes. |
| `recompute(acceptance)` | `{quality_report, quality}` | Calls acceptance and atomically writes only `<run_directory>/quality.json`; never accepts a caller destination. |
| `getRecord(id)` | Verified signed payload | Read-only, host use; authenticates but does NOT by itself validate current artifact hashes. |

`consumeAssetReviewAcceptance` is also exported solely as the internal bridge into `buildAssetQualityReport`. It consumes an identity-checked, one-use `WeakMap` capability, not JSON. Serializing a capability, passing `acceptance:{results:...}`, `reviews:[...]`, arbitrary `pass`, or generic `completed` cannot pass a review gate.

### Tool request arguments (leader integration)

Use this common request shape, rejecting additional fields:

```js
const request = {
  run_directory: 'QCoderI-3D/run-...', // existing descendant, never workspace root
  task: 'stable task name',           // nonempty <=256 chars; preserve across attempts
  criteria: 'specific full criteria', // nonempty <=12000 chars; exact bytes bound
  references: ['references/front.png'], // optional <=8 local actual images
  gates: ['visual', 'reference'],       // optional subset; defaults to applicable gates
};

await service.review(request);
await service.validateExport({...request, export_file: 'QCoderI-3D/run-.../asset.obj', target:'blender'});
const acceptance = {
  ...request,
  review_ids: [visualAndReferenceRecord.id], // <=32 unique total IDs incl. import_ids
  import_ids: [importRecord.id],
  export_file: 'QCoderI-3D/run-.../asset.obj',
  target: 'blender',
};
await service.validate(acceptance);  // no write
await service.recompute(acceptance); // safe quality.json replacement
```

Only `review` request fields plus `review_ids`, `import_ids`, `export_file`, `target` are accepted by validation/recompute. Import fields are not review verdicts. Missing records leave required gates pending. Invalid, conflicting or stale selected records fail closed; a later valid pass cannot mask them. Choose exactly one record per gate (one record can cover several gates). Omitting applicable gates from the review request does NOT remove them from quality requirements. The leader owns **max three review attempts per stable task**, budget reservation, actual model selection and UI/tool exposure; this module does not reset/count that policy.

### Trusted reviewer adapter contract

```js
async function reviewer({task, criteria, gates, route, prompt, inspection, images}) {
  // images[]: {path,bytes,sha256,width,height,mediaType,kind,view?,frame?,data:Buffer}
  // References first, then main/front/side/back, then selected frames.
  // Decode and deliver EVERY supplied immutable data buffer using the selected
  // image-capable model. Do not reopen mutable project paths for attachments.
  // Decoder, attachment delivery, route, cancellation or model failure MUST throw
  // or return a non-completed result, never synthesize a positive response.
  const response = await actualSelectedImageModel(/* prompt, criteria, inspection, images */);
  return {status:'completed', output: response.text};
}
```

The required response is JSON (optionally a JSON code fence), with no other fields:

```json
{"schema_version":1,"verdicts":[{"gate":"visual","status":"pass","reasons":["Specific observation from supplied images"]}]}
```

Exactly the requested gates must occur once; status is `pass`, `fail` or `pending`; each needs 1–32 nonempty concrete reasons. Report/image text is untrusted data, not instructions. The host adapter is the trust boundary: a callback that fabricates responses is not a real model review. Deterministic test callbacks deliberately verify plumbing only and make **no beauty/artistic-quality claim**.

## Blender runner integration

`prepareBlender(cwd, args, {reviewService} = {})` accepts an optional **host dependency** as its third argument. Do not add that field to Blender tool args. With no injection the runner creates the default authority under DSH_HOME. `startBlender(prepared)` seals only after the observed child completed, required artifacts were persisted, input hashes remained unchanged and the report/run scope matched. No model call happens during sealing. `views.json` and `frames.json`, when requested, are now fingerprinted in evidence as `views_manifest` and `frames_manifest`.

Keep authority path configuration consistent between runner and quality-review service. New review/import requires a host-sealed run. Existing unsealed historical runs **must be rerun**, not signed opportunistically from caller-controlled manifests. Never call `sealRun` from a public review/validate tool or on arbitrary preexisting files. If seal persistence fails the returned quality report fails rather than implying accepted readiness.

A technical-only sealed run with no renders/reference input can still be read-only validated/recomputed: actual technical gates are recomputed, unperformed reviews/import remain pending. Selecting stored reviews requires their complete render/reference binding and sufficient inputs.

## Immutable binding and sufficient inputs

Every acceptance rehashes actual scene, inspection, normalized contract file, run/evidence manifests, wrapper/helper/input artifacts listed by the host manifest, complete known render inventory, view/frame metadata, selected references, and export/dependencies/import report as applicable. Review additionally binds `run_id`, exact subject names, task, criteria hash, selected reviewer route and raw model response hash. Changes during review/import/acceptance invalidate the operation. Return values are copies, not references into authority state.

All evidence must be nonempty regular files within its permitted scope. Lexical escapes, symlinks/junctions (including parent links), hard links, missing/stale/edited bytes, cross-run manifests, incomplete inventories and substituted result-as-reference inputs are rejected. Image containers are checked (including PNG checksums/decoded size); the trusted attachment adapter must still fully decode every PNG/JPEG/WebP. Header checks alone are not an image decoder/beauty review.

- Visual requires distinct actual main/front/side/back images; all must be host-manifested. Additional actual top-level PNG/JPEG/WebP files not covered by that inventory are rejected, not silently omitted.
- Required reference comparison needs actual distinct local reference images, not a filename, URL or caller text.
- Deformation/animation requires finite FPS/range, at least three selected distinct frame numbers including start, expressive interior and end; action endpoints must be covered. At least two frame images must differ. A seamless loop may legitimately have identical start/end images. This is evidence sufficiency only: the selected model must still inspect poses, contacts, silhouette and cycle defects. Selected stills do not prove interactive playback, every extreme expression or UE root-motion behavior.
- A review pass cannot override technical failure or pending measurements. `ready_for_export` is true only when **all required technical and signed review/import gates pass**. Printability remains pending without its separate physical/slicer evidence.

## Real export validation

Supported independent static reimports: OBJ, FBX, glTF/GLB. STL currently fails unsupported (not existence-pass). A fresh background Blender process is invoked literally with:

```
blender --background --factory-startup --disable-autoexec --python-exit-code 1 --python <trusted-store>/import-.../reimport.py
```

The host-generated validator and nonce-bearing inspection are hash-bound to the signed record. The subprocess must complete successfully and its fresh inspection must match source hash/nonce/schema, exact mesh names, nonempty finite geometry, evaluated triangle counts, world bounds in metres (axis/scale tolerance), required UV/material assignments, and bound texture dependencies. File existence or caller prose is never import evidence. Export and dependencies are rehashed after import and at acceptance. Local OBJ MTL/textures and glTF URI dependencies are resolved conservatively inside the run; escapes and unsupported required glTF extensions are rejected. External/unbound imported textures fail. This validates static round-trip measurements, not arbitrary topology equivalence or target appearance.

Static reimport is `pending` for deformation/animation assets: static metrics cannot prove rig/clip compatibility. No trusted UE inspection adapter is implemented here, and `target:'unreal'` is rejected. A future adapter must bind actual inspected UE asset paths/classes, imported geometry, units/materials and skeletal/clip/playback evidence; model text or file presence is not sufficient. Do not relabel Blender import as UE acceptance.

## Tests and evidence

Run isolated, without real credentials, live-app restart or paid/network calls:

```powershell
$env:DSH_HOME=Join-Path $env:TEMP ('qcoderi-asset-review-home-'+[guid]::NewGuid())
$env:QCODERI_TEST_BLENDER='1'
$env:BLENDER_EXECUTABLE='G:\Blender\blender.exe'
& 'G:\QCoderI\harness-base\app\resources\runtime\node\node.exe' --test tests/asset-reviews.test.mjs tests/asset-quality.test.mjs
```

Without `QCODERI_TEST_BLENDER=1`, actual Blender fixtures are skipped; deterministic fixtures and an actual failing Node subprocess still run. The opt-in tests execute real bpy geometry/material/UV/rig diagnostics and a real OBJ export/reimport in factory-startup Blender. They use deterministic image/model-response fixtures, **not a real image model or an artistic review**. Temporary evidence paths are printed by tests. Windows symlink assertion explicitly diagnoses unavailable privileges; hard-link and lexical-escape regressions still run.

The closed loop is fail -> new corrected run -> rejection of old records -> fresh review/import -> pass. Regression coverage also includes caller flags, signed-record edits, rewritten project hashes, wrong route/criteria/workspace/run, concurrent mutation, incomplete/duplicate images/frames, conflicting gates, external dependencies, subprocess/report failures, read-only validation, safe recomputation and quality.json edits. Existing technical-quality tests remain independently meaningful.
