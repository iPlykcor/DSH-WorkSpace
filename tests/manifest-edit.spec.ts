/**
 * The manifest editor: the one place this plugin writes to the user's disk.
 *
 * These tests are the reason the editor exists as a separate module. A comment
 * losing round trip, a comma landing inside a trailing `// note`, a backup that
 * is not the original, or a failed edit that leaves a half-written manifest are
 * all silent failures in production — the file still exists, the tab still
 * renders, and only the author's manifest is quietly wrong. So each one is pinned
 * here, including the shape of the inserted text, byte for byte.
 *
 * The access rewrite has a worse failure mode on top of those: changing the WRONG
 * entry's permission, or refusing a legitimate one, is a security change the
 * operator never asked for — so its matching rule (exactly one hit, no guessing)
 * and the `changed: false` short circuit (no write, no backup) are pinned too.
 *
 * The removal has that failure mode and one of its own. It deletes an
 * authorization, so the same exactly-one-hit rule applies — and it is the append
 * read backwards, so the bytes it moves are pinned here as well: which separator
 * comma goes with the entry (one, never both: two leave `,,` and none leaves a
 * comma dangling before the `]`), and which line the entry may take with it. Its
 * third refusal is the product's own rule — a manifest must declare at least one
 * folder, so the array's ONLY entry cannot be removed — and like the other two it
 * is pinned as a document that did not move a byte, with no backup and no temp file
 * anywhere near it.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WS_MANIFEST_BACKUP_SUFFIX, addFolderToManifest, appendFolderEntry, backupPathFor,
  removeFolderEntry, removeFolderEntryInManifest, setFolderAccess, setFolderAccessInManifest,
} from '../src/manifest-edit.ts'
import { hasClaimedManifestExtension, parseWorkspaceManifest } from '../src/workspace-schema.ts'
import { WsManifestError } from '../src/workspace-policy.ts'

const created: string[] = []

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop()!
    await rm(dir, { recursive: true, force: true })
  }
})

/** A scratch directory that the test owns and removes. */
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'octopus-edit-'))
  created.push(dir)
  return dir
}

/** The written branch of an access rewrite, or a loud failure inside the test. */
function expectWritten(
  result: { changed: false } | { changed: true; backupPath: string; text: string },
): { backupPath: string; text: string } {
  if (!result.changed) throw new Error('expected the manifest edit to change the file')
  return result
}

/** Every file a refused or skipped edit must not leave behind. */
function leftoversOf(names: readonly string[]): string[] {
  return names.filter(name => name.includes(WS_MANIFEST_BACKUP_SUFFIX) || name.includes('.octopus-edit-'))
}

describe('appendFolderEntry', () => {
  it('appends after the last entry, leaving a trailing line comment a comment', () => {
    const before = [
      '{',
      '  // roots of the demo space',
      '  "folders": [',
      '    "C:/repo/a" // primary',
      '  ],',
      '  "settings": { "defaultAccess": "readOnly" }',
      '}',
      '',
    ].join('\n')
    const after = appendFolderEntry(before, { path: 'C:/repo/b', access: 'readOnly' })
    expect(after).toBe([
      '{',
      '  // roots of the demo space',
      '  "folders": [',
      '    "C:/repo/a", // primary',
      '    { "path": "C:/repo/b", "access": "readOnly" }',
      '  ],',
      '  "settings": { "defaultAccess": "readOnly" }',
      '}',
      '',
    ].join('\n'))
    // The decisive property: the comma sits behind the entry, never behind the
    // comment, so the document stays parseable.
    expect(parseWorkspaceManifest(after).errors).toEqual([])
  })

  it('expands an inline empty array at the array own indentation', () => {
    const before = '{\n  "folders": [],\n  "name": "demo"\n}\n'
    expect(appendFolderEntry(before, { path: 'C:/repo/b', access: 'readWrite' })).toBe(
      '{\n  "folders": [\n    { "path": "C:/repo/b", "access": "readWrite" }\n  ],\n  "name": "demo"\n}\n',
    )
  })

  it('keeps a comment that sits inside an otherwise empty array', () => {
    const before = '{\n  "folders": [\n    // add roots here\n  ]\n}\n'
    const after = appendFolderEntry(before, { path: 'C:/repo/b', access: 'readOnly' })
    expect(after).toBe(
      '{\n  "folders": [\n    { "path": "C:/repo/b", "access": "readOnly" }\n    // add roots here\n  ]\n}\n',
    )
    expect(parseWorkspaceManifest(after).errors).toEqual([])
  })

  it('ignores a folders token that is a value or sits inside a comment', () => {
    const before = [
      '{',
      '  // "folders": [ "decoy" ]',
      '  "name": "folders",',
      '  "folders": [',
      '    "C:/repo/a"',
      '  ]',
      '}',
      '',
    ].join('\n')
    expect(appendFolderEntry(before, { path: 'C:/repo/b', access: 'readOnly' })).toBe([
      '{',
      '  // "folders": [ "decoy" ]',
      '  "name": "folders",',
      '  "folders": [',
      '    "C:/repo/a",',
      '    { "path": "C:/repo/b", "access": "readOnly" }',
      '  ]',
      '}',
      '',
    ].join('\n'))
  })

  it('keeps the newline style the file already uses', () => {
    const after = appendFolderEntry('{\r\n  "folders": [\r\n    "C:/repo/a"\r\n  ]\r\n}\r\n', {
      path: 'C:/repo/b', access: 'readOnly',
    })
    expect(after).toBe(
      '{\r\n  "folders": [\r\n    "C:/repo/a",\r\n    { "path": "C:/repo/b", "access": "readOnly" }\r\n  ]\r\n}\r\n',
    )
  })

  it('states the access level explicitly, so a readWrite default cannot upgrade it', () => {
    const after = appendFolderEntry('{ "folders": [] }', { path: 'C:/repo/b', access: 'readOnly' })
    expect(after).toContain('"access": "readOnly"')
    expect(parseWorkspaceManifest(after).manifest?.folders[0]).toEqual({
      path: 'C:/repo/b', access: 'readOnly',
    })
  })

  it('refuses a manifest with no folders array instead of guessing where to put one', () => {
    expect(() => appendFolderEntry('{ "name": "demo" }', { path: 'C:/repo/b', access: 'readOnly' }))
      .toThrowError(/no "folders" array/)
  })

  it('reuses a trailing comma the author left in the array', () => {
    // A trailing comma is valid JSONC here, so it must not turn the append into a
    // `,,` the product's parser refuses.
    const after = appendFolderEntry([
      '{',
      '  "folders": [',
      '    "C:/repo/a",',
      '  ]',
      '}',
      '',
    ].join('\n'), { path: 'C:/repo/b', access: 'readOnly' })
    expect(after).toBe([
      '{',
      '  "folders": [',
      '    "C:/repo/a",',
      '    { "path": "C:/repo/b", "access": "readOnly" }',
      '  ]',
      '}',
      '',
    ].join('\n'))
    expect(parseWorkspaceManifest(after).errors).toEqual([])
  })
})

