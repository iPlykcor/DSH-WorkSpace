<#
.SYNOPSIS
  One-click deployer for dsh-octopus-operation-space (offline bundle).

.DESCRIPTION
  Wraps install-offline.ps1 so that "right-click -> Run with PowerShell" (or a
  double-click on deploy-offline.cmd) just works. It adds no install logic of its
  own: it locates the bundle, runs the verified installer with -Yes, prints the one
  thing the operator still has to do (restart the host), and keeps the console open
  long enough to read it.

  Three measured facts shape this script, because the right-click verb gives it none
  of them for free:

    1. NO ARGUMENTS are passed, so everything must have a sane default (-Yes, and
       -Profile all, which is what the installer already defaults to).
    2. The working directory is NOT the script folder (Explorer starts it in
       %SystemRoot%\System32), so every path here is resolved from $PSScriptRoot and
       passed absolute.
    3. The console window CLOSES the moment the process exits, so both the success
       and the failure path end in a pause.

  It never restarts a host: killing a running host would throw away whatever the user
  is doing. A desktop install therefore needs one manual step afterwards (quit it
  from the tray icon, then start it again).

.PARAMETER DshHome
  Target DSH home. Defaults to $env:DSH_HOME, then to ~\.dsh. Its own test entry is
  -DshHome with a throwaway folder.

.PARAMETER Profile
  Target profile name(s), comma separated, or `all` (the default) for every profile
  under <dsh home>\profiles. Which profile a host boots is not always guessable: a
  desktop install manages `desktop` but may boot `web`.

.PARAMETER DryRun
  Print the plan and change nothing.

.PARAMETER Force
  Install even when the DSH version probe cannot confirm compatibility.

.PARAMETER Uninstall
  Run the bundled uninstaller instead of the installer.

.PARAMETER NoPause
  Do not wait for Enter before exiting (used by deploy-offline.cmd and by the drill).

.EXAMPLE
  # What the right-click verb runs: no arguments at all.
  .\deploy-offline.ps1

.EXAMPLE
  # Look first, write nothing.
  .\deploy-offline.ps1 -DryRun

.EXAMPLE
  # Its own test entry (never touches the real profiles):
  .\deploy-offline.ps1 -DshHome "$env:TEMP\dsh-oneclick-test" -NoPause
#>
[CmdletBinding()]
param(
  [string]$DshHome = '',
  [string]$Profile = 'all',
  [switch]$DryRun,
  [switch]$Force,
  [switch]$Uninstall,
  [switch]$NoPause
)

# Every string this script PRINTS is ASCII: a BOM-less UTF-8 .ps1 is read through the system ANSI
# code page by Windows PowerShell 5.1, so non-ASCII console output turns into mojibake. The Chinese
# operator guide (INSTALL-OFFLINE.md) is a file to read in an editor, so it is not affected.
$ErrorActionPreference = 'Stop'

function Write-Line([string]$Text) { Write-Host $Text }
function Write-Step([string]$Text) { Write-Host ""; Write-Host "==> $Text" }

<#
Keep the window alive. The right-click verb closes the console as soon as the process exits, so
without this the operator sees the output flash by - and a failure would look like "nothing
happened". Read-Host at end-of-stream must not be allowed to throw, so it is guarded.
#>
function Wait-BeforeClose {
  if ($NoPause) { return }
  Write-Host ""
  try { $null = Read-Host 'Press Enter to close this window' } catch { }
}

# $PSScriptRoot is EMPTY inside a param() default on PS 5.1 (measured): resolve it in the body.
$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $scriptDir) {
  Write-Line 'ERROR: cannot determine the folder this script lives in.'
  Wait-BeforeClose
  exit 1
}

# A relative -DshHome would otherwise be resolved against %SystemRoot%\System32 by the installer.
if ($DshHome -and -not [System.IO.Path]::IsPathRooted($DshHome)) { $DshHome = Join-Path $scriptDir $DshHome }

Write-Line 'dsh-octopus-operation-space - one-click deploy'
Write-Line "  this script : $scriptDir"

<#
Locate the bundle. Inside the zip the layout is <bundle>\deploy-offline.ps1 with package\ next to
it, so $scriptDir IS the bundle. In the repo the same file lives in scripts\offline, where package\
is not built - fall back to the newest dist\offline\octopus-offline-* so the copy here stays usable
without editing it.
#>
$bundleRoot = ''
$hasPackageHere = Test-Path -LiteralPath (Join-Path $scriptDir 'package\package.json')
if ($hasPackageHere) {
  $bundleRoot = $scriptDir
} else {
  $repo = Split-Path -Parent (Split-Path -Parent $scriptDir)
  $builtRoot = Join-Path $repo 'dist\offline'
  $built = @()
  try { $built = @(Get-ChildItem -LiteralPath $builtRoot -Directory -Filter 'octopus-offline-*' -ErrorAction SilentlyContinue) } catch { $built = @() }
  if ($built.Count -gt 0) {
    $newest = @($built | Sort-Object -Property Name -Descending)[0]
    if (Test-Path -LiteralPath (Join-Path $newest.FullName 'package\package.json')) { $bundleRoot = $newest.FullName }
  }
}

