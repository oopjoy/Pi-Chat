$ErrorActionPreference = 'Stop'
try {
  # Health is token-protected, while bootstrap is the deliberately tokenless
  # same-origin handshake that returns the current process token. Probe that
  # strong Pi Chat-specific shape directly; probing the protected health route first creates a
  # circular dependency and made the launcher wait through its full timeout.
  $bootstrap = Invoke-RestMethod -Uri 'http://127.0.0.1:30170/api/bootstrap' -Method Get -TimeoutSec 2
  if ($bootstrap.requestToken -and $null -ne $bootstrap.state -and $null -ne $bootstrap.sessions -and $null -ne $bootstrap.models) { exit 0 }
} catch {
  # Not listening, still starting, or an unrelated service owns the port.
}
exit 1