describe('setFolderAccess', () => {
  it('replaces one declared access level and leaves every other byte alone', () => {
    const before = [
      '{',
      '  "name": "demo",',
      '  "folders": [',
      '    { "path": "C:/repo/a", "access": "readOnly" },',
      '    { "path": "C:/repo/b", "access": "readOnly" }',
      '  ]',
      '}',
      '',
    ].join('\n')
    const result = setFolderAccess(before, raw => raw === 'C:/repo/b', 'readWrite')
    expect(result.changed).toBe(true)
    expect(result.text).toBe([
      '{',
      '  "name": "demo",',
      '  "folders": [',
      '    { "path": "C:/repo/a", "access": "readOnly" },',
      '    { "path": "C:/repo/b", "access": "readWrite" }',
      '  ]',
      '}',
      '',
    ].join('\n'))
    // Exactly one literal moved: undo it and the original is back byte for byte.
    expect(result.text.replace('"readWrite"', '"readOnly"')).toBe(before)
    expect(parseWorkspaceManifest(result.text).manifest?.folders).toEqual([
      { path: 'C:/repo/a', access: 'readOnly' },
      { path: 'C:/repo/b', access: 'readWrite' },
    ])
  })

  it('keeps the comments inside and around the member it rewrites', () => {
    const before = [
      '{',
      '  // roots of the demo space',
      '  "folders": [',
      '    {',
      '      // the primary checkout, shared by the whole team',
      '      "path": "C:/repo/a", // keep this one read-only',
      '      "access": "readOnly"',
      '    },',
      '    { "path": "C:/repo/b", "access": "readWrite" }',
      '  ]',
      '}',
      '',
    ].join('\n')
    const result = setFolderAccess(before, raw => raw === 'C:/repo/a', 'readWrite')
    expect(result.text).toBe([
      '{',
      '  // roots of the demo space',
      '  "folders": [',
      '    {',
      '      // the primary checkout, shared by the whole team',
      '      "path": "C:/repo/a", // keep this one read-only',
      '      "access": "readWrite"',
      '    },',
      '    { "path": "C:/repo/b", "access": "readWrite" }',
      '  ]',
      '}',
      '',
    ].join('\n'))
    expect(result.text).toContain('// keep this one read-only\n')
    expect(parseWorkspaceManifest(result.text).errors).toEqual([])
    expect(parseWorkspaceManifest(result.text).manifest?.folders[0]?.access).toBe('readWrite')
  })

  it('adds the member when the object declares no access, keeping a note a comment', () => {
    const before = [
      '{',
      '  "folders": [',
      '    {',
      '      "path": "C:/repo/a" // the note keeps its line',
      '    }',
      '  ]',
      '}',
      '',
    ].join('\n')
    const result = setFolderAccess(before, raw => raw === 'C:/repo/a', 'readOnly')
    expect(result.changed).toBe(true)
    expect(result.text).toBe([
      '{',
      '  "folders": [',
      '    {',
      '      "path": "C:/repo/a", // the note keeps its line',
      '      "access": "readOnly"',
      '    }',
      '  ]',
      '}',
      '',
    ].join('\n'))
    // The decisive property, same as the append rule: the comma sits behind the
    // value, so the note is still a comment and the document still parses.
    expect(parseWorkspaceManifest(result.text).manifest?.folders).toEqual([
      { path: 'C:/repo/a', access: 'readOnly' },
    ])
  })

  it('keeps a one-line object on one line when it has to add the member', () => {
    const before = '{\n  "folders": [\n    { "path": "C:/repo/a" }\n  ]\n}\n'
    expect(setFolderAccess(before, raw => raw === 'C:/repo/a', 'readOnly').text).toBe(
      '{\n  "folders": [\n    { "path": "C:/repo/a", "access": "readOnly" }\n  ]\n}\n',
    )
  })

  it('reuses a trailing comma instead of writing a second one', () => {
    // JSONC tolerates the trailing comma an author leaves behind after deleting an
    // entry, so the edit must treat it as the separator it already is: `,,` would
    // leave the manifest unparseable and the transaction would refuse the edit.
    const before = [
      '{',
      '  "folders": [',
      '    {',
      '      "path": "C:/repo/a", // note',
      '    }',
      '  ]',
      '}',
      '',
    ].join('\n')
    const result = setFolderAccess(before, raw => raw === 'C:/repo/a', 'readOnly')
    expect(result.text).toBe([
      '{',
      '  "folders": [',
      '    {',
      '      "path": "C:/repo/a", // note',
      '      "access": "readOnly"',
      '    }',
      '  ]',
      '}',
      '',
    ].join('\n'))
    expect(parseWorkspaceManifest(result.text).manifest?.folders).toEqual([
      { path: 'C:/repo/a', access: 'readOnly' },
    ])
  })

  it('rewrites a string-shorthand entry into the object form, token verbatim', () => {
    const before = [
      '{',
      '  "folders": [',
      '    "C:/repo/a",',
      '    "D:/shared" // the shared drive',
      '  ]',
      '}',
      '',
    ].join('\n')
    const result = setFolderAccess(before, raw => raw === 'D:/shared', 'readOnly')
    expect(result.changed).toBe(true)
    expect(result.text).toBe([
      '{',
      '  "folders": [',
      '    "C:/repo/a",',
      '    { "path": "D:/shared", "access": "readOnly" } // the shared drive',
      '  ]',
      '}',
      '',
    ].join('\n'))
    expect(parseWorkspaceManifest(result.text).manifest?.folders).toEqual([
      { path: 'C:/repo/a' },
      { path: 'D:/shared', access: 'readOnly' },
    ])
    // The rewrite is idempotent: the entry now declares exactly what was asked for.
    expect(setFolderAccess(result.text, raw => raw === 'D:/shared', 'readOnly'))
      .toEqual({ text: result.text, changed: false })
  })

  it('copies the shorthand token verbatim, escapes and all, instead of re-quoting it', () => {
    // The `\/` escape is the giveaway: it decodes to `/`, so a re-quoted (or
    // unescaped) rewrite would not reproduce this token.
    const before = '{\n  "folders": [\n    "D:\\/shared"\n  ]\n}\n'
    const result = setFolderAccess(before, raw => raw === 'D:/shared', 'readOnly')
    expect(result.text).toBe(
      '{\n  "folders": [\n    { "path": "D:\\/shared", "access": "readOnly" }\n  ]\n}\n',
    )
    expect(parseWorkspaceManifest(result.text).manifest?.folders).toEqual([
      { path: 'D:/shared', access: 'readOnly' },
    ])
  })

  it('reports no change when the entry already declares that access', () => {
    const before = '{\n  "folders": [\n    { "path": "C:/repo/a", "access": "readOnly" }\n  ]\n}\n'
    expect(setFolderAccess(before, raw => raw === 'C:/repo/a', 'readOnly'))
      .toEqual({ text: before, changed: false })
  })

  it('uses the document newline style for a member that needs its own line', () => {
    const before = '{\r\n  "folders": [\r\n    {\r\n      "path": "C:/repo/a" // note\r\n    }\r\n  ]\r\n}\r\n'
    expect(setFolderAccess(before, raw => raw === 'C:/repo/a', 'readOnly').text).toBe(
      '{\r\n  "folders": [\r\n    {\r\n      "path": "C:/repo/a", // note\r\n      "access": "readOnly"\r\n    }\r\n  ]\r\n}\r\n',
    )
  })

  it('leaves a leading byte-order mark where it was', () => {
    // The product's own parser rejects a BOM (JSON.parse does), so the pure edit is
    // where this guarantee has to hold: whatever bytes surround the entry, the edit
    // never touches them.
    const before = '\ufeff{\n  "folders": [\n    "C:/repo/a"\n  ]\n}\n'
    const result = setFolderAccess(before, raw => raw === 'C:/repo/a', 'readOnly')
    expect(result.text.startsWith('\ufeff{')).toBe(true)
    expect(result.text.slice(0, 1)).toBe(before.slice(0, 1))
  })

  it('refuses a manifest with no folders array, like the append path', () => {
    expect(() => setFolderAccess('{ "name": "demo" }', () => true, 'readOnly'))
      .toThrowError(/no "folders" array/)
  })

  it('refuses when no entry matches instead of writing nothing quietly', () => {
    const before = '{\n  "folders": [\n    "C:/repo/a"\n  ]\n}\n'
    expect(() => setFolderAccess(before, raw => raw === 'C:/repo/z', 'readOnly'))
      .toThrowError(WsManifestError)
    expect(() => setFolderAccess(before, raw => raw === 'C:/repo/z', 'readOnly'))
      .toThrowError(/no declared folder matches/)
  })

  it('refuses when more than one entry matches, instead of guessing which one', () => {
    const before = [
      '{',
      '  "folders": [',
      '    "C:/repo/a",',
      '    { "path": "C:/repo/a", "access": "readOnly" }',
      '  ]',
      '}',
      '',
    ].join('\n')
    expect(() => setFolderAccess(before, raw => raw === 'C:/repo/a', 'readWrite'))
      .toThrowError(WsManifestError)
    expect(() => setFolderAccess(before, raw => raw === 'C:/repo/a', 'readWrite'))
      .toThrowError(/2 declared folders match/)
  })

  it('matches on the path the entry declares, not on the one the caller picks', () => {
    const before = [
      '{',
      '  "folders": [',
      '    "../docs",',
      '    { "path": "../src", "access": "readOnly" }',
      '  ]',
      '}',
      '',
    ].join('\n')
    // A relative path is handed over exactly as written: the caller resolves it.
    const result = setFolderAccess(before, raw => raw === '../src', 'readWrite')
    expect(result.text).toContain('{ "path": "../src", "access": "readWrite" }')
  })
})

