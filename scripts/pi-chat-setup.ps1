[CmdletBinding()]
param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "PiChat"),
  [string]$ReleaseTag = "latest",
  [switch]$NonInteractive
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$repo = "oopjoy/Pi-Chat"
$nodeVersion = "22.19.0"
$piPackage = "@earendil-works/pi-coding-agent"
$temporary = Join-Path ([IO.Path]::GetTempPath()) ("pi-chat-setup-" + [guid]::NewGuid().ToString("N"))
$appRoot = Join-Path $InstallRoot "app"
$nodeRoot = Join-Path $InstallRoot "runtime\node"
$managedRoot = Join-Path $InstallRoot "runtime\managed-pi"
$configRoot = Join-Path $InstallRoot "config"

function Fail([string]$Message) {
  [Console]::Error.WriteLine("[Pi Chat Setup] $Message")
  exit 1
}

function Download([string]$Url, [string]$Path) {
  Write-Host "下载 $Url"
  Invoke-WebRequest -Uri $Url -OutFile $Path -UseBasicParsing
}

function EnsureDirectory([string]$Path) {
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
}

function Get-ReleaseAsset {
  $uri = if ($ReleaseTag -eq "latest") {
    "https://api.github.com/repos/$repo/releases/latest"
  } else {
    "https://api.github.com/repos/$repo/releases/tags/$ReleaseTag"
  }
  $release = Invoke-RestMethod -Uri $uri -Headers @{ Accept = "application/vnd.github+json" } -UseBasicParsing
  $asset = @($release.assets) | Where-Object { $_.name -match '^pi-chat-windows-\d+\.\d+\.\d+\.zip$' } | Select-Object -First 1
  if (-not $asset) { throw "Release $($release.tag_name) 没有可用的 Windows Pi Chat ZIP。" }
  $checksumAsset = @($release.assets) | Where-Object { $_.name -eq "$($asset.name).sha256" } | Select-Object -First 1
  if (-not $checksumAsset) { throw "Release $($release.tag_name) 缺少 Pi Chat ZIP 校验文件。" }
  return @{ Tag = [string]$release.tag_name; Name = [string]$asset.name; Url = [string]$asset.browser_download_url; ChecksumUrl = [string]$checksumAsset.browser_download_url }
}

function InstallNode {
  EnsureDirectory $temporary
  $archiveName = "node-v$nodeVersion-win-x64.zip"
  $archive = Join-Path $temporary $archiveName
  $checksums = Join-Path $temporary "SHASUMS256.txt"
  Download "https://nodejs.org/dist/v$nodeVersion/$archiveName" $archive
  Download "https://nodejs.org/dist/v$nodeVersion/SHASUMS256.txt" $checksums
  $record = Get-Content -LiteralPath $checksums | Where-Object { $_ -match "\s$([regex]::Escape($archiveName))$" } | Select-Object -First 1
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
  $archive = Join-Path $temporary $asset.Name
  $checksumFile = Join-Path $temporary "$($asset.Name).sha256"
  Download $asset.Url $archive
  Download $asset.ChecksumUrl $checksumFile
  $record = Get-Content -LiteralPath $checksumFile | Where-Object { $_ -match "^([a-fA-F0-9]{64})\s+[* ]?$([regex]::Escape($asset.Name))$" } | Select-Object -First 1
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
  $metadata = Invoke-RestMethod -Uri "https://registry.npmjs.org/$([uri]::EscapeDataString($piPackage))" -Headers @{ Accept = "application/json" } -UseBasicParsing
  $version = [string]$metadata.'dist-tags'.latest
  if ($version -notmatch '^\d+\.\d+\.\d+') { throw "npm Registry 没有返回有效的 Pi Runtime 版本。" }
  $releaseRoot = Join-Path $managedRoot ("releases\" + $version)
  EnsureDirectory $releaseRoot
  $node = Join-Path $nodeRoot "node.exe"
  $npm = Join-Path $nodeRoot "node_modules\npm\bin\npm-cli.js"
  if (-not (Test-Path $npm)) { throw "随 Node.js 提供的 npm 不完整，无法安装 Pi Runtime。" }
  Write-Host "安装 Pi Runtime $version 到 $releaseRoot"
  & $node $npm install --prefix $releaseRoot "$piPackage@$version" --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "Pi Runtime 安装失败。" }
  Set-Content -LiteralPath (Join-Path $managedRoot "current-version") -Value $version -NoNewline -Encoding ascii
  return $managedRoot
}

try {
  EnsureDirectory $InstallRoot
  EnsureDirectory $temporary
  Write-Host "准备安装 Pi Chat 到 $InstallRoot"
  InstallNode
  $asset = Get-ReleaseAsset
  InstallApp $asset
  $existing = DetectExistingPi
  $managedPath = $null
  if ($existing) {
    Write-Host "检测到本机 Pi $($existing.version)：$($existing.entry)"
    $useExisting = $true
    if (-not $NonInteractive -and $env:PI_CHAT_NONINTERACTIVE -ne "1") {
      $answer = Read-Host "是否使用检测到的本机 Pi？[Y/n]"
      $useExisting = $answer -notmatch '^(n|no|否)$'
    }
    if (-not $useExisting) { $managedPath = InstallManagedPi }
  } else {
    Write-Host "未检测到可用 Pi，将安装 PiChat 管理的 Pi Runtime。"
    $managedPath = InstallManagedPi
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
  Write-Host "安装完成：$($asset.Tag)"
  Write-Host "首次启动将打开浏览器，并继续使用本机 Pi 或 PiChat 管理的 Pi Runtime。"
  Start-Process -FilePath $launcher -WorkingDirectory $appRoot
} catch {
  Fail $_.Exception.Message
} finally {
  Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
