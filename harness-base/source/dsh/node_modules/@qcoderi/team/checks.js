import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

const OUTPUT_LIMIT = 6000;

async function checkDirectory(workspace, directory) {
  const root = await realpath(workspace);
  const cwd = await realpath(resolve(root, directory));
  const rel = relative(root, cwd);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../')) throw new Error('Check cwd leaves the workspace (including directory links)');
  return cwd;
}

function quoteWin32Arg(value) {
  if (value.length === 0) return '""';
  if (!/[\s\t\n\v"]/.test(value)) return value;
  let out = '"';
  let backslashes = 0;
  for (const ch of value) {
    if (ch === '\\') { backslashes++; continue; }
    if (ch === '"') { out += '\\'.repeat(backslashes * 2 + 1) + '"'; backslashes = 0; continue; }
    if (backslashes) { out += '\\'.repeat(backslashes); backslashes = 0; }
    out += ch;
  }
  if (backslashes) out += '\\'.repeat(backslashes * 2);
  return out + '"';
}

// Quote every argv entry verbatim (bypassing PowerShell 5.1 native double-quote stripping
// via ProcessStartInfo for native .exe/.com targets). All execution still goes through
// the leader's normal tool pipeline, including its guards and standing permissions.
export function checkCommand(argv) {
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const win32Args = argv.slice(1).map(quoteWin32Arg).join(' ');
  const psArgs = argv.slice(1).map(quote).join(', ');
  return [
    "$ErrorActionPreference = 'Stop'",
    '$global:LASTEXITCODE = 0',
    `$__exe = ${quote(argv[0])}`,
    '$__cmd = Get-Command -Name $__exe -ErrorAction Stop | Select-Object -First 1',
    "if ($__cmd.CommandType -eq 'Application' -and $__cmd.Source -match '\\.(exe|com)$') {",
    '  $__psi = New-Object System.Diagnostics.ProcessStartInfo',
    '  $__psi.FileName = $__cmd.Source',
    '  $__psi.WorkingDirectory = (Get-Location).Path',
    `  $__psi.Arguments = ${quote(win32Args)}`,
    '  $__psi.UseShellExecute = $false',
    '  $__proc = [System.Diagnostics.Process]::Start($__psi)',
    '  try {',
    '    $__proc.WaitForExit()',
    '    exit $__proc.ExitCode',
    '  } finally {',
    '    if ($__proc -and -not $__proc.HasExited) { try { $__proc.Kill() } catch {} }',
    '    if ($__proc) { $__proc.Dispose() }',
    '  }',
    '}',
    argv.length > 1 ? `& $__exe @(${psArgs})` : '& $__exe',
    'if (-not $?) { if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 1 }',
    'exit $LASTEXITCODE',
  ].join('\n');
}

async function runCheck(check, workspace, signal, executeTool) {
  const started = Date.now();
  const result = { name: check.name, command: check.command, status: 'failed', exit_code: null, output: '', failure_kind: 'runner' };
  if (signal.aborted) return { ...result, status: 'cancelled', failure_kind: 'cancelled' };
  let cwd;
  try { cwd = await checkDirectory(workspace, check.cwd); }
  catch (error) { return { ...result, failure_kind: 'cwd', detail: error.message, duration_ms: Date.now() - started }; }
  if (signal.aborted) return { ...result, status: 'cancelled', failure_kind: 'cancelled' };
  try {
    if (!executeTool) throw new Error('Normal PowerShell tool executor unavailable');
    const execution = await executeTool({ command: checkCommand(check.command), description: `Команда QCoderI: ${check.name}`,
      workdir: cwd, timeoutMs: check.timeout_seconds * 1000, run_in_background: false }, signal);
    result.output = execution.content?.filter(block => block.type === 'text').map(block => block.text).join('\n').slice(-OUTPUT_LIMIT) ?? '';
    const value = execution.value;
    if (execution.isError) result.detail = result.output || 'Check tool failed';
    else if (value?.kind !== 'foreground' || !Number.isInteger(value.exitCode)) result.detail = 'PowerShell tool returned no foreground exit code';
    else {
      result.exit_code = value.exitCode;
      if (value.timedOut) { result.detail = 'Check timeout'; result.failure_kind = 'timeout'; }
      else if (value.sandbox?.denied || value.sandbox?.runnerFailed) { result.detail = 'Command unavailable under current execution policy'; result.failure_kind = 'policy'; }
      else if (value.aborted || value.signal) { result.detail = 'Check interrupted'; result.failure_kind = 'cancelled'; result.status = 'cancelled'; }
      else if (value.exitCode === 0) { result.status = 'passed'; delete result.failure_kind; }
      else { result.detail = `Exit code: ${value.exitCode}`; result.failure_kind = 'exit_code'; }
    }
  } catch (error) { result.detail = String(error?.message ?? error); }
  if (signal.aborted) { result.status = 'cancelled'; result.failure_kind = 'cancelled'; }
  result.duration_ms = Date.now() - started;
  return result;
}

export async function runChecks(task, workspace, signal, executeTool) {
  const results = [];
  let failed = false;
  for (let index = 0; index < task.checks.length;) {
    const check = task.checks[index];
    let end = index + 1;
    // A group is an explicit assertion of independence. Keep bounded waves
    // and wait for every member before running any dependent check.
    if (check.parallel_group) {
      while (end < task.checks.length && task.checks[end].parallel_group === check.parallel_group) end++;
    }
    const group = task.checks.slice(index, end);
    for (let start = 0; start < group.length; start += 2) {
      const wave = group.slice(start, start + 2);
      if (failed || signal.aborted) {
        results.push(...wave.map(item => ({ name: item.name, status: 'skipped', exit_code: null,
          detail: 'Previous check failed or task cancelled' })));
        continue;
      }
      const settled = await Promise.all(wave.map(item => runCheck(item, workspace, signal, executeTool)));
      results.push(...settled);
      failed = settled.some(result => result.status !== 'passed');
    }
    index = end;
  }
  return results;
}