function Find-BundleFile([string]$Name) {
  foreach ($dir in @($scriptDir, $bundleRoot)) {
    if (-not $dir) { continue }
    $candidate = Join-Path $dir $Name
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  return ''
}

if (-not $bundleRoot) {
  Write-Step 'cannot find the package'
  Write-Line '  The folder holding package\ was not found next to this script, and no built bundle'
  Write-Line '  was found either.'
  Write-Line ''
  Write-Line '  Extract the WHOLE zip first, then run this file from inside the extracted folder'
  Write-Line '  (that folder must contain package\, install-offline.ps1 and this script).'
  Wait-BeforeClose
  exit 1
}
Write-Line "  bundle      : $bundleRoot"

# ---- uninstall path -------------------------------------------------------------
if ($Uninstall) {
  $uninstaller = Find-BundleFile 'uninstall-plugin.ps1'
  if (-not $uninstaller) {
    Write-Step 'cannot find uninstall-plugin.ps1'
    Write-Line '  It ships next to this script in the bundle.'
    Wait-BeforeClose
    exit 1
  }
  $removeArgs = @{ Yes = $true }
  if ($DshHome) { $removeArgs['DshHome'] = $DshHome }
  Write-Step 'uninstall'
  $removed = $false
  try { & $uninstaller @removeArgs; $removed = $true } catch {
    Write-Line ""
    Write-Line "UNINSTALL FAILED: $($_.Exception.Message)"
  }
  if (-not $removed) { Wait-BeforeClose; exit 1 }
  Write-Step 'ready'
  Write-Line '  The plugin is out of the profile(s). Restart the host so the next start does not'
  Write-Line '  load it.'
  Write-Line ""
  Write-Line '  Note: folders you added to an operation space live in YOUR manifest files, not in the'
  Write-Line '        profile, so they stay - together with the sidecar backup written next to each'
  Write-Line '        edited manifest.'
  Wait-BeforeClose
  exit 0
}

# ---- install path ---------------------------------------------------------------
$installer = Find-BundleFile 'install-offline.ps1'
if (-not $installer) {
  Write-Step 'cannot find install-offline.ps1'
  Write-Line '  It ships next to this script in the bundle.'
  Wait-BeforeClose
  exit 1
}

$installArgs = @{ Yes = $true; Profile = $Profile }
if ($DshHome) { $installArgs['DshHome'] = $DshHome }
if ($DryRun) { $installArgs['DryRun'] = $true }
if ($Force) { $installArgs['Force'] = $true }
# Only needed when this script runs from the repo and the bundle lives under dist\offline.
if (-not $hasPackageHere) { $installArgs['PackageDir'] = (Join-Path $bundleRoot 'package') }

<#
A running host is not a reason to stop: the install is pure file operations and the plugin loads on
the NEXT start, so the files can be in place while the app runs (measured: the desktop app does not
rewrite package.json at startup or shutdown). But the operator has to be told, or the tab will seem
to have failed to appear.
#>
$hostProcesses = @()
try { $hostProcesses = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue) } catch { $hostProcesses = @() }
if ($hostProcesses.Count -gt 0 -and -not $DryRun) {
  Write-Step 'DeepSeek Harness is running'
  Write-Line "  $($hostProcesses.Count) process(es) found. That does not block the install - it writes files"
  Write-Line '  only, and the plugin loads on the NEXT start. But the tab will NOT appear until you'
  Write-Line '  quit the app from the tray icon and start it again.'
}

Write-Step 'deploy'
$deployed = $false
try {
  & $installer @installArgs
  $deployed = $true
} catch {
  Write-Line ""
  Write-Line "DEPLOY FAILED: $($_.Exception.Message)"
  Write-Line ""
  Write-Line '  Every profile this run touched was rolled back to its previous state.'
  Write-Line '  Run this again with -DryRun to see the plan without writing anything.'
}

if (-not $deployed) { Wait-BeforeClose; exit 1 }

Write-Step 'ready'
if ($DryRun) {
  Write-Line '  Dry run only - nothing was written.'
} else {
  Write-Line '  Files are in place. One step is left, and it cannot be done for you:'
  Write-Line ''
  Write-Line '    Desktop app : right-click its tray icon -> Quit, then start it again.'
  Write-Line '    dsh web     : stop that process and start it again.'
  Write-Line ''
  Write-Line '  The right sidebar then gains the operation-space tab, its start-page card,'
  Write-Line '  and the Ctrl+Alt+S shortcut.'
}
Write-Line ''
Write-Line "  Backups : <dsh home>\profiles\<profile>\octopus-offline-backups\<timestamp>\"
Write-Line '  Undo    : .\deploy-offline.cmd -Uninstall   (or: .\deploy-offline.ps1 -Uninstall)'
Write-Line '  Guide   : INSTALL-OFFLINE.md (Chinese, full detail)'
Wait-BeforeClose
exit 0
