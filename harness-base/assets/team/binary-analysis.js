import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, openSync, closeSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, dirname, delimiter } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { requireProject } from './desktop.js';
import { workspaceFile } from './blender-runner.js';

export const name = 'qcoderi-binary-analysis';
export const inject = ['jobs', 'tools', 'systemPrompt'];
const idaNames = ['idat.exe', 'idat64.exe'];
const ghidraJar = join('Ghidra', 'Framework', 'Utility', 'lib', 'Utility.jar');
const ghidraReportName = 'QCoderIGhidraReport.java';
const idaReportName = 'qcoderi-ida-report.py';
const ghidraReport = new URL('./' + ghidraReportName, import.meta.url);
const idaReport = new URL('./' + idaReportName, import.meta.url);

// ── query contract ──────────────────────────────────────────────────────────
// The scripts receive this object as JSON in QCODERI_ANALYSIS_QUERY and return
// bounded evidence for it. Bounds keep a single report readable and keep an
// accidental "match everything" request from stalling the analyzer.
const QUERY_BOUNDS = {matches: [1, 16, 4], instruction_limit: [1, 1024, 128],
  callgraph_depth: [0, 3, 0], string_limit: [1, 256, 32]};

function queryString(query, key) {
  const value = query[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw Error(`query.${key}: нужна непустая строка`);
  const text = value.trim();
  if (text.length > 256) throw Error(`query.${key}: не более 256 символов`);
  if (text.includes('\0')) throw Error(`query.${key}: недопустимый нулевой символ`);
  return text;
}

function normalizeQuery(value, legacyName) {
  if (value === undefined && legacyName === undefined) return undefined;
  if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    throw Error('query: нужен объект с параметрами запроса');
  }
  const query = {...(value ?? {})};
  if (legacyName !== undefined && query.function_name === undefined) query.function_name = legacyName;
  const unknown = Object.keys(query).filter(key => !['function_name', 'name_query', 'regex', 'address',
    'address_is_offset', 'decompile', 'xrefs', 'callgraph_depth', 'instruction_limit', 'strings_query',
    'string_limit', 'matches'].includes(key));
  if (unknown.length) throw Error('query: неизвестные поля ' + unknown.join(', '));
  const result = {};
  for (const key of ['function_name', 'name_query', 'address', 'strings_query']) {
    const text = queryString(query, key);
    if (text === undefined) continue;
    if (key === 'address' && !/^(0x)?[0-9a-f]+$/i.test(text)) throw Error('query.address: нужен шестнадцатеричный адрес');
    if (key === 'address' && text.length > 32) throw Error('query.address: адрес слишком длинный');
    result[key] = text;
  }
  for (const key of ['regex', 'address_is_offset', 'decompile', 'xrefs']) {
    if (query[key] === undefined) continue;
    if (typeof query[key] !== 'boolean') throw Error(`query.${key}: true или false`);
    result[key] = query[key];
  }
  for (const [key, [min, max]] of Object.entries(QUERY_BOUNDS)) {
    if (query[key] === undefined) continue;
    const number = query[key];
    if (!Number.isInteger(number) || number < min || number > max) throw Error(`query.${key}: от ${min} до ${max}`);
    result[key] = number;
  }
  if (result.regex && !result.name_query) throw Error('query.regex требует query.name_query');
  if (!result.function_name && !result.name_query && !result.address && !result.strings_query) {
    throw Error('query: укажите function_name, name_query, address или strings_query');
  }
  return result;
}

async function firstFile(paths) {
  for (const path of paths.filter(Boolean)) {
    if ((await stat(path).catch(() => null))?.isFile()) return realpath(path);
  }
}

async function matchingDirectories(root, filter) {
  if (!root) return [];
  const entries = await readdir(root, {withFileTypes: true}).catch(() => []);
  return entries.filter(entry => entry.isDirectory() && filter(entry.name))
    .sort((a, b) => b.name.localeCompare(a.name, undefined, {numeric: true}))
    .map(entry => join(root, entry.name));
}

