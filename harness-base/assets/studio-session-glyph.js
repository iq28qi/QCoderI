function QcSessionGlyph({node}) {
  const title=node.title??'';
  const preset=node.projectionValues?.agentPreset??'';
  const model=node.projectionValues?.modelSelection?.next?.model??'';
  const kind=node.blank?'chat':/seedance|kling/i.test(model)||/кино|видео|cinema|video/i.test(title)?'video':/unreal|ue[45]/i.test(preset+' '+title)?'project':'agent';
  return react.createElement('svg',{className:'qc-session-glyph','data-icon':kind,width:15,height:15,viewBox:'0 0 24 24','aria-hidden':true,focusable:'false'},
    react.createElement('use',{href:'#qcoderi-glyph-session-'+kind}));
}
