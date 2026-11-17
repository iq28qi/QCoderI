// QCODERI_IMAGE_GALLERY_BEGIN
function ImageGallery({ images, load, align, compact = false, labels }) {
  const [opened, setOpened] = react.useState(null);
  const close = react.useCallback(() => setOpened(null), []);
  const opener = react.useRef(null);
  const sequence = react.useRef(0);
  const show = async (index, element) => {
    if (element) opener.current = element;
    const ticket = ++sequence.current;
    const image = images[index];
    try {
      const src = image.preview?.url ?? await load(image.attachment);
      if (ticket === sequence.current) setOpened({index,src});
    } catch {}
  };
  const dismiss = react.useCallback(() => {
    ++sequence.current;
    close();
    requestAnimationFrame(() => opener.current?.focus());
  }, [close]);
  if (!images.length) return null;
  const variant = compact || images.length > 1 ? 'tile' : 'single';
  const tiles = images.map((image,index) => {
    const caption = image.attachment?.name ?? image.preview?.name ?? labels.image;
    const key = `${image.attachment?.attachmentId ?? image.preview?.url}:${index}`;
    if (!compact) return react_jsx_runtime.jsx(MessageImage,{image,load,variant,labels},key);
    return react_jsx_runtime.jsxs('span',{
      className:'qc-photo-cell',
      onClickCapture:event=>{
        const button=event.target.closest('button');
        if(!button?.querySelector('img'))return;
        event.stopPropagation();
        void show(index,button);
      },
      children:[
        react_jsx_runtime.jsx(MessageImage,{image,load,variant,labels:{...labels,open:caption}}),
        react_jsx_runtime.jsx('span',{className:'qc-photo-tooltip','aria-hidden':true,children:caption}),
      ],
    },key);
  });
  const active=opened && images[opened.index];
  const caption=active?.attachment?.name ?? active?.preview?.name ?? labels.image;
  const onKeyDown=event=>{
      if(event.key==='Escape')dismiss();
      if(event.key==='ArrowLeft'&&opened.index>0){event.preventDefault();void show(opened.index-1);}
      if(event.key==='ArrowRight'&&opened.index+1<images.length){event.preventDefault();void show(opened.index+1);}
  };
  const controls=active ? react_jsx_runtime.jsxs(react_jsx_runtime.Fragment,{
    children:[
      react_jsx_runtime.jsx(ImageLightbox,{src:opened.src,alt:caption,labels:labels.lightbox,onClose:dismiss}),
      react_dom.createPortal(react_jsx_runtime.jsxs('div',{
        className:'qc-photo-viewer-controls',
        children:[
          opened.index>0 && react_jsx_runtime.jsx('button',{className:'qc-photo-viewer-nav','data-side':'prev','aria-label':'Предыдущее изображение',onClick:()=>void show(opened.index-1),children:'‹'}),
          opened.index+1<images.length && react_jsx_runtime.jsx('button',{className:'qc-photo-viewer-nav','data-side':'next','aria-label':'Следующее изображение',onClick:()=>void show(opened.index+1),children:'›'}),
          react_jsx_runtime.jsx('div',{className:'qc-photo-viewer-caption',children:caption}),
        ],
      }),document.body),
    ],
  }) : null;
  return react_jsx_runtime.jsxs('div',{className:MessageImage_module_css_default.gallery,'data-align':align,
    onKeyDown:active?onKeyDown:undefined,children:[...tiles,controls]});
}
// QCODERI_IMAGE_GALLERY_END
