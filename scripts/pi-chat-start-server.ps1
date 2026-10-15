param(
  [string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
try {
  $runtimeRoot = Join-Path $ProjectDirectory 'runtime'
  if (-not (Test-Path -LiteralPath $runtimeRoot)) { $runtimeRoot = Join-Path (Split-Path -Parent $ProjectDirectory) 'runtime' }
  $configRoot = Join-Path $ProjectDirectory 'config'
  if (-not (Test-Path -LiteralPath $configRoot)) { $configRoot = Join-Path (Split-Path -Parent $ProjectDirectory) 'config' }
  $runtimeEnv = Join-Path $configRoot 'runtime.env'
  if (Test-Path -LiteralPath $runtimeEnv) {
    Get-Content -LiteralPath $runtimeEnv | ForEach-Object {
      if ($_ -match '^([A-Z][A-Z0-9_]*)=(.*)$') { Set-Item -Path ("Env:" + $matches[1]) -Value $matches[2] }
    }
  }
  $bundledNode = Join-Path $runtimeRoot 'node\node.exe'
  $node = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
  $entry = Join-Path $ProjectDirectory 'dist\server\server\index.js'
  $process = Start-Process -FilePath $node -ArgumentList @(('"' + $entry + '"'), '--port', '30170') -WorkingDirectory $ProjectDirectory -WindowStyle Hidden -RedirectStandardOutput $env:PI_CHAT_SERVER_OUT -RedirectStandardError $env:PI_CHAT_SERVER_ERR -PassThru
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
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $ProjectDirectory 'scripts\pi-chat-port-ready.ps1') -ProjectDirectory $ProjectDirectory
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
