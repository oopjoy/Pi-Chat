[CmdletBinding()]
param(
  [string]$Output
)

$ErrorActionPreference = "Stop"
# A parent pwsh process can leak its PS7 module paths into PSModulePath, which
# makes Windows PowerShell 5.1 load PowerShell 7's incompatible Utility module
# (Get-FileHash and friends disappear). Restore the 5.1 default explicitly.
if ($env:PSModulePath -and $env:PSModulePath -imatch 'PowerShell\\7\\') {
  $env:PSModulePath = "$env:SystemRoot\system32\WindowsPowerShell\v1.0\Modules;$env:ProgramFiles\WindowsPowerShell\Modules"
}
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
  # IExpress can leave a child writing $target after the maker process exits,
  # so wait for the file to exist AND stop growing before reading it.
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  $stableBytes = -1
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $target) {
      $size = (Get-Item -LiteralPath $target).Length
      if ($size -gt 0 -and $size -eq $stableBytes) { break }
      $stableBytes = $size
    }
    Start-Sleep -Milliseconds 250
  }
  if (-not (Test-Path -LiteralPath $target) -or $stableBytes -le 0) { throw "IExpress failed to create $target." }
  # Verify the embedded files, not an old executable left at Output.
  # Executing the EXE is non-deterministic across Windows builds (UI prompts;
  # quiet mode runs the installer). Instead locate the embedded Microsoft CAB
  # directly: scan for MSCF anywhere (new wextract stores it as an RCDATA
  # resource, old builds append it after the PE), validate the header, slice it
  # out, and expand it with the built-in expand.exe. Same path locally and on CI.
  $unpacked = Join-Path $stage 'unpacked'
  New-Item -ItemType Directory -Path $unpacked | Out-Null
  $bytes = [IO.File]::ReadAllBytes($target)
  $innerCab = $null
  for ($i = 0; $i -le $bytes.Length - 12; $i++) {
    if ($bytes[$i] -ne 0x4D -or $bytes[$i + 1] -ne 0x53 -or $bytes[$i + 2] -ne 0x43 -or $bytes[$i + 3] -ne 0x46) { continue }
    $cbFile = [int]$bytes[$i + 8] -bor ([int]$bytes[$i + 9] -shl 8) -bor ([int]$bytes[$i + 10] -shl 16) -bor ([int]$bytes[$i + 11] -shl 24)
    if ($cbFile -le 44 -or ($i + $cbFile) -gt $bytes.Length) { continue }
    $innerCab = Join-Path $stage 'inner.cab'
    $cab = New-Object byte[] $cbFile
    [Array]::Copy($bytes, $i, $cab, 0, $cbFile)
    [IO.File]::WriteAllBytes($innerCab, $cab)
    break
  }
  if (-not $innerCab) { throw 'Setup executable does not contain a verifiable embedded CAB payload.' }
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
