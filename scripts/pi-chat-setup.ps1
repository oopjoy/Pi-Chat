[CmdletBinding()]
param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "PiChat"),
  [string]$ReleaseTag = "latest",
  [switch]$NonInteractive,
  [switch]$SkipLaunch,
  [switch]$SkipPiInstall
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$logPath = Join-Path ([IO.Path]::GetTempPath()) ("pi-chat-setup.log")
try { $logStream = New-Object IO.StreamWriter($logPath, $true) } catch { $logStream = $null }
function Log([string]$Message) {
  Write-Host $Message
  if ($logStream) { $logStream.WriteLine(('[{0}] {1}' -f (Get-Date -Format o), $Message)); $logStream.Flush() }
}
function LogError([string]$Message) {
  [Console]::Error.WriteLine($Message)
  if ($logStream) { $logStream.WriteLine(('[{0}] ERROR {1}' -f (Get-Date -Format o), $Message)); $logStream.Flush() }
}
$repo = "oopjoy/Pi-Chat"
$nodeVersion = "22.19.0"
$piPackage = "@earendil-works/pi-coding-agent"
if ($env:PI_CHAT_SETUP_INSTALL_ROOT) { $InstallRoot = $env:PI_CHAT_SETUP_INSTALL_ROOT }
if ($env:PI_CHAT_SETUP_RELEASE_TAG) { $ReleaseTag = $env:PI_CHAT_SETUP_RELEASE_TAG }
if ($env:PI_CHAT_SETUP_NONINTERACTIVE -eq "1") { $NonInteractive = $true }
if ($env:PI_CHAT_SETUP_SKIP_LAUNCH -eq "1") { $SkipLaunch = $true }
if ($env:PI_CHAT_SETUP_SKIP_PI_INSTALL -eq "1") { $SkipPiInstall = $true }
if ($env:PI_CHAT_SETUP_USE_SYSTEM_NODE -eq "1") { $UseSystemNode = $true }
if ($env:PI_CHAT_SETUP_SKIP_RELEASE_DOWNLOAD -eq "1") { $SkipReleaseDownload = $true }
$temporary = Join-Path ([IO.Path]::GetTempPath()) ("pi-chat-setup-" + [guid]::NewGuid().ToString("N"))
$appRoot = Join-Path $InstallRoot "app"
$nodeRoot = Join-Path $InstallRoot "runtime\node"
$managedRoot = Join-Path $InstallRoot "runtime\managed-pi"
$configRoot = Join-Path $InstallRoot "config"

function Fail([string]$Message) {
  LogError("[Pi Chat Setup] $Message")
  exit 1
}

function Download([string]$Url, [string]$Path) {
  Log ("下载 " + $Url)
  Invoke-WebRequest -Uri $Url -OutFile $Path -UseBasicParsing
}

function EnsureDirectory([string]$Path) {
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
}

function Test-PiChatRunning {
  if ($env:PI_CHAT_SETUP_SKIP_RUNNING_CHECK -eq "1") { return $false }
  $rootPattern = [regex]::Escape([IO.Path]::GetFullPath($InstallRoot).TrimEnd('\\'))
  try {
    $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop)
    foreach ($process in $processes) {
      if ([string]$process.CommandLine -match $rootPattern) { return $true }
    }
  } catch {
    Log ("无法读取 Node.js 进程列表，将继续检查 30170 端口：" + $_.Exception.Message)
  }
  try {
    $listeners = @(Get-NetTCPConnection -LocalPort 30170 -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -gt 0) { return $true }
  } catch {
    # Get-NetTCPConnection is unavailable on some older Windows builds.
  }
  return $false
}

function InstallShortcuts {
  $shortcutScript = Join-Path $appRoot "scripts\\install-shortcuts.ps1"
  if (-not (Test-Path -LiteralPath $shortcutScript -PathType Leaf)) {
    throw "安装后的快捷方式脚本缺失。"
  }
  $desktop = [Environment]::GetFolderPath('DesktopDirectory')
  $startMenu = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\\Pi Chat'
  Log "创建桌面和开始菜单快捷方式"
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $shortcutScript -DesktopPath $desktop -StartMenuPath $startMenu
  if ($LASTEXITCODE -ne 0) { throw "Pi Chat 快捷方式创建失败。" }
}

function Get-ReleaseAsset {
  $uri = if ($ReleaseTag -eq "latest") {
    "https://api.github.com/repos/$repo/releases/latest"
  } else {
    "https://api.github.com/repos/$repo/releases/tags/$ReleaseTag"
  }
  $release = Invoke-RestMethod -Uri $uri -Headers @{ Accept = "application/vnd.github+json" } -UseBasicParsing
  $asset = @($release.assets) | Where-Object { $_.name -match '^pi-chat-windows-\d+\.\d+\.\d+\.zip$' } | Select-Object -First 1
  if (-not $asset) { throw ("Release {0} 没有可用的 Windows Pi Chat ZIP。" -f $release.tag_name) }
  $checksumName = [string]$asset.name + ".sha256"
  $checksumAsset = @($release.assets) | Where-Object { $_.name -eq $checksumName } | Select-Object -First 1
  if (-not $checksumAsset) { throw ("Release {0} 缺少 Pi Chat ZIP 校验文件。" -f $release.tag_name) }
  return @{ Tag = [string]$release.tag_name; Name = [string]$asset.name; Url = [string]$asset.browser_download_url; ChecksumUrl = [string]$checksumAsset.browser_download_url }
}

