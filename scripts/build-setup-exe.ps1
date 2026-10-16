[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PayloadRoot,
  [Parameter(Mandatory = $true)][string]$CompilerPath,
  [Parameter(Mandatory = $true)][string]$Output,
  [string]$AppId = 'PiChat.Desktop'
)
$ErrorActionPreference = 'Stop'
$PayloadRoot = [IO.Path]::GetFullPath($PayloadRoot)
$Output = [IO.Path]::GetFullPath($Output)
$version = (Get-Content -LiteralPath (Join-Path $PayloadRoot 'app\package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') { throw 'Invalid application version.' }
if ($AppId -notmatch '^[A-Za-z0-9.-]+$') { throw 'Invalid installer identity.' }
foreach ($file in @('app\LICENSE', 'app\dist\build-identity.json', 'app\dist\server\server\index.js', 'app\dist\web\index.html', 'runtime\node\node.exe', 'runtime\node\LICENSE', 'runtime\node\node_modules\npm\bin\npm-cli.js', 'runtime\pi\node_modules\@earendil-works\pi-coding-agent\dist\rpc-entry.js')) {
  if (-not (Test-Path -LiteralPath (Join-Path $PayloadRoot $file) -PathType Leaf)) { throw ('Missing embedded payload: ' + $file) }
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Output) | Out-Null
$arguments = @('/Q', ('/DPayloadRoot=' + $PayloadRoot), ('/DAppVersion=' + $version), ('/DOutputDir=' + (Split-Path -Parent $Output)), ('/DOutputName=' + [IO.Path]::GetFileNameWithoutExtension($Output)), ('/DSetupAppId=' + $AppId), (Join-Path $PSScriptRoot 'pi-chat-installer.iss'))
$logPath = $Output + '.iscc.log'
& $CompilerPath @arguments 2>&1 | Tee-Object -FilePath $logPath | Out-Host
if ($LASTEXITCODE -ne 0) {
  $compilerOutput = if (Test-Path -LiteralPath $logPath) { Get-Content -LiteralPath $logPath -Raw } else { '' }
  throw ('Inno Setup compilation failed: ' + $LASTEXITCODE + [Environment]::NewLine + $compilerOutput)
}
if (-not (Test-Path -LiteralPath $Output -PathType Leaf)) { throw 'Compiler did not produce the Setup EXE.' }
Write-Output $Output
