function qcReportDocument(html) {
  const csp = "default-src 'none'; base-uri 'none'; connect-src 'none'; form-action 'none'; frame-src 'none'; img-src data: blob:; media-src data: blob:; object-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; worker-src 'none'";
  const css = [
    ':root{color-scheme:dark;scrollbar-width:thin;scrollbar-color:#6b557e #181422}',
    'body{box-sizing:border-box;margin:0;padding:clamp(14px,3vw,24px);font:14px/1.6 "Segoe UI",system-ui,sans-serif;background:#181422;color:#eee8f6;overflow-wrap:anywhere}',
    ':where(h1){font-size:clamp(18px,3.2vw,23px);line-height:1.25;margin:0 0 12px;letter-spacing:-.02em}',
    ':where(h2){font-size:16px;line-height:1.35}',
    ':where(p){margin:0 0 12px}',
    ':where(img,video,canvas,svg){max-width:100%}',
    ':where(pre){overflow:auto}',
    ':where(button,input,select){font:inherit}',
    ':where(button,summary){cursor:pointer}',
    ':where(button):focus-visible,:where(summary):focus-visible{outline:2px solid #c6a0ee;outline-offset:2px}',
    ':where(button){border:1px solid #76608b;border-radius:8px;background:#2f2541;color:#f5edff;padding:6px 11px}',
    ':where(button[aria-pressed=true],button.on){background:#694b87}',
    ':where(table){border-collapse:collapse;width:100%}',
    ':where(td,th){padding:7px 10px;border-bottom:1px solid #463752;text-align:left}',
    'body.qc-report-cards{padding:clamp(16px,3vw,30px);font:14px/1.6 "Segoe UI",system-ui,sans-serif;color:#eee9f7;background:radial-gradient(ellipse at 17% 0%,#292035 0%,transparent 65%),#181422}',
    '.qc-report-cards>h1{max-width:46ch;font-size:clamp(20px,3.45vw,28px);font-weight:650;line-height:1.22;margin:0 0 10px;letter-spacing:-.024em}',
    '.qc-report-cards>p{max-width:74ch;color:#c0b4ce;margin:0 0 18px}',
    '.qc-report-cards>button{border:1px solid #594867;background:#241d30;color:#ded1eb;border-radius:100px;padding:5px 13px;min-height:34px;margin:0 4px 5px 0;font-weight:550}',
    '.qc-report-cards>button:hover{border-color:#a482bc;background:#342945}',
    '.qc-report-cards>button:is(.on,[aria-pressed=true]){border-color:#9c75b9;background:#513963;color:#faf1ff}',
    'body.qc-report-cards>.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:12px;margin-top:12px;padding-top:16px;border-top:1px solid #b698cf26}',
    '.qc-report-cards>.grid>article[data-kind]{--qc-report-accent:#ad9ec4;box-sizing:border-box;min-width:0;padding:13px 15px;border:1px solid #584664;border-radius:11px;background:linear-gradient(150deg,#282033,#211a2c);box-shadow:0 2px 8px #120d1a48}',
    '.qc-report-cards>.grid>article[data-kind="done"]{--qc-report-accent:#a3d6be}',
    '.qc-report-cards>.grid>article:is([data-kind="limit"],[data-kind="limits"]){--qc-report-accent:#ebcb9d}',
    '.qc-report-cards>.grid>article h2{display:flex;align-items:baseline;gap:8px;margin:0 0 8px;color:var(--qc-report-accent);font-size:15px;font-weight:650;line-height:1.4}',
    '.qc-report-cards>.grid>article h2::before{content:"";flex:0 0 5px;height:5px;border-radius:50%;align-self:start;margin-top:.65em;background:currentColor}',
    '.qc-report-cards>.grid>article ul{margin:0;padding-inline-start:17px}',
    '.qc-report-cards>.grid>article li+li{margin-top:3px}',
    '.qc-report-cards>.grid>article li::marker{color:#a895bd}',
    '.qc-report-cards>.grid>article .small{margin:10px 0 0;padding-top:8px;border-top:1px solid #b698cf26;color:#c2b3cf;font-size:12px;line-height:1.5}',
  ].join('');
  const script = '(' + function () {
    let last = 0;
    const sendSize = () => {
      const bounds = document.body.getBoundingClientRect();
      const height = Math.ceil(bounds.height + 2 * Math.max(0, bounds.top));
      if (height > 0 && height !== last) {
        last = height;
        parent.postMessage({type:'qcoderi-report-size', height}, '*');
      }
    };
    const watch = () => {
      if (document.body.querySelector(':scope > .grid > article[data-kind]') &&
          document.body.querySelector(':scope > h1')) document.body.classList.add('qc-report-cards');
      new ResizeObserver(sendSize).observe(document.body);
      sendSize();
    };
    addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.defaultPrevented) parent.postMessage({type:'qcoderi-report-escape'}, '*');
    });
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', watch, {once:true});
    else watch();
  }.toString() + ')();';
  return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + csp +
    '"><meta name="viewport" content="width=device-width, initial-scale=1"><style>' + css + '</style><script>' + script +
    '</script></head><body>' + html + '</body></html>';
}

