# Shared by preflight and the server launcher. Prefer a system Node that meets
# Pi's floor (22.19+); otherwise use the Setup-bundled runtime. Canonicalize
# app\. so the sibling runtime\node next to the install root is found.

$script:PiChatNodeMinimum = [version]'22.19.0'

function Get-PiChatCanonicalDirectory {
  param([Parameter(Mandatory = $true)][string]$Path)
  return [IO.Path]::GetFullPath($Path)
}

function Get-PiChatBundledNodePath {
  param([Parameter(Mandatory = $true)][string]$ProjectDirectory)
  $project = Get-PiChatCanonicalDirectory $ProjectDirectory
  $candidates = @(
    (Join-Path $project 'runtime\node\node.exe'),
    (Join-Path (Split-Path -Parent $project) 'runtime\node\node.exe')
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  return $null
}

function Get-PiChatNodeVersion {
  param([Parameter(Mandatory = $true)][string]$NodePath)
  $text = (& $NodePath -p 'process.versions.node' | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $text -notmatch '^\d+\.\d+\.\d+$') {
    throw ('Could not read Node.js version from ' + $NodePath + ' (got: ' + $text + ').')
  }
  return $text
}

function Get-PiChatNodeResolution {
  param([Parameter(Mandatory = $true)][string]$ProjectDirectory)
  $bundled = Get-PiChatBundledNodePath $ProjectDirectory
  $system = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  $systemPath = $null
  if ($system) {
    $systemPath = if ($system.Source) { [string]$system.Source } else { [string]$system.FullName }
  }
  if ($systemPath -and $bundled) {
    try {
      if ([IO.Path]::GetFullPath($systemPath) -eq [IO.Path]::GetFullPath($bundled)) { $systemPath = $null }
    } catch { }
  }
  if ($systemPath) {
    $versionText = Get-PiChatNodeVersion $systemPath
    if ([version]$versionText -ge $script:PiChatNodeMinimum) {
      return [pscustomobject]@{ Path = $systemPath; Source = 'system'; Version = $versionText }
    }
    if (-not $bundled) {
      throw ('Node.js 22.19 or newer is required; detected: ' + $versionText + '. Update Node.js, then reopen Pi Chat.')
    }
    [Console]::Error.WriteLine('[Pi Chat] System Node ' + $versionText + ' is below 22.19; using the bundled Node runtime.')
  }
  if ($bundled) {
    $versionText = Get-PiChatNodeVersion $bundled
    if ([version]$versionText -lt $script:PiChatNodeMinimum) {
      throw ('Bundled Node.js 22.19 or newer is required; detected: ' + $versionText + '. Reinstall using the complete pi-chat-setup.exe.')
    }
    return [pscustomobject]@{ Path = $bundled; Source = 'bundled'; Version = $versionText }
  }
  throw 'Node.js was not found. Reinstall using the complete pi-chat-setup.exe, or for a source checkout install Node.js 22.19 or newer from https://nodejs.org/, then reopen Pi Chat. A computer restart is not required.'
}
