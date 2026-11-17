$ErrorActionPreference = 'Stop'
$projectBase = Split-Path -Parent $PSScriptRoot
$applicationDirectory = if ($env:QCODERI_TEST_APP) { $env:QCODERI_TEST_APP } else { Join-Path $projectBase 'app' }
$electronExe = Join-Path $applicationDirectory 'QCoderI.exe'
$verificationScript = Join-Path $projectBase 'tests\verify.mjs'
$outputFile = Join-Path $projectBase 'tests\last-run.stdout.log'
$errorFile = Join-Path $projectBase 'tests\last-run.stderr.log'
$previousMode = $env:ELECTRON_RUN_AS_NODE
$previousArchive = $env:HARNESS_ARCHIVE
$previousTestNode = $env:QCODERI_TEST_NODE
try {
    if (-not $env:QCODERI_TEST_NODE) { $env:QCODERI_TEST_NODE = (Get-Command node -ErrorAction Stop).Source }
    $env:ELECTRON_RUN_AS_NODE = '1'
    $env:HARNESS_ARCHIVE = Join-Path $applicationDirectory 'resources\app.asar'
    foreach ($testFile in @($verificationScript, (Join-Path $projectBase 'tests\request-recovery.test.mjs'), (Join-Path $projectBase 'tests\workbench.test.mjs'), (Join-Path $projectBase 'tests\workbench-native.mjs'), (Join-Path $projectBase 'tests\reasoning-native.mjs'), (Join-Path $projectBase 'tests\images-native.mjs'), (Join-Path $projectBase 'tests\image-input-editor.test.mjs'), (Join-Path $projectBase 'tests\image-policy.test.mjs'), (Join-Path $projectBase 'tests\screenshots-native.mjs'), (Join-Path $projectBase 'tests\image-generation-native.mjs'), (Join-Path $projectBase 'tests\desktop-native.mjs'), (Join-Path $projectBase 'tests\studio3d-native.mjs'), (Join-Path $projectBase 'tests\visual-workflow.test.mjs'), (Join-Path $projectBase 'tests\stream-publication.test.mjs'), (Join-Path $projectBase 'tests\team.test.mjs'), (Join-Path $projectBase 'tests\team-checks.test.mjs'), (Join-Path $projectBase 'tests\team-native.mjs'), (Join-Path $projectBase 'tests\chat-native.mjs'), (Join-Path $projectBase 'tests\video.test.mjs'), (Join-Path $projectBase 'tests\video-native.mjs'), (Join-Path $projectBase 'tests\unreal.test.mjs'), (Join-Path $projectBase 'tests\aether.test.mjs'), (Join-Path $projectBase 'tests\aether-native.mjs'))) {
        $testProcess = Start-Process -FilePath $electronExe -ArgumentList ('"' + $testFile + '"') -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput $outputFile -RedirectStandardError $errorFile
        Get-Content -LiteralPath $outputFile -Encoding UTF8
        Get-Content -LiteralPath $errorFile -Encoding UTF8
        if ($testProcess.ExitCode -ne 0) { throw "Verification failed: $testFile ($($testProcess.ExitCode))" }
    }
} finally {
    $env:ELECTRON_RUN_AS_NODE = $previousMode
    $env:HARNESS_ARCHIVE = $previousArchive
    $env:QCODERI_TEST_NODE = $previousTestNode
}
