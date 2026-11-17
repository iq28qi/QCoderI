// Embedded in the layout module's existing React factory.
function NightGlyph({ name, size = 16 }) {
  const paths = {
    chat: 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3v-3H3V6a2 2 0 0 1 2-2Z',
    code: 'm8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16',
    files: 'M3 6h7l2 3h9v11H3V6Z',
    terminal: 'M3 4h18v16H3V4Zm4 4 4 4-4 4m7 0h4',
    agents: 'M12 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM3 17h18m-15 0v-4h12v4M3 17v4h4v-4m10 0v4h4v-4'
  };
  return react.createElement('svg', { width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.6,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true }, react.createElement('path',{d:paths[name]??paths.chat}));
}
function NightNavigation({ useSessions }) {
  const ready = useSessions(state => state.phase === 'ready' && state.current !== undefined);
  const items = [ ['chat','Чат'],['code','Код'],['files','Файлы'],['terminal','Терминал'],['agents','Агенты'] ];
  return react.createElement('div',{className:'qc-night-topbar'},
    react.createElement('nav',{className:'qc-night-navigation','aria-label':'Навигация QCoderI'},items.map(([kind,label])=>react.createElement('button',{
      key:kind,type:'button',className:'qc-night-nav-button'+(kind==='chat'?' is-current':''),
      disabled:!ready&&['code','files','terminal'].includes(kind),
      title:!ready&&['code','files','terminal'].includes(kind)?'Сначала выберите рабочую область':kind==='code'?'Просмотр кода файлов проекта':label,
      onClick:()=>window.dispatchEvent(new CustomEvent('qcoderi:navigate',{detail:{kind}}))
    },react.createElement(NightGlyph,{name:kind}),react.createElement('span',null,label)))),
    react.createElement('button',{type:'button',className:'qc-night-search',title:'Поиск диалогов','aria-label':'Найти диалог',onClick:()=>window.dispatchEvent(new CustomEvent('qcoderi:navigate',{detail:{kind:'search'}}))},
      react.createElement('svg',{width:18,height:18,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.6,'aria-hidden':true},react.createElement('circle',{cx:10,cy:10,r:6}),react.createElement('path',{d:'m15 15 6 6'}))));
}
function CenterColumn(props) {
  return react.createElement('div',{className:AppFrame_module_css_default.centerCol},
    react.createElement(NightNavigation,{useSessions:props.useSessions}),props.children);
}
