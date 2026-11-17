function VideoOptions({sessionId,running}) {
  const h=react.createElement,[seconds,setSeconds]=react.useState(5),[draft,setDraft]=react.useState('5'),[busy,setBusy]=react.useState(false),[error,setError]=react.useState('');
  const lifetime=react.useRef(null);
  const publish=(value,saving)=>window.dispatchEvent(new CustomEvent('qcoderi:video-options',{detail:{sessionId,seconds:value,saving}}));
  react.useEffect(()=>{
    const abort=new AbortController();lifetime.current=abort;
    setSeconds(5);setDraft('5');setBusy(false);setError('');publish(5,false);
    const load=async()=>{try{const value=await window.__qcoderiGetMediaOptions?.(sessionId,abort.signal);if(value&&!abort.signal.aborted){setSeconds(value.seconds);setDraft(String(value.seconds));publish(value.seconds,false);}}catch{if(!abort.signal.aborted)setError('Не удалось прочитать длительность. Обнови диалог.');}};
    const reload=event=>{if(event.detail?.sessionId===sessionId)load();};
    load();window.addEventListener('qcoderi:media-ready',load);window.addEventListener('qcoderi:video-options-reload',reload);
    return()=>{abort.abort();window.removeEventListener('qcoderi:media-ready',load);window.removeEventListener('qcoderi:video-options-reload',reload);};
  },[sessionId]);
  const save=async value=>{
    const number=Number(value);
    if(!Number.isInteger(number)||number<1||number>120){setError('Выбери от 1 до 120 секунд.');return;}
    if(number===seconds){setDraft(String(seconds));setError('');return;}
    if(busy||running)return;
    const signal=lifetime.current?.signal??new AbortController().signal;
    setBusy(true);setError('');publish(seconds,true);let saved=seconds;
    try{if(!window.__qcoderiSetMediaOptions)throw Error('Параметры видео пока недоступны.');const result=await window.__qcoderiSetMediaOptions(sessionId,number,signal);if(signal.aborted)return;saved=result.seconds;setSeconds(saved);setDraft(String(saved));}
    catch(error){if(!signal.aborted){setDraft(String(seconds));setError(error.message);}}
    finally{if(!signal.aborted){setBusy(false);publish(saved,false);}}
  };
  return h('section',{className:'qc-video-options','aria-label':'Параметры видео'},
    h('div',{className:'qc-video-options-row'},h('span',{className:'qc-video-options-label'},'Длительность'),
      h('div',{className:'qc-duration-presets',role:'group','aria-label':'Быстрый выбор длительности'},[5,10,15,30].map(value=>h('button',{key:value,type:'button','aria-pressed':seconds===value,disabled:busy||running,onClick:()=>save(value)},value+' с'))),
      h('label',{className:'qc-duration-custom'},h('input',{type:'number',min:1,max:120,step:1,value:draft,disabled:busy||running,'aria-label':'Своя длительность видео в секундах',onChange:event=>setDraft(event.target.value),onBlur:()=>save(draft),onKeyDown:event=>{if(event.key==='Enter'){event.preventDefault();event.stopPropagation();save(draft);}}}),h('span',null,'сек')),
      h('span',{className:'qc-video-options-saved','aria-live':'polite'},busy?'Сохраняю…':seconds+' с')),
    h('p',{className:error?'qc-video-options-error':'qc-video-options-note'},error||'1–120 секунд · длительность влияет на стоимость генерации')
  );
}
function StudioVideoPlayer({job,sessionId}) {
  const h=react.createElement,[phase,setPhase]=react.useState('preview'),[attempt,setAttempt]=react.useState(0),[near,setNear]=react.useState(false),video=react.useRef(null),frame=react.useRef(null);
  const src='/qcoderi-media/'+job.key+'/0?session='+encodeURIComponent(sessionId)+'&attempt='+attempt;
  react.useEffect(()=>{
    if(typeof IntersectionObserver==='undefined'){setNear(true);return;}
    const observer=new IntersectionObserver(rows=>{if(rows.some(row=>row.isIntersecting)){setNear(true);observer.disconnect();}},{rootMargin:'180px'});
    if(frame.current)observer.observe(frame.current);return()=>observer.disconnect();
  },[]);
  react.useEffect(()=>{if(!near)return;setPhase('loading');const timer=setTimeout(()=>setPhase(current=>current==='loading'?'slow':current),15000);return()=>clearTimeout(timer);},[src,near]);
  const retry=()=>{setPhase('loading');setAttempt(value=>value+1);};
  const play=()=>{setNear(true);requestAnimationFrame(()=>video.current?.play().catch(()=>setPhase('error')));};
  return h('div',{className:'qc-video-player'},
    h('div',{className:'qc-video-viewport','data-playback':phase,ref:frame},
      h('video',{key:src,ref:video,controls:true,preload:near?'auto':'none',playsInline:true,src:near?src:undefined,'aria-label':'Готовое видео NiceAI',onLoadedMetadata:()=>setPhase('ready'),onLoadedData:()=>setPhase('ready'),onCanPlay:()=>setPhase('ready'),onPlaying:()=>setPhase('playing'),onPause:()=>setPhase('ready'),onEnded:()=>setPhase('ready'),onWaiting:()=>setPhase('buffering'),onStalled:()=>{if(video.current?.readyState<1)setPhase('slow');},onError:()=>setPhase('error')}),
      ['preview','ready'].includes(phase)&&h('button',{type:'button',className:'qc-video-play-button',onClick:play,'aria-label':'Воспроизвести видео'},h('svg',{viewBox:'0 0 24 24',width:24,height:24,fill:'currentColor','aria-hidden':true},h('path',{d:'M8 5v14l11-7z'}))),
      ['loading','slow','error'].includes(phase)&&h('div',{className:'qc-video-loading',role:'status'},
        phase!=='error'&&h('span',{className:'qc-video-spinner','aria-hidden':true}),
        h('strong',null,phase==='error'?'Не удалось загрузить видео':phase==='slow'?'Загрузка занимает больше времени':'Загружаю видео'),
        h('span',null,phase==='error'?'Генерация уже готова. Повтор загрузки не создаёт новое видео.':'Получаю видео из NiceAI…'),
        h('button',{type:'button',onClick:retry},phase==='error'?'Повторить загрузку':'Загрузить заново')),
      phase==='buffering'&&h('div',{className:'qc-video-buffering',role:'status'},'Буферизация…')),
    h('div',{className:'qc-video-player-footer'},h('span',null,job.seconds+' секунд'),h('button',{type:'button',onClick:retry,'aria-label':'Перезагрузить видео'},'Перезагрузить'))
  );
}
function StudioActivity({sessionId}) {
  const h=react.createElement,media=useStudioMedia();
  const loose=media.jobs.filter(job=>!job.messageId||!media.anchors.has(job.messageId));
  return h('div',{className:'qc-activity-dock','data-qc-activity':true},
    loose.length>0&&h('section',{className:'qc-video-archive','aria-label':'Видео из истории диалога'},
      h('div',{className:'qc-video-archive-heading'},'Видео из истории · '+loose.length),
      loose.map(job=>h(StudioVideoCard,{key:job.key,job,sessionId}))),
    media.error&&h('p',{className:'qc-video-alert',role:'status'},media.error)
  );
}
