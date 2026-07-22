$ErrorActionPreference = 'Stop'
try {
  $health = Invoke-RestMethod -Uri 'http://127.0.0.1:30170/api/health' -Method Get -TimeoutSec 2
  if ($health.ok -ne $true) { exit 1 }
  if ($health.service -eq 'pi-chat') { exit 0 }

  # Upgrade compatibility for Pi Chat versions released before the explicit
  # service identity field. A generic { ok: true } endpoint is insufficient:
  # require the guarded Pi Chat bootstrap shape as a second fingerprint.
  $bootstrap = Invoke-RestMethod -Uri 'http://127.0.0.1:30170/api/bootstrap' -Method Get -TimeoutSec 2
  if ($bootstrap.requestToken -and $null -ne $bootstrap.state -and $null -ne $bootstrap.sessions -and $null -ne $bootstrap.models) { exit 0 }
} catch {
  # Not listening, still starting, or an unrelated service owns the port.
}
exit 1
