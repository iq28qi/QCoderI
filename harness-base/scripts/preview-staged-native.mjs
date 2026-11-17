// Launch ONLY the built disposable native release on the background desktop.
// Run with desktop_launch. Never reuses live DSH_HOME or attaches to live QCoderI.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {once} from 'node:events';
const [rootArg,infoArg]=process.argv.slice(2);assert(rootArg&&infoArg);
const root=resolve(rootArg),info=resolve(infoArg);
assert(root.includes('tests\\.runtime\\')||root.includes('tests/.runtime/'));
const manifest=JSON.parse(await readFile(join(root,'release-manifest.json'),'utf8'));assert(manifest.built&&!manifest.snapshot);
const home=await mkdtemp(join(resolve(info,'..'),'platform-ui-'));
const project=join(home,'project');await mkdir(project);
await writeFile(join(project,'architecture.md'),'# Local Project Brain fixture\nGeometry validation checks mesh vertices, topology and export evidence.\n');
await writeFile(join(home,'settings.yaml'),'locale:\n  language: ru-RU\n');
const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(done=>server.close(done));
const child=spawn(join(root,'QCoderI.exe'),[],{cwd:root,stdio:'ignore',windowsHide:false,env:{...process.env,DSH_HOME:home,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --disable-background-networking`}});
await writeFile(info,JSON.stringify({root,home,project,pid:child.pid,debugPort:port,version:manifest.version,exe_sha256:manifest.files.find(x=>x.path==='QCoderI.exe').sha256},null,2));
const watchdog=setTimeout(()=>child.kill(),15*60*1000);child.on('error',()=>{});await once(child,'exit');clearTimeout(watchdog);
