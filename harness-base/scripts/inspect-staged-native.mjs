// Read/control ONLY the disposable native preview described by its local info file.
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
const [infoPath,expressionArg,output]=process.argv.slice(2);assert(infoPath);
const info=JSON.parse(await readFile(resolve(infoPath),'utf8'));assert(info.root.includes('tests\\.runtime\\')||info.root.includes('tests/.runtime/'));
const page=(await fetch(`http://127.0.0.1:${info.debugPort}/json/list`).then(r=>r.json())).find(p=>p.url.endsWith('/index.html'));assert(page);
const socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise((done,reject)=>{socket.onopen=done;socket.onerror=reject;});
let id=0;const requests=new Map(),errors=[];
socket.onmessage=event=>{const value=JSON.parse(event.data),request=requests.get(value.id);if(request){requests.delete(value.id);clearTimeout(request.timer);value.error?request.reject(Error(JSON.stringify(value.error))):request.done(value.result);}if(value.method==='Runtime.exceptionThrown')errors.push(value.params.exceptionDetails);};
const send=(method,params={})=>new Promise((done,reject)=>{const seq=++id,timer=setTimeout(()=>{requests.delete(seq);reject(Error('CDP timeout '+method));},30000);requests.set(seq,{done,reject,timer});socket.send(JSON.stringify({id:seq,method,params}));});
try{
 await send('Runtime.enable');await send('Network.enable');await send('Network.setBlockedURLs',{urls:['https://*']});
 if(process.env.QCODERI_PREVIEW_VIEWPORT){const [width,height]=process.env.QCODERI_PREVIEW_VIEWPORT.split('x').map(Number);assert(width>=320&&width<=2000&&height>=400&&height<=2000);await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});}
 const expression=expressionArg??`({text:document.body.innerText,buttons:[...document.querySelectorAll('button')].map(b=>({label:b.getAttribute('aria-label')||b.textContent.trim(),disabled:b.disabled})),inputs:[...document.querySelectorAll('input')].map(e=>({placeholder:e.placeholder,label:e.getAttribute('aria-label'),type:e.type})),globals:Object.keys(window).filter(k=>/qcoder/i.test(k))})`;
 const response=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
 if(response.exceptionDetails)throw Error(JSON.stringify(response.exceptionDetails));
 if(process.env.QCODERI_PREVIEW_CAPTURE){const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(resolve(process.env.QCODERI_PREVIEW_CAPTURE),Buffer.from(shot.data,'base64'));}
 const value={value:response.result.value,errors};if(output)await writeFile(resolve(output),JSON.stringify(value,null,2));console.log(JSON.stringify(value,null,2));
}finally{socket.close();}
