param(
  [string]$DesktopPath = [Environment]::GetFolderPath('DesktopDirectory'),
  [string]$StartMenuPath = ""
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
if ([string]::IsNullOrWhiteSpace($StartMenuPath)) {
  $StartMenuPath = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\Pi Chat Git'
}
[void](New-Item -ItemType Directory -Force -Path $StartMenuPath)

$powershellPath = Join-Path $PSHOME 'powershell.exe'
$shell = New-Object -ComObject WScript.Shell

function Install-PiChatShortcut {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][ValidateSet('web', 'pwa')][string]$Mode,
    [Parameter(Mandatory = $true)][string]$Description,
    [string[]]$Destinations = @($DesktopPath, $StartMenuPath)
  )

  foreach ($destination in $Destinations) {
    $shortcutPath = Join-Path $destination ($Name + '.lnk')
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
}

# Source-checkout shortcuts have their own names and Start-menu group. Never
# overwrite the generic Pi Chat / Pi Chat Web entries owned by native Setup.
Install-PiChatShortcut -Name 'Pi Chat Git' -Mode 'web' -Description 'Open this Pi Chat Git checkout in the default browser'
Install-PiChatShortcut -Name 'Pi Chat Git' -Mode 'web' -Description 'Open this Pi Chat Git checkout in the default browser' -Destinations @($project)
Install-PiChatShortcut -Name 'Pi Chat Git PWA' -Mode 'pwa' -Description 'Optional: open this Pi Chat Git checkout as a browser app' -Destinations @($StartMenuPath)
