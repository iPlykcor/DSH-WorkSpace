<#
.SYNOPSIS
  Remove the octopus plugin from a dsh profile WITHOUT needing dsh to start.

.DESCRIPTION
  Recovery path for the case where a build of dsh-octopus-operation-space keeps
  DSH from starting at all. It is pure file surgery: no dsh CLI, no host process,
  no network, no restart. For every profile it

    1. backs the profile's package.json up,
    2. drops the dependency entry from package.json,
    3. deletes node_modules\dsh-octopus-operation-space (plus its .pnpm entries),
    4. strips any cordis.patch.yml / cordis.yml entry that mounts the plugin,
    5. verifies nothing points at the plugin any more and prints the next steps.

  Order matters on purpose: doing this by hand is easy to get wrong, and the dsh
  CLI is exactly the thing that may be refusing to run.

.PARAMETER DshHome
  The dsh home to repair. Defaults to $env:DSH_HOME, then to ~\.dsh.

.PARAMETER Profile
  Limit the sweep to one profile (default: every profile under <dsh home>\profiles).

.PARAMETER DryRun
  Print the plan and change nothing.

.PARAMETER Yes
  Skip the confirmation prompt.

.PARAMETER KeepBackup
  Do not copy package.json aside before editing it.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall-plugin.ps1 -DryRun

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall-plugin.ps1 -Yes
#>
[CmdletBinding()]
param(
  [string]$DshHome,
  [string]$Profile,
  [switch]$DryRun,
  [switch]$Yes,
  [switch]$KeepBackup
)

$ErrorActionPreference = 'Continue'
$pluginName = 'dsh-octopus-operation-space'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$problems = New-Object System.Collections.ArrayList

function Write-Head([string]$text) { Write-Host ''; Write-Host "== $text" }
function Write-Ok([string]$text) { Write-Host "  PASS  $text" }
function Write-Bad([string]$text) { Write-Host "  FAIL  $text"; [void]$problems.Add($text) }
function Write-Note([string]$text) { Write-Host "  NOTE  $text" }
function Write-Would([string]$text) { Write-Host "  WOULD $text" }

if (-not $DshHome -or $DshHome.Trim().Length -eq 0) {
  if ($env:DSH_HOME -and $env:DSH_HOME.Trim().Length -gt 0) { $DshHome = $env:DSH_HOME }
  else { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
}
$DshHome = [System.IO.Path]::GetFullPath($DshHome)

Write-Host "octopus uninstall"
Write-Host "  dsh home : $DshHome"
Write-Host "  plugin   : $pluginName"
if ($DryRun) { Write-Host "  mode     : DRY RUN (nothing is written)" }

if (-not (Test-Path $DshHome)) { Write-Bad "dsh home not found: $DshHome"; exit 1 }
$profilesRoot = Join-Path $DshHome 'profiles'
if (-not (Test-Path $profilesRoot)) { Write-Bad "no profiles directory under $DshHome"; exit 1 }

$targets = @()
if ($Profile -and $Profile.Trim().Length -gt 0) {
  $one = Join-Path $profilesRoot $Profile
  if (-not (Test-Path $one)) { Write-Bad "profile not found: $one"; exit 1 }
  $targets = @($one)
}
else {
  $targets = @(Get-ChildItem -Path $profilesRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne 'node_modules' } |
    ForEach-Object { $_.FullName })
  if ($targets.Count -eq 0) { Write-Bad "no profiles under $profilesRoot"; exit 1 }
}

# Plan first, so -DryRun and the confirmation prompt show the same list.
$plan = @()
foreach ($dir in $targets) {
  $manifestPath = Join-Path $dir 'package.json'
  $installedDir = Join-Path $dir "node_modules\$pluginName"
  $declared = $false
  $manifest = $null
  if (Test-Path $manifestPath) {
    try { $manifest = [string](Get-Content -Path $manifestPath -Raw) | ConvertFrom-Json }
    catch { $manifest = $null }
  }
  if ($manifest) {
    foreach ($section in @('dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies')) {
      $prop = $manifest.PSObject.Properties[$section]
      if ($prop -and $prop.Value -and $prop.Value.PSObject.Properties[$pluginName]) { $declared = $true }
    }
  }
  $ymlFiles = @()
  foreach ($yml in @('cordis.patch.yml', 'cordis.yml')) {
    $ymlPath = Join-Path $dir $yml
    if (Test-Path $ymlPath) {
      $text = [string](Get-Content -Path $ymlPath -Raw)
      if ($text -and $text.IndexOf($pluginName) -ge 0) { $ymlFiles += $ymlPath }
    }
  }
  $hasDir = Test-Path $installedDir
  $hasPnpm = $false
  $pnpmRoot = Join-Path $dir 'node_modules\.pnpm'
  if (Test-Path $pnpmRoot) {
    $hits = @(Get-ChildItem -Path $pnpmRoot -Directory -Filter "$pluginName@*" -ErrorAction SilentlyContinue)
    if ($hits.Count -gt 0) { $hasPnpm = $true }
  }
  $plan += [pscustomobject]@{
    Dir         = $dir
    Manifest    = $manifestPath
    Declared    = $declared
    Installed   = $hasDir
    Pnpm        = $hasPnpm
    Yml         = $ymlFiles
    Touched     = ($declared -or $hasDir -or $hasPnpm -or $ymlFiles.Count -gt 0)
  }
}