/** Run a short probe with file-backed stdio; pipes are unavailable in some sandboxes. */
async function capture(executable, argv, timeout = 15000) {
  const directory = await mkdtemp(join(tmpdir(), 'qcoderi-probe-'));
  const stdoutFile = join(directory, 'stdout.txt');
  const stderrFile = join(directory, 'stderr.txt');
  const out = openSync(stdoutFile, 'w');
  const err = openSync(stderrFile, 'w');
  let child;
  try {
    child = spawn(executable, argv, {windowsHide:true, shell:false, stdio:['ignore', out, err]});
  } finally { closeSync(out); closeSync(err); }
  const timer = setTimeout(() => child.kill(), timeout);
  const result = await new Promise(resolveRun => {
    child.once('error', error => resolveRun({code:null, error:error.message}));
    child.once('close', code => resolveRun({code}));
  });
  clearTimeout(timer);
  const stdout = await readFile(stdoutFile, 'utf8').catch(() => '');
  const stderr = await readFile(stderrFile, 'utf8').catch(() => '');
  await rm(directory, {recursive:true, force:true, maxRetries:2}).catch(() => {});
  return {...result, stdout, stderr};
}

async function findEngine(engine, install, javaHome, signal) {
  signal?.throwIfAborted();
  const programFiles = process.env.ProgramFiles;
  const pathDirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  if (engine === 'ida') {
    const candidates = install
      ? (idaNames.includes(basename(install).toLowerCase()) ? [install] : idaNames.map(name => join(install, name)))
      : [process.env.QCODERI_IDAT, ...[process.env.IDA_HOME, ...pathDirs,
        ...await matchingDirectories(programFiles, name => /^ida|^hex-rays/i.test(name))]
        .filter(Boolean).flatMap(directory => idaNames.map(name => join(directory, name)))];
    const executable = await firstFile(candidates);
    if (!executable || !idaNames.includes(basename(executable).toLowerCase())) {
      return {engine, available: false, message: 'Укажите папку IDA или путь к idat.exe / idat64.exe с IDAPython.'};
    }
    return {engine, available: true, executable};
  }
  const roots = install ? [install] : [
    process.env.QCODERI_GHIDRA_HOME, process.env.GHIDRA_HOME,
    ...await matchingDirectories(programFiles, name => /^ghidra/i.test(name)),
    ...await matchingDirectories('G:/сканерDllExe', name => /^ghidra_/i.test(name)),
    ...await matchingDirectories('D:/reverse-tools', name => /^ghidra_/i.test(name)),
  ];
  const utility = await firstFile(roots.filter(Boolean).map(root => join(root, ghidraJar)));
  if (!utility) return {engine, available: false, message: 'Укажите корневую папку Ghidra.'};
  const root = resolve(dirname(utility), '../../../..');
  const java = await firstFile(javaHome ? [join(javaHome, 'bin', 'java.exe')] : [
    ...await matchingDirectories(join(root, 'JLD'), name => /^jdk/i.test(name)).then(
      paths => paths.map(directory => join(directory, 'bin', 'java.exe'))),
    process.env.JAVA_HOME && join(process.env.JAVA_HOME, 'bin', 'java.exe'),
    ...pathDirs.map(directory => join(directory, 'java.exe')),
  ]);
  let detail = 'java.exe не найден в PATH, JAVA_HOME или JLD.';
  if (java) {
    const support = join(root, 'support', 'LaunchSupport.jar');
    const probe = await capture(java, ['-Dfile.encoding=UTF-8', '-cp', support, 'LaunchSupport', root, '-jdk_home']);
    signal?.throwIfAborted();
    const selectedHome = probe.code === 0
      ? probe.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).pop() : '';
    const executable = selectedHome && await firstFile([join(selectedHome, 'bin', 'java.exe')]);
    if (executable) return {engine, available: true, executable, root, utility};
    detail = (probe.stderr || probe.stdout || probe.error || 'LaunchSupport не подтвердил JDK').trim()
      .split(/\r?\n/).filter(Boolean).slice(-2).join(' ');
  }
  return {engine, available: false,
    message: 'Ghidra найдена. Укажите совместимый JDK через java_home. Проверка JDK: ' + detail};
}

