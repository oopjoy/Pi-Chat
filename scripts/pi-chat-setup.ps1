[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('CheckRunning', 'Detect', 'InstallPi')][string]$Action,
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [Parameter(Mandatory = $true)][string]$ResultFile
)

# Inno Setup owns files, shortcuts and uninstall. This helper never downloads
# the application/Node and never upgrades an already detected Pi.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$appRoot = Join-Path $InstallRoot 'app'
$node = Join-Path $InstallRoot 'runtime\node\node.exe'
$staging = $null
$logPath = Join-Path ([IO.Path]::GetTempPath()) 'pi-chat-pi-install.log'
function Report([bool]$Found, [string]$Message, [string]$Entry = '', [string]$Version = '') {
  $Message = $Message.Replace("`r", ' ').Replace("`n", ' ')
  $lines = @('[Pi]', ('Found=' + [int]$Found), ('Message=' + $Message), ('Entry=' + $Entry), ('Version=' + $Version))
  [IO.File]::WriteAllLines($ResultFile, $lines, [Text.Encoding]::Unicode)
}
function DetectPi {
  $envFile = Join-Path $InstallRoot 'config\runtime.env'
  if (Test-Path -LiteralPath $envFile) {
    foreach ($line in Get-Content -LiteralPath $envFile) {
      if ($line -match '^PI_CHAT_MANAGED_INSTALL_ROOT=(.+)$') { $env:PI_CHAT_MANAGED_INSTALL_ROOT = $matches[1] }
    }
  }
  $value = & $node (Join-Path $appRoot 'scripts\detect-pi-entry.mjs') 2>>$logPath
  if ($LASTEXITCODE -ne 0) { throw 'Pi detection failed; check PI_CHAT_PI_ENTRY or connection settings.' }
  if ($value) { return ($value | ConvertFrom-Json) }
  return $null
}
try {
  if ($Action -eq 'CheckRunning') {
    # A different checkout on 30170 cannot lock this installation. Its launcher
    # still refuses a foreign listener; never stop it or force-close processes.
    $pattern = [regex]::Escape($InstallRoot + '\')
    $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop)
    foreach ($process in $processes) {
      if ([string]$process.CommandLine -match $pattern -or [string]$process.ExecutablePath -match $pattern) {
        Report $false 'Pi Chat is running from this installation. Close it safely in Settings before installing or uninstalling.'
        exit 11
      }
    }
    Report $false 'Installation files are not owned by a running Node process.'
    exit 0
  }
  $existing = DetectPi
  if ($existing) {
    Report $true ('Using existing Pi ' + $existing.version + '; no upgrade or configuration copy performed.') ([string]$existing.entry) ([string]$existing.version)
    exit 0
  }
  if ($Action -eq 'Detect') {
    Report $false 'Pi is not installed. Pi Chat and its private Node are ready; install Pi optionally, or configure its entry later.'
    exit 0
  }
  $package = '@earendil-works/pi-coding-agent'
  $metadata = Invoke-RestMethod -Uri ('https://registry.npmjs.org/' + [uri]::EscapeDataString($package)) -TimeoutSec 20 -UseBasicParsing
  $version = [string]$metadata.'dist-tags'.latest
  if ($version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') { throw 'Pi registry version is invalid.' }
  $managed = Join-Path $env:USERPROFILE '.pi\agent\install'
  $release = Join-Path $managed ('releases\' + $version)
  $entry = Join-Path $release 'node_modules\@earendil-works\pi-coding-agent\dist\rpc-entry.js'
  if (-not (Test-Path -LiteralPath $entry)) {
    if (Test-Path -LiteralPath $release) { throw 'An incomplete Pi release directory already exists; use Pi connection settings to repair it.' }
    $staging = Join-Path $managed ('releases\.install-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $staging | Out-Null
    $npm = Join-Path $InstallRoot 'runtime\node\node_modules\npm\bin\npm-cli.js'
    & $node $npm install --prefix $staging ($package + '@' + $version) --ignore-scripts --no-audit --no-fund --fetch-retries=1 --fetch-timeout=20000 >>$logPath 2>&1
    if ($LASTEXITCODE -ne 0) { throw ('Pi download failed. The application remains installed. Log: ' + $logPath) }
    $preparedEntry = Join-Path $staging 'node_modules\@earendil-works\pi-coding-agent\dist\rpc-entry.js'
    if (-not (Test-Path -LiteralPath $preparedEntry)) { throw 'Downloaded Pi is missing its RPC entry.' }
    Move-Item -LiteralPath $staging -Destination $release
    $staging = $null
  }
  $pointer = Join-Path $managed 'current-version'
  $temporary = $pointer + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
  [IO.File]::WriteAllText($temporary, $version, [Text.Encoding]::ASCII)
  if (Test-Path -LiteralPath $pointer) { [IO.File]::Replace($temporary, $pointer, $null) }
  else { [IO.File]::Move($temporary, $pointer) }
  $config = Join-Path $InstallRoot 'config'
  New-Item -ItemType Directory -Force -Path $config | Out-Null
  $envFile = Join-Path $config 'runtime.env'
  $previous = if (Test-Path -LiteralPath $envFile) { @(Get-Content -LiteralPath $envFile | Where-Object { $_ -notmatch '^PI_CHAT_MANAGED_INSTALL_ROOT=' }) } else { @() }
  [IO.File]::WriteAllLines($envFile, @($previous) + @('PI_CHAT_MANAGED_INSTALL_ROOT=' + $managed), [Text.UTF8Encoding]::new($false))
  Report $true ('Installed Pi ' + $version + '. Existing credentials, Skills and sessions are unchanged.') $entry $version
} catch {
  Report $false ('Pi operation could not finish: ' + $_.Exception.Message + ' The application remains installed; retry from connection settings.')
  exit 1
} finally {
  if ($staging -and (Test-Path -LiteralPath $staging)) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
}
