<#
.SYNOPSIS
  dsh-octopus-operation-space <<PLUGIN_VERSION>> - single-file offline deployer.

.DESCRIPTION
  One file, no arguments needed. It carries everything inside itself: the built plugin
  (package\), the audited offline installer, the uninstaller and the SHA256 manifest.
  Running it unpacks that payload into a temporary directory, hands it to the SAME
  installer the multi-file bundle uses (byte-identical, verified by the drill), and
  cleans up afterwards.

  Nothing here duplicates installation logic. That is deliberate: the installer has
  been drilled through 9 branches (every profile by default, per-profile backup, both
  mount entries, per-file hashes, cross-profile rollback, refuse-out-of-range) and this
  file exists only to get it onto a machine that has no terminal habit and no files
  beyond the one you copied over.

  It never restarts a host. A desktop install therefore needs one manual step after it
  finishes (quit it from the tray icon, then start it again).

.PARAMETER DshHome
  Target DSH home. Defaults to $env:DSH_HOME, then to ~\.dsh.

.PARAMETER Profile
  Profile name(s), comma separated, or `all` (default) for every profile under
  <dsh home>\profiles. Which profile a host boots is not always guessable.

.PARAMETER DryRun
  Print the plan and change nothing.

.PARAMETER Force
  Install even when the version probe cannot confirm compatibility.

.PARAMETER Uninstall
  Remove the plugin from the profile(s) instead of installing it.

.PARAMETER ExtractTo
  Unpack the payload into this directory, run from there, and keep it (support/drilling).

.PARAMETER NoPause
  Do not wait for Enter before exiting.

.EXAMPLE
  # What a double-click does: no arguments at all.
  .\deploy.cmd

.EXAMPLE
  # Its own test entry (never touches the real profiles):
  .\deploy.cmd -DshHome "%TEMP%\dsh-oneclick-test" -NoPause
#>
[CmdletBinding()]
param(
  [string]$DshHome = '',
  [string]$Profile = 'all',
  [string]$DshInstall = '',
  [switch]$DryRun,
  [switch]$Force,
  [switch]$Uninstall,
  [switch]$NoPause,
  [string]$ExtractTo = ''
)

# Every string in this SOURCE is ASCII. That is not decoration: a BOM-less UTF-8 .ps1 is
# read through the system ANSI code page by Windows PowerShell 5.1, so any non-ASCII source
# byte is reinterpreted (the Chinese summary below is therefore carried as base64 and only
# decoded at run time).
$ErrorActionPreference = 'Stop'

$productName = '<<PLUGIN_NAME>>'
$productVersion = '<<PLUGIN_VERSION>>'
$builtAt = '<<BUILT_AT>>'
$builtFrom = '<<COMMIT>>'

# ---- embedded payload: generated, never hand-edited ------------------------------
# package\ as a zip, then the installer / uninstaller / hash manifest as text.
$payloadZip = @'
<<PAYLOAD_ZIP>>
'@
$installerText = @'
<<INSTALLER_B64>>
'@
$uninstallerText = @'
<<UNINSTALLER_B64>>
'@
$sumsText = @'
<<SUMS_B64>>
'@
$summaryZh = @'
<<SUMMARY_ZH_B64>>
'@

function ConvertFrom-Base64Text([string]$Text) {
  $clean = $Text -replace '[^A-Za-z0-9+/=]', ''
  if (-not $clean) { throw 'an embedded payload is empty' }
  return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($clean))
}

function ConvertFrom-Base64Bytes([string]$Text) {
  $clean = $Text -replace '[^A-Za-z0-9+/=]', ''
  if (-not $clean) { throw 'an embedded payload is empty' }
  return [System.Convert]::FromBase64String($clean)
}

<#
Only print Chinese when the console can actually represent it. [Console]::OutputEncoding
is the code page the host writes through; CJK code pages and UTF-8 are fine, an English
code page (437) is not, and there the English lines above have to stand on their own.
#>
function Test-CjkConsole {
  try {
    $cp = [int][Console]::OutputEncoding.CodePage
    return (@(936, 950, 949, 932, 65001) -contains $cp)
  } catch { return $false }
}

function Wait-BeforeClose {
  if ($NoPause) { return }
  Write-Host ''
  try { $null = Read-Host 'Press Enter to close this window' } catch { }
}

$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $scriptDir) { $scriptDir = (Get-Location).Path }

<#
Where the operator actually put the file. When this runs through deploy.cmd it has been
unpacked into %TEMP%, and printing that as "the folder" would be confusing; the launcher
passes the original path in OCTO_SELF.
#>
$originPath = $env:OCTO_SELF
if (-not $originPath -or -not (Test-Path -LiteralPath $originPath)) { $originPath = $null }
if ($originPath) { $originDir = Split-Path -Parent $originPath } else { $originDir = $scriptDir }
$originName = if ($originPath) { Split-Path -Leaf $originPath } else { 'deploy.ps1' }

# A relative -DshHome would otherwise be resolved against whatever the working directory is
# (Explorer and the .cmd launcher both start elsewhere).
if ($DshHome -and -not [System.IO.Path]::IsPathRooted($DshHome)) { $DshHome = Join-Path $originDir $DshHome }

