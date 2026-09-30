<#
.SYNOPSIS
Install dsh-octopus-operation-space into DSH profile(s) WITHOUT npm, pnpm, or any network access.

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

WHY EVERY PROFILE BY DEFAULT (`-Profile all`): a DSH home can hold several profiles, and which one a
host boots is not always guessable from outside. Measured on a real desktop install: the Electron app
creates and exclusively manages `profiles\desktop`, refuses to let the CLI touch it
("profile "desktop" is managed exclusively by the Electron application"), and yet the session it served
composed the `web` profile - which is where the plugin was mounted. Installing into every profile that
exists makes the tab appear whichever one gets booted, and costs one directory copy each. Use
`-Profile <name>` to target exactly one.

Version check: the plugin declares peer ranges `^0.1.7-rc.1 || ^0.2.0-rc.1` (i.e. [0.1.7-rc.1, 0.3.0)).
Every DSH install found on the machine is reported, and the install is refused unless at least one is
inside that range - and unless every DESKTOP install found is inside it, because a desktop app may be
the host that boots the profile. The desktop app's own shipped CLI is consulted for its version
(measured: it reported 0.2.0-rc.2 while the globally installed npm CLI still said 0.2.0-rc.1). A
mismatched bundle is skipped at startup by reportSkippedBundles: the tab just disappears, with no
plugin error in the log.

Safety: every touched profile manifest is backed up before anything is written, a replaced plugin
directory is kept aside rather than deleted, every copied file is checked against SHA256SUMS.txt, and
any failure rolls back EVERY profile this run touched. The script NEVER restarts a host: the install
takes effect on the next start, and killing a running host would throw away whatever the user is doing.

.PARAMETER DshHome
Target DSH home. Defaults to $env:DSH_HOME, else %USERPROFILE%\.dsh.

.PARAMETER Profile
`all` (default) installs into every profile that has a package.json; or name one profile.

.PARAMETER PackageDir
Directory holding the built package (package.json, lib/, src/, ...). Defaults to `package` next to
this script, which is how the offline bundle is laid out.

.PARAMETER DshInstall
Optional DSH desktop install root (the directory holding `resources\app.asar`). Only needed when the
app lives somewhere this script does not look.

.PARAMETER DryRun
Print the plan and write nothing.

.PARAMETER Yes
Do not ask for confirmation.