function QcReportView({ title, html, workbench = false }) {
  const h = react.createElement;
  const frame = react.useRef(null);
  const shell = react.useRef(null);
  const toggle = react.useRef(null);
  const [height, setHeight] = react.useState(310);
  const [expanded, setExpanded] = react.useState(false);
  const documentHtml = react.useMemo(() => qcReportDocument(html), [html]);
  const hasHeading = /<h1(?:\s|>)/i.test(html);

  const resizeDialog = next => {
    const dialog = shell.current;
    if (!dialog) return;
    dialog.close();
    if (next) dialog.showModal();
    else dialog.show();
    setExpanded(next);
    toggle.current?.focus({ preventScroll: true });
  };
  react.useLayoutEffect(() => {
    const receive = event => {
      if (!frame.current || event.source !== frame.current.contentWindow || event.origin !== 'null') return;
      if (event.data?.type === 'qcoderi-report-escape' && shell.current?.matches(':modal')) resizeDialog(false);
      if (event.data?.type === 'qcoderi-report-size' && Number.isFinite(event.data.height)) {
        setHeight(Math.min(20000, Math.max(90, event.data.height)));
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);
  return h('dialog', {
    ref: shell, open: true, className: 'qc-report' + (workbench ? ' qc-report-workbench' : ''),
    'aria-label': title || 'Интерактивный отчёт', 'data-qc-report': '',
    onCancel: event => { event.preventDefault(); if (expanded) resizeDialog(false); },
    onClick: event => {
      if (!expanded || event.target !== shell.current) return;
      const bounds = shell.current.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right ||
          event.clientY < bounds.top || event.clientY > bounds.bottom) resizeDialog(false);
    },
  },
  h('header', { className: 'qc-report-bar' },
    h('svg', { className:'qc-report-mark', width:16,height:16,viewBox:'0 0 24 24',fill:'none',
      stroke:'currentColor',strokeWidth:1.6,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true },
    h('path',{d:'M13.5 3.5H6.75A1.75 1.75 0 0 0 5 5.25v13.5a1.75 1.75 0 0 0 1.75 1.75h10.5A1.75 1.75 0 0 0 19 18.75V9m-5.5-5.5L19 9m-5.5-5.5V8A1 1 0 0 0 14.5 9H19M9 13h6m-6 3.5h5'})),
    h('strong', null, hasHeading ? 'Интерактивный отчёт' : title || 'Интерактивный отчёт'),
    h('button', {
      ref: toggle, type: 'button', className: 'qc-report-toggle',
      'aria-label': expanded ? 'Закрыть развёрнутый отчёт' : 'Развернуть отчёт',
      title: expanded ? 'Закрыть · Esc' : 'Развернуть отчёт',
      onClick: () => resizeDialog(!expanded),
    }, h('svg', { width:16,height:16,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.7,
      strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true },
    h('path',{d:expanded?'m6 6 12 12M18 6 6 18':'M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5'})),
    !expanded && h('span', null, 'Развернуть'))),
  h('iframe', {
    ref: frame, name:'qcoderi-report', title: title || 'Интерактивный отчёт',
    sandbox:'allow-scripts', referrerPolicy:'no-referrer', srcDoc:documentHtml,
    style:{'--qc-report-height':height+'px'},
  }));
}
