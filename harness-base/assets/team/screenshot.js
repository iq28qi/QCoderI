import {defineTool} from '@deepseek-ai/dsh-tools';
import {captureScreen,validateCapture} from './screen-capture.js';

export const name='qcoderi-screenshot';
export const inject=['tools','attachments','systemPrompt'];
const integer={type:'integer',required:true};
const imageSchema={type:'object',additionalProperties:false,required:true,properties:{
  attachmentId:{type:'string',required:true},mediaType:{type:'string',required:true},bytes:integer,width:integer,height:integer,name:{type:'string'},
  originalDimensions:{type:'object',additionalProperties:false,properties:{width:integer,height:integer}},
}};

export function installScreenshot(ctx,{capture=captureScreen}={}) {
  ctx.systemPrompt.section({name:'qcoderi:screenshots',order:95,interpolate:false,
    text:({agent})=>agent.session.header.cwd ? 'Сам решай, когда пользователю полезно увидеть результат. Если работа меняет видимый интерфейс, сцену, страницу, график или другую визуальную часть, открой именно этот результат, проверь его через take_screenshot и приложи удачный кадр до итогового ответа. Не жди отдельной команды «сделай скриншот» и не спрашивай разрешение на обычный демонстрационный снимок в рамках текущей задачи. Если нужно наглядно объяснить обнаруженную проблему или показать состояние работы, тоже самостоятельно используй take_screenshot. Снимай нужное окно или область и подписывай, что демонстрируешь; не выдавай снимок самого QCoderI за результат другого приложения. Инструмент сразу показывает изображение в чате. Для чисто текстовых и серверных задач без видимого результата снимок не нужен. Создаваемые иллюстрации и фотографии делай через generate_image; они не заменяют настоящий скриншот проверки. Захват разовый: каждый вызов создаёт новый кадр.' : '',
  });
  ctx.tools.register(defineTool({
    name:'take_screenshot',
    description:'Proactively take one real Windows desktop screenshot to demonstrate or verify a visual result during the current task. Do not wait for the user to request a screenshot: use it yourself when showing a changed UI, scene, page, chart or visual issue is useful. Show the actual relevant result, not an unrelated window. Use target="window" (or active_window with window) to capture a specific window (including background-desktop apps) directly without stealing focus. Coordinates are absolute desktop pixels; all four crop fields must be supplied together. Images remain in conversation history.',
    parameters:{
      target:{type:'string',enum:['primary','all','active_window','window'],description:'Capture target; default primary (or window if window ID is given).'},
      window:{type:'string',description:'Optional window ID. Captures that exact window directly (on user or background desktop) without requiring foreground focus.'},
      x:{type:'integer',description:'Absolute left coordinate; supply all four crop values together.'},
      y:{type:'integer',description:'Absolute top coordinate.'},
      width:{type:'integer',description:'Crop width, 1–8192 pixels.'},
      height:{type:'integer',description:'Crop height, 1–8192 pixels.'},
      delay_ms:{type:'integer',description:'Wait for rendering before capture, 0–3000 ms; default 0.'},
      caption:{type:'string',description:'Short caption describing what is being checked.'},
    },
    output:{schema:{type:'object',additionalProperties:false,properties:{
      image:imageSchema,caption:{type:'string',required:true},target:{type:'string',required:true},captured_at:{type:'string',required:true},
      bounds:{type:'object',additionalProperties:false,required:true,properties:{x:integer,y:integer,width:integer,height:integer}},
    }},render:(_args,value)=>[
      {type:'text',text:`${value.caption}\nСнимок экрана: ${value.bounds.width}×${value.bounds.height} px; начало (${value.bounds.x}, ${value.bounds.y}); ${value.captured_at}.`},
      {type:'image',attachment:value.image},
    ]},
    isConcurrencySafe:()=>false,
    async execute(args,exec) {
      if(!exec.agent?.session.header.cwd)throw Error('Снимки экрана доступны в режиме «Проекты»');
      const request=validateCapture(args);
      if(args.caption!==undefined && (typeof args.caption!=='string'||args.caption.length>240))throw Error('Подпись снимка: не более 240 символов');
      exec.signal.throwIfAborted();
      const result=await capture(request,exec.signal);
      exec.signal.throwIfAborted();
      const image=await ctx.attachments.saveImage({data:result.data,mediaType:'image/png',name:`QCoderI-screenshot-${result.captured_at.replace(/[^0-9TZ]/g,'')}.png`});
      exec.signal.throwIfAborted();
      return {image,caption:args.caption?.trim() || 'Снимок экрана',target:result.target,bounds:result.bounds,captured_at:result.captured_at};
    },
  }));
}
export function apply(ctx){installScreenshot(ctx);}
