function NightFeatureIcon({ kind }) {
  const paths = { code:'m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16',research:'M4 14h3v7H4v-7Zm6-5h3v12h-3V9Zm6-6h3v18h-3V3Z',automation:'m13 2-9 12h7l-1 8 10-13h-7l1-7Z',project:'m12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5'};
  return react.createElement('svg',{width:21,height:21,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.5,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},react.createElement('path',{d:paths[kind]}));
}
function HeroShell({ t, renderSlot, children, onSuggest }) {
  const h=react.createElement;
  const core=h('div',{className:'qc-hero-core'},h('span',null,'Q'));
  return h('section',{className:HeroShell_module_css_default.root+' qc-hero','aria-label':'QCoderI — пространство идей'},
    h('div',{className:'qc-hero-scene','aria-hidden':true},h('span',{className:'qc-orbit'}),h('span',{className:'qc-orbit qc-orbit--second'}),renderSlot('conversation.hero.brand.mark',{size:66},{fallback:core})),
    h('div',{className:'qc-hero-product'},'QCoderI'),
    h('div',{className:'qc-eyebrow'},h('span',{className:'qc-live-dot'}),'Пространство для больших идей'),
    h('h1',{className:'qc-hero-title'},'Твои идеи.',h('br'),h('em',null,'Новый масштаб.')),
    h('p',{className:'qc-hero-description'},'Исследуй, пиши код, создавай проекты и решай сложные задачи — в одном пространстве с ИИ.'),
    h('div',{className:'qc-hero-tags'},
      [['code','Разработка','Помоги разработать и реализовать новую функцию в моём проекте.'],['research','Исследования','Исследуй архитектуру проекта и предложи улучшения.'],['automation','Автоматизация','Помоги автоматизировать повторяющиеся задачи в моём проекте.']].map(([icon,label,prompt])=>h('button',{key:label,type:'button',onClick:()=>onSuggest(prompt)},h(NightFeatureIcon,{kind:icon}),label))),children);
}
function NightQuickCards({ onSuggest }) {
  const h=react.createElement;
  const cards=[
    ['code','Генерация кода','От идеи до готового решения','Помоги написать и проверить код для новой функции.'],
    ['research','Анализ и исследования','Глубокий анализ и выводы','Изучи мой проект, объясни архитектуру и найди возможности для улучшения.'],
    ['automation','Автоматизация задач','Скрипты, API, интеграции','Помоги создать автоматизацию для повседневных задач моего проекта.'],
    ['project','Создание проектов','От прототипа до релиза','Помоги спланировать новый проект и последовательно реализовать его.']
  ];
  return h('div',{className:'qc-quick-cards','aria-label':'Быстрый старт'},cards.map(([icon,title,description,prompt])=>h('button',{key:title,type:'button',className:'qc-quick-card',onClick:()=>onSuggest(prompt)},
    h('span',{className:'qc-quick-card-top','aria-hidden':true},h(NightFeatureIcon,{kind:icon}),h('span',null,'→')),h('strong',null,title),h('span',{className:'qc-quick-card-description'},description))));
}
