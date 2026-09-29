<#
.SYNOPSIS
Build the air-gapped (offline) deployment bundle for dsh-octopus-operation-space.

.DESCRIPTION
Produces a self-contained directory (and a zip) that installs the plugin on a host with NO npm
registry access:

  octopus-offline-<version>\
    INSTALL-OFFLINE.md            the operator guide (UTF-8, Chinese)
    SHA256SUMS.txt                one hash per file, checked by the installer
    install-offline.ps1           pure file-operation installer (backup, both mount entries, rollback)
    uninstall-plugin.ps1          the repo's uninstaller, which needs no working `dsh` either
    dsh-octopus-operation-space-<version>.tgz
    package\                      the exact published file set (package.json `files`)

Why this shape: the plugin has zero runtime dependencies and its peers come from DSH's own install,
so the offline path can be "copy the built directory + write the two mount entries" instead of
reconstructing a package manager. Mirroring the `files` list (rather than copying the repo) is what
keeps `package\` byte-identical to what `npm pack` would ship.

.PARAMETER OutDir
Where to write the bundle. Defaults to <repo>\dist\offline, which .gitignore already covers.

.PARAMETER SkipBuild
Reuse the existing lib\ instead of running `pnpm build` (the bundle must already be current).

.PARAMETER SkipZip
Do not produce the .zip.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\make-offline-package.ps1
#>
[CmdletBinding()]
param(
  [string]$OutDir = '',
  [switch]$SkipBuild,
  [switch]$SkipZip
)

# Every string this script prints is ASCII: a BOM-less UTF-8 .ps1 is read through the system ANSI code
# page by Windows PowerShell 5.1, so non-ASCII console output turns into mojibake (AGENTS.md section 2).
$ErrorActionPreference = 'Stop'

# $PSScriptRoot is EMPTY inside a param() default on PS 5.1 (measured): it is only reliable in the
# script body. Resolve it here instead, with $MyInvocation as the fallback.
$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $scriptDir) { throw "cannot determine the script directory" }
$repo = Split-Path -Parent $scriptDir
if (-not $OutDir) { $OutDir = Join-Path $repo 'dist\offline' }
$script:failures = 0

function Write-Step([string]$Text) { Write-Host ""; Write-Host "==> $Text" }
function Write-Pass([string]$Text) { Write-Host "  PASS  $Text" }
function Write-Note([string]$Text) { Write-Host "  NOTE  $Text" }
function Write-Fail([string]$Text) { Write-Host "  FAIL  $Text"; $script:failures++ }

<#
Run a native command without tripping PS 5.1's NativeCommandError: with $ErrorActionPreference='Stop',
merging or redirecting a native command's stderr is treated as a terminating error. Drop to 'Continue'
locally, remember the exit code, restore, and let the caller decide.
#>
function Invoke-Native([string]$Command, [string[]]$Arguments, [string]$WorkingDirectory) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    Push-Location $WorkingDirectory
    try { & $Command @Arguments 2>&1 | ForEach-Object { Write-Host "  $_" } }
    finally { Pop-Location }
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Read-TextFile([string]$Path) {
  $text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
  if ($null -eq $text) { throw "could not read $Path" }
  return $text
}

# BOM-less UTF-8, like the installer and like `dsh plugin add` leaves the profile manifest.
function Write-TextFile([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

Write-Host "dsh-octopus-operation-space - offline bundle"

Write-Step "read the package identity"
$manifestPath = Join-Path $repo 'package.json'
$manifest = (Read-TextFile $manifestPath) | ConvertFrom-Json
$name = $manifest.name
$version = $manifest.version
if (-not $name -or -not $version) { throw "package.json does not declare name/version" }
$bundleName = "octopus-offline-$version"
$bundleDir = Join-Path $OutDir $bundleName
$packageDir = Join-Path $bundleDir 'package'
$tarballName = "$name-$version.tgz"
Write-Pass "$name@$version"
Write-Host "  bundle   : $bundleDir"

$commit = 'unknown'
$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  Push-Location $repo
  try {
    # No Select-Object -First here: truncating the pipeline closes it early, git dies with a broken
    # pipe and $LASTEXITCODE stops meaning "rev-parse succeeded" (measured - the guide said "unknown").
    # @() as well: a single-line result is ONE string, and $output[0] on a string is its first
    # character (measured - the guide said "e").
    $output = @(& git rev-parse --short HEAD 2>&1)
    $code = $LASTEXITCODE
    if ($code -eq 0 -and $output.Count -gt 0) { $commit = ("$($output[0])").Trim() }
  } finally { Pop-Location }
} finally { $ErrorActionPreference = $previous }
Write-Host "  commit   : $commit"

if (-not $SkipBuild) {
  Write-Step "build (pnpm build)"
  $code = Invoke-Native 'pnpm' @('build') $repo
  if ($code -ne 0) { Write-Fail "pnpm build failed with exit code $code" } else { Write-Pass "pnpm build" }
} else {
  Write-Note "skipped the build (-SkipBuild): lib\ is reused as-is"
}

Write-Step "pack the tarball (pnpm pack)"
$code = Invoke-Native 'pnpm' @('pack') $repo
$packed = Join-Path $repo $tarballName
if ($code -ne 0 -or -not (Test-Path $packed)) {
  Write-Fail "pnpm pack did not produce $tarballName (exit code $code)"
} else {
  Write-Pass "packed $tarballName"
}

if ($script:failures -gt 0) { throw "cannot assemble a bundle: the artifact itself failed to build" }

Write-Step "assemble the bundle directory"
if (Test-Path $bundleDir) { Remove-Item -Path $bundleDir -Recurse -Force }
New-Item -ItemType Directory -Path $packageDir -Force | Out-Null

# Mirror package.json `files` instead of copying the repo: that list IS the published artifact, so the
# offline directory and the tarball must not disagree. Globs expand recursively, plain entries copy
# files or whole directories.
$copied = 0
foreach ($entry in $manifest.files) {
  if ($entry -match '\*\*') {
    $base = Split-Path -Parent ($entry -replace '/', '\')
    $pattern = Split-Path -Leaf $entry
    $source = Join-Path $repo $base
    if (-not (Test-Path $source)) { Write-Fail "files entry '$entry' has no source directory"; continue }
    $matched = Get-ChildItem -Path $source -Recurse -File -Filter $pattern
    if (-not $matched) { Write-Fail "files entry '$entry' matched nothing"; continue }
    foreach ($file in $matched) {
      $relative = $file.FullName.Substring($repo.Length + 1)
      $target = Join-Path $packageDir $relative
      New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
      Copy-Item -Path $file.FullName -Destination $target -Force
      $copied++
    }
  } else {
    $source = Join-Path $repo ($entry -replace '/', '\')
    if (-not (Test-Path $source)) { Write-Fail "files entry '$entry' does not exist"; continue }
    if ((Get-Item $source).PSIsContainer) {
      $target = Join-Path $packageDir $entry
      New-Item -ItemType Directory -Path $target -Force | Out-Null
      Copy-Item -Path (Join-Path $source '*') -Destination $target -Recurse -Force
      $copied += (Get-ChildItem -Path $target -Recurse -File).Count
    } else {
      $destination = Join-Path $packageDir $entry
      New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
      Copy-Item -Path $source -Destination $destination -Force
      $copied++
    }
  }
}
Write-Pass "$copied files copied into package\ (per package.json 'files')"

# `files` lists the SHIPPED paths, but package.json itself is always part of an npm artifact (npm adds
# it implicitly) - and both the installer and DSH read it, so it has to be here explicitly.
Copy-Item -Path $manifestPath -Destination (Join-Path $packageDir 'package.json') -Force
Write-Pass "package.json (implicit in npm artifacts, explicit here)"

foreach ($required in @('package.json', 'lib\index.js', 'lib\client.js', 'lib\client-registry.js', 'lib\invariant.js', 'dsh.plugin.json', 'cordis.patch.yml')) {
  if (-not (Test-Path (Join-Path $packageDir $required))) { Write-Fail "the bundle is missing $required" }
}
if ($script:failures -eq 0) { Write-Pass "every required file is present" }

Copy-Item -Path $packed -Destination (Join-Path $bundleDir $tarballName) -Force
Write-Pass "the tarball rides along as $tarballName"

Write-Step "render the operator guide"
$template = Join-Path $scriptDir 'offline\INSTALL-OFFLINE.md'
if (-not (Test-Path $template)) { throw "missing guide template: $template" }
$guide = Read-TextFile $template
foreach ($pair in @(
    @('{{PLUGIN_VERSION}}', $version),
    @('{{DSHWS_COMMIT}}', $commit),
    @('{{BUILT_AT}}', (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')))) {
  $guide = $guide.Replace($pair[0], $pair[1])
}
if ($guide -match '\{\{') { throw "the guide still has an unreplaced placeholder" }
if ($guide.Length -lt 2048) { throw "the rendered guide looks truncated ($($guide.Length) chars)" }
$guidePath = Join-Path $bundleDir 'INSTALL-OFFLINE.md'
Write-TextFile $guidePath $guide
Write-Pass "INSTALL-OFFLINE.md ($($guide.Length) chars)"

Copy-Item -Path (Join-Path $scriptDir 'offline\install-offline.ps1') -Destination (Join-Path $bundleDir 'install-offline.ps1') -Force
Copy-Item -Path (Join-Path $scriptDir 'uninstall-plugin.ps1') -Destination (Join-Path $bundleDir 'uninstall-plugin.ps1') -Force
Write-Pass "install-offline.ps1 and uninstall-plugin.ps1"

Write-Step "write SHA256SUMS.txt"
$sums = New-Object System.Collections.Generic.List[string]
foreach ($file in (Get-ChildItem -Path $bundleDir -Recurse -File | Sort-Object FullName)) {
  $relative = $file.FullName.Substring($bundleDir.Length + 1) -replace '\\', '/'
  if ($relative -eq 'SHA256SUMS.txt') { continue }
  $hash = (Get-FileHash -Path $file.FullName -Algorithm SHA256).Hash
  $sums.Add("$hash  $relative")
}
$sumsPath = Join-Path $bundleDir 'SHA256SUMS.txt'
Write-TextFile $sumsPath (($sums -join "`r`n") + "`r`n")
Write-Pass "$($sums.Count) hashes recorded"

if (-not $SkipZip) {
  Write-Step "zip"
  $zipPath = Join-Path $OutDir "$bundleName.zip"
  if (Test-Path $zipPath) { Remove-Item -Path $zipPath -Force }
  Compress-Archive -Path $bundleDir -DestinationPath $zipPath -CompressionLevel Optimal
  $zipMb = [Math]::Round((Get-Item $zipPath).Length / 1MB, 2)
  Write-Pass "$zipPath ($zipMb MB)"
}

if (Test-Path $packed) { Remove-Item -Path $packed -Force }
if ($script:failures -gt 0) { throw "the bundle has $script:failures problem(s)" }

Write-Step "done"
$totalMb = [Math]::Round(((Get-ChildItem -Path $bundleDir -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB), 2)
Write-Host "  bundle : $bundleDir  ($totalMb MB)"
if (-not $SkipZip) { Write-Host "  zip    : $(Join-Path $OutDir "$bundleName.zip")" }
Write-Host ""
Write-Host "  On the air-gapped host: copy the bundle, then"
Write-Host "    powershell -NoProfile -ExecutionPolicy Bypass -File .\install-offline.ps1 -DryRun"
Write-Host "    powershell -NoProfile -ExecutionPolicy Bypass -File .\install-offline.ps1 -Yes"