describe('removeFolderEntry', () => {
  it('removes a middle entry, keeping both neighbours and their comments', () => {
    const before = [
      '{',
      '  "name": "demo",',
      '  "folders": [',
      '    "C:/repo/a", // primary',
      '    "C:/repo/b",',
      '    "C:/repo/c" // tertiary',
      '  ]',
      '}',
      '',
    ].join('\n')
    const result = removeFolderEntry(before, raw => raw === 'C:/repo/b')
    expect(result.changed).toBe(true)
    expect(result.text).toBe([
      '{',
      '  "name": "demo",',
      '  "folders": [',
      '    "C:/repo/a", // primary',
      '    "C:/repo/c" // tertiary',
      '  ]',
      '}',
      '',
    ].join('\n'))
    // The decisive property: exactly one comma went with the entry, so the two
    // surviving entries are still separated and both notes are still comments.
    expect(parseWorkspaceManifest(result.text).errors).toEqual([])
    expect(parseWorkspaceManifest(result.text).manifest?.folders).toEqual([
      { path: 'C:/repo/a' },
      { path: 'C:/repo/c' },
    ])
  })

  it('removes the last entry without leaving its separator dangling before the bracket', () => {
    const before = [
      '{',
      '  "folders": [',
      '    "C:/repo/a",',
      '    "C:/repo/b"',
      '  ]',
      '}',
      '',
    ].join('\n')
    const result = removeFolderEntry(before, raw => raw === 'C:/repo/b')
    // The last entry has no comma behind it, so the PRECEDING one is the separator
    // that has to go: leaving it behind is the `"C:/repo/a", ]` the parser refuses.
    expect(result.text).toBe([
      '{',
      '  "folders": [',
      '    "C:/repo/a"',
      '  ]',
      '}',
      '',
    ].join('\n'))
    expect(result.text).not.toContain(',,')
    expect(parseWorkspaceManifest(result.text).errors).toEqual([])
  })

  it('removes the last entry of an array that carries a JSONC trailing comma', () => {
    // A trailing comma is already tolerated by the parser, which is exactly why the
    // removal has to be careful here: taking the entry out while leaving BOTH its
    // own comma and the one before it would produce the `,,` the parser refuses.
    const before = [
      '{',
      '  "folders": [',
      '    "C:/repo/a",',
      '    "C:/repo/b",',
      '  ]',
      '}',
      '',
    ].join('\n')
    const result = removeFolderEntry(before, raw => raw === 'C:/repo/b')
    expect(result.text).toBe([
      '{',
      '  "folders": [',
      '    "C:/repo/a",',
      '  ]',
      '}',
      '',
    ].join('\n'))
    expect(result.text).not.toContain(',,')
    expect(parseWorkspaceManifest(result.text).errors).toEqual([])
    expect(parseWorkspaceManifest(result.text).manifest?.folders).toEqual([{ path: 'C:/repo/a' }])
  })

  it('removes the first of two entries and keeps the survivor comment', () => {
    const before = [
      '{',
      '  "folders": [',
      '    "C:/repo/a", // primary',
      '    "C:/repo/b" // secondary',
      '  ]',
      '}',
      '',
    ].join('\n')
    expect(removeFolderEntry(before, raw => raw === 'C:/repo/a').text).toBe([
      '{',
      '  "folders": [',
      '    "C:/repo/b" // secondary',
      '  ]',
      '}',
      '',
    ].join('\n'))
  })

  it('refuses to remove the only entry, before it moves a byte', () => {
    // The product's own rule, not taste: `folders` must be a NON-EMPTY array, so a
    // removal of the last entry could only ever produce a manifest the transactional
    // re-read refuses. Refusing here is what turns that into a reason the operator
    // can read — and it is the same guarantee the other two refusals give: nothing
    // moves, so nothing has to be undone or cleaned up.
    const before = [
      '{',
      '  "folders": [',
      '    // the only root for now',
      '    "C:/repo/a"',
      '  ]',
      '}',
      '',
    ].join('\n')
    expect(() => removeFolderEntry(before, raw => raw === 'C:/repo/a'))
      .toThrowError(WsManifestError)
    expect(() => removeFolderEntry(before, raw => raw === 'C:/repo/a'))
      .toThrowError(/this is the only declared folder, and a manifest must declare at least one; nothing was changed/)
    // Not a byte of the document changed: it still declares its one root and still
    // carries the comment that lives in the array.
    const parsed = parseWorkspaceManifest(before)
    expect(parsed.errors).toEqual([])
    expect(parsed.manifest?.folders).toEqual([{ path: 'C:/repo/a' }])
    expect(before).toContain('// the only root for now')
  })

  it('counts only the entries it located, so comments in the array do not pose as entries', () => {
    // The only-entry refusal has to be about REAL entries: an array whose text also
    // holds a note, or an entry-shaped line inside a comment, still holds exactly one
    // declared folder, and removing it must be refused rather than attempted.
    const before = [
      '{',
      '  "folders": [',
      '    // "C:/repo/decoy" is not an entry, it is a note',
      '    "C:/repo/a",',
      '    /* neither is this: { "path": "C:/repo/other" } */',
      '    "C:/repo/b"',
      '  ]',
      '}',
      '',
    ].join('\n')
    // Two real entries, so this one is allowed — and only the note-bearing chatter
    // is skipped by the scanner, which is what makes the removal byte-exact.
    expect(removeFolderEntry(before, raw => raw === 'C:/repo/a').text).toBe([
      '{',
      '  "folders": [',
      '    // "C:/repo/decoy" is not an entry, it is a note',
      '    /* neither is this: { "path": "C:/repo/other" } */',
      '    "C:/repo/b"',
      '  ]',
      '}',
      '',
    ].join('\n'))
    // Now the same note-bearing array with only ONE real entry: refused.
    const only = [
      '{',
      '  "folders": [',
      '    // "C:/repo/decoy" is not an entry, it is a note',
      '    "C:/repo/a"',
      '  ]',
      '}',
      '',
    ].join('\n')
    expect(() => removeFolderEntry(only, raw => raw === 'C:/repo/a'))
      .toThrowError(/this is the only declared folder/)
  })

  it('removes a string-shorthand entry by its decoded path, escapes and all', () => {
    // The `\/` escape is the giveaway: it decodes to `/`, so a match that compared
    // the raw token instead of the value would not find this entry at all.
    const before = [
      '{',
      '  "folders": [',
      '    "C:/repo/a",',
      '    "D:\\/shared", // the shared drive',
      '    { "path": "C:/repo/c", "access": "readOnly" }',
      '  ]',
      '}',
      '',
    ].join('\n')
    const result = removeFolderEntry(before, raw => raw === 'D:/shared')
    expect(result.text).toBe([
      '{',
      '  "folders": [',
      '    "C:/repo/a",',
      '    { "path": "C:/repo/c", "access": "readOnly" }',
      '  ]',
      '}',
      '',
    ].join('\n'))
    expect(parseWorkspaceManifest(result.text).manifest?.folders).toEqual([
      { path: 'C:/repo/a' },
      { path: 'C:/repo/c', access: 'readOnly' },
    ])
  })

  it('keeps the newline style of a CRLF document', () => {
    const before = '{\r\n  "folders": [\r\n    "C:/repo/a", // keep\r\n    "C:/repo/b"\r\n  ]\r\n}\r\n'
    expect(removeFolderEntry(before, raw => raw === 'C:/repo/b').text).toBe(
      '{\r\n  "folders": [\r\n    "C:/repo/a" // keep\r\n  ]\r\n}\r\n',
    )
  })

  it('takes a note on the removed entry own line with it', () => {
    // The pinned choice, and the reason for it: an entry that owns its line owns
    // that line's note too — that line is exactly what an append wrote, so this is
    // what makes a removal reproduce the file the append started from. A note on a
    // NEIGHBOURING line is not the entry's and stays (see the middle-entry test).
    const before = [
      '{',
      '  "folders": [',
      '    "C:/repo/a",',
      '    "C:/repo/b", // the scratch clone',
      '    "C:/repo/c"',
      '  ]',
      '}',
      '',
    ].join('\n')
    const result = removeFolderEntry(before, raw => raw === 'C:/repo/b')
    expect(result.text).toBe([
      '{',
      '  "folders": [',
      '    "C:/repo/a",',
      '    "C:/repo/c"',
      '  ]',
      '}',
      '',
    ].join('\n'))
    expect(result.text).not.toContain('// the scratch clone')
  })

  it('takes the comments and blank lines inside a removed object entry with it', () => {
    // The other half of the same choice: what sits INSIDE the entry's own braces IS
    // the entry, so it goes with it. Leaving that hole — the notes of a deleted root
    // floating inside a deleted object — would be a manifest nobody wrote.
    const before = [
      '{',
      '  "folders": [',
      '    "C:/repo/a",',
      '    {',
      '      // the scratch clone, deleted again',
      '',
      '      "path": "C:/repo/b"',
      '    },',
      '    "C:/repo/c"',
      '  ]',
      '}',
      '',
    ].join('\n')
    const result = removeFolderEntry(before, raw => raw === 'C:/repo/b')
    expect(result.text).toBe([
      '{',
      '  "folders": [',
      '    "C:/repo/a",',
      '    "C:/repo/c"',
      '  ]',
      '}',
      '',
    ].join('\n'))
    expect(parseWorkspaceManifest(result.text).errors).toEqual([])
    expect(parseWorkspaceManifest(result.text).manifest?.folders).toEqual([
      { path: 'C:/repo/a' },
      { path: 'C:/repo/c' },
    ])
  })

  it('removes an entry from a one-line array without taking the line with it', () => {
    // The flip side of "the entry owns its line": when a line is SHARED, no line is
    // this entry's to take — a whole-line cut here would delete its neighbours too.
    const before = '{ "folders": ["C:/repo/a", "C:/repo/b"] }\n'
    const result = removeFolderEntry(before, raw => raw === 'C:/repo/b')
    expect(result.text).toBe('{ "folders": ["C:/repo/a" ] }\n')
    expect(parseWorkspaceManifest(result.text).errors).toEqual([])
    expect(parseWorkspaceManifest(result.text).manifest?.folders).toEqual([{ path: 'C:/repo/a' }])
  })

  it('refuses when no entry matches, so a stale row cannot empty the array', () => {
    const before = '{\n  "folders": [\n    "C:/repo/a"\n  ]\n}\n'
    expect(() => removeFolderEntry(before, raw => raw === 'C:/repo/z'))
      .toThrowError(WsManifestError)
    expect(() => removeFolderEntry(before, raw => raw === 'C:/repo/z'))
      .toThrowError(/no declared folder matches/)
    // Nothing was changed and there is no second answer to write: the document the
    // caller passed in still declares its entry.
    expect(parseWorkspaceManifest(before).manifest?.folders).toEqual([{ path: 'C:/repo/a' }])
  })

  it('refuses when more than one entry matches, naming the count', () => {
    const before = [
      '{',
      '  "folders": [',
      '    "C:/repo/a",',
      '    { "path": "C:/repo/a", "access": "readOnly" }',
      '  ]',
      '}',
      '',
    ].join('\n')
    expect(() => removeFolderEntry(before, raw => raw === 'C:/repo/a'))
      .toThrowError(WsManifestError)
    expect(() => removeFolderEntry(before, raw => raw === 'C:/repo/a'))
      .toThrowError(/2 declared folders match/)
  })

  it('refuses a manifest with no folders array, like the other two edits', () => {
    expect(() => removeFolderEntry('{ "name": "demo" }', () => true))
      .toThrowError(/no "folders" array/)
  })

  it('removes exactly what an append wrote, reproducing the original bytes', async () => {
    // The removal is the append read backwards, so this is the test that keeps the
    // two honest about each other: whatever an append introduced — the separator
    // comma and the whole fresh line — is what a removal has to give back.
    const dir = await scratch()
    const manifest = join(dir, 'demo.dsh-octopus')
    const original = [
      '{',
      '  // roots of the demo space',
      '  "folders": [',
      '    "C:/repo/a" // primary',
      '  ],',
      '  "settings": { "defaultAccess": "readOnly" }',
      '}',
      '',
    ].join('\n')
    await writeFile(manifest, original, 'utf8')

    const appended = await addFolderToManifest(manifest, { path: 'C:/repo/b', access: 'readOnly' })
    expect(appended.text).not.toBe(original)

    expect(removeFolderEntry(appended.text, raw => raw === 'C:/repo/b').text).toBe(original)
  })
})

