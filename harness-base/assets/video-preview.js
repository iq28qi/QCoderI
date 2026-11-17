function VideoChatNodes({sessionId,nodeStore,...props}) {
  const media=qcMedia.useStudioMedia();
  const rows=props.order.flatMap(key=>{const node=nodeStore.get(key);return (node?.kind==='user'||node?.kind==='steering')&&node.data.messageId?[{messageId:node.data.messageId,turn:node.location?.turn?.turn}]:[];});
  const ids=rows.map(row=>row.messageId);
  const signature=JSON.stringify(rows);
  react.useEffect(()=>{
    media.registerAnchors?.(sessionId,ids,rows);
    return()=>media.registerAnchors?.(sessionId,[]);
  },[sessionId,signature,media.registerAnchors]);
  const imageGroups=react.useMemo(()=>qcImageGroups(props.order,nodeStore),[props.order,nodeStore]);
  return react.createElement(ChatNodeList,{...props,imageGroups});
}
