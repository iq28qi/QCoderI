function NightFeatureIcon({ kind, size = 18 }) {
  const paths = {
    code:'m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16',
    research:'M16 16l5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0ZM7 6a5 5 0 0 1 7 0',
    automation:'m13 2-9 12h7l-1 8 10-13h-7l1-7Z',
    project:'M3 6h7l2 3h9v11H3V6Z',
    idea:'M9 18h6m-5 3h4M8 14a6 6 0 1 1 8 0c-1 1-1 2-1 3H9c0-1 0-2-1-3Z',
    text:'M5 4h14M12 4v16m-4 0h8',
    chat:'M6 3h12a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4h-7l-6 4v-4a4 4 0 0 1-3-4V7a4 4 0 0 1 4-4Zm1 8h.01M12 11h.01M17 11h.01',
  };
  return react.createElement('svg',{width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.5,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},react.createElement('path',{d:paths[kind]??paths.chat}));
}
function HeroShell({ renderSlot, chatMode, videoMode, videoSeconds=5 }) {
  const h = react.createElement;
  return h('section',{className:HeroShell_module_css_default.root+' qc-hero','aria-label':chatMode?'Обычный чат':'Работа над проектом'},
    h('div',{className:'qc-eyebrow'},videoMode?'ГЕНЕРАЦИЯ ВИДЕО · NICEAI':chatMode?'ПРОСТРАНСТВО ДЛЯ РАЗГОВОРА':'ПРОСТРАНСТВО ДЛЯ СОЗДАНИЯ'),
    h('h1',{className:'qc-hero-title'},videoMode?'Какое видео создадим?':chatMode?'О чём поговорим?':'От идеи ',!videoMode&&!chatMode&&h('em',null,'к результату.')),
    h('p',{className:'qc-hero-description'},videoMode?`Опиши сцену и движение камеры. Длительность ролика — ${videoSeconds} с.`:chatMode?'Спроси о чём угодно. Найдём идеи, разберёмся в сложном или просто поболтаем.':'Разрабатывай, исследуй и собирай команду агентов — с контекстом твоего проекта.'));
}
function NightQuickCards({ onSuggest, chatMode, videoMode }) {
  const h=react.createElement;
  const cards=videoMode ? [
    ['research','Пейзаж','Свет, воздух и движение','Кинематографичный пейзаж: волны на закате, тёплый свет, медленное движение камеры вдоль берега.'],
    ['idea','Киносцена','Один выразительный момент','Ночная улица после дождя, отражения неона на асфальте, плавный наезд камеры, атмосферная киношная сцена.'],
    ['project','Предметная съёмка','Внимание к деталям','Стеклянный флакон на тёмном фоне, мягкий боковой свет, медленный облёт камеры, премиальная предметная съёмка.'],
    ['chat','Своя идея','Придумай собственную сцену','Создай видео: '],
  ] : chatMode ? [
    ['research','Разобраться в теме','Сложное — простыми словами','Помоги разобраться в новой теме. Для начала спроси, что мне интересно.'],
    ['idea','Найти идею','Свежий взгляд на привычное','Давай придумаем что-нибудь интересное. Спроси, для чего мне нужны идеи.'],
    ['text','Написать текст','Подобрать нужные слова','Помоги написать текст. Сначала уточни тему, аудиторию и нужный тон.'],
    ['chat','Просто поговорить','Без задач и дедлайнов','Привет! Хочется просто поболтать.'],
  ] : [
    ['code','Написать код','От замысла до реализации','Помоги написать и проверить код для новой функции.'],
    ['research','Изучить проект','Архитектура и возможности','Изучи мой проект, объясни архитектуру и предложи улучшения.'],
    ['automation','Автоматизировать','Освободить время для важного','Помоги автоматизировать повторяющиеся задачи моего проекта.'],
    ['project','Собрать команду','Распределить большую задачу','Помоги разделить задачу между параллельными исполнителями и проверить общий результат.'],
  ];
  const art={research:'book',idea:'orbit',text:'feather',chat:'moon',code:'book',automation:'orbit',project:'moon'};
  return h('div',{className:'qc-quick-cards','aria-label':chatMode?'Идеи для разговора':'Быстрый старт'},cards.map(([icon,title,description,prompt])=>h('button',{key:title,type:'button',className:'qc-quick-card','data-qc-art':art[icon],onClick:()=>onSuggest(prompt)},
    h('img',{className:'qc-card-art',src:'./qcoderi-card-'+art[icon]+'.svg',alt:'','aria-hidden':true,draggable:false}),
    h('span',{className:'qc-quick-card-top'},h('span',{className:'qc-card-icon'},h(NightFeatureIcon,{kind:icon,size:22}))),
    h('strong',null,title),h('span',{className:'qc-quick-card-description'},description))));
}
