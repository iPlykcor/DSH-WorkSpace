/**
 * Archive-format sniffing shared by the archive folder-preview surfaces
 * (ZipView + the center Files view). The three supported container formats
 * are recognised by their leading magic bytes, so the same viewer can route
 * the fetched bytes to the right reader — zip→fflate, 7z→7z-wasm, rar→
 * node-unrar-js — without trusting the file extension.
 */

/** The archive formats the folder-preview viewer can open. */
export type ArchiveFormat = 'zip' | '7z' | 'rar'

/** Extensions that route to the folder-preview archive viewer. */
export const ARCHIVE_EXTS: readonly string[] = ['zip', '7z', 'rar']

/** The lowercased extension (no dot) of a path. */
export function extOfPath(path: string): string {
  const at = path.lastIndexOf('.')
  if (at === -1) return ''
  return path.slice(at + 1).toLowerCase()
}

/** Whether an extension is one the archive folder-preview viewer handles. */
export function isArchiveExt(ext: string): boolean {
  return ARCHIVE_EXTS.includes(ext.toLowerCase())
}

/**
 * Detect the archive format from the leading bytes.
 * - zip:  `PK\x03\x04` (local header) or `PK\x05\x06` (empty end-of-central)
 * - 7z:   `37 7A BC AF 27 1C`
 * - rar:  `Rar!\x1A\x07` followed by `\x00` (RAR4) or `\x01\x00` (RAR5)
 * Returns `null` when the bytes are too short or the signature is unknown.
 */
export function archiveFormatOf(bytes: ArrayBuffer | Uint8Array): ArchiveFormat | null {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (data.length < 4) return null
  const b = (i: number): number => data[i] ?? 0
  // ZIP local-file / empty-archive signatures.
  if (b(0) === 0x50 && b(1) === 0x4b) {
    if ((b(2) === 0x03 && b(3) === 0x04) || (b(2) === 0x05 && b(3) === 0x06)) return 'zip'
  }
  // 7-Zip.
  if (data.length >= 6 && b(0) === 0x37 && b(1) === 0x7a && b(2) === 0xbc && b(3) === 0xaf && b(4) === 0x27 && b(5) === 0x1c) {
    return '7z'
  }
  // RAR4 / RAR5. RAR4 signature is 7 bytes (`Rar!\x1A\x07\x00`); RAR5 adds a
  // fifth marker byte (`Rar!\x1A\x07\x01\x00`).
  if (data.length >= 7 && b(0) === 0x52 && b(1) === 0x61 && b(2) === 0x72 && b(3) === 0x21 && b(4) === 0x1a && b(5) === 0x07) {
    if (b(6) === 0x00) return 'rar'
    if (data.length >= 8 && b(6) === 0x01 && b(7) === 0x00) return 'rar'
  }
  return null
}
