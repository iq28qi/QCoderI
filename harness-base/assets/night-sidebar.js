// Embedded in the existing SidebarRoot React module.
function NightSidebarShortcuts({ wide }) {
  const h=react.createElement;
  const items=[['m12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5','Рабочие области','workspaces'],['M3 6h7l2 3h9v11H3V6Z','Проекты','projects'],['m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5L12 2Z','Агенты','agents'],['M3 3h7v7H3V3Zm11 0h7v7h-7V3ZM3 14h7v7H3v-7Zm11 0h7v7h-7v-7Z','Инструменты','tools'],['m12 2 9 5v10l-9 5-9-5V7l9-5Zm0 10v10M3 7l9 5 9-5','Ресурсы','resources']];
  return h('nav',{className:'qc-sidebar-shortcuts'+(!wide?' is-rail':''),'aria-label':'Разделы студии'},items.map(([icon,label,kind])=>h('button',{key:kind,type:'button',title:label,onClick:()=>window.dispatchEvent(new CustomEvent('qcoderi:navigate',{detail:{kind}}))},h('svg',{className:'qc-shortcut-icon',width:18,height:18,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.5,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},h('path',{d:icon})),wide&&h('span',null,label),wide&&h('span',{className:'qc-shortcut-chevron','aria-hidden':true},'⌄'))));
}
function NightProfile({ wide }) {
  if(!wide)return null;
  const h=react.createElement;
  return h('button',{type:'button',className:'qc-profile-card',onClick:()=>window.dispatchEvent(new CustomEvent('qcoderi:open-settings',{detail:{id:'general'}}))},
    h('span',{className:'qc-profile-avatar','aria-hidden':true}),h('span',{className:'qc-profile-copy'},h('strong',null,'QCoderI Studio'),h('span',null,'Личная ИИ-студия')),h('span',{className:'qc-profile-spark','aria-hidden':true},'✦'));
}
