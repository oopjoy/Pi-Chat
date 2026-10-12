[CmdletBinding()]
param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "PiChat"),
  [switch]$NonInteractive
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$logPath = Join-Path ([IO.Path]::GetTempPath()) ("pi-chat-uninstall.log")
try { $logStream = New-Object IO.StreamWriter($logPath, $true) } catch { $logStream = $null }
function Log([string]$Message) {
  Write-Host $Message
  if ($logStream) { $logStream.WriteLine(('[{0}] {1}' -f (Get-Date -Format o), $Message)); $logStream.Flush() }
}
function LogError([string]$Message) {
  [Console]::Error.WriteLine($Message)
  if ($logStream) { $logStream.WriteLine(('[{0}] ERROR {1}' -f (Get-Date -Format o), $Message)); $logStream.Flush() }
}

if ($env:PI_CHAT_SETUP_INSTALL_ROOT) { $InstallRoot = $env:PI_CHAT_SETUP_INSTALL_ROOT }
if ($env:PI_CHAT_SETUP_NONINTERACTIVE -eq "1") { $NonInteractive = $true }

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

function Remove-PiChatShortcuts {
  $desktop = $env:PI_CHAT_SETUP_DESKTOP_PATH
  if ([string]::IsNullOrWhiteSpace($desktop)) { $desktop = [Environment]::GetFolderPath('DesktopDirectory') }
  $startMenu = $env:PI_CHAT_SETUP_START_MENU_PATH
  if ([string]::IsNullOrWhiteSpace($startMenu)) { $startMenu = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\Pi Chat' }
  foreach ($shortcut in @('Pi Chat.lnk', 'Pi Chat Web.lnk')) {
    foreach ($location in @($desktop, $startMenu)) {
      $path = Join-Path $location $shortcut
      if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Force
        Log ("移除快捷方式 " + $path)
      }
    }
  }
  if (Test-Path -LiteralPath $startMenu) {
    $remaining = @(Get-ChildItem -LiteralPath $startMenu -Force -ErrorAction SilentlyContinue)
    if ($remaining.Count -eq 0) { Remove-Item -LiteralPath $startMenu -Force -ErrorAction SilentlyContinue }
  }
}

try {
  Log ("准备卸载 Pi Chat（" + $InstallRoot + "）")
  if (Test-PiChatRunning) {
    throw "检测到 Pi Chat 正在运行（端口 30170 或安装目录中的 Node.js 进程）。请先关闭 Pi Chat 后再卸载。"
  }
  if (-not (Test-Path -LiteralPath $InstallRoot)) {
    Log "安装目录不存在，仅清理注册表项和快捷方式。"
  }
  if (-not $NonInteractive -and $env:PI_CHAT_NONINTERACTIVE -ne "1") {
    $answer = Read-Host "将卸载 Pi Chat（保留你的 Pi 数据、会话和受管 Pi）。确认卸载？[y/N]"
    if ($answer -notmatch '^(y|yes|是)$') { Log "已取消卸载。"; exit 0 }
  }
  Remove-PiChatShortcuts
  $uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Pi Chat'
  if (Test-Path -LiteralPath $uninstallKey) {
    Remove-Item -LiteralPath $uninstallKey -Recurse -Force
    Log "移除卸载注册表项"
  }
  if (Test-Path -LiteralPath $InstallRoot) {
    Remove-Item -LiteralPath $InstallRoot -Recurse -Force
    Log ("移除安装目录 " + $InstallRoot)
  }
  # ~/.pi/agent (sessions, settings, managed Pi) is user-owned Pi state and is
  # deliberately preserved; Pi Chat never deletes it during uninstall.
  Log "卸载完成。你的 Pi 数据、会话和 Skills 保留在 ~/.pi/agent，未受影响。"
} catch {
  LogError $_.Exception.ToString()
  [Console]::Error.WriteLine("[Pi Chat Uninstall] " + $_.Exception.Message)
  exit 1
} finally {
  if ($logStream) { $logStream.Dispose() }
}
