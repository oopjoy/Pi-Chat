function Get-PiChatLauncherExitCode {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [System.Diagnostics.Process]$Process
  )

  # Windows PowerShell 5 may leave ExitCode unset for a PassThru process that
  # redirects output until both WaitForExit and Refresh have completed.
  $Process.WaitForExit()
  $Process.Refresh()
  return [int]$Process.ExitCode
}

function Start-PiChatLauncherProcess {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectDirectory,
    [Parameter(Mandatory = $true)]
    [string]$LauncherPath,
    [Parameter(Mandatory = $true)]
    [ValidateSet('web', 'pwa')]
    [string]$Mode,
    [Parameter(Mandatory = $true)]
    [string]$StandardOutputPath,
    [Parameter(Mandatory = $true)]
    [string]$StandardErrorPath
  )

  # Windows PowerShell 5 joins Start-Process ArgumentList values into a single
  # command line. Keep that line constant and pass all variable values through
  # the environment so spaces and shell metacharacters cannot break quoting.
  $env:PI_CHAT_LAUNCHER = $LauncherPath
  $env:PI_CHAT_LAUNCH_MODE = $Mode
  Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" `
    -ArgumentList @('/d', '/c', 'call "%PI_CHAT_LAUNCHER%" %PI_CHAT_LAUNCH_MODE%') `
    -WorkingDirectory $ProjectDirectory `
    -WindowStyle Hidden `
    -RedirectStandardOutput $StandardOutputPath `
    -RedirectStandardError $StandardErrorPath `
    -PassThru
}
