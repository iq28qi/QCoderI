function TodoPanel({todos,t}) {
  const h=react.createElement,[openOverride,setOpenOverride]=react.useState(null);
  if(!todos.length)return null;
  const done=todos.filter(item=>item.status==='completed').length;
  const complete=done===todos.length;
  const open=openOverride?.complete===complete ? openOverride.open : !complete;
  const percent=Math.round(done/todos.length*100);
  return h('section',{className:'qc-task-card','aria-label':'Прогресс задач','data-complete':complete,'data-expanded':open},
    h('button',{type:'button',className:'qc-task-heading','aria-expanded':open,onClick:()=>setOpenOverride({complete,open:!open})},
      h('span',{className:'qc-task-symbol','aria-hidden':true},'✓'),
      h('span',{className:'qc-task-label'},h('strong',null,complete?'План выполнен':'План работы'),h('small',null,`${done} из ${todos.length} задач завершено`)),
      !complete&&h('span',{className:'qc-task-percent'},`${percent}%`),
      h('svg',{className:'qc-task-chevron','aria-hidden':true,width:14,height:14,viewBox:'0 0 16 16',fill:'none',stroke:'currentColor',strokeWidth:1.5,strokeLinecap:'round',strokeLinejoin:'round'},h('path',{d:'m4.5 6.5 3.5 3.5 3.5-3.5'}))),
    !complete&&h('div',{className:'qc-progress-track',role:'progressbar','aria-label':'Завершённые задачи','aria-valuemin':0,'aria-valuemax':todos.length,'aria-valuenow':done},h('span',{style:{width:percent+'%'}})),
    open&&h('ol',{className:'qc-task-list'},todos.map((item,index)=>h('li',{key:index,'data-status':item.status},
      h('span',{className:'qc-task-number','aria-hidden':true},item.status==='completed'?'✓':item.status==='in_progress'?'◌':String(index+1).padStart(2,'0')),
      h('span',{className:'qc-task-text'},item.content),h('small',null,item.status==='completed'?'Готово':item.status==='in_progress'?'В работе':'Ожидает'))))
  );
}