function requestedEngine(value) {
  const engine = value ?? 'auto';
  if (!['auto', 'ghidra', 'ida'].includes(engine)) throw Error('engine: auto, ghidra или ida');
  return engine;
}

async function selectEngine(args, signal) {
  const engine = requestedEngine(args.engine);
  if (args.install && engine === 'auto') throw Error('При указании install выберите ghidra или ida.');
  const detected = [];
  for (const candidate of engine === 'auto' ? ['ghidra', 'ida'] : [engine]) {
    const status = await findEngine(candidate, args.install, args.java_home, signal);
    detected.push(status);
    if (status.available) return status;
  }
  throw Error(detected.map(status => status.message).join(' '));
}

function ghidraArgv(engine, projectLocation, projectName, report, scriptPath, extra = []) {
  return ['-Djava.system.class.loader=ghidra.GhidraClassLoader', '-Djava.awt.headless=true',
    '-Dfile.encoding=UTF-8', '-Xshare:off', '-Xmx2G', '-cp', engine.utility,
    'ghidra.Ghidra', 'ghidra.app.util.headless.AnalyzeHeadless', projectLocation, projectName,
    ...extra, '-scriptPath', scriptPath, '-postScript', ghidraReportName, report];
}

async function writeScripts(output) {
  await writeFile(join(output, ghidraReportName), await readFile(ghidraReport));
  await writeFile(join(output, idaReportName), await readFile(idaReport));
}

async function prepareAnalysis(cwd, args, signal) {
  const timeout = args.timeout_seconds ?? 300;
  if (!Number.isInteger(timeout) || timeout < 15 || timeout > 1800) throw Error('timeout_seconds: от 15 до 1800');
  const query = normalizeQuery(args.query, args.function_name);
  const input = await workspaceFile(cwd, args.file_path);
  const info = await stat(input);
  if (!info.isFile() || info.size === 0 || info.size > 512 * 1024 ** 2) throw Error('Нужен непустой файл до 512 МБ.');
  const engine = await selectEngine(args, signal);
  signal.throwIfAborted();
  const outputRoot = join(await realpath(cwd), 'QCoderI-Analysis');
  await mkdir(outputRoot, {recursive:true});
  await workspaceFile(cwd, outputRoot);
  const output = await mkdtemp(join(outputRoot, 'run-'));
  const inputs = join(output, 'input');
  await mkdir(inputs);
  const snapshot = join(inputs, basename(input));
  await copyFile(input, snapshot);
  const hash = createHash('sha256');
  const stream = createReadStream(snapshot, {signal});
  for await (const chunk of stream) hash.update(chunk);
  const report = join(output, 'analysis.json');
  const journal = join(output, 'run.json');
  const log = join(output, 'process.log');
  const metadata = {engine:engine.engine, executable:engine.executable, utility:engine.utility, root:engine.root,
    input, input_sha256:hash.digest('hex'), output, report, log, query};
  let argv;
  await writeScripts(output);
  if (engine.engine === 'ghidra') {
    const project = join(output, 'analysis.gpr');
    metadata.project = project;
    argv = ghidraArgv(engine, output, 'analysis', report, output, ['-import', snapshot,
      '-analysisTimeoutPerFile', String(timeout - 5)]);
  } else {
    metadata.project = join(output, 'analysis.i64');
    argv = ['-A', '-L' + join(output, 'ida.log'), '-o' + metadata.project, '-S"' + join(output, idaReportName) + '"', snapshot];
  }
  await writeFile(journal, JSON.stringify({...metadata, state:'prepared'}, null, 2));
  const env = {...process.env};
  if (query) env.QCODERI_ANALYSIS_QUERY = JSON.stringify(query);
  return {executable:engine.executable, argv, output, timeout, report, journal, log, metadata, query, env};
}

