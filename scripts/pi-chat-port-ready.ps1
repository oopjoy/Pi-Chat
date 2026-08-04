param(
  [int]$Port = 30170,
  [string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$identityPath = Join-Path $ProjectDirectory 'dist\build-identity.json'
try {
  # This is the desired build on disk, not merely an arbitrary Pi Chat listener.
  # A stale Node process can continue to serve a replaced dist\web directory.
  $expected = Get-Content -LiteralPath $identityPath -Raw | ConvertFrom-Json
  if ($expected.schemaVersion -ne 1 -or $expected.fingerprint -notmatch '^[a-f0-9]{64}$') { exit 1 }

  # Only the handshake is tokenless. It proves that Pi Chat owns the port and
  # returns the token the browser will use for protected requests. Runtime
  # readiness is intentionally not part of launcher readiness.
  $handshake = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/bootstrap/handshake" -Method Get -TimeoutSec 2
  if (-not $handshake.requestToken -or -not $handshake.buildIdentity -or $handshake.buildIdentity.fingerprint -notmatch '^[a-f0-9]{64}$') { exit 1 }
  if ($handshake.buildIdentity.schemaVersion -eq $expected.schemaVersion -and $handshake.buildIdentity.fingerprint -eq $expected.fingerprint) { exit 0 }

  # The endpoint is an authenticated Pi Chat instance but it is not the build
  # represented by this launcher's local dist. cmd reports this conflict rather
  # than closing a potentially unrelated checkout or installation.
  exit 2
} catch {
  # Not listening, still starting, malformed desired identity, or an unrelated service owns the port.
  exit 1
}
