# sync-bundle.ps1 — copy the built doorman bundle into DSH profiles that depend on it.
#
# Why: `dsh plugin add` installs a `file:` dependency as a *copy* into the profile's
# node_modules, so editing bundle/ alone changes nothing at runtime. Run this after
# every build, then restart the Desktop app (or `dsh web`) to load the new code.
#
# Usage:
#   pwsh -File tools/sync-bundle.ps1                 # sync into all matching profiles
#   pwsh -File tools/sync-bundle.ps1 -Profile desktop
#   pwsh -File tools/sync-bundle.ps1 -WhatIf         # preview only
#   pwsh -File tools/sync-bundle.ps1 -Restart        # sync, then restart the Desktop app
param(
  [string[]]$Profile = @('desktop', 'web'),
  [switch]$Restart,
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'

$RepoRoot  = Split-Path -Parent $PSScriptRoot
$SourceDir = Join-Path $RepoRoot 'bundle\dsh-a2a-doorman'
$Source    = Join-Path $SourceDir 'index.js'
$DshHome   = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$PackageName = 'dsh-a2a-doorman'

if (-not (Test-Path -LiteralPath $Source)) { throw "built bundle missing: $Source" }
$sourceHash = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash
Write-Host "source : $Source"
Write-Host "sha256 : $sourceHash"

$synced = 0
foreach ($name in $Profile) {
  $target = Join-Path $DshHome "profiles\$name\node_modules\$PackageName"
  if (-not (Test-Path -LiteralPath (Join-Path $target 'index.js'))) {
    Write-Host "skip   : $name (not installed at $target)"
    continue
  }
  $targetFile = Join-Path $target 'index.js'
  $targetHash = (Get-FileHash -LiteralPath $targetFile -Algorithm SHA256).Hash
  if ($targetHash -eq $sourceHash) {
    Write-Host "ok     : $name (already in sync)"
    continue
  }
  if ($WhatIf) {
    Write-Host "would  : copy -> $targetFile"
    continue
  }
  Get-ChildItem -LiteralPath $SourceDir -Force | Copy-Item -Destination $target -Recurse -Force
  $newHash = (Get-FileHash -LiteralPath $targetFile -Algorithm SHA256).Hash
  if ($newHash -ne $sourceHash) { throw "copy verification failed for $name" }
  Write-Host "synced : $name -> $target"
  $synced++
}

if ($synced -gt 0 -and -not $WhatIf) {
  Write-Host ''
  Write-Host "Reload required: restart the Desktop app (or stop and restart 'dsh web')."
}

if ($Restart) {
  if ($WhatIf) { Write-Host 'would  : restart the Desktop app'; exit 0 }
  $exe = 'D:\Program Files\DeepSeek Harness\DeepSeek Harness.exe'
  if (-not (Test-Path -LiteralPath $exe)) { throw "desktop executable not found: $exe" }
  Write-Host 'restarting the Desktop app...'
  Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
  Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe) | Out-Null
  Write-Host 'Desktop app relaunched.'
}