describe('addFolderToManifest', () => {
  it('writes the entry, keeps every comment, and leaves the original as a backup', async () => {
    const dir = await scratch()
    const manifest = join(dir, 'demo.dsh-octopus')
    const original = [
      '{',
      '  // keep me',
      '  "folders": [',
      '    "C:/repo/a" // primary',
      '  ]',
      '}',
      '',
    ].join('\n')
    await writeFile(manifest, original, 'utf8')

    const result = await addFolderToManifest(manifest, { path: 'C:/repo/b', access: 'readWrite' })

    expect(result.backupPath).toBe(`${manifest}`.concat(result.backupPath.slice(manifest.length)))
    expect(result.backupPath.endsWith(WS_MANIFEST_BACKUP_SUFFIX)).toBe(true)
    // A backup must never look like a manifest, or discovery would offer it.
    expect(hasClaimedManifestExtension(result.backupPath)).toBe(false)
    expect(await readFile(result.backupPath, 'utf8')).toBe(original)

    const written = await readFile(manifest, 'utf8')
    expect(written).toBe(result.text)
    expect(written).toContain('// keep me')
    expect(written).toContain('// primary')
    const parsed = parseWorkspaceManifest(written)
    expect(parsed.errors).toEqual([])
    expect(parsed.manifest?.folders).toEqual([
      { path: 'C:/repo/a' },
      { path: 'C:/repo/b', access: 'readWrite' },
    ])
  })

  it('restores the file byte for byte and keeps no backup when the edit is rejected', async () => {
    const dir = await scratch()
    const manifest = join(dir, 'broken.dsh-octopus')
    // The array is fine and the document is not: the product's parser refuses it,
    // which is exactly the check that must catch a bad edit before it sticks.
    const original = '{ "folders": [ "C:/repo/a" ]'
    await writeFile(manifest, original, 'utf8')

    await expect(addFolderToManifest(manifest, { path: 'C:/repo/b', access: 'readOnly' }))
      .rejects.toThrowError(/invalid manifest/)

    expect(await readFile(manifest, 'utf8')).toBe(original)
    // Neither a sidecar backup nor the temporary file may survive a refused edit:
    // the file is untouched, so there is nothing to undo and nothing to clean up.
    const leftovers = (await readdir(dir))
      .filter(name => name.includes(WS_MANIFEST_BACKUP_SUFFIX) || name.includes('.octopus-edit-'))
    expect(leftovers).toEqual([])
  })

  it('names a fresh backup per edit', () => {
    expect(backupPathFor('C:/ws/demo.dsh-octopus')).toMatch(
      /^C:\/ws\/demo\.dsh-octopus\.\d{8}-\d{6}\.octopus-backup$/,
    )
  })
})

