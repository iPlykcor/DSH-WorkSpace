<#
.SYNOPSIS
  Regenerate src\client\guide-artwork.tsx from a source image.

.DESCRIPTION
  The start-page capsule draws its artwork from a React component
  (ui-sidebar-right: `entry.icon ?? CubeGlyph`), not from a URL, so the image has
  to travel inside the client bundle. This script centre-crops the source to a
  square, downscales it, encodes JPEG, and writes the whole TypeScript module -
  header comment, data URL and component - so swapping the artwork stays a
  reproducible one-liner instead of a hand-edited base64 blob.

  Why so small: the capsule draws the artwork at 26 px (22 px without a
  description), so 128 px is already ~5x oversampled for a 2x display, and
  tests\client-tab.spec.ts caps the encoded length so a future artwork cannot
  quietly add a megabyte to every client load.

  Output is ASCII-only and written WITHOUT a BOM: the repo's rule is that a
  BOM-less UTF-8 script is read as the system ANSI code page by PS 5.1, and
  PowerShell's own -Encoding UTF8 would emit one.

.PARAMETER Source
  Source image (JPEG, PNG, BMP or GIF). A transparent PNG is flattened onto
  white by JPEG encoding - pass a white-background source for predictable edges.

.PARAMETER Size
  Square edge length in pixels. Default 128.

.PARAMETER Quality
  JPEG quality 1-100. Default 88.

.PARAMETER Target
  Output module. Defaults to src\client\guide-artwork.tsx in this repository.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\make-guide-artwork.ps1 -Source ..\候选.jpg
#>
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [int]$Size = 128,
  [int]$Quality = 88,
  [string]$Target
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
if (-not $Target) { $Target = Join-Path $root 'src\client\guide-artwork.tsx' }
if (-not (Test-Path -LiteralPath $Source)) { throw "source image not found: $Source" }
if ($Size -lt 16 -or $Size -gt 1024) { throw "size must be 16..1024, got $Size" }
if ($Quality -lt 1 -or $Quality -gt 100) { throw "quality must be 1..100, got $Quality" }

$temporary = Join-Path $env:TEMP ('octopus-artwork-' + [guid]::NewGuid().ToString('N') + '.jpg')
$image = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $Source).Path)
try {
  $width = $image.Width
  $height = $image.Height
  $side = [Math]::Min($width, $height)
  $crop = New-Object System.Drawing.Rectangle ([int](($width - $side) / 2)), ([int](($height - $side) / 2)), $side, $side

  $canvas = New-Object System.Drawing.Bitmap $Size, $Size
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($canvas)
    try {
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $graphics.DrawImage($image, (New-Object System.Drawing.Rectangle 0, 0, $Size, $Size), $crop, [System.Drawing.GraphicsUnit]::Pixel)
    } finally { $graphics.Dispose() }

    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
    if (-not $codec) { throw 'no JPEG encoder available' }
    $parameters = New-Object System.Drawing.Imaging.EncoderParameters 1
    $parameters.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([int64]$Quality)
    $canvas.Save($temporary, $codec, $parameters)
  } finally { $canvas.Dispose() }
} finally { $image.Dispose() }

$bytes = [System.IO.File]::ReadAllBytes($temporary)
Remove-Item -LiteralPath $temporary -Force
$encoded = [Convert]::ToBase64String($bytes)

$header = @'
/**
 * The operation space's guide artwork: what the start-page capsule shows where a
 * tab type without an illustration of its own gets the platform's cube
 * placeholder (`ui-sidebar-right/lib/client.js:461` - `entry.icon ?? CubeGlyph`).
 *
 * WHY AN EMBEDDED DATA URL. `guide[].icon` is a React COMPONENT
 * (`ComponentType<IconProps>`, drawn at `size` 22 - or 26 while the capsule also
 * renders its description), not a URL, so the artwork has to arrive as parts:
 * either a shipped file the shell fetches, or the bytes themselves. The bytes win
 * here - no host route, no trust fence, no second request, and no broken image
 * while one is in flight - at the price of bundle weight. That price is why the
 * source is centre-cropped and downscaled to 128 px (the capsule draws it at 26)
 * and why `tests/client-tab.spec.ts` caps the encoded length: a future artwork
 * cannot quietly add a megabyte to every client load.
 *
 * `borderRadius` makes the artwork read as a tile instead of a crop, and
 * `objectFit: cover` keeps it square whatever the source's aspect ratio. No colour
 * is hardcoded, so the skin stays the shell's business; the image is decorative,
 * so it is hidden from assistive technology and the capsule's title carries the
 * meaning. REGENERATE, DO NOT HAND-EDIT:
 * `scripts\make-guide-artwork.ps1 -Source <image>`.
 */
import type { ReactElement } from 'react'

/** Props the platform passes to a guide icon. */
export interface GuideIconProps {
  size?: number
  className?: string
}

/** The artwork: JPEG, 128x128, centre-cropped from the source. */
const ARTWORK = '
'@

$footer = @'

/**
 * Render the operation space's guide artwork.
 * @param props - the platform's icon props.
 * @returns the artwork at the requested size.
 */
export function OctopusGuideArtwork({ size, className }: GuideIconProps): ReactElement {
  return (
    <img
      src={ARTWORK}
      alt=""
      aria-hidden="true"
      className={className}
      width={size}
      height={size}
      style={{ width: size, height: size, borderRadius: '22%', objectFit: 'cover' }}
    />
  )
}
'@

$module = $header + 'data:image/jpeg;base64,' + $encoded + "'" + $footer
$utf8 = New-Object System.Text.UTF8Encoding $false

# Guard rail before the overwrite: the repo has lost a file once to a
# String.Replace that returned $null and was written straight back.
if ($module.Length -lt 2000 -or -not $module.StartsWith('/**')) { throw 'refusing to write a suspiciously small module' }
[System.IO.File]::WriteAllText($Target, $module, $utf8)

$written = [System.IO.File]::ReadAllText($Target, [System.Text.Encoding]::UTF8)
$nonAscii = ([regex]::Matches($written, '[^\x00-\x7F]')).Count
if ($nonAscii -ne 0) { throw "output is not ASCII-only ($nonAscii offending characters)" }
$check = [regex]::Match($written, "base64,([A-Za-z0-9+/=]+)'").Groups[1].Value
if ([Convert]::FromBase64String($check).Length -ne $bytes.Length) { throw 'round-trip check failed' }

Write-Host ("source    : {0} ({1}x{2})" -f (Resolve-Path -LiteralPath $Source).Path, $width, $height)
Write-Host ("written   : {0}" -f $Target)
Write-Host ("jpeg      : {0} bytes at {1}x{1}, quality {2}" -f $bytes.Length, $Size, $Quality)
Write-Host ("base64    : {0} characters" -f $encoded.Length)
Write-Host ("module    : {0} bytes, ASCII-only" -f (Get-Item -LiteralPath $Target).Length)
