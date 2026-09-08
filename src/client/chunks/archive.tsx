/**
 * The lazy `archive` chunk: the 7z + rar folder-preview readers, fetched by
 * ZipView on first open of a 7z/rar file (see chunk-loader.ts). The core
 * bundle never statically imports this entry.
 *
 * Both libraries are wasm-backed and ship their .wasm as a separate file:
 * - 7z  → `7z-wasm` (LGPL) — the full 7-Zip CLI compiled to wasm; we drive it
 *   through an in-memory FS (write the archive bytes, `callMain(["x", …])`,
 *   then read the extracted tree).
 * - rar → `node-unrar-js` (UnRAR license) — an extraction API over the
 *   official C++ unrar compiled to wasm; `extract()` yields each entry's bytes.
 *
 * The .wasm payloads are embedded at build time as base64 (inlineWasmPlugin
 * reads them from the plugin's own dependency tree) so the chunk is fully
 * self-contained for the offline/intranet install — no host wasm route, no
 * runtime filesystem dependency. base64 is decoded once per open; the wasm
 * instance is cached for the page (7z) / for the library (unrar).
 */
import SevenZip from '7z-wasm'
import { createExtractorFromData } from 'node-unrar-js'
import sevenZipWasm from 'dsh-wasm/7z'
import unrarWasm from 'dsh-wasm/unrar'
import type { ZipArchive } from '../zip-types.ts'

/** The 7z wasm module factory result (lazy-initialised once per page). */
let sevenZipModule: Awaited<ReturnType<typeof SevenZip>> | null = null
/** The decoded 7z wasm bytes (cached; decompressing 1.65MB per open is wasteful). */
let sevenZipWasmBinary: ArrayBuffer | null = null

/** base64 → Uint8Array (browser `atob`). */
function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
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

/** Create (once) the 7z-wasm module driven through its in-memory FS. */
async function getSevenZip() {
  if (sevenZipModule !== null) return sevenZipModule
  if (sevenZipWasmBinary === null) sevenZipWasmBinary = b64ToBytes(sevenZipWasm).buffer as ArrayBuffer
  sevenZipModule = await SevenZip({
    wasmBinary: sevenZipWasmBinary,
    noExitRuntime: true,
    print: () => {},
    printErr: () => {},
  })
  return sevenZipModule
}

/**
 * Read a 7z archive: write the bytes into the wasm FS, run `x` to extract
 * everything into `/memout`, then walk the extracted tree and read each file.
 * Returns the same {@link ZipArchive} shape as the zip reader.
 */
export async function read7z(bytes: ArrayBuffer | Uint8Array): Promise<ZipArchive> {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const sevenZip = await getSevenZip()
  const FS = sevenZip.FS
  const name = '/archive.7z'
  try {
    const stream = FS.open(name, 'w+')
    FS.write(stream, data, 0, data.length)
    FS.close(stream)
    sevenZip.callMain(['x', name, '-o/memout', '-y'])
  } catch (failure) {
    throw new Error(failure instanceof Error ? failure.message : String(failure))
  }
  const files = new Map<string, Uint8Array>()
  const dirs = new Set<string>()
  const root = '/memout'
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = FS.readdir(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry === '.' || entry === '..') continue
      const full = `${dir}/${entry}`
      let isDir = false
      try {
        const st = FS.stat(full)
        isDir = FS.isDir(st.mode)
      } catch {
        continue
      }
      const rel = full.slice(root.length + 1)
      if (isDir) {
        dirs.add(rel)
        walk(full)
      } else {
        const content = FS.readFile(full)
        files.set(rel, content)
        addParentDirs(dirs, rel)
      }
    }
  }
  walk(root)
  return { files, dirs }
}

/**
 * Read a rar archive via node-unrar-js: `extract()` yields every entry with
 * its name + uncompressed bytes, so we build the archive map in one pass.
 */
export async function readRar(bytes: ArrayBuffer | Uint8Array): Promise<ZipArchive> {
  const data = bytes instanceof Uint8Array
    ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    : bytes
  const wasmBinary = b64ToBytes(unrarWasm).buffer as ArrayBuffer
  const extractor = await createExtractorFromData({ data, wasmBinary })
  const files = new Map<string, Uint8Array>()
  const dirs = new Set<string>()
  const { files: extracted } = extractor.extract()
  for (const file of extracted) {
    const header = file.fileHeader
    const name = header.name
    if (header.flags.directory) {
      dirs.add(name)
      addParentDirs(dirs, name)
    } else {
      files.set(name, file.extraction ?? new Uint8Array(0))
      addParentDirs(dirs, name)
    }
  }
  return { files, dirs }
}