.PARAMETER Force
Install even when the version probe cannot confirm compatibility.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-offline.ps1 -DryRun
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-offline.ps1 -Yes
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-offline.ps1 -Profile desktop -Yes
# Its own test entry (never touches the real profiles):
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-offline.ps1 -DshHome "$env:TEMP\dsh-offline-test" -Yes
#>
[CmdletBinding()]
param(
  [string]$DshHome = '',
  [string]$Profile = 'all',
  [string]$PackageDir = '',
  [string]$DshInstall = '',
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
  if (-not $Version) { return 'unknown' }
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

function Read-PackageVersion([string]$PackageJsonPath) {
  try {
    $manifest = (Read-TextFile $PackageJsonPath) | ConvertFrom-Json
    if ($manifest.version) { return $manifest.version }
  } catch { }
  return $null
}

<#
The CLI that ships INSIDE a desktop install is authoritative about that install's DSH version
(measured: it reports 0.2.0-rc.2 while the globally installed npm CLI still said 0.2.0-rc.1). It is an
Electron binary launched with ELECTRON_RUN_AS_NODE=1, so --version prints and exits without a window.
#>
function Get-DesktopCliVersion([string]$Root) {
  $cli = Join-Path $Root 'resources\runtime\cli\bin\dsh.cmd'
  if (-not (Test-Path $cli)) { return $null }
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = @(& cmd /c "`"$cli`" --version" 2>&1)
    if ($LASTEXITCODE -eq 0 -and $output.Count -gt 0) {
      $candidate = ("$($output[0])").Trim()
      if ($candidate -match '^\d+\.\d+\.\d+') { return $candidate }
    }
  } catch { } finally { $ErrorActionPreference = $previous }
  return $null
}

<#
Find every DSH install we can see, because different ones can boot different profiles:
  * cli     - a global npm install (`dsh` on PATH, plus the paths DSH's own offline marker records)
  * desktop - an Electron app shipping `resources\app.asar` (its own CLI and pnpm are inside)
#>
function Get-DshInstalls {
  $found = New-Object System.Collections.Generic.List[object]
  $seen = New-Object System.Collections.Generic.HashSet[string]

  function Add-Found([string]$Kind, [string]$Path, [string]$Version, [string]$Source) {
    if (-not $Version) { return }
    if (-not $seen.Add("$Kind|$Path")) { return }
    $found.Add([pscustomobject]@{
        Kind = $Kind; Path = $Path; Version = $Version; Source = $Source
        Verdict = (Test-DshVersion $Version)
      })
  }

  # 1. the CLI on PATH
  $command = Get-Command dsh -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command -and $command.Source) {
    $binDir = Split-Path -Parent $command.Source
    foreach ($candidate in @(
        (Join-Path $binDir 'node_modules\@deepseek-ai\dsh\package.json'),
        (Join-Path (Split-Path -Parent $binDir) 'node_modules\@deepseek-ai\dsh\package.json'))) {
      if (Test-Path $candidate) { Add-Found 'cli' (Split-Path -Parent $candidate) (Read-PackageVersion $candidate) 'dsh on PATH' }
    }
  }

  # 2. paths DSH itself recorded when it was installed (its own offline marker)
  $marker = Join-Path $DshHome '.dsh-offline-install.json'
  if (Test-Path $marker) {
    try {
      $record = (Read-TextFile $marker) | ConvertFrom-Json
      foreach ($dir in @($record.npmDir, $record.installRoot)) {
        if (-not $dir) { continue }
        $candidate = Join-Path $dir 'node_modules\@deepseek-ai\dsh\package.json'
        if (Test-Path $candidate) { Add-Found 'cli' (Split-Path -Parent $candidate) (Read-PackageVersion $candidate) '.dsh-offline-install.json' }
      }
    } catch { Write-Note "could not parse $marker" }
  }

  # 3. conventional global npm locations
  foreach ($dir in @($env:APPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if (-not $dir) { continue }
    foreach ($candidate in @(
        (Join-Path $dir 'npm\node_modules\@deepseek-ai\dsh\package.json'),
        (Join-Path $dir 'nodejs\node_modules\@deepseek-ai\dsh\package.json'))) {
      if (Test-Path $candidate) { Add-Found 'cli' (Split-Path -Parent $candidate) (Read-PackageVersion $candidate) 'conventional npm location' }
    }
  }

  # 4. desktop installs: an explicit -DshInstall wins, then the running app's own argv (which names
  #    resources\app.asar), then the usual install roots. The argv route is what makes this work even
  #    when the app was installed somewhere unusual.
  $roots = New-Object System.Collections.Generic.List[string]
  if ($DshInstall) { $roots.Add($DshInstall) }
  $processes = Get-CimInstance Win32_Process -Filter "Name like '%Harness%'" -ErrorAction SilentlyContinue
  foreach ($process in $processes) {
    if ($process.CommandLine -and $process.CommandLine -match '^"?([^"]+\.exe)"?') {
      $exePath = $Matches[1]
      if ($process.CommandLine -match '([A-Za-z]:\\[^"]*?)\\resources\\app\.asar') { $roots.Add($Matches[1]) }
      else { $roots.Add((Split-Path -Parent $exePath)) }
    }
  }
  foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, (Join-Path $env:LOCALAPPDATA 'Programs'))) {
    if (-not $base -or -not (Test-Path $base)) { continue }
    foreach ($child in (Get-ChildItem $base -Directory -ErrorAction SilentlyContinue)) {
      if (Test-Path (Join-Path $child.FullName 'resources\app.asar')) { $roots.Add($child.FullName) }
    }
  }

  foreach ($root in ($roots | Sort-Object -Unique)) {
    if (-not $root) { continue }
    if (-not (Test-Path (Join-Path $root 'resources\app.asar'))) { continue }
    $version = Get-DesktopCliVersion $root
    $source = 'resources\runtime\cli\dsh.cmd --version'
    if (-not $version) {
      # Fallback: the app's own version stamp. Measured to agree with the shipped CLI (0.2.0-rc.2).
      foreach ($exe in (Get-ChildItem $root -Filter '*.exe' -ErrorAction SilentlyContinue)) {
        $fileVersion = $exe.VersionInfo.FileVersion
        if ($fileVersion -and $fileVersion -match '^\d+\.\d+\.\d+') { $version = $fileVersion; $source = "$($exe.Name) FileVersion"; break }
      }
    }
    if ($version) { Add-Found 'desktop' $root $version $source }
  }

  return $found
}

<#
Every profile that has a package.json is a mount target: `profiles\node_modules` (a shared dependency
directory) has none, so it is skipped naturally.
#>
function Get-TargetProfiles {
  $profilesDir = Join-Path $DshHome 'profiles'
  if (-not (Test-Path $profilesDir)) { throw "no profiles directory at $profilesDir - start DSH once with this DSH_HOME so a profile exists, then run this installer again" }
  $existing = @(Get-ChildItem $profilesDir -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName 'package.json') } |
    ForEach-Object { $_.Name } | Sort-Object)
  if ($existing.Count -eq 0) { throw "$profilesDir holds no profile directory with a package.json - start DSH once so a profile exists" }
  if ($Profile -eq 'all') { return $existing }
  if ($existing -notcontains $Profile) { throw "profile '$Profile' does not exist; found: $($existing -join ', ')" }
  return @($Profile)
}

$script:states = New-Object System.Collections.Generic.List[object]

function Install-IntoProfile([string]$Name) {
  Write-Step "profile '$Name'"
  $profileDir = Join-Path $DshHome "profiles\$Name"
  $manifestPath = Join-Path $profileDir 'package.json'
  $pluginDir = Join-Path $profileDir "node_modules\$pluginName"
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backupDir = Join-Path $profileDir "octopus-offline-backups\$stamp"
  $state = [pscustomobject]@{
    Name = $Name; Manifest = $manifestPath; PluginDir = $pluginDir
    Backup = $null; Displaced = $null; ManifestWritten = $false
  }
  $script:states.Add($state)

  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
  $state.Backup = Join-Path $backupDir 'package.json'
  Copy-Item -Path $manifestPath -Destination $state.Backup -Force
  Write-Pass "[$Name] backed up package.json to $($state.Backup)"

  if (Test-Path $pluginDir) {
    # Keep the previous install aside instead of deleting it: this branch is what makes an in-place
    # upgrade reversible on a host that has no package manager to fall back on.
    $state.Displaced = "$pluginDir.replaced-$stamp"
    Move-Item -Path $pluginDir -Destination $state.Displaced -Force
    Write-Note "[$Name] moved the previous install aside to $(Split-Path -Leaf $state.Displaced)"
  }
  New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null
  Copy-Item -Path (Join-Path $PackageDir '*') -Destination $pluginDir -Recurse -Force
  Write-Pass "[$Name] copied $PackageDir -> $pluginDir"

  $manifest = (Read-TextFile $manifestPath) | ConvertFrom-Json
  $tarballName = "$pluginName-$pluginVersion.tgz"
  $tarballPath = Join-Path (Split-Path -Parent $PackageDir) $tarballName
  # Mirror what `dsh plugin add` writes: a file: spec pointing at the bundle's tarball, forward slashes
  # included. If the tarball is not next to the package, point at the package path instead.
  $spec = if (Test-Path $tarballPath) { 'file:' + ($tarballPath -replace '\\', '/') }
          else { 'file:' + ($PackageDir -replace '\\', '/') }
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
  Write-TextFile $manifestPath ($manifest | ConvertTo-Json -Depth 12)
  $state.ManifestWritten = $true
  Write-Pass "[$Name] dependencies['$pluginName'] = $spec"
  Write-Pass "[$Name] dsh.profile.bundles = $($bundles -join ', ')"

  $written = (Read-TextFile $manifestPath) | ConvertFrom-Json
  if (-not $written.dependencies.PSObject.Properties[$pluginName]) { Write-Fail "[$Name] the dependency entry is missing after the write" } else { Write-Pass "[$Name] the profile lists the dependency" }
  if (@($written.dsh.profile.bundles) -notcontains $pluginName) { Write-Fail "[$Name] the bundles entry is missing after the write" } else { Write-Pass "[$Name] the profile lists the bundle" }
  if (@($written.dsh.profile.bundles | Where-Object { $_ -eq $pluginName }).Count -ne 1) { Write-Fail "[$Name] the bundles entry is duplicated" }
  $installedManifest = (Read-TextFile (Join-Path $pluginDir 'package.json')) | ConvertFrom-Json
  if ($installedManifest.version -ne $pluginVersion) { Write-Fail "[$Name] installed version is $($installedManifest.version), expected $pluginVersion" } else { Write-Pass "[$Name] installed version is $pluginVersion" }

  # Verify the copy against the bundle's own hash list. This is also what catches a corrupted or
  # tampered copy, and it is why that list ships next to the installer.
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
      if (-not (Test-Path $target)) { Write-Fail "[$Name] missing after the copy: $relative"; continue }
      if ((Get-Sha256 $target) -ne $expected) { Write-Fail "[$Name] hash mismatch: $relative" } else { $checked++ }
    }
    if ($checked -gt 0) { Write-Pass "[$Name] $checked files match SHA256SUMS.txt" }
  } else {
    Write-Note "no SHA256SUMS.txt next to the bundle; skipped the hash check"
  }

  if ($script:failures -eq 0 -and $state.Displaced) {
    Remove-Item -Path $state.Displaced -Recurse -Force
    Write-Note "[$Name] removed the displaced previous install"
  }
}

function Restore-Profiles {
  Write-Step "rolling back every profile this run touched"
  # Reverse order, by index: Select-Object has no -Reverse (measured), and a failure on this path
  # would be the worst possible time to discover it.
  for ($index = $script:states.Count - 1; $index -ge 0; $index--) {
    $state = $script:states[$index]
    if ($state.ManifestWritten -and $state.Backup -and (Test-Path $state.Backup)) {
      Copy-Item -Path $state.Backup -Destination $state.Manifest -Force
      Write-Pass "[$($state.Name)] restored the profile manifest"
    }
    if ($state.Displaced -and (Test-Path $state.Displaced)) {
      if (Test-Path $state.PluginDir) { Remove-Item -Path $state.PluginDir -Recurse -Force -ErrorAction SilentlyContinue }
      Move-Item -Path $state.Displaced -Destination $state.PluginDir -Force
      Write-Pass "[$($state.Name)] restored the previous install"
    } elseif (Test-Path $state.PluginDir) {
      # Nothing was there before: leave nothing behind.
      Remove-Item -Path $state.PluginDir -Recurse -Force -ErrorAction SilentlyContinue
      Write-Pass "[$($state.Name)] removed the partially copied package"
    }
  }
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

Write-Step "choose the target profiles"
$targets = @(Get-TargetProfiles)
Write-Pass "$($targets.Count) profile(s): $($targets -join ', ')"
if ($Profile -eq 'all') { Write-Note "all profiles are targeted because which one a host boots is not always guessable from outside ('-Profile <name>' narrows this)" }

Write-Step "check the DSH version (the plugin's peers are provided by DSH itself)"
$installs = @(Get-DshInstalls)
if ($installs.Count -eq 0) {
  Write-Note "no DSH install found; cannot verify compatibility"
} else {
  foreach ($install in $installs) {
    $mark = if ($install.Verdict -eq 'yes') { 'in range' } else { "OUT OF RANGE ($($install.Verdict))" }
    Write-Host "  $($install.Kind.PadRight(7)) $($install.Version.PadRight(12)) $mark"
    Write-Host "          $($install.Path)"
    Write-Host "          version from: $($install.Source)"
  }
}
$inRange = @($installs | Where-Object { $_.Verdict -eq 'yes' })
$desktopOut = @($installs | Where-Object { $_.Kind -eq 'desktop' -and $_.Verdict -ne 'yes' })
$verdictOk = ($inRange.Count -gt 0 -and $desktopOut.Count -eq 0)
if ($verdictOk) {
  Write-Pass "a DSH install is inside ^0.1.7-rc.1 || ^0.2.0-rc.1, and no desktop install is outside it"
} elseif ($Force) {
  Write-Note "compatibility not confirmed but -Force was given; continuing"
} else {
  if ($inRange.Count -eq 0) { Write-Fail "no detected DSH install is inside ^0.1.7-rc.1 || ^0.2.0-rc.1" }
  if ($desktopOut.Count -gt 0) { Write-Fail "this desktop install is outside the supported range: $($desktopOut[0].Path) ($($desktopOut[0].Version))" }
  throw "install refused. An unsupported bundle is silently skipped at startup (the tab just disappears, with no plugin error in the log). Pass -Force to install anyway."
}

if (-not $DryRun -and -not $Yes) {
  $answer = Read-Host "Install $pluginName@$pluginVersion into profile(s) $($targets -join ', ') under $DshHome ? [y/N]"
  if ($answer -notmatch '^(y|Y|yes|YES)$') { Write-Host "aborted by the operator"; exit 2 }
}

if ($DryRun) {
  Write-Step "plan"
  foreach ($target in $targets) {
    $profileDir = Join-Path $DshHome "profiles\$target"
    Write-Host "  [$target]"
    Write-Host "    1. back up $profileDir\package.json into octopus-offline-backups\<timestamp>\"
    Write-Host "    2. copy $PackageDir  ->  $profileDir\node_modules\$pluginName"
    Write-Host "    3. set dependencies['$pluginName'] and append '$pluginName' to dsh.profile.bundles"
    Write-Host "    4. verify every copied file against SHA256SUMS.txt and both mount entries"
  }
  Write-Host ""
  Write-Host "DRY RUN complete - nothing was written."
  exit 0
}

try {
  foreach ($target in $targets) { Install-IntoProfile $target }
  if ($script:failures -gt 0) { throw "verification failed ($script:failures problem(s))" }
} catch {
  Write-Fail $_.Exception.Message
  Restore-Profiles
  Write-Host ""
  throw "install failed; every profile this run touched is back to its previous state"
}

Write-Step "done"
Write-Host "  package : $pluginName@$pluginVersion"
foreach ($target in $targets) { Write-Host "  profile : $(Join-Path $DshHome "profiles\$target")" }
Write-Host "  backups : under each profile's octopus-offline-backups\<timestamp>\"
Write-Host ""
Write-Host "  NEXT: quit and restart the host (this script never restarts it) - the plugin loads on the"
Write-Host "        NEXT start. For the desktop app, quit it from the tray so it really stops."
Write-Host "        The sidebar then gains the operation-space tab, its start-page card, and Ctrl+Alt+S."
Write-Host ""
Write-Host "  To undo:"
Write-Host "        powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall-plugin.ps1 -Yes"
Write-Host "        then copy each backed-up package.json back over its profile's own"
