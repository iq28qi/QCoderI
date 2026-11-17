// Runtime-specific native benchmark evidence, independent of report/generated timestamps.
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
export function benchmarkRuntimeIdentity(manifest){
 const relevant=manifest.files.filter(({path})=>path==='QCoderI.exe'||path.startsWith('harness-base/source/dsh/')||path.startsWith('harness-base/app/resources/runtime/')||['harness-base/native/desktop-server.mjs','harness-base/native/updates.mjs','harness-base/native/startup-cache.mjs'].includes(path));
 assert(relevant.some(x=>x.path==='QCoderI.exe'));assert(relevant.some(x=>x.path.startsWith('harness-base/source/dsh/')));
 return createHash('sha256').update(JSON.stringify(relevant.map(({path,sha256,bytes})=>({path,sha256,bytes})).sort((a,b)=>a.path.localeCompare(b.path)))).digest('hex');
}
export function assertBenchmarkReuse(saved,current){
 assert(saved?.runtime_sha256,'Prior sample lacks runtime identity; bind it explicitly to unchanged historical manifest before reuse');
 assert.equal(saved.runtime_sha256,current.runtime_sha256,'Cannot reuse samples from changed native runtime');
 assert.equal(saved.exe_sha256,current.exe_sha256,'Cannot reuse samples from changed EXE');
}
