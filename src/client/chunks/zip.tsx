/**
 * The lazy `zip` chunk: archive reading for the .zip "folder preview" viewer.
 * `fflate` (MIT) inflates entries; this module also parses the ZIP central
 * directory to recover each entry's RAW filename bytes + the UTF-8 language
 * flag, so names encoded in a legacy codepage (GBK / Big5) are re-decoded
 * instead of shown as latin1/CP437 mojibake. No disk writes; in-memory only.
 */
import { unzipSync, strFromU8 } from 'fflate/browser'

/** A parsed .zip archive: entry path → bytes, plus the set of directory paths. */
export interface ZipArchive {
  files: Map<string, Uint8Array>
  dirs: Set<string>
}

/** Read a .zip into an in-memory archive (files + directories). Entry paths
 *  are '/'-separated; directory paths carry no trailing '/'. */
export function readZip(bytes: ArrayBuffer | Uint8Array): ZipArchive {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const out = unzipSync(data)
  const files = new Map<string, Uint8Array>()
  const dirs = new Set<string>()
  const central = parseCentralDir(data)
  for (const entry of central) {
    // fflate keys each entry by its decoded name: UTF-8 when flagged, else
    // latin1 (each byte → a char). Recover that key from the raw bytes to look
    // up the data, then choose the DISPLAY name (re-decode legacy names).
    const key = entry.utf8 ? decodeUtf8(entry.nameBytes) : latin1(entry.nameBytes)
    const content = out[key]
    if (content === undefined) continue
    const name = entry.utf8 ? key : decodeLegacyName(entry.nameBytes)
    if (name.endsWith('/')) {
      addParentDirs(dirs, name.slice(0, -1))
      continue
    }
    files.set(name, content)
    addParentDirs(dirs, name)
  }
  return { files, dirs }
}

/** Register every ancestor directory of a path in `dirs`. */
function addParentDirs(dirs: Set<string>, path: string): void {
  const parts = path.split('/').filter(Boolean)
  let p = ''
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i] ?? ''
    p = p === '' ? part : `${p}/${part}`
    dirs.add(p)
  }
}

/** Decode a UTF-8 entry's bytes to a string (latin1 fallback for CP437-ish names). */
export function textOf(data: Uint8Array): string {
  try {
    return strFromU8(data)
  } catch {
    return strFromU8(data, true)
  }
}

/** The lowercased extension (no dot) of a zip entry path. */
export function extOfPath(path: string): string {
  const at = path.lastIndexOf('.')
  if (at === -1) return ''
  const base = path.slice(at + 1).toLowerCase()
  return base.includes('/') ? '' : base
}

// ── ZIP central-directory name recovery ──────────────────────────────────

interface CentralEntry {
  nameBytes: Uint8Array
  /** General-purpose bit 0x800 — the name is UTF-8. */
  utf8: boolean
}

/** Parse the central directory for each entry's raw filename bytes + UTF-8 flag. */
function parseCentralDir(bytes: Uint8Array): CentralEntry[] {
  const eocd = findEocd(bytes)
  if (eocd < 0) return []
  const total = (bytes[eocd + 10] ?? 0) | ((bytes[eocd + 11] ?? 0) << 8)
  const cdOffset = (bytes[eocd + 16] ?? 0) | ((bytes[eocd + 17] ?? 0) << 8) | ((bytes[eocd + 18] ?? 0) << 16) | ((bytes[eocd + 19] ?? 0) << 24)
  const entries: CentralEntry[] = []
  let p = cdOffset
  for (let n = 0; n < total; n += 1) {
    if (bytes[p] !== 0x50 || bytes[p + 1] !== 0x4b || bytes[p + 2] !== 0x01 || bytes[p + 3] !== 0x02) break
    const flag = (bytes[p + 8] ?? 0) | ((bytes[p + 9] ?? 0) << 8)
    const utf8 = (flag & 0x800) !== 0
    const nameLen = (bytes[p + 28] ?? 0) | ((bytes[p + 29] ?? 0) << 8)
    const extraLen = (bytes[p + 30] ?? 0) | ((bytes[p + 31] ?? 0) << 8)
    const commentLen = (bytes[p + 32] ?? 0) | ((bytes[p + 33] ?? 0) << 8)
    const nameBytes = bytes.slice(p + 46, p + 46 + nameLen)
    entries.push({ nameBytes, utf8 })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** Locate the End Of Central Directory signature (PK\x05\x06), searching back. */
function findEocd(bytes: Uint8Array): number {
  const min = Math.max(0, bytes.length - 65557)
  for (let i = bytes.length - 22; i >= min; i -= 1) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) return i
  }
  return -1
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return latin1(bytes)
  }
}

/** Heuristic for an unflagged (legacy) name: UTF-8 → GB18030 → Big5 → latin1. */
function decodeLegacyName(bytes: Uint8Array): string {
  const utf8 = tryDecode(bytes, 'utf-8')
  if (utf8 !== null) return utf8
  const gb = tryDecode(bytes, 'gb18030')
  if (gb !== null && hasCjk(gb)) return gb
  const big5 = tryDecode(bytes, 'big5')
  if (big5 !== null && hasCjk(big5)) return big5
  return latin1(bytes)
}

function tryDecode(bytes: Uint8Array, enc: string): string | null {
  try {
    return new TextDecoder(enc, { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

function hasCjk(s: string): boolean {
  return /[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/.test(s)
}

/** latin1 decode: every byte maps to the char with the same code point (this
 *  is how fflate decodes unflagged zip names, so the raw bytes are recoverable). */
function latin1(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i] ?? 0)
  return s
}
