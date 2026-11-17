import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access,readFile,writeFile,mkdir,mkdtemp,readdir,realpath,stat} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,extname,basename} from 'node:path';
import {normalizeAssetSpecification} from './asset-specification.js';
import {buildAssetQualityReport,fingerprintArtifact} from './asset-quality.js';
const run=promisify(execFile);
export async function findBlender(executable){
  if(executable){await access(executable);return resolve(executable);}
  const candidates=[process.env.BLENDER_EXECUTABLE,'G:/Blender/blender.exe'];
  for(const root of [join(process.env.ProgramFiles??'C:/Program Files','Blender Foundation'),'G:/Blender']){
    try{for(const entry of (await readdir(root,{withFileTypes:true})).filter(e=>e.isDirectory()).sort((a,b)=>b.name.localeCompare(a.name,undefined,{numeric:true})))candidates.push(join(root,entry.name,'blender.exe'));}catch{}
  }
  for(const candidate of candidates.filter(Boolean)){try{await access(candidate);return resolve(candidate);}catch{}}
  try{const {stdout}=await run('where.exe',['blender.exe'],{windowsHide:true,timeout:3000});return stdout.trim().split(/\r?\n/)[0];}catch{return undefined;}
}
export async function workspaceFile(cwd,path,extension){
  const root=await realpath(cwd),file=await realpath(resolve(root,path));
  const rel=relative(root,file);
  if(isAbsolute(rel)||rel==='..'||rel.startsWith('..\\')||rel.startsWith('../'))throw Error('Файл должен находиться внутри выбранного проекта');
  if(extension&&extname(file).toLowerCase()!==extension)throw Error('Нужен файл '+extension);
  return file;
}
export async function blenderStatus(executable){
  const path=await findBlender(executable);if(!path)return {installed:false,message:'Укажите полный путь blender.exe; автоматическая установка не выполняется'};
  const {stdout}=await run(path,['--version'],{windowsHide:true,timeout:15000,maxBuffer:50000});
  return {installed:true,executable:path,version:stdout.split(/\r?\n/)[0]};
}
export async function prepareBlender(cwd,args,{reviewService}={}){
  // Validate before discovery/output creation; specifications never execute code.
  const specification=normalizeAssetSpecification(args.asset_specification);
  const executable=await findBlender(args.executable);if(!executable)throw Error('Blender не найден; передайте executable — путь к blender.exe');
  const script=args.script_file?await workspaceFile(cwd,args.script_file,'.py'):undefined;
  const blend=args.blend_file?await workspaceFile(cwd,args.blend_file,'.blend'):undefined;
  if(!script&&!blend)throw Error('Нужен script_file для создания или blend_file для инспекции');
  const timeout=args.timeout_seconds??600;if(!Number.isInteger(timeout)||timeout<10||timeout>1800)throw Error('timeout_seconds: от 10 до 1800');
  if(args.views!==undefined&&typeof args.views!=='boolean')throw Error('views: true или false');
  const frames = args.frames ?? [];
  if (!Array.isArray(frames) || frames.length > 8 || frames.some(frame => !Number.isInteger(frame) || Math.abs(frame) > 1048574)) {
    throw Error('frames: до восьми целых номеров кадров Blender');
  }
  const parent=join(await realpath(cwd),'QCoderI-3D');await mkdir(parent,{recursive:true});
  await workspaceFile(cwd,parent);
  const out=await mkdtemp(join(parent,'run-'));const helper=join(out,'qcoderi_quality.py');
  await writeFile(helper,await readFile(new URL('./blender-quality.py',import.meta.url)));
  const report=join(out,'inspection.json'),scene=join(out,'scene.blend'),image=join(out,'render.png'),wrapper=join(out,'run.py');
  const specificationFile=join(out,'asset-specification.json'),quality=join(out,'quality.json'),evidenceFile=join(out,'evidence.json');
  await writeFile(specificationFile,JSON.stringify(specification,null,2),'utf8');
  // Archive the script bytes. Execute at its original path to preserve __file__
  // and imports; compare input hashes after the job to detect concurrent edits.
  const scriptSnapshot=script?join(out,'project-script.py'):undefined;
  if(script)await writeFile(scriptSnapshot,await readFile(script));
  const inputs=await Promise.all([scriptSnapshot&&[scriptSnapshot,'input_script'],blend&&[blend,'input_blend']].filter(Boolean).map(([path,kind])=>fingerprintArtifact(path,kind)));
  const body=`import bpy, json, runpy, sys\nfrom pathlib import Path\nsys.path.insert(0, ${JSON.stringify(out)})\nimport qcoderi_quality as qc\nspecification=json.loads(Path(${JSON.stringify(specificationFile)}).read_text(encoding='utf8'))\n`+
    (script?`runpy.run_path(${JSON.stringify(script)}, init_globals={'bpy':bpy,'qc':qc,'QC_OUTPUT_DIR':${JSON.stringify(out)}}, run_name='__main__')\n`:'')+
    (args.render||args.views?`if not bpy.context.scene.camera: qc.studio()\n`:'')+
    `report=qc.audit(specification)\nreport['run']={'run_id':${JSON.stringify(basename(out))},'scene':${JSON.stringify(scene)}}\nPath(${JSON.stringify(report)}).write_text(json.dumps(report,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf8')\n`+
    // Save the inspected scene too: automatic studio setup may have changed it.
    // The loaded source remains untouched; evidence always names this snapshot.
    `bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(scene)})\n`+
    (args.render||args.views?`bpy.context.scene.render.image_settings.file_format='PNG'\nbpy.context.scene.render.filepath=${JSON.stringify(image)}\nbpy.ops.render.render(write_still=True)\n`:'')+
    (args.views?`views=qc.render_views(${JSON.stringify(out)})\nPath(${JSON.stringify(join(out,'views.json'))}).write_text(json.dumps(views),encoding='utf8')\n`:'')+
    (frames.length ? `frames=qc.render_frames(${JSON.stringify(out)}, ${JSON.stringify([...new Set(frames)])})\nPath(${JSON.stringify(join(out,'frames.json'))}).write_text(json.dumps(frames),encoding='utf8')\n` : '');
  await writeFile(wrapper,body,'utf8');
  const prepared={executable,args:['--background','--factory-startup','--disable-autoexec',...blend?[blend]:[],'--python-exit-code','1','--python',wrapper],cwd,timeout:timeout*1000,out,report,scene,createdScene:scene,image:args.render||args.views?image:undefined,views:args.views===true,frames:[...new Set(frames)],specification,specificationFile,quality,evidenceFile,inputs,script,scriptSnapshot,blend,wrapper,helper,runId:basename(out)};
  // Even a crash/cancellation leaves a pending report tied to this run.
  await writeFile(quality,JSON.stringify(buildAssetQualityReport({specification,run:{run_id:prepared.runId,scene:prepared.scene},evidence:inputs}),null,2),'utf8');
  await writeFile(evidenceFile,JSON.stringify({schema_version:1,run_id:prepared.runId,status:'pending',artifacts:inputs},null,2),'utf8');
  // Host dependency, not a model-supplied tool argument. Default authority uses
  // DSH_HOME outside the project; no paid/model work happens during sealing.
  prepared.reviewService=reviewService;
  return prepared;
}
async function verifyBlenderOutput(prepared,report,views,frames){
  if(!Array.isArray(report?.objects)||!Array.isArray(report?.warnings)||typeof report?.blender!=='string')return 'Отсутствует корректный inspection.json';
  const required=[prepared.createdScene,prepared.image].filter(Boolean);
  if(prepared.views){
    const names=['front','side','back'];
    if(!Array.isArray(views)||views.length!==names.length||!names.every(name=>views.some(view=>view.path===join(prepared.out,`render-${name}.png`))))return 'Неполный набор контрольных ракурсов';
    required.push(...views.map(view=>view.path));
  }
  if(prepared.frames?.length){
    if(!Array.isArray(frames)||frames.length!==prepared.frames.length||!prepared.frames.every(frame=>
      frames.some(item=>item.frame===frame&&item.path===join(prepared.out,`frame-${frame}.png`))))return 'Неполный набор кадров анимации';
    required.push(...frames.map(frame=>frame.path));
  }
  const missing=await Promise.all(required.map(async file=>{
    try{const info=await stat(file);if(info.isFile()&&info.size>0)return undefined;}
    catch{}
    return file;
  }));
  return missing.every(file=>file===undefined)?undefined:`Blender не записал ожидаемые файлы: ${missing.filter(Boolean).join(', ')}`;
}
/** Persist independent process/evidence/quality records. Quality failure does not
 * change legacy job completion: it is returned explicitly in quality.status. */
