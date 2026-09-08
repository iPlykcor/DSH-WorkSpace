/**
 * Real-zip readZip tests (src/client/chunks/zip.tsx).
 */
import { describe, expect, it } from 'vitest'
import { zipSync } from 'fflate/browser'
import { readZip } from '../src/client/chunks/zip.tsx'

/** Clear the UTF-8 language flag (bit 0x800) in every header (local PK\x03\x04
 *  and central PK\x01\x02) so fflate treats the names as legacy CP437. */
function clearUtf8Flags(zip: Uint8Array): Uint8Array {
  const copy = zip.slice()
  for (let i = 0; i < copy.length - 4; i += 1) {
    const b0 = copy[i] ?? 0
    const b1 = copy[i + 1] ?? 0
    const b2 = copy[i + 2] ?? 0
    const b3 = copy[i + 3] ?? 0
    if (b0 === 0x50 && b1 === 0x4b && (b2 === 0x03 || b2 === 0x01) && b3 === 0x04 || (b2 === 0x01 && b3 === 0x02)) {
      copy[i + 8] = 0
      copy[i + 9] = 0
    }
  }
  return copy
}

describe('zip readZip', () => {
  it('parses a UTF-8-flagged archive into files + dirs', () => {
    const zip = zipSync({
      'docs/a.txt': new TextEncoder().encode('hi'),
      'src/b.ts': new TextEncoder().encode('x'),
      'docs/nested/notes.md': new TextEncoder().encode('# n'),
    })
    const archive = readZip(zip)
    expect([...archive.files.keys()].sort()).toEqual(['docs/a.txt', 'docs/nested/notes.md', 'src/b.ts'])
    expect([...archive.dirs].sort()).toEqual(['docs', 'docs/nested', 'src'])
  })

  it('keeps a legacy (unflagged) name via CP437-key reconstruction + re-decode', () => {
    // Names use UTF-8 bytes (representing a Chinese filename); flags cleared so
    // fflate decodes them as CP437. readZip must reconstruct the same CP437 key
    // (its inner CP437 table) to find the data, then re-decode to the UTF-8 name.
    const zip = clearUtf8Flags(zipSync({
      '測試.txt': new TextEncoder().encode('hi'),
      'plain.txt': new TextEncoder().encode('x'),
    }))
    const archive = readZip(zip)
    const keys = [...archive.files.keys()]
    expect(keys).toContain('測試.txt')
    expect(new TextDecoder().decode(archive.files.get('測試.txt')!)).toBe('hi')
  })
})
