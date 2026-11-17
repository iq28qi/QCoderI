$ErrorActionPreference = 'Stop'
$buildScript = Join-Path $PSScriptRoot 'harness-base\scripts\build.py'
& python $buildScript @args
if ($LASTEXITCODE -ne 0) { throw "Build failed: $LASTEXITCODE" }