Write-Host "$productName@$productVersion - single-file offline deployer"
Write-Host "  built  : $builtAt from $builtFrom"
Write-Host "  folder : $originDir"

$tempRoot = ''
$failure = ''
try {
  if ($ExtractTo) {
    $tempRoot = $ExtractTo
    if (-not (Test-Path -LiteralPath $tempRoot)) { New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null }
  } else {
    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('octopus-deploy-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
  }

  Write-Host ''
  Write-Host '==> unpack the payload'
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zipPath = Join-Path $tempRoot 'payload.zip'
  [System.IO.File]::WriteAllBytes($zipPath, (ConvertFrom-Base64Bytes $payloadZip))
  [System.IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $tempRoot)
  Remove-Item -LiteralPath $zipPath -Force

  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText((Join-Path $tempRoot 'install-offline.ps1'), (ConvertFrom-Base64Text $installerText), $utf8)
  [System.IO.File]::WriteAllText((Join-Path $tempRoot 'uninstall-plugin.ps1'), (ConvertFrom-Base64Text $uninstallerText), $utf8)
  [System.IO.File]::WriteAllText((Join-Path $tempRoot 'SHA256SUMS.txt'), (ConvertFrom-Base64Text $sumsText), $utf8)

  if (-not (Test-Path -LiteralPath (Join-Path $tempRoot 'package\package.json'))) {
    throw "the payload did not unpack (package\package.json is missing under $tempRoot)"
  }
  Write-Host "  PASS  plugin package, installer and SHA256SUMS.txt unpacked"

  if ($Uninstall) {
    $tool = Join-Path $tempRoot 'uninstall-plugin.ps1'
    $common = @{ Yes = $true }
    if ($DshHome) { $common['DshHome'] = $DshHome }
    if ($DryRun) { $common['DryRun'] = $true }
    # uninstall-plugin.ps1 takes ONE profile name, and an empty -Profile means every profile.
    # Passing our own default 'all' straight through would make it look for profiles\all and
    # exit 1 (measured), so 'all' is translated into "no -Profile at all", and a comma list is
    # walked one profile at a time.
    $uninstallTargets = @()
    if ($Profile -and $Profile -ne 'all') {
      $uninstallTargets = @($Profile -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    }
    if ($uninstallTargets.Count -eq 0) { $uninstallTargets = @('') }
    Write-Host ''
    Write-Host '==> uninstall'
    foreach ($one in $uninstallTargets) {
      $toolArgs = @{} + $common
      if ($one) { $toolArgs['Profile'] = $one }
      & $tool @toolArgs
      # A called script that runs `exit 1` sets $LASTEXITCODE but throws nothing, so success
      # cannot be inferred from "no exception" here (measured).
      if ($LASTEXITCODE -ne 0) { throw "the uninstaller reported a problem (exit $LASTEXITCODE)" }
    }
  } else {
    $tool = Join-Path $tempRoot 'install-offline.ps1'
    $toolArgs = @{ Yes = $true; Profile = $Profile }
    if ($DshHome) { $toolArgs['DshHome'] = $DshHome }
    if ($DshInstall) { $toolArgs['DshInstall'] = $DshInstall }
    if ($DryRun) { $toolArgs['DryRun'] = $true }
    if ($Force) { $toolArgs['Force'] = $true }
    Write-Host ''
    Write-Host '==> deploy'
    & $tool @toolArgs
  }
} catch {
  $failure = $_.Exception.Message
}

# ---- outcome ---------------------------------------------------------------------
if ($failure) {
  Write-Host ''
  Write-Host "FAILED: $failure"
  Write-Host ''
  if ($tempRoot -and (Test-Path -LiteralPath $tempRoot) -and -not $ExtractTo) {
    Write-Host "  The unpacked payload is kept so the failure can be inspected:"
    Write-Host "    $tempRoot"
    Write-Host '  Delete that folder when you are done with it.'
  }
  if ($failure -match 'refused|outside the supported range') {
    Write-Host ''
    Write-Host '  If that version really is what you want, run this again with -Force:'
    Write-Host "    powershell -NoProfile -ExecutionPolicy Bypass -File `"$originDir\$originName`" -Force"
    Write-Host '  (-Force also reaches the installer when you pass it to deploy.cmd.)'
  }
  Wait-BeforeClose
  exit 1
}

if (-not $ExtractTo -and (Test-Path -LiteralPath $tempRoot)) {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host 'READY.'
if ($Uninstall) {
  Write-Host '  The plugin is out of the profile(s); restart the host so the next start'
  Write-Host '  does not load it.'
} else {
  Write-Host '  One step is left and it cannot be done for you:'
  Write-Host '    Desktop app : right-click its tray icon -> Quit, then start it again.'
  Write-Host '    dsh web     : stop that process and start it again.'
  Write-Host '  The right sidebar then gains the operation-space tab, its start-page card,'
  Write-Host '  and Ctrl+Alt+S.'
}
Write-Host ''
Write-Host '  Backups are under <dsh home>\profiles\<profile>\octopus-offline-backups\<timestamp>\'
Write-Host "  To undo: $originDir\$originName -Uninstall"

if (Test-CjkConsole) {
  Write-Host ''
  Write-Host (ConvertFrom-Base64Text $summaryZh)
}

Wait-BeforeClose
exit 0