async function prepareQuery(cwd, args, signal) {
  const timeout = args.timeout_seconds ?? 300;
  if (!Number.isInteger(timeout) || timeout < 15 || timeout > 1800) throw Error('timeout_seconds: от 15 до 1800');
  const query = normalizeQuery(args.query, args.function_name);
  const target = await workspaceFile(cwd, args.analysis);
  const directory = (await stat(target)).isDirectory() ? target : dirname(target);
  const journalPath = join(directory, 'run.json');
  let saved;
  try { saved = JSON.parse(await readFile(journalPath, 'utf8')); }
  catch { throw Error('В каталоге нет run.json от binary_analyze: ' + directory); }
  if (saved.state !== 'completed') {
    throw Error(`База анализа не готова (${saved.state ?? 'без состояния'}). Дождитесь job_output или запустите binary_analyze.`);
  }
  const engineName = saved.engine;
  if (!['ghidra', 'ida'].includes(engineName) || !saved.project) throw Error('Журнал не содержит движок и базу анализа.');
  const detected = await findEngine(engineName, args.install, args.java_home, signal);
  if (!detected.available) throw Error(detected.message);
  signal.throwIfAborted();
  const engine = {...detected,
    executable:await firstFile([saved.executable, detected.executable]) ?? detected.executable,
    utility:await firstFile([saved.utility, detected.utility]) ?? detected.utility};
  await workspaceFile(cwd, saved.project);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const report = join(directory, `query-${stamp}.json`);
  const log = join(directory, `query-${stamp}.log`);
  const journal = join(directory, `query-${stamp}.run.json`);
  await writeScripts(directory);
  let argv;
  if (engineName === 'ghidra') {
    argv = ghidraArgv(engine, directory, 'analysis', report, directory, ['-process', basename(saved.input ?? ''),
      '-noanalysis']);
  } else {
    argv = ['-A', '-L' + log, '-S"' + join(directory, idaReportName) + '"', saved.project];
  }
  const metadata = {engine:engineName, executable:engine.executable, utility:engine.utility,
    input:saved.input, input_sha256:saved.input_sha256, output:directory, report, log, query, analysis:journalPath};
  await writeFile(journal, JSON.stringify({...metadata, state:'prepared'}, null, 2));
  return {executable:engine.executable, argv, output:directory, timeout, report, journal, log, metadata, query,
    env:{...process.env, QCODERI_ANALYSIS_QUERY:JSON.stringify(query)}, mode:'query'};
}

function launch(prepared) {
  const started_at = new Date().toISOString();
  writeFileSync(prepared.journal, JSON.stringify({...prepared.metadata, state:'running', started_at}, null, 2));
  const descriptor = openSync(prepared.log, 'wx');
  let child;
  try {
    child = spawn(prepared.executable, prepared.argv, {
      cwd:prepared.output, env:prepared.env, windowsHide:true, shell:false,
      stdio:['ignore', descriptor, descriptor],
    });
  } finally { closeSync(descriptor); }
  let stopping = false;
  let result;
  const cancel = () => {
    if (stopping || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
    stopping = true;
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide:true, shell:false, stdio:'ignore',
    });
    killer.once('error', () => child.kill());
  };
  let launchError;
  child.once('error', error => { launchError = error.message; });
  const timer = setTimeout(cancel, prepared.timeout * 1000);
  const done = new Promise(resolveDone => {
    child.once('close', async exit_code => {
      clearTimeout(timer);
      let analysis;
      let error = launchError;
      try { analysis = JSON.parse(await readFile(prepared.report, 'utf8')); }
      catch { error ??= 'Анализатор не создал отчёт. Проверьте process.log и журнал анализатора.'; }
      const status = stopping ? 'killed' : exit_code === 0 && analysis?.analysis_complete === true ? 'completed' : 'failed';
      const details = {...prepared.metadata, started_at, finished_at:new Date().toISOString(),
        state:status, exit_code, error,
        summary:analysis && {format:analysis.format, architecture:analysis.architecture, functions:analysis.function_count,
          matched:analysis.function_details?.length, strings:analysis.string_matches?.length,
          analysis_complete:analysis.analysis_complete}};
      try { await writeFile(prepared.journal, JSON.stringify(details, null, 2)); }
      catch (error) {
        result = JSON.stringify({...details, state:'failed', journal_error:error.message});
        resolveDone({status:'failed', output:result});
        return;
      }
      if (prepared.mode === 'query') {
        result = JSON.stringify(summarize(prepared, status, analysis, error, details));
      } else result = JSON.stringify(details);
      resolveDone({status, output:result});
    });
  });
  return {done, cancel, readOutput:()=>result ?? JSON.stringify({...prepared.metadata, state:'running', started_at})};
}

