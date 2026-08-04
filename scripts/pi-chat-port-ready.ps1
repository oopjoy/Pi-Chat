$ErrorActionPreference = 'Stop'
try {
  # Only the handshake is tokenless. It proves that Pi Chat owns the port and
  # returns the token the browser will use for the protected bootstrap request.
  # Runtime readiness is intentionally not part of launcher readiness.
  $handshake = Invoke-RestMethod -Uri 'http://127.0.0.1:30170/api/bootstrap/handshake' -Method Get -TimeoutSec 2
  if ($handshake.requestToken -and $handshake.buildIdentity -and $handshake.buildIdentity.fingerprint) { exit 0 }
} catch {
  # Not listening, still starting, or an unrelated service owns the port.
}
exit 1
