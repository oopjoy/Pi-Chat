param(
  [string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
try {
  $node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $node) {
    throw 'Node.js was not found. Install Node.js 22.19 or newer from https://nodejs.org/, then reopen Pi Chat. A computer restart is not required.'
  }
  $versionText = (& $node.Source -p 'process.versions.node' | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '^\d+\.\d+\.\d+$' -or [version]$versionText -lt [version]'22.19.0') {
    throw "Node.js 22.19 or newer is required; detected: $versionText. Update Node.js, then reopen Pi Chat."
  }
  & $node.Source (Join-Path $ProjectDirectory 'scripts\check-runtime-files.mjs') $ProjectDirectory
  exit $LASTEXITCODE
} catch {
  [Console]::Error.WriteLine("[Pi Chat] Startup check failed: " + $_.Exception.Message)
  exit 1
}
