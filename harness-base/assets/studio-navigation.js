function NightGlyph({ name, size = 16 }) {
  const paths = { chat:'M4 5h16v12H9l-5 4V5Z', workbench:'M4 7h16v14H4zM9 7V3h6v4M4 12h16m-10 0v3h4v-3', projects:'M3 6h7l2 3h9v11H3V6Z', files:'M6 3h8l4 4v14H6V3Zm8 0v5h4', terminal:'m5 7 5 5-5 5m8 0h6', agents:'M12 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM4 21v-5a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v5' };
  return react.createElement('svg',{width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.5,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},react.createElement('path',{d:paths[name]??paths.chat}));
}
function NightNavigation({ useSessions }) {
  const chatMode = useStudioChat(useSessions);
  const ready = useSessions(state => state.phase === 'ready' && state.current !== undefined);
  const [panel, setPanel] = react.useState('chat');
  const [error, setError] = react.useState('');
  const [workbenchOpen,setWorkbenchOpen]=react.useState(false);
  react.useEffect(() => {
    const navigate = event => { if(event.detail?.kind!=='workbench')setPanel(event.detail?.kind ?? 'chat'); setError(''); };
    const workbench=event=>setWorkbenchOpen(event.detail?.open===true);
    const failed = event => setError(event.detail?.message ?? 'Не удалось открыть диалог');
    window.addEventListener('qcoderi:navigate', navigate);window.addEventListener('qcoderi:workbench-state',workbench);
    window.addEventListener('qcoderi:navigation-error', failed);
    return () => { window.removeEventListener('qcoderi:navigate', navigate);window.removeEventListener('qcoderi:workbench-state',workbench); window.removeEventListener('qcoderi:navigation-error', failed); };
  }, []);
  const h=react.createElement;
  const go=kind=>window.dispatchEvent(new CustomEvent('qcoderi:navigate',{detail:{kind}}));
  return h('div',{className:'qc-night-topbar'},
    h('span',{className:'qc-mode-title'},chatMode?'Общение':'Проекты'),
    error&&h('span',{className:'qc-navigation-error',role:'alert'},error),
    !chatMode&&h('div',{className:'qc-project-actions'},[['chat','Чат'],['files','Файлы'],['terminal','Терминал'],['workbench','Работа']].map(([kind,label])=>h('button',{key:kind,type:'button','data-qc-workbench-toggle':kind==='workbench'?true:undefined,'aria-label':kind==='workbench'?'Рабочая панель':label,'aria-haspopup':kind==='workbench'?'dialog':undefined,'aria-expanded':kind==='workbench'?workbenchOpen:undefined,disabled:!ready,className:'qc-project-action'+((kind==='workbench'?workbenchOpen:panel===kind)?' is-current':''),onClick:()=>go(kind)},h(NightGlyph,{name:kind}),h('span',null,label)))),
    h('button',{type:'button',className:'qc-night-search',title:'Поиск диалогов','aria-label':'Найти диалог',onClick:()=>go('search')},h('svg',{width:18,height:18,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.6,'aria-hidden':true},h('circle',{cx:10,cy:10,r:6}),h('path',{d:'m15 15 6 6'}))));
}
function CenterColumn(props) {
  return react.createElement('div',{className:AppFrame_module_css_default.centerCol},react.createElement(NightNavigation,{useSessions:props.useSessions}),props.children);
}
