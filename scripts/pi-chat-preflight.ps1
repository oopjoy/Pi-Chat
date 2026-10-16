param(
  [string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
try {
  . (Join-Path $PSScriptRoot 'pi-chat-resolve-runtime.ps1')
  $project = Get-PiChatCanonicalDirectory $ProjectDirectory
  $resolved = Get-PiChatNodeResolution $project
  & $resolved.Path (Join-Path $project 'scripts\check-runtime-files.mjs') $project
  exit $LASTEXITCODE
} catch {
  [Console]::Error.WriteLine("[Pi Chat] Startup check failed: " + $_.Exception.Message)
  exit 1
}