Write-Head 'plan'
$anyTouched = $false
foreach ($item in $plan) {
  if (-not $item.Touched) { Write-Note "$($item.Dir): plugin is not installed here"; continue }
  $anyTouched = $true
  Write-Host "  profile: $($item.Dir)"
  if ($item.Declared) { Write-Host "    - drop the dependency entry from package.json" }
  if ($item.Installed) { Write-Host "    - delete node_modules\$pluginName" }
  if ($item.Pnpm) { Write-Host "    - delete node_modules\.pnpm\$pluginName@*" }
  foreach ($yml in $item.Yml) { Write-Host "    - strip its entry from $(Split-Path -Leaf $yml)" }
}
if (-not $anyTouched) { Write-Note 'nothing to do: no profile references the plugin' }

if ($DryRun) {
  Write-Head 'result'
  Write-Ok 'dry run: the plan above is what -Yes would do'
  exit 0
}

if ($anyTouched -and -not $Yes) {
  Write-Host ''
  $answer = Read-Host 'Remove the plugin from the profiles listed above? [y/N]'
  if ($answer -notmatch '^(y|Y)') { Write-Host 'aborted'; exit 0 }
}

foreach ($item in $plan) {
  if (-not $item.Touched) { continue }
  Write-Head "cleaning $($item.Dir)"

  if (-not $KeepBackup -and (Test-Path $item.Manifest)) {
    $backupDir = Join-Path $item.Dir "octopus-uninstall-backups\$stamp"
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    Copy-Item -Path $item.Manifest -Destination (Join-Path $backupDir 'package.json') -Force
    Write-Ok "backed up package.json to $backupDir"
  }

  if ($item.Declared) {
    $manifest = $null
    try { $manifest = [string](Get-Content -Path $item.Manifest -Raw) | ConvertFrom-Json }
    catch { $manifest = $null }
    if (-not $manifest) {
      Write-Bad "cannot parse $($item.Manifest); remove the dependency by hand"
    }
    else {
      $removed = 0
      foreach ($section in @('dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies')) {
        $prop = $manifest.PSObject.Properties[$section]
        if ($prop -and $prop.Value -and $prop.Value.PSObject.Properties[$pluginName]) {
          $prop.Value.PSObject.Properties.Remove($pluginName)
          $removed++
        }
      }
      $json = $manifest | ConvertTo-Json -Depth 20
      [System.IO.File]::WriteAllText($item.Manifest, $json, (New-Object System.Text.UTF8Encoding($false)))
      Write-Ok "removed $removed dependency entr(y|ies) from package.json"
    }
  }

  foreach ($yml in $item.Yml) {
    $lines = @(Get-Content -Path $yml)
    $kept = @($lines | Where-Object { $_.IndexOf($pluginName) -lt 0 })
    [System.IO.File]::WriteAllLines($yml, $kept, (New-Object System.Text.UTF8Encoding($false)))
    Write-Ok "stripped $($lines.Count - $kept.Count) line(s) from $(Split-Path -Leaf $yml)"
  }

  $installedDir = Join-Path $item.Dir "node_modules\$pluginName"
  if (Test-Path $installedDir) {
    Remove-Item -Path $installedDir -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path $installedDir) { Write-Bad "could not delete $installedDir" }
    else { Write-Ok 'deleted the installed package' }
  }

  $pnpmRoot = Join-Path $item.Dir 'node_modules\.pnpm'
  if (Test-Path $pnpmRoot) {
    foreach ($hit in @(Get-ChildItem -Path $pnpmRoot -Directory -Filter "$pluginName@*" -ErrorAction SilentlyContinue)) {
      Remove-Item -Path $hit.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
    $linkPath = Join-Path $pnpmRoot "node_modules\$pluginName"
    if (Test-Path $linkPath) { Remove-Item -Path $linkPath -Recurse -Force -ErrorAction SilentlyContinue }
    Write-Ok 'cleaned the pnpm store entries'
  }
}

Write-Head 'verify'
foreach ($item in $plan) {
  if (-not $item.Touched) { continue }
  if (Test-Path (Join-Path $item.Dir "node_modules\$pluginName")) { Write-Bad "$($item.Dir): package directory still present" }

  $declared = $false
  if (Test-Path $item.Manifest) {
    $text = [string](Get-Content -Path $item.Manifest -Raw)
    if ($text -and $text.IndexOf($pluginName) -ge 0) { $declared = $true }
  }
  if ($declared) { Write-Bad "$($item.Dir): package.json still mentions the plugin" }

  foreach ($yml in @('cordis.patch.yml', 'cordis.yml')) {
    $ymlPath = Join-Path $item.Dir $yml
    if (-not (Test-Path $ymlPath)) { continue }
    $text = [string](Get-Content -Path $ymlPath -Raw)
    if ($text -and $text.IndexOf($pluginName) -ge 0) { Write-Bad "$($item.Dir): $yml still mentions the plugin" }
  }
  Write-Ok "$($item.Dir): no reference left"
}

Write-Head 'result'
if ($problems.Count -gt 0) {
  Write-Host "FAILED: $($problems.Count) problem(s) above"
  exit 1
}
Write-Ok 'the plugin is out of every profile it was installed in'
Write-Host ''
Write-Host 'NEXT: restart the host so the next start does not load it:'
Write-Host '  dsh web'
Write-Host 'To put it back later (after a fix):'
Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy.ps1 -Yes'
exit 0
