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
  # IExpress appends a CAB (MSCF) payload after the PE stub; executing the EXE
  # to extract is non-deterministic across Windows builds (UI prompts, quiet
  # mode runs the installer instead), so slice the embedded CAB out and expand
  # it with the built-in expand.exe. The same path runs locally and on CI.
  $unpacked = Join-Path $stage 'unpacked'
  New-Item -ItemType Directory -Path $unpacked | Out-Null
  $bytes = [IO.File]::ReadAllBytes($target)
  $cabOffset = -1
  for ($i = $bytes.Length - 4; $i -ge 4; $i--) {
    if ($bytes[$i] -eq 0x4D -and $bytes[$i + 1] -eq 0x53 -and $bytes[$i + 2] -eq 0x43 -and $bytes[$i + 3] -eq 0x46) {
      # CABFOLDER/CAB header check: reserved1 immediately after MSCF is zeroed.
      if ($bytes[$i + 4] -eq 0 -and $bytes[$i + 5] -eq 0 -and $bytes[$i + 6] -eq 0 -and $bytes[$i + 7] -eq 0) { $cabOffset = $i; break }
    }
  }
  if ($cabOffset -lt 0) { throw 'Setup executable does not contain an embedded CAB payload.' }
  $innerCab = Join-Path $stage 'inner.cab'
  $cab = New-Object byte[] ($bytes.Length - $cabOffset)
  [Array]::Copy($bytes, $cabOffset, $cab, 0, $cab.Length)
  [IO.File]::WriteAllBytes($innerCab, $cab)
  & "$env:SystemRoot\System32\expand.exe" -F:* $innerCab $unpacked | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Setup CAB extraction failed (exit code $($LASTEXITCODE))." }
  $extracted = @(Get-ChildItem -LiteralPath $unpacked -Recurse -File)
  foreach ($file in (Get-ChildItem -LiteralPath $source -File)) {
    $actual = $extracted | Where-Object { $_.Name -ieq $file.Name } | Select-Object -First 1
    if (-not $actual -or (Get-FileHash -LiteralPath $actual.FullName).Hash -ne (Get-FileHash -LiteralPath $file.FullName).Hash) {
      $listing = ($extracted | ForEach-Object { $_.FullName.Substring($unpacked.Length + 1) }) -join ', '
      $detail = if ($actual) {
        $a = [IO.File]::ReadAllBytes($actual.FullName)
        $b = [IO.File]::ReadAllBytes($file.FullName)
        $hexA = (($a | Select-Object -First 64 | ForEach-Object { $_.ToString('X2') }) -join ' ')
        $hexB = (($b | Select-Object -First 64 | ForEach-Object { $_.ToString('X2') }) -join ' ')
        "extracted $($a.Length)B sha256=$((Get-FileHash -LiteralPath $actual.FullName).Hash) head=[$hexA]; expected $($b.Length)B sha256=$((Get-FileHash -LiteralPath $file.FullName).Hash) head=[$hexB]"
      } else { 'extracted file missing' }
      throw "Setup embedded file mismatch: $($file.Name). $detail. Extracted: [$listing]"
    }
  }
  Copy-Item -LiteralPath $target -Destination $Output -Force
  $hash = (Get-FileHash -LiteralPath $Output -Algorithm SHA256).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText(($Output + '.sha256'), ($hash + ' *' + [IO.Path]::GetFileName($Output) + "`n"), [Text.UTF8Encoding]::new($false))
  Write-Output $Output
} finally {
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}