/** Keep the follow-up tool result small; the full evidence stays in its report file. */
function summarize(prepared, status, analysis, error, details) {
  const detailsOf = analysis?.function_details ?? [];
  return {
    engine:prepared.metadata.engine, query:prepared.query, state:status, error,
    report:prepared.report, journal:prepared.journal, log:prepared.log,
    analysis_complete:analysis?.analysis_complete ?? null,
    image_base:analysis?.image_base, address_convention:analysis?.address_convention,
    functions:detailsOf.map(detail => ({name:detail.name, address:detail.address, size:detail.size,
      matched_by:detail.matched_by, instruction_count:detail.instruction_count, truncated:detail.truncated,
      decompiled:detail.decompiled ? {available:detail.decompiled.available, language:detail.decompiled.language,
        reason:detail.decompiled.reason} : undefined,
      callers:detail.callers?.length, callees:detail.callees?.length,
      callgraph_nodes:detail.callgraph?.nodes?.length})),
    string_matches:analysis?.string_matches?.slice(0, 32),
    exit_code:details.exit_code,
    next:'Полные инструкции, псевдокод и перекрёстные ссылки — в report; читайте его через read и grep.',
  };
}

const selection = {
  engine:{type:'string', enum:['auto','ghidra','ida']},
  install:{type:'string', description:'Ghidra installation directory or an IDA directory/idat executable. Requires explicit engine.'},
  java_home:{type:'string', description:'Optional compatible JDK directory for Ghidra.'},
};
const queryParameters = {
  function_name:{type:'string', description:'Exact function name (kept for compatibility).'},
  name_query:{type:'string', description:'Substring or regular expression matched against function names.'},
  regex:{type:'boolean', description:'Treat name_query as a regular expression.'},
  address:{type:'string', description:'Hexadecimal address of a VA, or an RVA when address_is_offset is true.'},
  address_is_offset:{type:'boolean', description:'Treat address as an offset from the image base.'},
  decompile:{type:'boolean', description:'Include decompiled pseudocode when a decompiler is available.'},
  xrefs:{type:'boolean', description:'Include callers and callees with addresses; default true when a function is selected.'},
  callgraph_depth:{type:'integer', description:'0–3; bounded call graph rooted at each matched function.'},
  instruction_limit:{type:'integer', description:'Instructions per function, 1–1024, default 128.'},
  strings_query:{type:'string', description:'Find defined strings containing this text.'},
  string_limit:{type:'integer', description:'1–256, default 32.'},
  matches:{type:'integer', description:'Matched functions to expand, 1–16, default 4.'},
};
const output = {schema:{type:'string'}, render:(_args,text)=>[{type:'text',text}]};