describe('setFolderAccessInManifest', () => {
  it('rewrites the entry, keeps every comment, and leaves the original as a backup', async () => {
    const dir = await scratch()
    const manifest = join(dir, 'demo.dsh-octopus')
    const original = [
      '{',
      '  // keep me',
      '  "folders": [',
      '    { "path": "C:/repo/a", "access": "readOnly" } // primary',
      '  ]',
      '}',
      '',
    ].join('\n')
    await writeFile(manifest, original, 'utf8')

    const result = expectWritten(
      await setFolderAccessInManifest(manifest, raw => raw === 'C:/repo/a', 'readWrite'),
    )

    expect(result.backupPath.endsWith(WS_MANIFEST_BACKUP_SUFFIX)).toBe(true)
    // A backup must never look like a manifest, or discovery would offer it.
    expect(hasClaimedManifestExtension(result.backupPath)).toBe(false)
    expect(await readFile(result.backupPath, 'utf8')).toBe(original)

    const written = await readFile(manifest, 'utf8')
    expect(written).toBe(result.text)
    expect(written).toContain('// keep me')
    expect(written).toContain('// primary')
    const parsed = parseWorkspaceManifest(written)
    expect(parsed.errors).toEqual([])
    expect(parsed.manifest?.folders).toEqual([{ path: 'C:/repo/a', access: 'readWrite' }])
    // A successful edit cleans up after itself even though it keeps the backup:
    // the sidecar is the only thing that may be left in the directory.
    const names = await readdir(dir)
    expect(leftoversOf(names)).toEqual([result.backupPath.slice(dir.length + 1)])
  })

  it('writes nothing at all when the entry already declares that access', async () => {
    const dir = await scratch()
    const manifest = join(dir, 'demo.dsh-octopus')
    const original = '{\n  "folders": [\n    { "path": "C:/repo/a", "access": "readOnly" }\n  ]\n}\n'
    await writeFile(manifest, original, 'utf8')

    const result = await setFolderAccessInManifest(manifest, raw => raw === 'C:/repo/a', 'readOnly')

    expect(result).toEqual({ changed: false })
    // No write and, above all, no sidecar: a backup next to an untouched manifest
    // would suggest something changed, which is exactly what must not be implied.
    expect(await readFile(manifest, 'utf8')).toBe(original)
    expect(leftoversOf(await readdir(dir))).toEqual([])
  })

  it('restores the file byte for byte and keeps no backup when the rewrite is rejected', async () => {
    const dir = await scratch()
    const manifest = join(dir, 'broken.dsh-octopus')
    // The array is fine and the document is not: the product's parser refuses it,
    // which is exactly the check that must catch a bad edit before it sticks.
    const original = '{ "folders": [ "C:/repo/a" ]'
    await writeFile(manifest, original, 'utf8')

    await expect(setFolderAccessInManifest(manifest, raw => raw === 'C:/repo/a', 'readWrite'))
      .rejects.toThrowError(/invalid manifest/)

    expect(await readFile(manifest, 'utf8')).toBe(original)
    // Neither a sidecar backup nor the temporary file may survive a refused rewrite.
    expect(leftoversOf(await readdir(dir))).toEqual([])
  })

  it('leaves the manifest alone when the requested entry does not exist', async () => {
    const dir = await scratch()
    const manifest = join(dir, 'demo.dsh-octopus')
    const original = '{\n  "folders": [\n    { "path": "C:/repo/a" }\n  ]\n}\n'
    await writeFile(manifest, original, 'utf8')

    await expect(setFolderAccessInManifest(manifest, raw => raw === 'C:/repo/z', 'readWrite'))
      .rejects.toThrowError(WsManifestError)

    expect(await readFile(manifest, 'utf8')).toBe(original)
    expect(leftoversOf(await readdir(dir))).toEqual([])
  })
})

