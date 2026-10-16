param(
  [string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
try {
  . (Join-Path $PSScriptRoot 'pi-chat-resolve-runtime.ps1')
  $project = Get-PiChatCanonicalDirectory $ProjectDirectory
  $configRoot = Join-Path $project 'config'
  if (-not (Test-Path -LiteralPath $configRoot)) { $configRoot = Join-Path (Split-Path -Parent $project) 'config' }
  $runtimeEnv = Join-Path $configRoot 'runtime.env'
  if (Test-Path -LiteralPath $runtimeEnv) {
    Get-Content -LiteralPath $runtimeEnv | ForEach-Object {
      if ($_ -match '^([A-Z][A-Z0-9_]*)=(.*)$') { Set-Item -Path ("Env:" + $matches[1]) -Value $matches[2] }
    }
  }
  $node = (Get-PiChatNodeResolution $project).Path
  $entry = Join-Path $project 'dist\server\server\index.js'
  $process = Start-Process -FilePath $node -ArgumentList @(('"' + $entry + '"'), '--port', '30170') -WorkingDirectory $project -WindowStyle Hidden -RedirectStandardOutput $env:PI_CHAT_SERVER_OUT -RedirectStandardError $env:PI_CHAT_SERVER_ERR -PassThru
  # Retain the process handle so Windows PowerShell can read a fast child's exit code.
  $null = $process.Handle
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  do {
    if ($process.HasExited) {
      $process.WaitForExit()
      $process.Refresh()
      $exitDetail = if ($null -ne $process.ExitCode) { " (exit code $($process.ExitCode))" } else { '' }
      throw "Pi Chat service exited before it was ready$exitDetail."
    }
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $project 'scripts\pi-chat-port-ready.ps1') -ProjectDirectory $project
    if ($LASTEXITCODE -eq 0) { exit 0 }
    if ($LASTEXITCODE -eq 2) { throw 'A different Pi Chat build is listening on port 30170. Close it from its own window before starting this version.' }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'Pi Chat did not become ready within 60 seconds. Check the server logs and whether another program occupies port 30170.'
} catch {
  foreach ($logPath in @($env:PI_CHAT_SERVER_OUT, $env:PI_CHAT_SERVER_ERR)) {
    if ($logPath -and (Test-Path -LiteralPath $logPath)) {
      [Console]::Error.WriteLine("--- Server log: $logPath ---")
      Get-Content -LiteralPath $logPath -Tail 20 -ErrorAction SilentlyContinue | ForEach-Object { [Console]::Error.WriteLine($_) }
    }
  }
  [Console]::Error.WriteLine("[Pi Chat] " + $_.Exception.Message)
  exit 1
} finally {
  if ($process) { $process.Dispose() }
}
