const StudioMediaContext=react.createContext(null);
const EMPTY_VIDEO_JOBS=[];
function useStudioMedia(){return react.useContext(StudioMediaContext)??{jobs:EMPTY_VIDEO_JOBS,anchors:new Set(),running:false,videoMode:false};}
function StudioMediaRoot({mediaSessionId:sessionId,mediaRunning:running,mediaVideoMode:videoMode,mediaModel:model,mediaSeconds:seconds,mediaOnRepeat:onRepeat,...props}) {
  const [state,setState]=react.useState({sessionId,jobs:[],error:'',refreshing:false});
  const [anchorState,setAnchorState]=react.useState({sessionId:null,ids:new Set(),turns:[]});
  const refresh=react.useRef(null);
  const registerAnchors=react.useCallback((id,ids,turns=[])=>setAnchorState({sessionId:id,ids:new Set(ids),turns}),[]);
  react.useEffect(()=>{
    const abort=new AbortController();let timer,busy=false,again=false,signature='';
    setState({sessionId,jobs:[],error:'',refreshing:false});
    const update=async(manual=false)=>{
      if(abort.signal.aborted)return;
      if(busy){again=true;return;}busy=true;
      if(manual)setState(previous=>previous.sessionId===sessionId?{...previous,refreshing:true}:previous);
      try{
        const read=window.__qcoderiReadMedia;
        if(read&&sessionId){const value=await read(sessionId,abort.signal);if(!abort.signal.aborted){const next=JSON.stringify(value);if(next!==signature){signature=next;setState({sessionId,jobs:value.slice().sort((a,b)=>a.createdAt-b.createdAt),error:'',refreshing:false});}else setState(previous=>previous.error||previous.refreshing?{...previous,error:'',refreshing:false}:previous);}}
      }catch{if(!abort.signal.aborted)setState(previous=>({...previous,error:'Не удалось обновить видео. Результаты сохранены, проверяем снова автоматически.',refreshing:false}));}
      finally{busy=false;if(!abort.signal.aborted){setState(previous=>previous.refreshing?{...previous,refreshing:false}:previous);timer=setTimeout(update,again?0:5000);again=false;}}
    };
    const request=(manual=false)=>{clearTimeout(timer);update(manual);};refresh.current=request;update();
    const connected=()=>request();window.addEventListener('qcoderi:media-ready',connected);
    return()=>{abort.abort();clearTimeout(timer);window.removeEventListener('qcoderi:media-ready',connected);if(refresh.current===request)refresh.current=null;};
  },[sessionId]);
  react.useEffect(()=>{refresh.current?.();},[sessionId,running]);
  const jobs=state.sessionId===sessionId?state.jobs:EMPTY_VIDEO_JOBS;
  const anchors=react.useMemo(()=>anchorState.sessionId===sessionId?anchorState.ids:new Set(),[anchorState,sessionId]);
  const videoTurns=react.useMemo(()=>new Set(anchorState.sessionId===sessionId?anchorState.turns.filter(row=>Number.isInteger(row.turn)&&jobs.some(job=>job.messageId===row.messageId)).map(row=>row.turn):[]),[anchorState,sessionId,jobs]);
  const value=react.useMemo(()=>({sessionId,jobs,anchors,videoTurns,registerAnchors,running,videoMode,model,seconds,onRepeat,refresh:()=>refresh.current?.(true),refreshing:state.refreshing,error:state.error}),[sessionId,jobs,anchors,videoTurns,registerAnchors,running,videoMode,model,seconds,onRepeat,state.refreshing,state.error]);
  return react.createElement(StudioMediaContext.Provider,{value},react.createElement('div',props));
}
function StudioVideoReply({messageId,time}) {
  const h=react.createElement,media=useStudioMedia();
  const jobs=media.jobs.filter(job=>job.messageId===messageId);
  const last=[...media.anchors].at(-1);
  if(!jobs.length&&media.running&&media.videoMode&&last===messageId)return h('div',{className:'qc-video-answer','data-video-message':messageId},h(StudioVideoCard,{sessionId:media.sessionId,job:{key:'preparing-'+messageId,state:'preparing',createdAt:time??Date.now(),model:media.model?.model,seconds:media.seconds}}));
  if(!jobs.length)return null;
  return h('div',{className:'qc-video-answer','data-video-message':messageId},jobs.map(job=>h(StudioVideoCard,{key:job.key,job,sessionId:media.sessionId})));
}
function StudioVideoCard({job,sessionId}) {
  const h=react.createElement,media=useStudioMedia();
  const [clock,setClock]=react.useState(Date.now()),[busy,setBusy]=react.useState(false),[notice,setNotice]=react.useState('');
  const ready=job.state==='completed',failed=['failed','rejected'].includes(job.state);
  react.useEffect(()=>{if(ready||failed)return;const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer);},[ready,failed]);
  const elapsed=Math.max(0,Math.floor((clock-job.createdAt)/1000));
  const title=ready?'Видео готово':failed?'Не удалось создать видео':job.state==='preparing'?'Подготавливаю генерацию':job.state==='submitting'?(job.warning?'Отправка не подтверждена':'Отправляю запрос'):job.status==='in_progress'?'Создаю видео':'Видео в очереди';
  const src='/qcoderi-media/'+job.key+'/0?session='+encodeURIComponent(sessionId);
  const repeat=async()=>{if(busy||media.running)return;setBusy(true);setNotice('');try{await media.onRepeat?.(job);setNotice('Описание, модель и длительность подставлены. Нажми «Отправить», чтобы создать новое видео.');}catch(error){setNotice(error.message);}finally{setBusy(false);}};
  return h('article',{className:'qc-video-panel qc-video-response','data-state':job.state,'data-qc-video-key':job.key,'data-video-message-id':job.messageId,'aria-label':'Задача видео NiceAI'},
    h('header',{className:'qc-video-panel-heading'},h('div',null,
      h('div',{className:'qc-video-kicker'},h('span',{className:'qc-video-spark','aria-hidden':true},'✦'),'ВИДЕО',h('span',{'data-ready':ready},ready?'ГОТОВО':failed?'ОШИБКА':'NICEAI')),
      h('h2',null,title),h('p',null,(job.model??'NiceAI')+' · '+(job.seconds??5)+' с')),
      !ready&&!failed&&h('div',{className:'qc-video-panel-actions'},h('time',null,Math.floor(elapsed/60)+':'+String(elapsed%60).padStart(2,'0')),h('button',{type:'button',onClick:()=>media.refresh?.(),disabled:media.refreshing,'aria-label':'Проверить статус видео'},'↻'))),
    ready&&h(StudioVideoPlayer,{job,sessionId}),
    !ready&&!failed&&h('div',{className:'qc-render-stage'},
      h('div',{className:'qc-render-status'},h('span',{className:'qc-video-spinner','aria-hidden':true}),h('strong',null,job.state==='preparing'?'Проверяю модель и параметры':job.state==='submitting'?'Ожидаем подтверждение NiceAI':job.status==='in_progress'?'Генерация идёт':'Ожидаем свободный слот'),typeof job.progress==='number'&&h('span',{className:'qc-render-percent'},job.progress+'%')),
      h('div',{className:'qc-render-track',role:'progressbar','aria-label':'Прогресс NiceAI','aria-valuemin':0,'aria-valuemax':100,...(typeof job.progress==='number'?{'aria-valuenow':job.progress}:{'aria-valuetext':'Сервис не сообщил процент'})},h('span',{className:typeof job.progress==='number'?'':'is-indeterminate',style:typeof job.progress==='number'?{width:job.progress+'%'}:undefined})),
      h('div',{className:'qc-render-steps'},['Запрос','Генерация','Готово'].map((label,index)=>h('span',{key:label,'data-active':index===0?Boolean(job.id):index===1?job.status==='in_progress':ready},h('i'),label)))),
    (job.error||job.warning)&&h('p',{className:'qc-video-alert',role:'status'},job.error||job.warning),
    h('footer',{className:'qc-video-response-actions'},
      ready&&h('a',{className:'qc-video-download',href:src+'&download=1',download:'QCoderI-'+job.model+'-'+job.seconds+'s.mp4'},'↓ Скачать'),
      job.prompt&&h('button',{type:'button',onClick:repeat,disabled:busy||media.running,title:'Подставить описание, модель и длительность в новое сообщение'},busy?'Подготавливаю…':'↻ Повторить'),
      ready&&job.urls?.[0]&&h('a',{className:'qc-video-original',href:job.urls[0],target:'_blank',rel:'noopener noreferrer'},'Оригинал ↗')),
    notice&&h('p',{className:'qc-video-repeat-notice',role:'status'},notice)
  );
}
