/**
 * Archive-format sniffing tests (src/client/archive-format.ts): the magic-byte
 * detector that routes fetched bytes to the right archive reader.
 */
import { describe, expect, it } from 'vitest'
import { archiveFormatOf, isArchiveExt, extOfPath } from '../src/client/archive-format.ts'

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values)
}

describe('archiveFormatOf', () => {
  it('detects zip by the PK local-file signature', () => {
    expect(archiveFormatOf(bytes(0x50, 0x4b, 0x03, 0x04))).toBe('zip')
  })

  it('detects an empty zip by the PK end-of-central-directory signature', () => {
    expect(archiveFormatOf(bytes(0x50, 0x4b, 0x05, 0x06, 0x00, 0x00))).toBe('zip')
  })

  it('detects 7z by the 37 7A BC AF 27 1C signature', () => {
    expect(archiveFormatOf(bytes(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c))).toBe('7z')
  })

  it('detects RAR4 and RAR5 by the Rar!^A^G signature', () => {
    expect(archiveFormatOf(bytes(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00))).toBe('rar')
    expect(archiveFormatOf(bytes(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00))).toBe('rar')
  })

  it('returns null for unknown or too-short inputs', () => {
    expect(archiveFormatOf(bytes(0x00, 0x01, 0x02, 0x03))).toBeNull()
    expect(archiveFormatOf(new ArrayBuffer(0))).toBeNull()
    expect(archiveFormatOf(bytes(0x50, 0x4b))).toBeNull()
  })
})

describe('isArchiveExt / extOfPath', () => {
  it('recognises the supported archive extensions', () => {
    expect(isArchiveExt('zip')).toBe(true)
    expect(isArchiveExt('7z')).toBe(true)
    expect(isArchiveExt('rar')).toBe(true)
    expect(isArchiveExt('ZIP')).toBe(true)
    expect(isArchiveExt('txt')).toBe(false)
  })

  it('lowercases and strips the dot from a path', () => {
    expect(extOfPath('/w/My.File.ZIP')).toBe('zip')
    expect(extOfPath('no-ext')).toBe('')
  })
})
