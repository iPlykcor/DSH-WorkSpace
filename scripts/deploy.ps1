<#
.SYNOPSIS
  One-click deploy of dsh-octopus-operation-space into a DSH profile.

.DESCRIPTION
  Builds + packs this package, backs the target profile's manifest up, installs
  the tarball with `dsh plugin --profile <name> add file:<tgz>` and verifies the
  result.

  It NEVER restarts a running `dsh web`. An install only takes effect on the
  next start, and killing the host would drop whatever the user is doing in it,
  so the script prints the restart and undo commands instead.

  Unlike scripts/smoke.ps1 - which installs into a throwaway DSH_HOME and never
  touches the real one - this script targets the REAL profile by default. Pass
  -DshHome to install somewhere else; that is also how the script is tested.

  PowerShell 5.1 trap: every native call below runs with the error preference
  lowered to Continue, because under Stop a native command's stderr (even via
  plain redirection) becomes a terminating NativeCommandError.

.PARAMETER Profile
  The DSH profile to install into. Default: web (the GUI profile).

.PARAMETER DshHome
  The DSH home to operate on. Default: $env:DSH_HOME, else $env:USERPROFILE\.dsh.

.PARAMETER SkipTests
  Skip the four gates (typecheck / test / build / lint) before installing.

.PARAMETER SkipBuild
  Reuse the existing lib/ instead of rebuilding (still repacks the tarball).

.PARAMETER Uninstall
  Remove the plugin from the profile instead of installing it.

.PARAMETER Yes
  Do not ask for confirmation.

.PARAMETER DryRun
  Print every action and change nothing.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy.ps1 -Uninstall

