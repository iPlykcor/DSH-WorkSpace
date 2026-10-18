<#
.SYNOPSIS
Build the single-file, double-clickable offline deployer for dsh-octopus-operation-space.

.DESCRIPTION
Produces, from an already built offline bundle:

  dist\offline\octopus-oneclick-<version>.zip     <- the deliverable: contains ONE file
    deploy.cmd                                    <- double-click it; it deploys
  dist\offline\octopus-oneclick-<version>\
    deploy.cmd                                    the same file, unzipped
    deploy.ps1                                    the same deployer as a plain .ps1
                                                  (for hosts that do have a
                                                  "Run with PowerShell" verb)

Why .cmd inside the zip: Windows EXECUTES a .cmd on double-click but only OPENS a .ps1.
Measured on the build machine, .ps1 is associated with an AppX editor and the
`Microsoft.PowerShellScript.1` ProgId (which carries "Run with PowerShell") is not
registered at all, so a double-clicked .ps1 can never deploy. The .cmd is a ~20 line
prologue; everything below its marker line is PowerShell, and the payload it unpacks is
the SAME installer the multi-file bundle ships, byte for byte.

Nothing about installation is re-implemented here: the deployer embeds `package\`,
`install-offline.ps1`, `uninstall-plugin.ps1` and `SHA256SUMS.txt` and, at run time,
unpacks them and calls the installer. The installer keeps doing the real work (per-profile
backup, both mount entries, per-file hash verification, cross-profile rollback).

.PARAMETER BundleDir
The multi-file bundle to wrap. Defaults to dist\offline\octopus-offline-<version>.

.PARAMETER OutDir
Where to write the artifacts. Defaults to dist\offline (already git-ignored).

.PARAMETER SkipZip
Do not produce the .zip.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\make-oneclick-package.ps1
#>
[CmdletBinding()]
param(
  [string]$BundleDir = '',
  [string]$OutDir = '',
  [switch]$SkipZip
)

# Every string this script prints is ASCII: a BOM-less UTF-8 .ps1 is read through the system
# ANSI code page by Windows PowerShell 5.1, so non-ASCII console output turns into mojibake.
# The Chinese summary is a data file (summary-zh.txt) read with an explicit UTF-8 decoder.
$ErrorActionPreference = 'Stop'

# $PSScriptRoot is EMPTY inside a param() default on PS 5.1 (measured): resolve it in the body.
$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $scriptDir) { throw 'cannot determine the script directory' }
$repo = Split-Path -Parent $scriptDir
if (-not $OutDir) { $OutDir = Join-Path $repo 'dist\offline' }
$script:failures = 0

function Write-Step([string]$Text) { Write-Host ''; Write-Host "==> $Text" }
function Write-Pass([string]$Text) { Write-Host "  PASS  $Text" }
function Write-Note([string]$Text) { Write-Host "  NOTE  $Text" }
function Write-Fail([string]$Text) { Write-Host "  FAIL  $Text"; $script:failures++ }

function Read-TextFile([string]$Path) {
  $text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
  if ($null -eq $text) { throw "could not read $Path" }
  return $text
}

function Write-TextFile([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

<#
Base64 wrapped at 76 columns. The deployer strips everything that is not base64 before
decoding, so the wrapping is only there to keep the generated .ps1 readable (one 200 KB
line would also make some editors crawl).
#>
function ConvertTo-WrappedBase64([byte[]]$Bytes, [int]$Width = 76) {
  $b64 = [System.Convert]::ToBase64String($Bytes)
  $lines = New-Object System.Collections.Generic.List[string]
  for ($i = 0; $i -lt $b64.Length; $i += $Width) {
    $length = [Math]::Min($Width, $b64.Length - $i)
    $lines.Add($b64.Substring($i, $length))
  }
  return ($lines -join "`n")
}

Write-Host 'dsh-octopus-operation-space - single-file offline deployer'

Write-Step 'read the package identity'
$manifest = (Read-TextFile (Join-Path $repo 'package.json')) | ConvertFrom-Json
$name = $manifest.name
$version = $manifest.version
if (-not $name -or -not $version) { throw 'package.json does not declare name/version' }
Write-Pass "$name@$version"