async function persistQuality(prepared,{report,processStatus,verificationError,code,expired,log}){
  const paths=[[prepared.scene,'scene'],[prepared.report,'inspection'],[prepared.specificationFile,'specification'],
    [prepared.wrapper,'wrapper'],[prepared.helper,'audit_helper']];
  if(prepared.image)paths.push([prepared.image,'render']);
  if(prepared.views)for(const name of ['front','side','back'])paths.push([join(prepared.out,`render-${name}.png`),'view']);
  for(const frame of prepared.frames??[])paths.push([join(prepared.out,`frame-${frame}.png`),'frame']);
  if(prepared.views)paths.push([join(prepared.out,'views.json'),'views_manifest']);
  if(prepared.frames?.length)paths.push([join(prepared.out,'frames.json'),'frames_manifest']);
  const artifacts=await Promise.all(paths.filter(([path])=>path).map(([path,kind])=>fingerprintArtifact(path,kind)));
  for(const input of prepared.inputs??[]){
    artifacts.push(input);
    const original=input.kind==='input_script'?prepared.script:prepared.blend;
    const current=await fingerprintArtifact(original,input.kind+'_after');
    if(current.sha256!==input.sha256||current.status!=='pass')artifacts.push({...current,status:'fail',reason:'input_changed_during_run'});
  }
  const run={run_id:prepared.runId,scene:prepared.scene,inspection:prepared.report,process_status:processStatus,
    exit_code:code,timed_out:expired,verification_error:verificationError};
  // inspection.run binds the measured frame to the saved scene, not a prior run.
  if(report&&(report.run?.run_id!==prepared.runId||report.run?.scene!==prepared.scene))run.verification_error='inspection.json run/scene binding mismatch';
  let quality=buildAssetQualityReport({specification:prepared.specification,inspection:report,run,evidence:artifacts});
  await writeFile(prepared.evidenceFile,JSON.stringify({schema_version:1,...run,artifacts},null,2),'utf8');
  await writeFile(prepared.quality,JSON.stringify(quality,null,2),'utf8');
  await writeFile(join(prepared.out,'blender.log'),log,'utf8');
  await writeFile(join(prepared.out,'run.json'),JSON.stringify({...run,executable:prepared.executable,args:prepared.args,
    specification:prepared.specificationFile,quality:prepared.quality,evidence:prepared.evidenceFile,log:'blender.log',log_tail_only:true},null,2),'utf8');
  if(processStatus==='completed' && !run.verification_error && artifacts.every(a=>a.status==='pass')) {
    try {
      const service=prepared.reviewService??await (await import('./asset-reviews.js')).createAssetReviewService({cwd:prepared.cwd});
      await service.sealRun({run_directory:prepared.out});
    } catch(error) {
      // A usable legacy job is not an accepted asset if the authority cannot seal.
      run.verification_error='Host run sealing failed: '+error.message;
      quality=buildAssetQualityReport({specification:prepared.specification,inspection:report,run,evidence:artifacts});
      await writeFile(prepared.quality,JSON.stringify(quality,null,2),'utf8');
    }
  }
  return quality;
}
export function startBlender(prepared){
  const child=spawn(prepared.executable,prepared.args,{cwd:prepared.cwd,windowsHide:true,stdio:['ignore','pipe','pipe'],shell:false});
  let log='',stopping=false,expired=false,settledOutput,spawnError;
  const append=data=>{log=(log+data.toString()).slice(-24000);};child.stdout.on('data',append);child.stderr.on('data',append);
  const cancel=()=>{stopping=true;if(child.pid&&process.platform==='win32'){const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.on('error',()=>child.kill());}else child.kill('SIGTERM');};
  let timer;
  const done=new Promise(resolveDone=>{
    child.once('error',error=>{spawnError=error.message;append(error.message);});
    child.once('close',async code=>{
      clearTimeout(timer);let report,views,frames;
      try{report=JSON.parse(await readFile(prepared.report,'utf8'));}catch{}
      try{views=JSON.parse(await readFile(join(prepared.out,'views.json'),'utf8'));}catch{}
      try{frames=JSON.parse(await readFile(join(prepared.out,'frames.json'),'utf8'));}catch{}
      let verificationError,quality,qualityError;
      try{verificationError=spawnError??(code===0&&!stopping?await verifyBlenderOutput(prepared,report,views,frames):undefined);}
      catch(error){verificationError=error.message;}
      let status=stopping?'killed':code===0&&!verificationError?'completed':'failed';
      try{quality=await persistQuality(prepared,{report,processStatus:status,verificationError,code,expired,log});}
      catch(error){qualityError=error.message;if(status==='completed')status='failed';}
      settledOutput=JSON.stringify({exit_code:code,timed_out:expired,output_directory:prepared.out,scene:prepared.scene,render:prepared.image,views,frames,report,quality,quality_report:prepared.quality,evidence:prepared.evidenceFile,quality_error:qualityError,verification_error:verificationError,log});
      resolveDone({status,output:settledOutput});
    });
    timer=setTimeout(()=>{expired=true;cancel();},prepared.timeout);
  });
  return {done,readOutput:()=>settledOutput??log,cancel};
}
