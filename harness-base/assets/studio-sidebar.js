function SidebarGlyph({name,size=18,className=''}) {
  return react.createElement('svg',{className:'qc-sidebar-glyph '+className,'data-icon':name,width:size,height:size,viewBox:name==='system'?'0 0 48 48':'0 0 24 24','aria-hidden':true,focusable:'false'},
    react.createElement('use',{href:'#qcoderi-glyph-'+name}));
}

function sidebarNavigate(kind) {
  window.dispatchEvent(new CustomEvent('qcoderi:navigate',{detail:{kind}}));
}
function NightSidebarShortcuts({wide}) {
  const h=react.createElement;
  const [mode,setMode]=react.useState(document.body.dataset.qcMode??'chat');
  react.useEffect(()=>{
    const observer=new MutationObserver(()=>setMode(document.body.dataset.qcMode??'chat'));
    observer.observe(document.body,{attributes:true,attributeFilter:['data-qc-mode']});
    return()=>observer.disconnect();
  },[]);
  const items=[['chat','Общение','new-chat'],['agents','Агенты','agents'],['projects','Проекты','projects'],['resources','Модели','resources'],['tools','Инструменты','tools'],['mcp','MCP','mcp']];
  return h('nav',{className:'qc-sidebar-shortcuts qc-night-navigation'+(!wide?' is-rail':''),'aria-label':'Разделы'},items.map(([icon,label,kind])=>{
    const current=kind==='new-chat'&&mode==='chat'||kind==='projects'&&mode==='project';
    return h('button',{key:kind,type:'button',title:kind==='mcp'?'MCP — каталог подключений и плагинов':label,'aria-label':label,'aria-current':current?'page':undefined,'data-qc-action':kind,onClick:()=>sidebarNavigate(kind)},
      h(SidebarGlyph,{name:icon}),wide&&h('span',null,label),wide&&(kind==='new-chat'||kind==='projects')&&h('span',{className:'qc-shortcut-chevron','aria-hidden':true},'›'));
  }));
}
function SidebarSystem() {
  const h=react.createElement;
  const [sample,setSample]=react.useState(null);
  react.useEffect(()=>{
    let active=true,pending=false;
    const read=async(force=false)=>{
      if(pending||!force&&document.hidden)return;
      pending=true;
      try{const next=await window.dshDesktop?.system?.snapshot();if(active)setSample(next??null);}
      catch{if(active)setSample(null);}
      finally{pending=false;}
    };
    const visible=()=>{if(!document.hidden)read();};
    read(true);const timer=window.setInterval(read,3000);
    document.addEventListener('visibilitychange',visible);
    return()=>{active=false;window.clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
  },[]);
  const ready=sample?.phase==='ready';
  const status=sample===null?'Ожидание данных':ready?'В работе':sample.phase==='error'?'Требует внимания':'Подключение…';
  return h('section',{className:'qc-system-card','aria-label':'Состояние системы'},
    h('div',{className:'qc-system-heading'},h('span',{className:'qc-system-icon'},h(SidebarGlyph,{name:'system',size:48})),h('span',null,h('strong',null,'Система'),h('span',{className:'qc-system-status','data-ready':ready},h('i',{'aria-hidden':true}),status))),
    h('div',{className:'qc-system-meters'},[['CPU',sample?.cpu],['RAM',sample?.ram],['GPU',null]].map(([label,value])=>h('div',{key:label,className:'qc-system-meter',title:label==='GPU'?'Загрузка GPU недоступна':value===null||value===undefined?'Ожидание измерения':label==='CPU'?'Общая загрузка процессора':'Использование оперативной памяти'},
      h('span',null,h('b',null,label),h('span',null,Number.isFinite(value)?Math.round(value)+'%':'—')),
      h('div',{className:'qc-system-track','data-kind':label,'data-unavailable':!Number.isFinite(value)},h('i',{style:{width:Number.isFinite(value)?value+'%':'0%'}}))))));
}
function NightProfile({wide}) {
  const h=react.createElement;
  const [notificationsOpen,setNotificationsOpen]=react.useState(false);
  const [notices,setNotices]=react.useState([]);
  const [update,setUpdate]=react.useState(null);
  const updater=window.dshDesktop?.updates;
  const footer=react.useRef(null),bell=react.useRef(null);
  const updateRequest=async action=>{
    try{setUpdate(await updater.request(action));}
    catch(error){setUpdate({phase:'error',message:error.message});}
  };
  react.useEffect(()=>{
    if(!updater)return;
    updater.ready();
  },[updater]);
  react.useEffect(()=>{
    if(!updater)return;
    let active=true,inflight=false;
    const sync=async()=>{
      if(inflight||document.hidden)return;
      inflight=true;
      try{
        const state=await updater.request();
        if(active)setUpdate(previous=>{
          const keys=Object.keys(state);
          return previous&&keys.length===Object.keys(previous).length&&keys.every(key=>previous[key]===state[key])?previous:state;
        });
      }
      catch{}
      finally{inflight=false;}
    };
    const visible=()=>{if(!document.hidden)sync();};
    const timer=setInterval(sync,notificationsOpen?1000:15000);
    document.addEventListener('visibilitychange',visible);
    void sync();
    return()=>{active=false;clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
  },[updater,notificationsOpen]);
  react.useEffect(()=>{
    let sequence=0;
    const receive=event=>{const message=event.detail?.message;if(typeof message==='string'&&message)setNotices(previous=>[...previous.slice(-19),{id:++sequence,message}]);};
    window.addEventListener('qcoderi:navigation-error',receive);
    return()=>window.removeEventListener('qcoderi:navigation-error',receive);
  },[]);
  react.useEffect(()=>{
    if(!notificationsOpen)return;
    const outside=event=>{if(!footer.current?.contains(event.target))setNotificationsOpen(false);};
    const escape=event=>{if(event.key==='Escape'){setNotificationsOpen(false);bell.current?.focus();}};
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
  },[notificationsOpen]);
  return h('div',{className:'qc-sidebar-footer',ref:footer},wide&&h(SidebarSystem),wide&&h('div',{className:'qc-profile-card'},
    h('span',{className:'qc-profile-avatar','aria-hidden':true}),h('span',{className:'qc-profile-copy'},h('strong',null,'Твоё пространство'),h('span',null,'QCoderI · Moonlight')),
    h('button',{type:'button',className:'qc-profile-settings','aria-label':'Основные настройки',title:'Основные настройки',onClick:()=>sidebarNavigate('settings')},h(SidebarGlyph,{name:'settings',size:16}))),
    h('div',{className:'qc-sidebar-utilities','aria-label':'Быстрые действия'},[['settings','Настройки'],['notifications','Уведомления и обновления'],['connections','Подключения моделей'],['quit','Выйти из QCoderI']].map(([kind,label])=>h('button',{key:kind,type:'button',ref:kind==='notifications'?bell:undefined,'aria-label':label,title:label,'aria-expanded':kind==='notifications'?notificationsOpen:undefined,'aria-controls':kind==='notifications'?'qc-sidebar-notifications':undefined,onClick:()=>kind==='notifications'?setNotificationsOpen(value=>!value):sidebarNavigate(kind)},h(SidebarGlyph,{name:kind,size:19}),kind==='notifications'&&(notices.length>0||update?.phase==='available'||update?.previousError)&&h('i',{className:'qc-notification-dot','aria-label':'Есть сообщения'})))),
    notificationsOpen&&h('aside',{id:'qc-sidebar-notifications',className:'qc-sidebar-notifications',role:'dialog','aria-label':'Уведомления и обновления'},h('div',{className:'qc-notifications-heading'},h('strong',null,'Уведомления и обновления'),h('button',{type:'button','aria-label':'Закрыть уведомления',onClick:()=>{setNotificationsOpen(false);bell.current?.focus();}},'×')),
      updater&&h('section',{className:'qc-update-card', 'data-update-phase':update?.phase},
        h('strong',null,'Обновление QCoderI'),
        h('p',{role:'status'},update?.message??({
          checking:'Проверяю обновления…', current:'Установлена последняя версия',
          unconfigured:'Канал обновлений ещё не настроен.',
          available:'Доступна версия '+update?.version, downloading:'Загрузка · '+update?.percent+'%',
          restarting:'Устанавливаю обновление и перезапускаю…',
        }[update?.phase]??('Версия '+(update?.currentVersion??'')))),
        update?.previousError&&h('p',{className:'qc-update-error'},update.previousError),
        update?.phase==='downloading'&&h('progress',{value:update.percent,max:100,'aria-label':'Загрузка обновления'}),
        h('button',{type:'button',disabled:['checking','downloading','restarting'].includes(update?.phase),
          onClick:()=>updateRequest(update?.phase==='available'?'install':'check')},
          update?.phase==='available'?'Установить и перезапустить':'Проверить обновления')),
      notices.length?h('ul',null,notices.map(notice=>h('li',{key:notice.id},notice.message))):null));
}
