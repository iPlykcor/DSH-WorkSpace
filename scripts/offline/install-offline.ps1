<#
.SYNOPSIS
Install dsh-octopus-operation-space into a DSH profile WITHOUT npm, pnpm, or any network access.

.DESCRIPTION
`dsh plugin add` is the official path, but it runs pnpm and therefore wants a registry (metadata at
minimum). On an air-gapped host that is not available. This installer does the two things that mount
a DSH plugin, with plain file operations:

  1. it copies the already-built package into <DSH_HOME>\profiles\<profile>\node_modules\<name>;
  2. it writes the two mount entries into <DSH_HOME>\profiles\<profile>\package.json -
     `dependencies["<name>"]` AND `dsh.profile.bundles[]`.

Both entries are required. Writing only the first one makes the profile demand a package it cannot
load, and the next start fails; writing only the second one mounts nothing. This is the same pair
`dsh plugin add` writes, so an offline install and an official install end up structurally identical.

The package carries no runtime dependencies of its own (its peers are provided by DSH itself), so
nothing has to be resolved - which is exactly why the file-operation path is faithful here.

Safety: the profile manifest is backed up before anything is written, a replaced plugin directory is
kept aside rather than deleted, every written file is checked against SHA256SUMS.txt, and any failure
restores both. The script NEVER restarts `dsh web`: the install takes effect on the next start, and
killing a running host would throw away whatever the user is doing.

.PARAMETER DshHome
Target DSH home. Defaults to $env:DSH_HOME, else %USERPROFILE%\.dsh.

.PARAMETER Profile
Profile to install into. Defaults to 'web'.

.PARAMETER PackageDir
Directory holding the built package (package.json, lib/, src/, ...). Defaults to `package` next to
this script, which is how the offline bundle is laid out.

.PARAMETER DryRun
Print the plan and write nothing.

.PARAMETER Yes
Do not ask for confirmation.

.PARAMETER Force
Install even when the DSH version probe cannot confirm compatibility. Without it an unreadable or
out-of-range DSH version stops the install - a plugin mounted under an incompatible DSH is skipped
at startup with no plugin error in the log, which is a silent failure worth refusing.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-offline.ps1 -DryRun
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-offline.ps1 -Yes
# Its own test entry (never touches the real profile):
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-offline.ps1 -DshHome "$env:TEMP\dsh-offline-test" -Yes
#>
[CmdletBinding()]
param(
  [string]$DshHome = '',
  [string]$Profile = 'web',
  [string]$PackageDir = '',
  [switch]$DryRun,
  [switch]$Yes,
  [switch]$Force
)

# The repo's PS 5.1 rule: every string this script PRINTS is ASCII, because a BOM-less UTF-8 script
# is read by Windows PowerShell through the system ANSI code page (GBK here) and non-ASCII output
# turns into mojibake. The Chinese install guide next to this script is a UTF-8 file the operator
# opens in an editor, which is not subject to that rule.
$ErrorActionPreference = 'Stop'

