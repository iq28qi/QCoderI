param([Parameter(Mandatory=$true)][string]$ProjectFile, [Parameter(Mandatory=$true)][string]$EngineDirectory)
$ErrorActionPreference = 'Stop'
$projectPath = (Resolve-Path -LiteralPath $ProjectFile).Path
$enginePath = (Resolve-Path -LiteralPath $EngineDirectory).Path
$projectDirectory = Split-Path -Parent $projectPath
$pluginDirectory = Join-Path $projectDirectory 'Plugins/QCoderIBridge'
$pluginDescriptor = Join-Path $pluginDirectory 'QCoderIBridge.uplugin'
$build = Join-Path $enginePath 'Engine/Build/BatchFiles/Build.bat'
if (-not (Test-Path -LiteralPath $pluginDescriptor)) { throw 'Run unreal_setup first.' }
if (Get-Process UnrealEditor,UnrealEditor-Cmd -ErrorAction SilentlyContinue) { throw 'Close Unreal Editor before building the plugin.' }
$buildDirectory = Join-Path $projectDirectory ('Saved/QCoderI/Build-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $buildDirectory -Force | Out-Null
$hostDirectory = Join-Path $buildDirectory 'HostProject'
$hostPluginParent = Join-Path $hostDirectory 'Plugins'
New-Item -ItemType Directory -Path $hostPluginParent -Force | Out-Null
$hostPlugin = Join-Path $hostPluginParent 'QCoderIBridge'
New-Item -ItemType Directory -Path $hostPlugin -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $pluginDirectory 'Source') -Destination $hostPlugin -Recurse -Force
Copy-Item -LiteralPath $pluginDescriptor -Destination $hostPlugin -Force
$hostProject = Join-Path $hostDirectory 'QCoderIBridgeHost.uproject'
$hostJson = @{ FileVersion=3; Plugins=@(@{Name='QCoderIBridge';Enabled=$true}) } | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($hostProject, $hostJson, [System.Text.UTF8Encoding]::new($false))
$hostDescriptor = Join-Path $hostPlugin 'QCoderIBridge.uplugin'
# A normal local compiler avoids UBA cache stalls and reduces peak memory.
& $build UnrealEditor Win64 Development "-Project=$hostProject" "-Plugin=$hostDescriptor" -NoUBA -MaxParallelActions=1 -NoHotReload -NoPCH -NoSharedPCH
if ($LASTEXITCODE -ne 0) { throw "Unreal plugin build failed ($LASTEXITCODE). Install the C++ toolchain required by this Unreal version. Build logs: $buildDirectory" }
$builtBinaries = Join-Path $hostPlugin 'Binaries'
if (-not (Test-Path -LiteralPath (Join-Path $builtBinaries 'Win64/UnrealEditor-QCoderIBridge.dll'))) { throw 'Build finished without the editor DLL' }
Copy-Item -LiteralPath $builtBinaries -Destination $pluginDirectory -Recurse -Force
Write-Output "QCoderIBridge built. Open project: $projectPath"