function InstallNode {
  if ($UseSystemNode -and (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    Log "使用系统 Node.js 进行隔离测试"
    if (Test-Path $nodeRoot) { Remove-Item -LiteralPath $nodeRoot -Recurse -Force }
    EnsureDirectory $nodeRoot
    Copy-Item -LiteralPath (Get-Command node.exe).Source -Destination (Join-Path $nodeRoot "node.exe")
    return
  }
  EnsureDirectory $temporary
  $archiveName = "node-v$nodeVersion-win-x64.zip"
  $archive = Join-Path $temporary $archiveName
  $checksums = Join-Path $temporary "SHASUMS256.txt"
  Download "https://nodejs.org/dist/v$nodeVersion/$archiveName" $archive
  Download "https://nodejs.org/dist/v$nodeVersion/SHASUMS256.txt" $checksums
  $archivePattern = '\s' + [regex]::Escape($archiveName) + '$'
  $record = Get-Content -LiteralPath $checksums | Where-Object { $_ -match $archivePattern } | Select-Object -First 1
  if (-not $record) { throw "无法取得 Node.js $nodeVersion 的校验值。" }
  $expected = ($record -split "\s+")[0].ToLowerInvariant()
  $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "Node.js 下载校验失败。" }
  $extract = Join-Path $temporary "node-extract"
  Expand-Archive -LiteralPath $archive -DestinationPath $extract -Force
  $source = Join-Path $extract "node-v$nodeVersion-win-x64"
  if (-not (Test-Path (Join-Path $source "node.exe"))) { throw "Node.js 压缩包内容不完整。" }
  if (Test-Path $nodeRoot) { Remove-Item -LiteralPath $nodeRoot -Recurse -Force }
  EnsureDirectory (Split-Path $nodeRoot -Parent)
  Move-Item -LiteralPath $source -Destination $nodeRoot
}

function InstallApp($asset) {
  if ($SkipReleaseDownload) {
    Log "跳过 Release 下载，使用本地源码构建进行隔离测试"
    if (Test-Path $appRoot) { Remove-Item -LiteralPath $appRoot -Recurse -Force }
    EnsureDirectory $appRoot
    $projectRoot = Split-Path -Parent $PSScriptRoot
    if (-not (Test-Path (Join-Path $projectRoot "scripts\pi-chat-setup.ps1"))) { $projectRoot = "D:\git_project\pi-chat" }
    $packageJson = Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw | ConvertFrom-Json
    Set-Content -LiteralPath (Join-Path $appRoot "package.json") -Value ($packageJson | ConvertTo-Json -Depth 10)
    Copy-Item -LiteralPath (Join-Path $projectRoot "scripts") -Destination (Join-Path $appRoot "scripts") -Recurse
    Copy-Item -LiteralPath (Join-Path $projectRoot "dist") -Destination (Join-Path $appRoot "dist") -Recurse
    Copy-Item -LiteralPath (Join-Path $projectRoot "resources") -Destination (Join-Path $appRoot "resources") -Recurse -ErrorAction SilentlyContinue
    Copy-Item -LiteralPath (Join-Path $projectRoot "pi-chat-launch.cmd") -Destination (Join-Path $appRoot "pi-chat-launch.cmd")
    Copy-Item -LiteralPath (Join-Path $projectRoot "start-pi-chat.cmd") -Destination (Join-Path $appRoot "start-pi-chat.cmd") -ErrorAction SilentlyContinue
    Copy-Item -LiteralPath (Join-Path $projectRoot "start-pi-chat-ui.ps1") -Destination (Join-Path $appRoot "start-pi-chat-ui.ps1") -ErrorAction SilentlyContinue
    return
  }
  $archive = Join-Path $temporary $asset.Name
  $checksumFile = Join-Path $temporary ([string]$asset.Name + ".sha256")
  Download $asset.Url $archive
  Download $asset.ChecksumUrl $checksumFile
  $assetPattern = '^([a-fA-F0-9]{64})\s+[* ]?' + [regex]::Escape([string]$asset.Name) + '$'
  $record = Get-Content -LiteralPath $checksumFile | Where-Object { $_ -match $assetPattern } | Select-Object -First 1
  if (-not $record) { throw "Pi Chat Release 校验文件格式无效。" }
  $expected = ($record -split "\s+")[0].ToLowerInvariant()
  $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "Pi Chat Release 下载校验失败。" }
  $extract = Join-Path $temporary "app-extract"
  Expand-Archive -LiteralPath $archive -DestinationPath $extract -Force
  $source = Get-ChildItem -LiteralPath $extract -Directory | Select-Object -First 1
  if (-not $source -or -not (Test-Path (Join-Path $source.FullName "dist\server\server\index.js"))) {
    throw "Pi Chat Release 内容不完整。"
  }
  $old = $null
  try {
    if (Test-Path $appRoot) {
      $old = Join-Path $InstallRoot ("app-previous-" + [DateTime]::UtcNow.ToString("yyyyMMddHHmmss"))
      Move-Item -LiteralPath $appRoot -Destination $old
    }
    Move-Item -LiteralPath $source.FullName -Destination $appRoot
  } catch {
    if ($old -and (Test-Path -LiteralPath $old) -and -not (Test-Path -LiteralPath $appRoot)) {
      Move-Item -LiteralPath $old -Destination $appRoot -Force
    }
    throw
  }
}

