import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
const jsx=(type,props,key)=>({type,props,key});
const context=vm.createContext({react_jsx_runtime:{jsx,jsxs:jsx,Fragment:'fragment'}});
vm.runInContext(readFileSync(fileURLToPath(new URL('../assets/report-view.js',import.meta.url)),'utf8'),context);
vm.runInContext(readFileSync(fileURLToPath(new URL('../assets/screenshot-view.js',import.meta.url)),'utf8'),context);
const attachment={attachmentId:'fixture-image',width:160,height:160,bytes:1234,mediaType:'image/png'};
for(const tool of ['take_screenshot','share_image','desktop_inspect','desktop_action','generate_image','unreal_viewport']){
  context.node={kind:'tool-call',data:{root:{callId:'fixture',call:{name:tool},content:[{type:'text',text:'Проверенный результат'},{type:'image',attachment}]}}};
  const shots=vm.runInContext('qcScreenshotItems(node)',context);assert.equal(shots.length,1);
  context.shots=shots;context.render=owner=>({gallery:owner.images});context.ordinary={tool:'collapsed'};
  const view=vm.runInContext('qcScreenshotView(shots,render,node,ordinary)',context);
  assert.equal(view.props.children[0],null,'standalone result is visible outside the collapsed tool row');
  assert.equal(view.props.children[1].type,'details');
  assert.equal(view.props.children[1].props.children[1].gallery[0].attachment.attachmentId,'fixture-image');
  if(tool==='share_image')assert.equal(view.props.children[1].props.children[1].gallery[0].attachment.name,'Проверенный результат');
}
context.node={kind:'tool-call',data:{root:{call:{name:'share_image'},isError:true,content:[{type:'image',attachment}]}}};
assert.equal(vm.runInContext('qcScreenshotItems(node).length',context),0);
context.node={kind:'tool-call',data:{root:{call:{name:'desktop_inspect'},content:[{type:'text',text:JSON.stringify({window:{title:'Blender'},elements:[{element:'hwnd:123',value:'technical output'}]})},{type:'image',attachment}]}}};
assert.equal(vm.runInContext('qcScreenshotItems(node)[0].text',context),'Окно: Blender','the preview caption does not dump the automation tree into the chat');
const shotNode=(id,turn)=>({kind:'tool-call',location:{turn:{turn}},data:{root:{callId:id,call:{name:'share_image'},content:[
  {type:'text',text:'Фас\nG:\\project\\front.png\n160×160 px'},{type:'image',attachment},
]}}});
context.nodes=new Map([['front',shotNode('front',1)],['side',shotNode('side',1)],['different',shotNode('different',2)]]);
const grouped=vm.runInContext("qcImageGroups(['front','side','different'],nodes)",context);
assert.equal(grouped.get('front').length,2);
assert.equal(grouped.get('side'),null);
assert.equal(grouped.get('different').length,1);
assert.equal(grouped.get('front')[0].text,'Фас');
console.log('PASS: screenshots, app actions, generated assets and shared 3D renders render through the native image gallery outside collapsed tool history');

context.node={kind:'tool-call',data:{root:{callId:'report',call:{name:'interactive_report'},content:[{type:'text',text:JSON.stringify({kind:'qcoderi-report',title:'Отчёт',html:'<details><summary>Открыть</summary>Данные</details>'})}]}}};
context.shots=vm.runInContext('qcScreenshotItems(node)',context);assert.equal(context.shots.length,1);
const report=vm.runInContext('qcScreenshotView(shots,render,node,ordinary)',context).props.children[1];
assert.equal(report.type.name,'QcReportView');
const reportDocument=vm.runInContext('qcReportDocument(shots[0].html)',context);
assert(reportDocument.includes("connect-src 'none'"));assert(reportDocument.includes('Content-Security-Policy'));
assert(reportDocument.includes('scrollbar-color'));
console.log('PASS: interactive report stays visible in chat and renders in a sandboxed CSP frame');

// Displaying a render is not a review attestation. Keep technical quality data
// separate from native gallery rendering and never infer export readiness.
const {buildAssetQualityReport}=await import('../assets/team/asset-quality.js');
const quality=buildAssetQualityReport({run:{process_status:'completed'},evidence:[
  {kind:'scene',status:'pass',path:'fixture.blend'},
  {kind:'render',status:'pass',path:'fixture.png'},
]});
assert.equal(quality.ready_for_export,false);
for(const id of ['visual_review','reference_review','export_validation']){
  assert.equal(quality.gates.find(gate=>gate.id===id).status,'pending');
}
const studioSource=readFileSync(fileURLToPath(new URL('../assets/team/studio3d.js',import.meta.url)),'utf8');
assert(studioSource.includes('asset_specification:assetSpecificationParameter'));
assert(studioSource.includes('quality_report:prepared.quality'));
console.log('PASS: 3D gallery artifacts never promote unperformed reviews to export readiness');
