$listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 30170 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
  exit 0
}
exit 1