function DetectExistingPi {
  $node = Join-Path $nodeRoot "node.exe"
  $probe = Join-Path $appRoot "scripts\detect-pi-entry.mjs"
  if (-not (Test-Path $probe)) { return $null }
  try {
    $json = & $node $probe 2>$null
    if ($LASTEXITCODE -eq 0 -and $json) { return ($json | ConvertFrom-Json) }
    if ($env:PI_CHAT_PI_ENTRY) { throw "PI_CHAT_PI_ENTRY 指向的 Pi RPC 入口不可用，请先修复该环境变量。" }
  } catch {
    if ($env:PI_CHAT_PI_ENTRY) { throw }
  }
  return $null
}

function InstallManagedPi {
  $packageEncoded = [uri]::EscapeDataString($piPackage)
  $registryUri = 'https://registry.npmjs.org/' + $packageEncoded
  $metadata = Invoke-RestMethod -Uri $registryUri -Headers @{ Accept = "application/json" } -UseBasicParsing
  $version = [string]$metadata.'dist-tags'.latest
  if ($version -notmatch '^\d+\.\d+\.\d+') { throw "npm Registry 没有返回有效的 Pi Runtime 版本。" }
  $releaseRoot = Join-Path $managedRoot ("releases\" + $version)
  EnsureDirectory $releaseRoot
  $node = Join-Path $nodeRoot "node.exe"
  $npm = Join-Path $nodeRoot "node_modules\npm\bin\npm-cli.js"
  if (-not (Test-Path $npm)) { throw "随 Node.js 提供的 npm 不完整，无法安装 Pi Runtime。" }
  Log ("安装 Pi Runtime " + $version + " 到 " + $releaseRoot)
  & $node $npm install --prefix $releaseRoot "$piPackage@$version" --ignore-scripts --no-audit --no-fund | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Pi Runtime 安装失败。" }
  Set-Content -LiteralPath (Join-Path $managedRoot "current-version") -Value $version -NoNewline -Encoding ascii
  return $managedRoot
}

try {
  EnsureDirectory $InstallRoot
  EnsureDirectory $temporary
  if (Test-PiChatRunning) {
    throw "检测到 Pi Chat 正在运行（端口 30170 或安装目录中的 Node.js 进程）。请先关闭 Pi Chat 后再安装或升级。"
  }
  Log ("准备安装 Pi Chat 到 " + $InstallRoot)
  InstallNode
  $asset = if ($SkipReleaseDownload) { @{ Tag = "local-test" } } else { Get-ReleaseAsset }
  InstallApp $asset
  $existing = DetectExistingPi
  $managedPath = $null
  if ($existing) {
    Log ("检测到本机 Pi " + $existing.version + "：" + $existing.entry)
    $useExisting = $true
    if (-not $NonInteractive -and $env:PI_CHAT_NONINTERACTIVE -ne "1") {
      $answer = Read-Host "是否使用检测到的本机 Pi？[Y/n]"
      $useExisting = $answer -notmatch '^(n|no|否)$'
    }
    if (-not $useExisting) { $managedPath = InstallManagedPi }
  } else {
    Log "未检测到可用 Pi，将安装 PiChat 管理的 Pi Runtime。"
    if (-not $SkipPiInstall) { $managedPath = InstallManagedPi }
  }
  EnsureDirectory $configRoot
  $envFile = Join-Path $configRoot "runtime.env"
  if ($managedPath) {
    Set-Content -LiteralPath $envFile -Value "PI_CHAT_MANAGED_INSTALL_ROOT=$managedPath" -Encoding utf8
  } else {
    Remove-Item -LiteralPath $envFile -Force -ErrorAction SilentlyContinue
  }
  $launcher = Join-Path $appRoot "pi-chat-launch.cmd"
  if (-not (Test-Path $launcher)) { throw "安装后的 Pi Chat 启动器缺失。" }
  InstallShortcuts
  Log ("安装完成：" + $asset.Tag)
  Log "首次启动将打开浏览器，并继续使用本机 Pi 或 PiChat 管理的 Pi Runtime。"
  if (-not $SkipLaunch) { Start-Process -FilePath $launcher -WorkingDirectory $appRoot }
} catch {
  LogError $_.Exception.ToString()
  Fail $_.Exception.Message
} finally {
  if ($logStream) { $logStream.Dispose() }
  Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
