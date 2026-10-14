function Get-PiChatLauncherExitCode {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [System.Diagnostics.Process]$Process
  )

  $Process.WaitForExit()
  # Unknown is not success. In particular, never cast a null PowerShell 5
  # PassThru ExitCode to zero and open a different build's browser window.
  $code = $Process.ExitCode
  if ($null -eq $code) { throw 'The launcher exit code is unavailable; startup cannot be confirmed.' }
  return [int]$code
}

function Start-PiChatLauncherProcess {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$ProjectDirectory,
    [Parameter(Mandatory = $true)][string]$LauncherPath,
    [Parameter(Mandatory = $true)][ValidateSet('web', 'pwa')][string]$Mode,
    [Parameter(Mandatory = $true)][string]$StandardOutputPath,
    [Parameter(Mandatory = $true)][string]$StandardErrorPath
  )

  # Process.Start retains the original native handle, even for a very fast
  # failure. Start-Process -PassThru may reacquire a process only after it exits.
  # Keep all paths out of cmd source; /v:off also preserves literal ! characters.
  # cmd owns file redirection, avoiding asynchronous PowerShell pipe callbacks.
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = Join-Path $env:SystemRoot 'System32\cmd.exe'
  $info.Arguments = '/d /v:off /s /c ""%PI_CHAT_LAUNCHER%" %PI_CHAT_LAUNCH_MODE% 1>"%PI_CHAT_LAUNCH_OUT%" 2>"%PI_CHAT_LAUNCH_ERR%""'
  $info.WorkingDirectory = $ProjectDirectory
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.EnvironmentVariables['PI_CHAT_LAUNCHER'] = $LauncherPath
  $info.EnvironmentVariables['PI_CHAT_LAUNCH_MODE'] = $Mode
  $info.EnvironmentVariables['PI_CHAT_LAUNCH_OUT'] = $StandardOutputPath
  $info.EnvironmentVariables['PI_CHAT_LAUNCH_ERR'] = $StandardErrorPath
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $info
  try {
    if (-not $process.Start()) { throw 'The Pi Chat launcher could not start.' }
    return $process
  } catch {
    $process.Dispose()
    throw
  }
}
