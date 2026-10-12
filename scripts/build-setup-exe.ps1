[CmdletBinding()]
param(
  [string]$Output
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $Output) { $Output = Join-Path $projectRoot "dist-local\pi-chat-setup.exe" }
$iexpress = Join-Path $env:SystemRoot "System32\iexpress.exe"
if (-not (Test-Path -LiteralPath $iexpress)) {
  throw "Windows IExpress is unavailable; cannot build the single-file Setup executable."
}

$stage = Join-Path ([IO.Path]::GetTempPath()) ("pi-chat-setup-exe-" + [guid]::NewGuid().ToString("N"))
$source = Join-Path $stage "source"
$sed = Join-Path $stage "pi-chat-setup.sed"
try {
  New-Item -ItemType Directory -Force -Path $source, (Split-Path -Parent $Output) | Out-Null
  $wrapper = "@echo off`r`nchcp 65001 >nul`r`necho Pi Chat Setup starting> `"%TEMP%\pi-chat-setup-wrapper.log`"`r`npowershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File `"%~dp0pi-chat-setup.ps1`"`r`nexit /b %ERRORLEVEL%`r`n"
  [IO.File]::WriteAllText((Join-Path $source "pi-chat-setup.cmd"), $wrapper, [Text.ASCIIEncoding]::new())
  Copy-Item -LiteralPath (Join-Path $projectRoot "scripts\pi-chat-setup.ps1") -Destination (Join-Path $source "pi-chat-setup.ps1")
  $target = Join-Path $stage 'pi-chat-setup.exe'
  $sedContent = @"
[Version]
Class=IEXPRESS
SEDVersion=3

[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=1
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=1
CAB_FixedSize=0
CAB_AutoIncrementFileSize=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$target
FriendlyName=Pi Chat Setup
AppLaunched=cmd.exe /c pi-chat-setup.cmd
PostInstallCmd=<None>
SourceFiles=SourceFiles

[SourceFiles]
SourceFiles0=$source

[SourceFiles0]
pi-chat-setup.cmd=
pi-chat-setup.ps1=
"@
  [IO.File]::WriteAllText($sed, $sedContent.TrimStart(), [Text.UTF8Encoding]::new($false))
  & $iexpress /N /Q $sed
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  while (-not (Test-Path -LiteralPath $target) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 250 }
  if (-not (Test-Path -LiteralPath $target)) { throw "IExpress failed to create $target." }
  # Verify the embedded files, not an old executable left at Output.
  $unpacked = Join-Path $stage 'unpacked'
  New-Item -ItemType Directory -Path $unpacked | Out-Null
  $extractor = Start-Process -FilePath $target -ArgumentList @('/Q', '/C', ('/T:"' + $unpacked + '"')) -PassThru
  if (-not $extractor.WaitForExit(60000) -or $extractor.ExitCode -ne 0) { throw 'Setup extraction verification failed.' }
  foreach ($file in (Get-ChildItem -LiteralPath $source -File)) {
    $actual = Join-Path $unpacked $file.Name
    if (-not (Test-Path -LiteralPath $actual) -or (Get-FileHash -LiteralPath $actual).Hash -ne (Get-FileHash -LiteralPath $file.FullName).Hash) {
      throw "Setup embedded file mismatch: $($file.Name)"
    }
  }
  Copy-Item -LiteralPath $target -Destination $Output -Force
  $hash = (Get-FileHash -LiteralPath $Output -Algorithm SHA256).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText(($Output + '.sha256'), ($hash + ' *' + [IO.Path]::GetFileName($Output) + "`n"), [Text.UTF8Encoding]::new($false))
  Write-Output $Output
} finally {
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}
