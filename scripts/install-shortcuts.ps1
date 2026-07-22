param(
  [string]$DesktopPath = [Environment]::GetFolderPath('DesktopDirectory')
)

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$launcherUi = Join-Path $project 'start-pi-chat-ui.ps1'
$iconPath = Join-Path $project 'resources\icons\pi-chat.ico'

foreach ($requiredPath in @($launcherUi, $iconPath)) {
  if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
    throw "Required launcher file was not found: $requiredPath"
  }
}
if ([string]::IsNullOrWhiteSpace($DesktopPath)) {
  throw 'Windows Desktop directory could not be resolved.'
}
[void](New-Item -ItemType Directory -Force -Path $DesktopPath)

$powershellPath = Join-Path $PSHOME 'powershell.exe'
$shell = New-Object -ComObject WScript.Shell

function Install-PiChatShortcut {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][ValidateSet('web', 'pwa')][string]$Mode,
    [Parameter(Mandatory = $true)][string]$Description
  )

  $shortcutPath = Join-Path $DesktopPath ($Name + '.lnk')
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $powershellPath
  $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcherUi + '" ' + $Mode
  $shortcut.WorkingDirectory = $project
  $shortcut.WindowStyle = 7
  $shortcut.IconLocation = $iconPath + ',0'
  $shortcut.Description = $Description
  $shortcut.Save()
  Write-Host "Installed $shortcutPath"
}

Install-PiChatShortcut -Name 'Pi Chat' -Mode 'pwa' -Description 'Open Pi Chat as an Edge app'
Install-PiChatShortcut -Name 'Pi Chat Web' -Mode 'web' -Description 'Open Pi Chat in the default browser'
