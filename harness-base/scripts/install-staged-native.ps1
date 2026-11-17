# Install a verified local release ONLY after QCoderI has been closed manually.
# Never stops processes, launches an agent, contacts the network or migrates data.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Stage,
  [Parameter(Mandatory=$true)][string]$InstallRoot,
  [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function ArtifactHash([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }
  finally { $hasher.Dispose(); $stream.Dispose() }
}
$Stage = [IO.Path]::GetFullPath($Stage)
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
if ($Stage.TrimEnd('\') -eq $InstallRoot.TrimEnd('\')) { throw 'Stage must differ from the live installation' }
$manifest = Get-Content -LiteralPath (Join-Path $Stage 'release-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.schema_version -ne 1 -or -not $manifest.built -or $manifest.snapshot -or $manifest.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Not a completed native release' }
$entries = @($manifest.files)
if (-not ($entries | Where-Object path -eq 'QCoderI.exe')) { throw 'Manifest has no executable' }
foreach ($entry in $entries) {
  $dependencyData = $entry.path.StartsWith('harness-base/source/dsh/node_modules/') -or ($entry.path.StartsWith('harness-base/app/resources/runtime/') -and $entry.path.Contains('/node_modules/'))
  if ($entry.path -match '(^|/)(\.\.?|\.git|\.startup-preview-browser)(/|$)' -or ($entry.path -match '(^|/)data(/|$)' -and -not $dependencyData) -or $entry.path -match '[:\\]' -or $entry.path.StartsWith('/')) { throw ('Unsafe manifest path: ' + $entry.path) }
  $path = Join-Path $Stage $entry.path
  $item = Get-Item -LiteralPath $path
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('Linked artifact: ' + $entry.path) }
  $cursor = $item.Directory
  while ($cursor -and $cursor.FullName -ne $Stage) {
    if ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked staging directory' }
    $cursor = $cursor.Parent
  }
  if (-not $cursor) { throw 'Artifact outside stage' }
  if ($item.Length -ne $entry.bytes -or (ArtifactHash $path) -ne $entry.sha256) { throw ('Artifact hash mismatch: ' + $entry.path) }
}
if ($VerifyOnly) { Write-Output ('PASS: verified release ' + $manifest.version + ', ' + $entries.Count + ' artifacts; no installation'); return }
$exe = Join-Path $InstallRoot 'QCoderI.exe'
foreach ($process in [Diagnostics.Process]::GetProcessesByName('QCoderI')) {
  try { $runningPath = $process.MainModule.FileName }
  catch { throw 'Cannot verify a running QCoderI process. No installation was performed.' }
  finally { $process.Dispose() }
  if ($runningPath -and [IO.Path]::GetFullPath($runningPath).Equals($exe,[StringComparison]::OrdinalIgnoreCase)) { throw 'QCoderI is running. Close it manually and rerun this installer; no process was stopped.' }
}
if ((ArtifactHash $exe) -ne $manifest.live_exe_before) { throw 'Installed EXE changed since staging. Re-stage against the current installation before installing.' }
$rootItem = Get-Item -LiteralPath $InstallRoot
if ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked installation root is not supported' }
$lock = [IO.File]::Open((Join-Path $InstallRoot '.qcoderi-window.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
$releaseRoot = Join-Path $InstallRoot '.qcoderi-releases'
$destination = Join-Path $releaseRoot $manifest.version
$pending = $destination + '.pending-' + [guid]::NewGuid().ToString('N')
$backup = Join-Path $InstallRoot ('QCoderI.before-' + $manifest.version + '.exe')
$journal = Join-Path $InstallRoot '.qcoderi-local-install.json'
$installed = $false
try {
  if (Test-Path -LiteralPath $destination) { throw ('Release destination already exists: ' + $destination) }
  if (Test-Path -LiteralPath $backup) { throw ('Backup already exists, review previous transaction: ' + $backup) }
  New-Item -ItemType Directory -Path $pending -Force | Out-Null
  foreach ($entry in $entries) {
    if (-not $entry.path.StartsWith('harness-base/')) { continue }
    $target = Join-Path $pending $entry.path
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($target)) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $Stage $entry.path) -Destination $target
    if ((ArtifactHash $target) -ne $entry.sha256) { throw ('Copy verification failed: ' + $entry.path) }
  }
  Copy-Item -LiteralPath (Join-Path $Stage 'release-manifest.json') -Destination (Join-Path $pending 'release-manifest.json')
  Move-Item -LiteralPath $pending -Destination $destination
  $state = @{ schema_version=1; version=$manifest.version; phase='release_ready'; previous_exe=$manifest.live_exe_before; backup=$backup; release=$destination; at=[datetime]::UtcNow.ToString('o'); data_changed=$false; application_started=$false }
  [IO.File]::WriteAllText($journal,($state | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
  Copy-Item -LiteralPath $exe -Destination $backup
  $next = Join-Path $InstallRoot ('QCoderI.install-' + [guid]::NewGuid().ToString('N') + '.exe')
  Copy-Item -LiteralPath (Join-Path $Stage 'QCoderI.exe') -Destination $next
  $exeEntry = $entries | Where-Object path -eq 'QCoderI.exe'
  if ((ArtifactHash $next) -ne $exeEntry.sha256) { throw 'Copied EXE hash mismatch' }
  $atomicBackup = Join-Path $InstallRoot ('QCoderI.atomic-' + [guid]::NewGuid().ToString('N') + '.bak')
  [IO.File]::Replace($next,$exe,$atomicBackup)
  $installed = $true
  $state.phase='installed_awaiting_manual_launch'
  [IO.File]::WriteAllText($journal,($state | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
  Write-Output ('Installed ' + $manifest.version + '. User data was not changed. Start QCoderI.exe manually. Backup: ' + $backup)
} catch {
  if ($installed -and (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $backup -Destination $exe -Force }
  throw
} finally { $lock.Dispose() }