describe('removeFolderEntryInManifest', () => {
  it('drops the entry, keeps every other comment, and leaves the original as a backup', async () => {
    const dir = await scratch()
    const manifest = join(dir, 'demo.dsh-octopus')
    const original = [
      '{',
      '  // keep me',
      '  "folders": [',
      '    "C:/repo/a", // primary',
      '    { "path": "C:/repo/b", "access": "readOnly" }, // the scratch clone',
      '    "C:/repo/c" // tertiary',
      '  ]',
      '}',
      '',
    ].join('\n')
    await writeFile(manifest, original, 'utf8')

    const result = await removeFolderEntryInManifest(manifest, raw => raw === 'C:/repo/b')

    // There is no "already like that" answer here: a declared entry was dropped, so
    // the call reports a change, a write and the sidecar that undoes it.
    expect(result.changed).toBe(true)
    expect(result.backupPath.endsWith(WS_MANIFEST_BACKUP_SUFFIX)).toBe(true)
    // A backup must never look like a manifest, or discovery would offer it.
    expect(hasClaimedManifestExtension(result.backupPath)).toBe(false)
    expect(await readFile(result.backupPath, 'utf8')).toBe(original)

    const written = await readFile(manifest, 'utf8')
    expect(written).toBe(result.text)
    expect(written).toContain('// keep me')
    expect(written).toContain('// primary')
    expect(written).toContain('// tertiary')
    // The dropped entry's own line went with it, note included (the pinned choice);
    // every comment that was not on that line is still there.
    expect(written).not.toContain('// the scratch clone')
    const parsed = parseWorkspaceManifest(written)
    expect(parsed.errors).toEqual([])
    expect(parsed.manifest?.folders).toEqual([
      { path: 'C:/repo/a' },
      { path: 'C:/repo/c' },
    ])
    // A successful removal cleans up after itself even though it keeps the backup:
    // the sidecar is the only thing that may be left in the directory.
    const names = await readdir(dir)
    expect(leftoversOf(names)).toEqual([result.backupPath.slice(dir.length + 1)])
  })

  it('restores the file byte for byte and keeps no backup when the removal is rejected', async () => {
    const dir = await scratch()
    const manifest = join(dir, 'broken.dsh-octopus')
    // The array is fine and the document is not: the product's parser refuses it,
    // which is exactly the check that must catch a bad edit before it sticks. Two
    // entries, so this is a removal the pure edit allows and the re-read rejects.
    const original = '{ "folders": [ "C:/repo/a", "C:/repo/b" ]'
    await writeFile(manifest, original, 'utf8')

    await expect(removeFolderEntryInManifest(manifest, raw => raw === 'C:/repo/b'))
      .rejects.toThrowError(/invalid manifest/)

    expect(await readFile(manifest, 'utf8')).toBe(original)
    // Neither a sidecar backup nor the temporary file may survive a refused removal.
    expect(leftoversOf(await readdir(dir))).toEqual([])
  })

  it('leaves the manifest and the directory alone when the entry is not declared', async () => {
    const dir = await scratch()
    const manifest = join(dir, 'demo.dsh-octopus')
    const original = '{\n  "folders": [\n    { "path": "C:/repo/a" }\n  ]\n}\n'
    await writeFile(manifest, original, 'utf8')

    await expect(removeFolderEntryInManifest(manifest, raw => raw === 'C:/repo/z'))
      .rejects.toThrowError(WsManifestError)

    expect(await readFile(manifest, 'utf8')).toBe(original)
    // The refusal happens before the transaction opens: there is nothing to undo, so
    // a sidecar here would claim an edit that never happened.
    expect(leftoversOf(await readdir(dir))).toEqual([])
  })

  it('refuses to empty the array, before any backup or temporary file exists', async () => {
    // The product's own schema is what decides this, not taste: `"folders"` must be
    // a non-empty array, so dropping the ONLY declared entry would leave a manifest
    // the parser refuses. The pure edit refuses it first, which is the difference
    // between the operator reading a reason and reading a validation error — and it
    // means the last root of a space cannot be removed from here at all.
    const dir = await scratch()
    const manifest = join(dir, 'demo.dsh-octopus')
    const original = '{\n  "folders": [\n    "C:/repo/a" // the only root\n  ]\n}\n'
    await writeFile(manifest, original, 'utf8')

    await expect(removeFolderEntryInManifest(manifest, raw => raw === 'C:/repo/a'))
      .rejects.toThrowError(/this is the only declared folder, and a manifest must declare at least one; nothing was changed/)

    expect(await readFile(manifest, 'utf8')).toBe(original)
    // Not just "no leftovers": the refusal happens BEFORE the transaction opens, so
    // the directory still holds nothing but the manifest — no sidecar, no temp file.
    expect(await readdir(dir)).toEqual(['demo.dsh-octopus'])
    expect(leftoversOf(await readdir(dir))).toEqual([])
  })
})
