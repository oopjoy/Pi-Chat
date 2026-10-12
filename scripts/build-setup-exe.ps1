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
  # A freshly built self-extractor can be briefly locked by antivirus scans,
  # so a failed verification retries once with a clean directory before failing.
  $unpacked = Join-Path $stage 'unpacked'
  $sevenZip = Join-Path $env:ProgramFiles '7-Zip\7z.exe'
  if (-not (Test-Path -LiteralPath $sevenZip)) { $sevenZip = (Get-Command 7z.exe -ErrorAction SilentlyContinue).Source }
  $verified = $false
  $lastFailure = ''
  for ($attempt = 1; $attempt -le 2 -and -not $verified; $attempt++) {
    if (Test-Path -LiteralPath $unpacked) { Remove-Item -LiteralPath $unpacked -Recurse -Force }
    New-Item -ItemType Directory -Path $unpacked | Out-Null
    try {
      if ($sevenZip) {
        # Deterministic, UI-free extraction (IExpress packages are CAB SFX).
        # CI runners ship 7-Zip; executing the EXE there blocks on IExpress UI.
        & $sevenZip x -y ('-o' + $unpacked) $target | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Setup archive extraction failed (exit code $($LASTEXITCODE))." }
      } else {
        # Extract-only fallback. IExpress shows a confirmation dialog in /C mode on
        # some builds, so this path is only used where it is known to behave.
        $extractor = Start-Process -FilePath $target -ArgumentList @('/C', ('/T:"' + $unpacked + '"')) -PassThru
        if (-not $extractor.WaitForExit(120000)) { throw 'Setup extraction verification timed out.' }
        if ($extractor.ExitCode -ne 0) { throw "Setup extraction verification failed (exit code $($extractor.ExitCode))." }
      }
      foreach ($file in (Get-ChildItem -LiteralPath $source -File)) {
        $actual = Join-Path $unpacked $file.Name
        if (-not (Test-Path -LiteralPath $actual) -or (Get-FileHash -LiteralPath $actual).Hash -ne (Get-FileHash -LiteralPath $file.FullName).Hash) {
          throw "Setup embedded file mismatch: $($file.Name)"
        }
      }
      $verified = $true
    } catch {
      $lastFailure = $_.Exception.Message
      $listing = (Get-ChildItem -LiteralPath $unpacked -File -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }) -join ', '
      Write-Warning ("Setup verification attempt $attempt failed: $lastFailure (unpacked: [$listing])")
    }
  }
  if (-not $verified) { throw "Setup verification failed after retries: $lastFailure" }
  Copy-Item -LiteralPath $target -Destination $Output -Force
  $hash = (Get-FileHash -LiteralPath $Output -Algorithm SHA256).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText(($Output + '.sha256'), ($hash + ' *' + [IO.Path]::GetFileName($Output) + "`n"), [Text.UTF8Encoding]::new($false))
  Write-Output $Output
} finally {
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}