export function apply(ctx) {
  ctx.systemPrompt.section({name:'qcoderi:hacker-workflow', order:96, interpolate:false,
    text:({agent})=>JSON.stringify({
      role:'Исполнитель технических задач', workspace:agent?.session.header.cwd,
      plan:['Определи цель и критерий проверки', 'Используй todo_write для этапов',
        'Для локального статического анализа запускай binary_analyze; повторные вопросы по той же базе — binary_query без повторного анализа',
        'Читай фактические артефакты: analysis.json и query-*.json через read и grep, а не по памяти',
        'Вноси допустимые правки, запускай тесты и сверяй результат'],
      evidence:'Каждое утверждение о бинарнике подкрепляй адресом (VA), именем функции и фрагментом инструкций или псевдокода из отчёта. Декомпилированный код без символов и строк остаётся гипотезой — помечай её. Различай RVA, файловое смещение и VA; модуль загружается по базе, отличной от image_base.',
      queries:{function_name:'точное имя', name_query:'подстрока или regex', address:'hex VA или RVA с address_is_offset',
        decompile:'псевдокод при наличии декомпилятора', callgraph_depth:'0–3', strings_query:'поиск строк'},
      permissions:'Используй выданные рабочей средой разрешения. Фоновый рабочий стол не изолирует файловую систему.',
      deliverable:'Назови проверенные результаты, пути к артефактам, фактические команды и оставшиеся ограничения.',
    })});
  ctx.tools.register(defineTool({
    name:'binary_analyzer_status', description:'Find local headless Ghidra and IDA analyzers without opening a window.',
    parameters:selection, output,
    async execute(args, exec) {
      requireProject(exec);
      const engine = requestedEngine(args.engine);
      if (engine === 'auto' && args.install) throw Error('При указании install выберите ghidra или ida.');
      const statuses = await Promise.all((engine === 'auto' ? ['ghidra','ida'] : [engine])
        .map(candidate => findEngine(candidate, args.install, args.java_home, exec.signal)));
      return JSON.stringify(statuses);
    },
  }));
  ctx.tools.register(defineTool({
    name:'binary_analyze',
    description:'Run static analysis of a local project file in background Ghidra or IDA. Never launches the input. Saves an analysis database, JSON inventory, and logs. The optional query adds bounded evidence: functions by exact name, name substring/regex or address, instructions, callers/callees, a call graph and decompiled pseudocode (Ghidra decompiler, IDA Hex-Rays). Use job_output to wait, then read the saved report.',
    parameters:{...selection, file_path:{type:'string',required:true},
      function_name:{type:'string',description:'Optional exact function name for a bounded instruction listing.'},
      query:{type:'object', additionalProperties:false, properties:queryParameters},
      timeout_seconds:{type:'integer'}},
    output, isConcurrencySafe:()=>true,
    async execute(args, exec) {
      requireProject(exec);
      const prepared = await prepareAnalysis(exec.agent.session.header.cwd, args, exec.signal);
      exec.signal.throwIfAborted();
      const job_id = ctx.jobs.start({kind:'process', owner:exec.agent, label:'Анализ · '+basename(args.file_path),
        run:()=>launch(prepared)});
      return JSON.stringify({job_id, ...prepared.metadata, journal:prepared.journal});
    },
  }));
  ctx.tools.register(defineTool({
    name:'binary_query',
    description:'Answer a follow-up question about an existing binary_analyze run: reopen the saved Ghidra/IDA database and return bounded evidence for a query (name, name regex/substring, address, strings, instructions, callers/callees, call graph, pseudocode). No re-analysis. The result names the report file that holds full pseudocode and instruction listings.',
    parameters:{analysis:{type:'string',required:true,
      description:'Run directory (or its run.json) created by binary_analyze inside this workspace.'},
      ...selection, query:{type:'object', additionalProperties:false, properties:queryParameters},
      function_name:{type:'string',description:'Exact function name shortcut for query.function_name.'},
      timeout_seconds:{type:'integer'}},
    output, isConcurrencySafe:()=>true,
    async execute(args, exec) {
      requireProject(exec);
      const prepared = await prepareQuery(exec.agent.session.header.cwd, args, exec.signal);
      exec.signal.throwIfAborted();
      const job_id = ctx.jobs.start({kind:'process', owner:exec.agent, label:'Запрос · '+basename(prepared.output),
        run:()=>launch(prepared)});
      return JSON.stringify({job_id, engine:prepared.metadata.engine, report:prepared.report,
        journal:prepared.journal, log:prepared.log, analysis:prepared.metadata.analysis, query:prepared.query});
    },
  }));
}