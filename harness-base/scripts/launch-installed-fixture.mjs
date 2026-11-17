// Launch only a disposable locally installed release to test native versioned runtime.
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
const [rootArg,outputArg]=process.argv.slice(2),root=resolve(rootArg),output=resolve(outputArg);
assert(root.includes('tests\\.runtime\\platform-installed-'));
const journal=JSON.parse((await readFile(join(root,'.qcoderi-local-install.json'),'utf8')).replace(/^\uFEFF/,''));assert.equal(journal.phase,'installed_awaiting_manual_launch');
const previous=process.env.QCODERI_INSTALLED_FIXTURE_HOME;
if(previous)assert(resolve(previous).startsWith(join(resolve(output,'..'),'installed-native-')));
const home=previous?resolve(previous):await mkdtemp(join(resolve(output,'..'),'installed-native-'));
const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(done=>server.close(done));
const child=spawn(join(root,'QCoderI.exe'),[],{cwd:root,stdio:'ignore',windowsHide:false,env:{...process.env,DSH_HOME:home,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --disable-background-networking`}});
await writeFile(output,JSON.stringify({root,home,pid:child.pid,debugPort:port,version:journal.version},null,2));
const guard=setTimeout(()=>child.kill(),180000);await once(child,'exit');clearTimeout(guard);