# $PSScriptRoot is EMPTY inside a param() default on PS 5.1 (measured): resolve the defaults here.
$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $scriptDir) { throw "cannot determine the script directory" }
if (-not $DshHome) { $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' } }
if (-not $PackageDir) { $PackageDir = Join-Path $scriptDir 'package' }
$script:failures = 0

function Write-Step([string]$Text) { Write-Host ""; Write-Host "==> $Text" }
function Write-Pass([string]$Text) { Write-Host "  PASS  $Text" }
function Write-Note([string]$Text) { Write-Host "  NOTE  $Text" }
function Write-Fail([string]$Text) { Write-Host "  FAIL  $Text"; $script:failures++ }

function Get-Sha256([string]$Path) {
  return (Get-FileHash -Path $Path -Algorithm SHA256).Hash
}

# An empty read is a hard error: `[string](Get-Content -Raw)` returns $null for an empty file and the
# following .Trim() throws (measured on PS 5.1, see AGENTS.md section 2).
function Read-TextFile([string]$Path) {
  $text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
  if ($null -eq $text) { throw "could not read $Path" }
  return $text
}

# PS 5.1's `Set-Content -Encoding UTF8` writes a BOM, and a BOM in the profile manifest is not what
# `dsh plugin add` leaves behind. Write BOM-less UTF-8 through .NET instead.
function Write-TextFile([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

<#
The plugin's declared peer ranges are `^0.1.7-rc.1 || ^0.2.0-rc.1`, i.e. [0.1.7-rc.1, 0.3.0). Caret on
0.x locks the minor version, and semver only matches a prerelease against a comparator that shares the
major.minor.patch tuple AND carries a prerelease - which is why the range needs both spellings. This
check mirrors that range instead of trusting a "should be fine".
#>
function Test-DshVersion([string]$Version) {
  if ($Version -notmatch '^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.\-]+))?') { return 'unknown' }
  $major = [int]$Matches[1]
  $minor = [int]$Matches[2]
  $patch = [int]$Matches[3]
  $pre = $Matches[4]
  $tuple = ($major * 1000000) + ($minor * 1000) + $patch
  if ($tuple -lt 1007) { return 'no' }        # older than 0.1.7
  if ($tuple -ge 3000) { return 'no' }        # 0.3.0 and later: outside both ranges
  if ($tuple -eq 1007 -and $pre) {
    # 0.1.7 prereleases lower than rc.1 (0.1.7-rc.0, 0.1.7-alpha...) are excluded by ^0.1.7-rc.1.
    if ($pre -notmatch '^rc\.(\d+)$') { return 'no' }
    if ([int]$Matches[1] -lt 1) { return 'no' }
  }
  return 'yes'
}

function Find-DshVersion {
  $candidates = New-Object System.Collections.Generic.List[string]
  $command = Get-Command dsh -ErrorAction SilentlyContinue
  if ($command -and $command.Source) {
    $binDir = Split-Path -Parent $command.Source
    if ($binDir) { $candidates.Add((Join-Path $binDir 'node_modules\@deepseek-ai\dsh\package.json')) }
  }
  if ($env:APPDATA) { $candidates.Add((Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\package.json')) }
  if ($env:ProgramFiles) { $candidates.Add((Join-Path $env:ProgramFiles 'nodejs\node_modules\@deepseek-ai\dsh\package.json')) }
  $candidates.Add((Join-Path $DshHome 'node_modules\@deepseek-ai\dsh\package.json'))
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      try {
        $manifest = (Read-TextFile $candidate) | ConvertFrom-Json
        if ($manifest.version) { return @{ Path = $candidate; Version = $manifest.version } }
      } catch {
        Write-Note "could not parse $candidate"
      }
    }
  }
  return $null
}

# ---------------------------------------------------------------------------------------------------
Write-Host "dsh-octopus-operation-space - offline install"
Write-Host "  dsh home : $DshHome"
Write-Host "  profile  : $Profile"
Write-Host "  package  : $PackageDir"
if ($DryRun) { Write-Host "  mode     : DRY RUN (nothing will be written)" }

Write-Step "read the bundle"
$sourceManifestPath = Join-Path $PackageDir 'package.json'
if (-not (Test-Path $sourceManifestPath)) { throw "no package.json in $PackageDir - point -PackageDir at the bundle's 'package' directory" }
$sourceManifest = (Read-TextFile $sourceManifestPath) | ConvertFrom-Json
$pluginName = $sourceManifest.name
$pluginVersion = $sourceManifest.version
if (-not $pluginName -or -not $pluginVersion) { throw "$sourceManifestPath does not declare name/version" }
$required = @('lib\index.js', 'lib\client.js', 'lib\client-registry.js', 'lib\invariant.js', 'dsh.plugin.json', 'cordis.patch.yml')
foreach ($relative in $required) {
  if (-not (Test-Path (Join-Path $PackageDir $relative))) { throw "the bundle is incomplete: $relative is missing" }
}
Write-Pass "$pluginName@$pluginVersion ($($required.Count) required files present)"

$profileDir = Join-Path $DshHome "profiles\$Profile"
$profileManifestPath = Join-Path $profileDir 'package.json'
$pluginDirName = $pluginName
$pluginDir = Join-Path $profileDir "node_modules\$pluginDirName"

Write-Step "check the target profile"
if (-not (Test-Path $profileManifestPath)) {
  Write-Fail "no profile manifest at $profileManifestPath"
  throw "start DSH once with this DSH_HOME so the '$Profile' profile exists, then run this installer again (dsh web --port 0 --no-open, then stop it)"
}
Write-Pass "found $profileManifestPath"

Write-Step "check the DSH version (the plugin's peers are provided by DSH itself)"
$dsh = Find-DshVersion
$verdict = 'unknown'
if ($dsh) {
  $verdict = Test-DshVersion $dsh.Version
  Write-Host "  dsh version: $($dsh.Version)  ($($dsh.Path))"
} else {
  Write-Note "no @deepseek-ai/dsh package.json found; cannot verify compatibility"
}
if ($verdict -eq 'yes') {
  Write-Pass "DSH $($dsh.Version) is inside the supported range ^0.1.7-rc.1 || ^0.2.0-rc.1"
} elseif ($Force) {
  Write-Note "compatibility not confirmed ($verdict) but -Force was given; continuing"
} else {
  Write-Fail "DSH version is not a supported one ($verdict): the plugin declares ^0.1.7-rc.1 || ^0.2.0-rc.1"
  throw "install refused. An unsupported bundle is silently skipped at startup (the tab just disappears, with no plugin error in the log). Pass -Force to install anyway."
}

if (-not $DryRun -and -not $Yes) {
  $answer = Read-Host "Install $pluginName@$pluginVersion into $profileDir ? [y/N]"
  if ($answer -notmatch '^(y|Y|yes|YES)$') { Write-Host "aborted by the operator"; exit 2 }
}

# ---------------------------------------------------------------------------------------------------
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $profileDir "octopus-offline-backups\$stamp"
$displacedDir = $null
$manifestBackup = $null
$manifestWritten = $false

if ($DryRun) {
  Write-Step "plan"
  Write-Host "  1. back up the profile manifest to $backupDir\package.json"
  Write-Host "  2. copy $PackageDir  ->  $pluginDir"
  Write-Host "  3. set dependencies['$pluginName'] in the profile manifest"
  Write-Host "  4. add '$pluginName' to dsh.profile.bundles in the profile manifest"
  Write-Host "  5. verify every copied file against SHA256SUMS.txt and both mount entries"
  Write-Host ""
  Write-Host "DRY RUN complete - nothing was written."
  exit 0
}

try {
  Write-Step "back up the profile manifest"
  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
  $manifestBackup = Join-Path $backupDir 'package.json'
  Copy-Item -Path $profileManifestPath -Destination $manifestBackup -Force
  Write-Pass "backed up to $manifestBackup"

  Write-Step "install the package files"
  if (Test-Path $pluginDir) {
    # Keep the previous install aside instead of deleting it: this branch is what makes an in-place
    # upgrade reversible on a host that has no package manager to fall back on.
    $displacedDir = "$pluginDir.replaced-$stamp"
    Move-Item -Path $pluginDir -Destination $displacedDir -Force
    Write-Note "moved the previous install aside to $(Split-Path -Leaf $displacedDir)"
  }
  New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null
  Copy-Item -Path (Join-Path $PackageDir '*') -Destination $pluginDir -Recurse -Force
  Write-Pass "copied $PackageDir -> $pluginDir"

  Write-Step "write the two mount entries"
  $manifest = (Read-TextFile $profileManifestPath) | ConvertFrom-Json
  $tarballName = "$pluginName-$pluginVersion.tgz"
  $tarballPath = Join-Path (Split-Path -Parent $PackageDir) $tarballName
  # Mirror what `dsh plugin add` writes: a file: spec pointing at the bundle's tarball, forward
  # slashes included. If the tarball is not next to the package, fall back to the package path so the
  # spec never dangles.
  $spec = if (Test-Path $tarballPath) { 'file:' + ($tarballPath -replace '\\', '/') }
          else { 'file:' + (($PackageDir -replace '\\', '/')) }
  if (-not $manifest.dependencies) { $manifest | Add-Member -NotePropertyName dependencies -NotePropertyValue (New-Object PSObject) }
  $existing = $manifest.dependencies.PSObject.Properties[$pluginName]
  if ($existing) { $existing.Value = $spec } else { $manifest.dependencies | Add-Member -NotePropertyName $pluginName -NotePropertyValue $spec }
  if (-not $manifest.dsh) { $manifest | Add-Member -NotePropertyName dsh -NotePropertyValue (New-Object PSObject) }
  if (-not $manifest.dsh.profile) { $manifest.dsh | Add-Member -NotePropertyName profile -NotePropertyValue (New-Object PSObject) }
  $bundles = @($manifest.dsh.profile.bundles)
  if ($bundles -notcontains $pluginName) {
    $bundles += $pluginName
    if ($manifest.dsh.profile.PSObject.Properties['bundles']) { $manifest.dsh.profile.bundles = $bundles }
    else { $manifest.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles }
  }
  Write-TextFile $profileManifestPath ($manifest | ConvertTo-Json -Depth 12)
  $manifestWritten = $true
  Write-Pass "dependencies['$pluginName'] = $spec"
  Write-Pass "dsh.profile.bundles = $($bundles -join ', ')"

  Write-Step "verify"
  $written = (Read-TextFile $profileManifestPath) | ConvertFrom-Json
  if (-not $written.dependencies.PSObject.Properties[$pluginName]) { Write-Fail "the dependency entry is missing after the write" } else { Write-Pass "the profile lists the dependency" }
  if (@($written.dsh.profile.bundles) -notcontains $pluginName) { Write-Fail "the bundles entry is missing after the write" } else { Write-Pass "the profile lists the bundle" }
  $installedManifest = (Read-TextFile (Join-Path $pluginDir 'package.json')) | ConvertFrom-Json
  if ($installedManifest.version -ne $pluginVersion) { Write-Fail "installed version is $($installedManifest.version), expected $pluginVersion" } else { Write-Pass "installed version is $pluginVersion" }

  # SHA256SUMS.txt sits next to this script in the bundle; the parent is checked too so the script also
  # works when it is run from a copy that lives one level down.
  $sumsPath = Join-Path $scriptDir 'SHA256SUMS.txt'
  if (-not (Test-Path $sumsPath)) { $sumsPath = Join-Path (Split-Path -Parent $scriptDir) 'SHA256SUMS.txt' }
  if (Test-Path $sumsPath) {
    $checked = 0
    foreach ($line in (Get-Content $sumsPath)) {
      if ($line -notmatch '^([0-9A-Fa-f]{64})\s+\*?(.+)$') { continue }
      $expected = $Matches[1].ToUpperInvariant()
      $relative = $Matches[2].Trim()
      if ($relative -notlike 'package/*') { continue }
      $target = Join-Path $pluginDir ($relative.Substring('package/'.Length) -replace '/', '\')
      if (-not (Test-Path $target)) { Write-Fail "missing after the copy: $relative"; continue }
      $actual = Get-Sha256 $target
      if ($actual -ne $expected) { Write-Fail "hash mismatch: $relative" } else { $checked++ }
    }
    if ($checked -gt 0) { Write-Pass "$checked files match SHA256SUMS.txt" }
  } else {
    Write-Note "no SHA256SUMS.txt next to the bundle; skipped the hash check"
  }

  $installedIndex = Join-Path $pluginDir 'lib\index.js'
  if (Test-Path $installedIndex) { Write-Pass "lib\index.js sha256 $((Get-Sha256 $installedIndex).Substring(0, 12))..." }

  if ($script:failures -gt 0) { throw "verification failed ($script:failures problem(s))" }
  if ($displacedDir) { Remove-Item -Path $displacedDir -Recurse -Force; Write-Note "removed the displaced previous install" }

  Write-Step "done"
  Write-Host "  package : $pluginName@$pluginVersion"
  Write-Host "  profile : $profileDir"
  Write-Host "  backup  : $manifestBackup"
  Write-Host ""
  Write-Host "  NEXT: restart dsh web (this script never restarts it) - the plugin loads on the NEXT start."
  Write-Host "        The sidebar gains the operation-space tab, its start-page card, and Ctrl+Alt+S."
  Write-Host ""
  Write-Host "  To undo:"
  Write-Host "        powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall-plugin.ps1 -Yes"
  Write-Host "        Copy-Item '$manifestBackup' '$profileManifestPath' -Force"
  $installed = $true
} catch {
  Write-Fail $_.Exception.Message
  Write-Step "rolling back"
  if ($manifestWritten -and $manifestBackup) {
    Copy-Item -Path $manifestBackup -Destination $profileManifestPath -Force
    Write-Pass "restored the profile manifest from $manifestBackup"
  }
  if ($displacedDir -and (Test-Path $displacedDir)) {
    if (Test-Path $pluginDir) { Remove-Item -Path $pluginDir -Recurse -Force -ErrorAction SilentlyContinue }
    Move-Item -Path $displacedDir -Destination $pluginDir -Force
    Write-Pass "restored the previous install"
  } elseif (Test-Path $pluginDir) {
    # Nothing was there before: leave nothing behind.
    Remove-Item -Path $pluginDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Pass "removed the partially copied package"
  }
  Write-Host ""
  throw "install failed; the profile is back to its previous state"
}