.EXAMPLE
  # Exercise the whole install path without touching the real profile:
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy.ps1 -DshHome "$env:TEMP\dsh-deploy-test" -SkipTests -Yes
#>
[CmdletBinding()]
param(
  [string]$Profile = 'web',
  [string]$DshHome = '',
  [switch]$SkipTests,
  [switch]$SkipBuild,
  [switch]$Uninstall,
  [switch]$Yes,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$PackageName = 'dsh-octopus-operation-space'
$Repo = Split-Path -Parent $PSScriptRoot
$script:failures = 0
# Set when a failed `add` forced the profile manifest to be restored from this
# run's backup, so the failure summary can say the plugin is still mounted.
$script:mountsRestored = $false

function Write-Step([string]$Text) { Write-Host ''; Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Pass([string]$Text) { Write-Host "  PASS  $Text" -ForegroundColor Green }
function Write-Note([string]$Text) { Write-Host "  NOTE  $Text" -ForegroundColor Yellow }
function Write-Fail([string]$Text) { Write-Host "  FAIL  $Text" -ForegroundColor Red; $script:failures++ }

# Native stderr must never become a terminating error (PS 5.1 + Stop).
function Get-NativeExit {
  try { return [int]$LASTEXITCODE } catch { return 0 }
}

# Run a native command with its output STREAMED to the console; throw on failure.
function Invoke-Streamed {
  param([string]$Label, [scriptblock]$Command)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Command
    $code = Get-NativeExit
  } finally {
    $ErrorActionPreference = $previous
  }
  if ($code -ne 0) { throw "$Label failed with exit code $code" }
  Write-Pass $Label
}

# Run a native command with stdout/stderr captured to files; returns the exit code.
function Invoke-Captured {
  param([scriptblock]$Command, [string]$OutFile, [string]$ErrFile)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Command > $OutFile 2> $ErrFile
    return Get-NativeExit
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Show-CapturedFailure {
  param([string]$OutFile, [string]$ErrFile)
  foreach ($file in @($OutFile, $ErrFile)) {
    if (Test-Path $file) { Get-Content $file -ErrorAction SilentlyContinue | Write-Host }
  }
}

# Put the profile manifest back after an `add` that failed on every attempt.
#
# Why this exists: `dsh plugin add` is not atomic from the caller's point of
# view. pnpm links the package and updates the lockfile, then renames the
# profile's package.json - and THAT rename can fail with `[EPERM] operation not
# permitted` on a transient Windows file lock (measured once on the real
# profile, 0.8.0: the installed bytes were current, the lockfile was current,
# and the manifest had lost both mount entries). Because the install path
# removes the previous version first, the profile is left mounting NOTHING: the
# next GUI start would silently lose the tab. Restoring this run's own backup
# puts the mount back; its dependency spec still resolves because old tarballs
# are only cleaned up after a successful verify.
function Restore-ProfileMounts {
  param([string]$BackupDir, [string]$ManifestPath, [string]$Name)
  $backupManifest = Join-Path $BackupDir 'package.json'
  if (-not (Test-Path $backupManifest)) {
    Write-Note "no profile manifest backup to restore from: $backupManifest"
    Write-Note "the profile may be left unmounted; check $ManifestPath by hand"
    return
  }
  Copy-Item $backupManifest $ManifestPath -Force
  $restored = Get-Content $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $dep = $restored.dependencies.$Name
  $bundled = $restored.dsh.profile.bundles -contains $Name
  if ($null -ne $dep -and $bundled) {
    Write-Pass "restored the mount entries from $backupManifest ($Name -> $dep)"
  } else {
    Write-Note "restored $ManifestPath, but it does not name $Name in BOTH dependencies and dsh.profile.bundles"
  }
  $script:mountsRestored = $true
}

# -- preflight ----------------------------------------------------------------
Push-Location $Repo
$previousDshHome = $env:DSH_HOME
$backupDir = ''
try {
  Write-Step 'preflight'
  $pkgJsonPath = Join-Path $Repo 'package.json'
  if (-not (Test-Path $pkgJsonPath)) { throw "not a package checkout (no package.json): $Repo" }
  $pkg = Get-Content $pkgJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($pkg.name -ne $PackageName) { throw "unexpected package name '$($pkg.name)' in $pkgJsonPath" }
  Write-Pass "package $($pkg.name)@$($pkg.version)"

  foreach ($tool in @('node', 'pnpm', 'dsh')) {
    $found = Get-Command $tool -ErrorAction SilentlyContinue
    if ($null -eq $found) { throw "required tool '$tool' was not found on PATH" }
    Write-Pass "$tool -> $($found.Path)"
  }

  if ($DshHome -eq '') {
    if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME } else { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
  }
  $profileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
  $profileManifest = Join-Path $profileDir 'package.json'
  if (Test-Path $profileDir) { Write-Pass "target profile $profileDir" }
  else { Write-Note "profile directory does not exist yet (dsh will create it): $profileDir" }
  if ($DryRun) { Write-Note 'DRY RUN: nothing will be written' }

  # Keep `dsh` pointed at the home this run selected.
  $env:DSH_HOME = $DshHome

  # -- uninstall --------------------------------------------------------------
  if ($Uninstall) {
    Write-Step "uninstall $PackageName from profile '$Profile'"
    if ($DryRun) {
      Write-Note "[dry-run] would run: dsh plugin --profile $Profile remove $PackageName"
    } else {
      Invoke-Streamed "dsh plugin --profile $Profile remove $PackageName" `
        { & dsh plugin --profile $Profile remove $PackageName }
      if (Test-Path $profileManifest) {
        $after = Get-Content $profileManifest -Raw -Encoding UTF8 | ConvertFrom-Json
        $deps = $after.PSObject.Properties['dependencies']
        $still = if ($null -ne $deps -and $null -ne $deps.Value) { $deps.Value.PSObject.Properties[$PackageName] } else { $null }
        if ($null -eq $still) { Write-Pass "profile no longer lists $PackageName" }
        else { Write-Fail "profile still lists $PackageName -> $($still.Value)" }
      }
    }
    if ($script:failures -gt 0) { Write-Host ''; Write-Host "DEPLOY FAILED: $($script:failures) check(s)" -ForegroundColor Red; exit 1 }
    Write-Host ''
    Write-Host 'UNINSTALLED' -ForegroundColor Green
    Write-Host '  Restart your GUI to pick up the change (this script never restarts it).'
    exit 0
  }

  # -- confirm ----------------------------------------------------------------
  if (-not $Yes -and -not $DryRun) {
    $answer = Read-Host "Install $PackageName@$($pkg.version) into $profileDir ? [y/N]"
    if ($answer -notmatch '^(y|yes)$') { Write-Host 'Aborted; nothing was installed.'; exit 2 }
  }

  # -- gates ------------------------------------------------------------------
  if ($SkipTests) {
    Write-Step 'gates skipped (-SkipTests)'
  } else {
    Write-Step 'gates: typecheck / test / build / lint'
    if ($DryRun) {
      Write-Note '[dry-run] would run: pnpm typecheck; pnpm test; pnpm build; pnpm lint'
    } else {
      Invoke-Streamed 'pnpm typecheck' { & pnpm typecheck }
      Invoke-Streamed 'pnpm test' { & pnpm test }
      Invoke-Streamed 'pnpm build' { & pnpm build }
      Invoke-Streamed 'pnpm lint' { & pnpm lint }
    }
  }

  # -- build + pack -----------------------------------------------------------
  Write-Step 'pack the tarball'
  if ($DryRun) {
    Write-Note '[dry-run] would run: pnpm pack'
    $tgz = Join-Path $Repo "$PackageName-$($pkg.version).tgz"
  } else {
    if ($SkipBuild) { Write-Note 'reusing the existing lib/ (-SkipBuild)' } else {
      # `pnpm build` already ran when the gates were not skipped; only rebuild
      # here if it did not.
      if ($SkipTests) { Invoke-Streamed 'pnpm build' { & pnpm build } }
    }
    # Old tarballs are deliberately NOT cleaned here. The profile currently
    # mounts one of them, and if the install below fails, the backups-based
    # recovery restores a manifest that names it - so it has to still exist.
    # They are cleaned after a successful verify instead.
    $packOut = Join-Path $env:TEMP "octopus-pack-$PID.out"
    $packErr = Join-Path $env:TEMP "octopus-pack-$PID.err"
    $code = Invoke-Captured -Command { & pnpm pack } -OutFile $packOut -ErrFile $packErr
    if ($code -ne 0) {
      Show-CapturedFailure -OutFile $packOut -ErrFile $packErr
      throw "pnpm pack failed with exit code $code"
    }
    $tgzName = (Get-Content $packOut -Encoding UTF8 | Where-Object { $_ -match '\S' } | Select-Object -Last 1)
    if ($null -eq $tgzName) { throw "pnpm pack produced no output; see $packOut" }
    $tgz = Join-Path $Repo $tgzName.Trim()
    Remove-Item $packOut, $packErr -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path $tgz)) { throw "pnpm pack did not produce $tgz" }
    Write-Pass "packed $tgzName"
  }

  # -- backup -----------------------------------------------------------------
  Write-Step 'back up the target profile manifest'
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backupDir = Join-Path (Join-Path $profileDir 'octopus-deploy-backups') $stamp
  if ($DryRun) {
    Write-Note "[dry-run] would copy the profile manifest into $backupDir"
  } elseif (-not (Test-Path $profileManifest)) {
    Write-Note 'no profile manifest to back up yet (fresh profile)'
  } else {
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    foreach ($name in @('package.json', 'pnpm-lock.yaml')) {
      $src = Join-Path $profileDir $name
      if (Test-Path $src) { Copy-Item $src (Join-Path $backupDir $name) -Force }
    }
    Write-Pass "backed up to $backupDir"
  }

  # -- install ----------------------------------------------------------------
  Write-Step "install into profile '$Profile'"
  # `file:` + forward slashes: a Windows path is not a valid file: URL.
  $uri = 'file:' + ($tgz -replace '\\', '/')
  if ($DryRun) {
    Write-Note "[dry-run] would run: dsh plugin --profile $Profile remove $PackageName (when present), then add $uri"
  } else {
    # A bare `add` at the SAME version and path is a pnpm NO-OP: it sees the
    # dependency already satisfied and never re-extracts the tarball, so a
    # rebuild stays in the repo while the profile keeps running the OLD bytes.
    # That is not theoretical - it happened on the real profile (installed
    # index.js mtime unchanged, no new route in the installed bundle) while
    # `add` still reported success. Removing first makes the add a real
    # install; the hash comparison below is what proves it really happened.
    if (Test-Path (Join-Path $profileDir "node_modules\$PackageName")) {
      $rmOut = Join-Path $env:TEMP "octopus-rm-$PID.out"
      $rmErr = Join-Path $env:TEMP "octopus-rm-$PID.err"
      $code = Invoke-Captured -Command { & dsh plugin --profile $Profile remove $PackageName } -OutFile $rmOut -ErrFile $rmErr
      if ($code -ne 0) {
        Show-CapturedFailure -OutFile $rmOut -ErrFile $rmErr
        throw "dsh plugin remove failed with exit code $code (it is what forces a real reinstall; profile manifest backed up at $backupDir)"
      }
      Remove-Item $rmOut, $rmErr -Force -ErrorAction SilentlyContinue
      Write-Pass 'removed the previous install first (so the new build is really extracted)'
    }
    # `add` is retried because its failure mode is transient: pnpm can install
    # everything and then be refused the atomic rename of the profile's
    # package.json (`[EPERM] ... -> package.json`) by a momentary file lock.
    # Trying again is the whole fix for that case, and it is far cheaper than
    # the recovery below.
    $addOk = $false
    $attempts = 3
    for ($attempt = 1; $attempt -le $attempts; $attempt++) {
      $addOut = Join-Path $env:TEMP "octopus-add-$PID-$attempt.out"
      $addErr = Join-Path $env:TEMP "octopus-add-$PID-$attempt.err"
      $code = Invoke-Captured -Command { & dsh plugin --profile $Profile add $uri } -OutFile $addOut -ErrFile $addErr
      if ($code -eq 0) {
        Remove-Item $addOut, $addErr -Force -ErrorAction SilentlyContinue
        if ($attempt -eq 1) { Write-Pass 'dsh plugin add succeeded' }
        else { Write-Pass "dsh plugin add succeeded on attempt $attempt of $attempts" }
        $addOk = $true
        break
      }
      if ($attempt -lt $attempts) {
        Write-Note "dsh plugin add failed with exit code $code (attempt $attempt of $attempts); retrying - a transient file lock is the known cause"
        Start-Sleep -Milliseconds 2000
      } else {
        Write-Note "dsh plugin add failed with exit code $code on all $attempts attempts; its output follows"
        Show-CapturedFailure -OutFile $addOut -ErrFile $addErr
      }
    }
    if (-not $addOk) {
      # Leave the profile MOUNTED even though this run failed: an unmounted
      # profile loses the tab on the next start, which is worse than a stale
      # version. Re-running the script is the documented next step.
      Restore-ProfileMounts -BackupDir $backupDir -ManifestPath $profileManifest -Name $PackageName
      throw "dsh plugin add failed on all $attempts attempts; the mount entries were restored from $backupDir"
    }
  }

  # -- verify -----------------------------------------------------------------
  Write-Step 'verify the install'
  if ($DryRun) {
    Write-Note '[dry-run] would verify the profile manifest, the plugin files, and that the installed bundles match this build'
  } else {
    if (-not (Test-Path $profileManifest)) {
      Write-Fail "the profile has no package.json: $profileManifest"
    } else {
      $profilePkg = Get-Content $profileManifest -Raw -Encoding UTF8 | ConvertFrom-Json
      $deps = $profilePkg.PSObject.Properties['dependencies']
      $dep = if ($null -ne $deps -and $null -ne $deps.Value) { $deps.Value.PSObject.Properties[$PackageName] } else { $null }
      if ($null -eq $dep) { Write-Fail "the profile does not list $PackageName" }
      else { Write-Pass "profile lists $PackageName -> $($dep.Value)" }
    }
    $installedManifest = Join-Path $profileDir "node_modules\$PackageName\dsh.plugin.json"
    if (Test-Path $installedManifest) { Write-Pass 'installed plugin manifest present' }
    else { Write-Fail "missing $installedManifest" }
    # The decisive check: "installed" is not the same as "current". Only the
    # bytes prove the profile will load what this run just built.
    foreach ($relative in @('lib\index.js', 'lib\client.js')) {
      $built = Join-Path $Repo $relative
      $onDisk = Join-Path $profileDir "node_modules\$PackageName\$relative"
      if (-not (Test-Path $onDisk)) { Write-Fail "missing $onDisk"; continue }
      $builtHash = (Get-FileHash -Path $built -Algorithm SHA256).Hash
      $diskHash = (Get-FileHash -Path $onDisk -Algorithm SHA256).Hash
      if ($builtHash -eq $diskHash) { Write-Pass "$relative on disk matches this build ($($builtHash.Substring(0, 12))...)" }
      else { Write-Fail "$relative on disk is STALE (installed $($diskHash.Substring(0, 12))..., built $($builtHash.Substring(0, 12))...)" }
    }
  }

  # -- clean up superseded tarballs (only after a successful verify) -----------
  # Now that the profile mounts THIS tarball, the older ones are dead weight.
  # Doing it here - not before the install - is what keeps a failed install's
  # restored manifest resolvable.
  if (-not $DryRun -and $script:failures -eq 0) {
    $stale = @(Get-ChildItem -Path $Repo -Filter '*.tgz' -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -ne $tgz })
    if ($stale.Count -gt 0) {
      $stale | Remove-Item -Force
      Write-Pass "removed $($stale.Count) superseded tarball(s)"
    }
  }

  # -- a running host is NOT restarted ----------------------------------------
  Write-Step 'running host (never restarted by this script)'
  $running = @()
  try {
    # Match the DSH PACKAGE path, not the bare string "dsh": a checkout under
    # e.g. D:\DSH_WorkSpace would otherwise make every node process started from
    # there look like a DSH host.
    $running = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop |
      Where-Object { $_.CommandLine -and $_.CommandLine -match '@deepseek-ai[\\/]dsh' })
  } catch {
    # CIM can be unavailable in constrained environments; that must not fail a deploy.
    $running = @()
  }
  if ($running.Count -gt 0) {
    Write-Note "$($running.Count) node process(es) under @deepseek-ai/dsh are running; the install takes effect on the NEXT start"
  } else {
    Write-Pass 'no running DSH process detected'
  }

  # -- summary ----------------------------------------------------------------
  Write-Host ''
  if ($script:failures -gt 0) {
    Write-Host "DEPLOY FAILED: $($script:failures) check(s)" -ForegroundColor Red
    if ($backupDir -ne '') { Write-Host "  profile manifest backup: $backupDir" }
    exit 1
  }
  Write-Host 'DEPLOYED' -ForegroundColor Green
  Write-Host "  package : $PackageName@$($pkg.version)"
  Write-Host "  profile : $profileDir"
  if ($backupDir -ne '' -and (Test-Path $backupDir)) { Write-Host "  backup  : $backupDir" }
  Write-Host ''
  Write-Host '  NEXT: restart your GUI to pick up the change (this script never restarts it):' -ForegroundColor Yellow
  Write-Host '        stop the running `dsh web`, then start it again'
  Write-Host ''
  Write-Host '  To undo:'
  Write-Host "        powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy.ps1 -Uninstall"
  if ($backupDir -ne '' -and (Test-Path $backupDir)) {
    Write-Host "        Copy-Item '$backupDir\package.json' '$profileManifest' -Force"
  }
  exit 0
} catch {
  Write-Host ''
  Write-Host "DEPLOY FAILED: $($_.Exception.Message)" -ForegroundColor Red
  if ($backupDir -ne '' -and (Test-Path $backupDir)) { Write-Host "  profile manifest backup: $backupDir" }
  if ($script:mountsRestored) { Write-Host '  the profile manifest was restored from that backup: the plugin is still mounted (previous version)' -ForegroundColor Yellow }
  exit 1
} finally {
  if ($null -ne $previousDshHome) { $env:DSH_HOME = $previousDshHome } else { Remove-Item Env:\DSH_HOME -ErrorAction SilentlyContinue }
  # Back to the caller's directory (Push-Location ran at the top).
  Pop-Location -ErrorAction SilentlyContinue
}
