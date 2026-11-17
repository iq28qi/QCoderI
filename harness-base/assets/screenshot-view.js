// QCODERI_SCREENSHOT_VIEW_BEGIN
const QC_IMAGE_TOOLS = new Set(['take_screenshot','generate_image','desktop_inspect','desktop_action','share_image','unreal_viewport','read_image']);
const qcImagePlural = new Intl.PluralRules('ru');

function qcScreenshotItems(node) {
  if(node?.kind!=='tool-call')return [];
  const shots=[];
  const visit=block=>{
    if(!block)return;
    if(QC_IMAGE_TOOLS.has(block.call?.name) && !block.isError && Array.isArray(block.content)) {
      const images=block.content.filter(part=>part.type==='image' && typeof part.attachment?.attachmentId==='string' && part.attachment.width>0 && part.attachment.height>0).map(part=>({attachment:part.attachment}));
      let text=block.content.filter(part=>part.type==='text').map(part=>part.text).join('\n');
      if(['desktop_inspect','desktop_action'].includes(block.call.name)){
        try{const state=JSON.parse(text);text=state.window?.title ? `Окно: ${state.window.title}` : 'Состояние приложения';if(state.screenshot_error)text+='\n'+state.screenshot_error;}catch{text='Состояние приложения';}
      }
      let file;
      if(block.call.name==='take_screenshot')text=text.split('\nСнимок экрана:')[0];
      if(block.call.name==='generate_image')text=text.split('\nМодель:')[0];
      if(block.call.name==='read_image')text='';
      if(block.call.name==='share_image'){
        const lines=text.split('\n');
        if(lines.length>2 && /^\d+×\d+ px$/.test(lines.at(-1))){
          file=lines.at(-2);text=lines.slice(0,-2).join('\n');
        }
      }
      if(block.call.name==='unreal_viewport'){try{file=JSON.parse(text.slice(text.indexOf('\n')+1)).file;}catch{}text='Кадр Unreal Editor';}
      if(images.length)shots.push({key:block.callId,images,text,file});
    }
    if(block.call?.name==='interactive_report'&&!block.isError){try{const value=JSON.parse(block.content.filter(p=>p.type==='text').map(p=>p.text).join('\n'));if(value.kind==='qcoderi-report')shots.push({key:block.callId,title:value.title,html:value.html});}catch{}}
    for(const child of block.subCalls ?? [])visit(child);
  };
  visit(node.data.root);
  return shots;
}
function qcImageGroups(order,nodeStore){
  const groups=new Map();
  let previous;
  for(const key of order){
    const node=nodeStore.get(key);
    const turn=node?.location?.turn?.turn;
    const shots=node?.kind==='tool-call' && QC_IMAGE_TOOLS.has(node.data.root.call?.name) ? qcScreenshotItems(node) : [];
    if(turn===undefined || !shots.length || shots.some(shot=>shot.html)){previous=undefined;continue;}
    if(previous?.turn===turn){
      previous.shots.push(...shots);
      groups.set(key,null);
    }else{
      previous={turn,shots};
      groups.set(key,shots);
    }
  }
  return groups;
}
function qcScreenshotView(shots,renderMessageImages,node,ordinary) {
  if(!shots.length)return ordinary;
  const name=node.data.root.call?.name;
  const direct=QC_IMAGE_TOOLS.has(name)||name==='interactive_report';
  const sections=[];
  let images=[];
  const flush=()=>{
    if(!images.length)return;
    const tiles=images.flatMap(shot=>shot.images.map(({attachment})=>({
      attachment:{...attachment,name:shot.text || shot.file?.split(/[\\/]/).at(-1) || attachment.name},
    })));
    const count=tiles.length;
    const plural=qcImagePlural.select(count);
    const noun=plural==='one'?'изображение':plural==='few'?'изображения':'изображений';
    sections.push(react_jsx_runtime.jsxs('details',{
      className:'qc-image-stack','data-qcoderi-screenshot':true,open:true,
      children:[
        react_jsx_runtime.jsx('summary',{children:`${count} ${noun}`}),
        renderMessageImages({images:tiles,align:'start',compact:true}),
      ],
    },images[0].key));
    images=[];
  };
  for(const shot of shots){
    if(!shot.html){images.push(shot);continue;}
    flush();
    sections.push(react_jsx_runtime.jsx(QcReportView,{title:shot.title,html:shot.html},shot.key));
  }
  flush();
  return react_jsx_runtime.jsxs(react_jsx_runtime.Fragment,{children:[direct?null:ordinary,...sections]});
}
// QCODERI_SCREENSHOT_VIEW_END
