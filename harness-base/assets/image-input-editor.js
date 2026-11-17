// QCODERI_IMAGE_INPUT_EDITOR_BEGIN
function QcImageInputEditor({model,index,disabled,onChange}) {
  const input=Array.isArray(model.input) && model.input.length ? model.input : undefined;
  const value=input===undefined?'auto':input.includes('image')?'image':'text';
  return (0,react_jsx_runtime.jsxs)('label',{
    className:ModelsSection_module_css_default.modelField,
    children:[
      (0,react_jsx_runtime.jsx)('span',{className:ModelsSection_module_css_default.modelFieldLabel,children:'Поддержка изображений'}),
      (0,react_jsx_runtime.jsxs)('select',{
        className:ModelsSection_module_css_default.input,
        'aria-label':`Поддержка изображений ${index+1}`,value,disabled,
        onChange:event=>onChange({input:event.target.value==='auto'?undefined:event.target.value==='image'?['text','image']:['text']}),
        children:[
          (0,react_jsx_runtime.jsx)('option',{value:'auto',children:'Авто — каталог модели и API'}),
          (0,react_jsx_runtime.jsx)('option',{value:'image',children:'Текст и изображения'}),
          (0,react_jsx_runtime.jsx)('option',{value:'text',children:'Только текст'}),
        ],
      }),
      (0,react_jsx_runtime.jsx)('span',{style:{fontSize:'12px',opacity:.7},children:'Явный выбор имеет приоритет над каталогом API. Используйте его, если провайдер неверно описывает модель.'}),
    ],
  });
}
// QCODERI_IMAGE_INPUT_EDITOR_END