if (-not $BundleDir) { $BundleDir = Join-Path $OutDir "octopus-offline-$version" }
$packageDir = Join-Path $BundleDir 'package'
foreach ($required in @($packageDir, (Join-Path $BundleDir 'install-offline.ps1'), (Join-Path $BundleDir 'uninstall-plugin.ps1'), (Join-Path $BundleDir 'SHA256SUMS.txt'))) {
  if (-not (Test-Path -LiteralPath $required)) {
    throw "the multi-file bundle is incomplete: $required is missing. Run scripts\make-offline-package.ps1 first."
  }
}
Write-Pass "bundle inputs found under $BundleDir"

$commit = 'unknown'
$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  Push-Location $repo
  try {
    # No Select-Object -First here: truncating the pipeline kills git with a broken pipe and
    # $LASTEXITCODE stops meaning "rev-parse succeeded". @() as well, because a single-line
    # result is ONE string and $output[0] on a string is its first character (measured).
    $output = @(& git rev-parse --short HEAD 2>&1)
    if ($LASTEXITCODE -eq 0 -and $output.Count -gt 0) { $commit = ("$($output[0])").Trim() }
  } finally { Pop-Location }
} finally { $ErrorActionPreference = $previous }
$builtAt = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')

$work = Join-Path ([System.IO.Path]::GetTempPath()) ('octopus-oneclick-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work -Force | Out-Null
try {
  Write-Step 'zip the plugin package (that is what the deployer carries)'
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $payloadZipPath = Join-Path $work 'package.zip'
  # includeBaseDirectory = true, so the entries are package\... and extracting next to the
  # installer recreates exactly the layout install-offline.ps1 expects.
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $packageDir, $payloadZipPath,
    [System.IO.Compression.CompressionLevel]::Optimal, $true)
  $payloadBytes = [System.IO.File]::ReadAllBytes($payloadZipPath)
  $packageFileCount = (Get-ChildItem -LiteralPath $packageDir -Recurse -File).Count
  Write-Pass ("package\ -> {0:N1} KB zip ({1} files)" -f ($payloadBytes.Length / 1KB), $packageFileCount)

  Write-Step 'encode the payload and the installer'
  $installerBytes = [System.IO.File]::ReadAllBytes((Join-Path $BundleDir 'install-offline.ps1'))
  $uninstallerBytes = [System.IO.File]::ReadAllBytes((Join-Path $BundleDir 'uninstall-plugin.ps1'))
  $sumsBytes = [System.IO.File]::ReadAllBytes((Join-Path $BundleDir 'SHA256SUMS.txt'))
  $summaryBytes = [System.IO.File]::ReadAllBytes((Join-Path $scriptDir 'offline\oneclick\summary-zh.txt'))
  $summaryText = (New-Object System.Text.UTF8Encoding($false)).GetString($summaryBytes)
  if ($summaryText.Length -lt 20) { throw 'summary-zh.txt looks empty' }
  if ($summaryText -match '[\uFFFD]') { throw 'summary-zh.txt is not valid UTF-8' }
  Write-Pass ("installer {0:N1} KB, uninstaller {1:N1} KB, sums {2:N1} KB, summary {3} chars" -f `
      ($installerBytes.Length / 1KB), ($uninstallerBytes.Length / 1KB), ($sumsBytes.Length / 1KB), $summaryText.Length)

  Write-Step 'fill the deployer template'
  $template = Read-TextFile (Join-Path $scriptDir 'offline\oneclick\deploy-template.ps1')
  $deployer = $template
  foreach ($pair in @(
      @('<<PAYLOAD_ZIP>>', (ConvertTo-WrappedBase64 $payloadBytes)),
      @('<<INSTALLER_B64>>', (ConvertTo-WrappedBase64 $installerBytes)),
      @('<<UNINSTALLER_B64>>', (ConvertTo-WrappedBase64 $uninstallerBytes)),
      @('<<SUMS_B64>>', (ConvertTo-WrappedBase64 $sumsBytes)),
      @('<<SUMMARY_ZH_B64>>', (ConvertTo-WrappedBase64 $summaryBytes)),
      @('<<PLUGIN_NAME>>', $name),
      @('<<PLUGIN_VERSION>>', $version),
      @('<<BUILT_AT>>', $builtAt),
      @('<<COMMIT>>', $commit))) {
    $deployer = $deployer.Replace($pair[0], $pair[1])
  }
  if ($deployer -match '<<') { throw 'the deployer template still has an unreplaced placeholder' }
  if ($deployer.Length -lt 20000) { throw "the generated deployer looks truncated ($($deployer.Length) chars)" }
  if ($deployer -match '[^\x00-\x7F]') { throw 'the generated deployer is not pure ASCII' }
  Write-Pass ('deploy.ps1 rendered ({0:N0} KB, ASCII)' -f ($deployer.Length / 1KB))

  Write-Step 'wrap it in a double-clickable .cmd'
  $launcher = Read-TextFile (Join-Path $scriptDir 'offline\oneclick\launcher-template.cmd')
  $launcher = $launcher.Replace('<<PLUGIN_VERSION>>', $version)
  if ($launcher -match '<<') { throw 'the launcher template still has an unreplaced placeholder' }
  if ($launcher -match '[^\x00-\x7F]') { throw 'the launcher prologue is not pure ASCII' }
  $marker = '#OCTOPUS-PS1-BEGIN#'
  if (([regex]::Matches($launcher, [regex]::Escape($marker))).Count -ne 1) { throw "the launcher template must contain $marker exactly once" }
  if (([regex]::Matches($deployer, [regex]::Escape($marker))).Count -ne 0) { throw "the deployer must not contain $marker" }
  # CRLF throughout: batch needs it, and PowerShell reads either.
  $cmdText = ($launcher.TrimEnd("`r", "`n") + "`n" + $deployer.TrimStart("`n"))
  $cmdText = $cmdText -replace "(?<!`r)`n", "`r`n"

  # NOT $outDir: PowerShell variable names are case-INsensitive, so that would silently
  # overwrite the -OutDir parameter and put the zip inside the artifact folder (measured).
  $artifactDir = Join-Path $OutDir "octopus-oneclick-$version"
  if (Test-Path -LiteralPath $artifactDir) { Remove-Item -LiteralPath $artifactDir -Recurse -Force }
  New-Item -ItemType Directory -Path $artifactDir -Force | Out-Null
  $cmdPath = Join-Path $artifactDir 'deploy.cmd'
  $ps1Path = Join-Path $artifactDir 'deploy.ps1'
  Write-TextFile $ps1Path $deployer
  [System.IO.File]::WriteAllText($cmdPath, $cmdText, (New-Object System.Text.UTF8Encoding($false)))
  Write-Pass ('deploy.cmd rendered ({0:N0} KB)' -f ($cmdText.Length / 1KB))

  Write-Step 'verify the two artifacts parse and carry the same payload'
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($ps1Path, [ref]$tokens, [ref]$errors)
  if ($errors -and $errors.Count -gt 0) { Write-Fail "deploy.ps1 does not parse: $($errors[0].Message)" }
  # The payload inside the .cmd is what actually runs, so parse THAT text, not the .ps1.
  $cmdRead = [System.IO.File]::ReadAllText($cmdPath)
  $at = $cmdRead.IndexOf($marker)
  if ($at -lt 0) { throw "the generated .cmd lost its marker" }
  $embedded = $cmdRead.Substring($at + $marker.Length)
  $embeddedPath = Join-Path $work 'embedded.ps1'
  Write-TextFile $embeddedPath $embedded
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($embeddedPath, [ref]$tokens, [ref]$errors)
  if ($errors -and $errors.Count -gt 0) { Write-Fail "the .cmd payload does not parse: $($errors[0].Message)" }
  if ($script:failures -eq 0) { Write-Pass 'both artifacts parse under the PowerShell parser' }

  # The embedded installer must be the audited one, byte for byte; the embedded package must
  # be the same package\ the multi-file bundle ships.
  $embeddedZb64 = [regex]::Match($embedded, "(?s)\`$payloadZip = @'\r?\n(.*?)\r?\n'@").Groups[1].Value
  if (-not $embeddedZb64) { Write-Fail 'could not find the payload blob in the generated .cmd' }
  $checkZipPath = Join-Path $work 'check.zip'
  [System.IO.File]::WriteAllBytes($checkZipPath, [System.Convert]::FromBase64String(($embeddedZb64 -replace '[^A-Za-z0-9+/=]', '')))
  $archive = [System.IO.Compression.ZipFile]::OpenRead($checkZipPath)
  try {
    # .NET Framework's CreateFromDirectory writes BACKSLASH entry names on Windows
    # (measured: "package\package.json"), so compare with the separator normalised rather
    # than assuming what Compress-Archive produces.
    $entries = @($archive.Entries | Where-Object { -not $_.PSIsContainer })
    $manifestEntry = $entries | Where-Object { ($_.FullName -replace '\\', '/') -eq 'package/package.json' } | Select-Object -First 1
    if (-not $manifestEntry) {
      Write-Fail 'the embedded zip has no package/package.json'
    } else {
      $stream = $manifestEntry.Open()
      try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try { $embeddedHash = [System.BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
        finally { $sha.Dispose() }
      } finally { $stream.Dispose() }
      $sourceHash = (Get-FileHash -LiteralPath (Join-Path $packageDir 'package.json') -Algorithm SHA256).Hash
      if ($embeddedHash -ne $sourceHash) { Write-Fail 'the embedded package.json differs from the bundle' } else { Write-Pass "embedded package.json matches the bundle ($($entries.Count) entries)" }
    }
  } finally { $archive.Dispose() }

  $embeddedInstallerB64 = [regex]::Match($embedded, "(?s)\`$installerText = @'\r?\n(.*?)\r?\n'@").Groups[1].Value
  $embeddedInstaller = (New-Object System.Text.UTF8Encoding($false)).GetString([System.Convert]::FromBase64String(($embeddedInstallerB64 -replace '[^A-Za-z0-9+/=]', '')))
  $sourceInstaller = Read-TextFile (Join-Path $BundleDir 'install-offline.ps1')
  if ($embeddedInstaller -ne $sourceInstaller) { Write-Fail 'the embedded installer differs from the audited install-offline.ps1' } else { Write-Pass 'the embedded installer is byte-identical to install-offline.ps1' }

  if ($script:failures -gt 0) { throw "the single-file deployer has $script:failures problem(s)" }

  if (-not $SkipZip) {
    Write-Step 'zip (contains exactly one file)'
    $zipPath = Join-Path $OutDir "octopus-oneclick-$version.zip"
    if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
    Compress-Archive -LiteralPath $cmdPath -DestinationPath $zipPath -CompressionLevel Optimal
    $zipArchive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
    try { $zipEntries = @($zipArchive.Entries | Where-Object { -not $_.PSIsContainer }) } finally { $zipArchive.Dispose() }
    if ($zipEntries.Count -ne 1) { Write-Fail "the zip must contain one file, it has $($zipEntries.Count)" }
    elseif ($zipEntries[0].FullName -ne 'deploy.cmd') { Write-Fail "the zip entry is '$($zipEntries[0].FullName)', expected 'deploy.cmd'" }
    else { Write-Pass "zip holds exactly deploy.cmd ($([Math]::Round((Get-Item -LiteralPath $zipPath).Length / 1KB, 1)) KB)" }
    $zipHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
    Write-TextFile "$zipPath.sha256" ("$zipHash  $(Split-Path -Leaf $zipPath)`r`n")
    Write-Pass "sidecar $((Split-Path -Leaf $zipPath)).sha256 written"
  }
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

if ($script:failures -gt 0) { throw "the single-file package has $script:failures problem(s)" }

Write-Step 'done'
Write-Host "  deploy.cmd : $(Join-Path $OutDir "octopus-oneclick-$version\deploy.cmd")"
if (-not $SkipZip) { Write-Host "  zip        : $(Join-Path $OutDir "octopus-oneclick-$version.zip")" }
Write-Host ''
Write-Host '  On the air-gapped host: copy the zip, extract it, DOUBLE-CLICK deploy.cmd.'
Write-Host '  It needs no arguments, no terminal and no network, and it pauses before closing.'
Write-Host '  deploy.ps1 (next to the zip, not inside it) is the same deployer for hosts whose'
Write-Host '  .ps1 files do have a "Run with PowerShell" verb.'
Write-Host '  Optional: deploy.cmd -DryRun | -Uninstall | -Profile web | -Force'
