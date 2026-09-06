import { describe, expect, it } from 'vitest'
import {
  autoActivateOf, DEFAULT_WS_AUTO_ACTIVATE, DEFAULT_WS_FOLDER_ACCESS,
  folderAccessOf, longestWsRoot, normalizeWsPath, parseWorkspaceManifest,
  stripJsonc, wsRootContains, type DshWorkspaceFile,
} from '../src/workspace-schema.ts'

describe('stripJsonc', () => {
  it('keeps plain JSON byte-for-byte', () => {
    const text = '{ "folders": [ "a" ], "x": { "y": 1 } }'
    expect(stripJsonc(text)).toBe(text)
  })

  it('drops line and block comments, preserving string contents', () => {
    const input = [
      '{ // drop me',
      '  "folders": ["/*not a comment*/", "// not a comment //"],',
      '  /* block',
      '     comment */',
      '  "x": 1, // trailing',
      '}',
    ].join('\n')
    const cleaned = stripJsonc(input)
    expect(cleaned).not.toContain('drop me')
    expect(cleaned).not.toContain('block')
    expect(cleaned).toContain('/*not a comment*/')
    expect(cleaned).toContain('// not a comment //')
    expect(JSON.parse(cleaned)).toEqual({ folders: ['/*not a comment*/', '// not a comment //'], x: 1 })
  })

  it('drops trailing commas but not commas inside strings', () => {
    const input = '{ "a": [1, 2,], "b": "x,}," , }'
    expect(JSON.parse(stripJsonc(input))).toEqual({ a: [1, 2], b: 'x,},' })
  })
})

describe('parseWorkspaceManifest', () => {
  const ok = (text: string): DshWorkspaceFile => {
    const result = parseWorkspaceManifest(text)
    expect(result.errors).toEqual([])
    expect(result.manifest).toBeDefined()
    return result.manifest!
  }

  it('accepts the canonical form with mixed access and string shorthand', () => {
    const manifest = ok(`{
      "version": 1,
      "name": "demo",
      "folders": [
        { "path": "C:/repo/a", "access": "readWrite" },
        { "path": "../docs" },
        "C:/repo/b"
      ],
      "settings": { "defaultAccess": "readWrite" }
    }`)
    expect(manifest.name).toBe('demo')
    expect(manifest.folders).toHaveLength(3)
    expect(manifest.folders[0]).toEqual({ path: 'C:/repo/a', access: 'readWrite' })
    expect(manifest.folders[2]).toEqual({ path: 'C:/repo/b' })
    expect(manifest.settings?.defaultAccess).toBe('readWrite')
  })

  it('defaults unlabeled folders to readOnly (security default)', () => {
    const manifest = ok('{ "folders": [{ "path": "/a" }, { "path": "/b", "access": "readWrite" }] }')
    expect(folderAccessOf(manifest.folders[0]!, manifest.settings)).toBe('readOnly')
    expect(folderAccessOf(manifest.folders[1]!, manifest.settings)).toBe('readWrite')
    expect(DEFAULT_WS_FOLDER_ACCESS).toBe('readOnly')
  })

  it('lets settings.defaultAccess flip the default', () => {
    const manifest = ok('{ "folders": [{ "path": "/a" }], "settings": { "defaultAccess": "readWrite" } }')
    expect(folderAccessOf(manifest.folders[0]!, manifest.settings)).toBe('readWrite')
  })

  it('autoActivate defaults to true and honors the setting', () => {
    expect(autoActivateOf(undefined)).toBe(DEFAULT_WS_AUTO_ACTIVATE)
    expect(autoActivateOf({})).toBe(true)
    expect(autoActivateOf({ autoActivate: false })).toBe(false)
  })

  it('reports blocking errors for malformed documents', () => {
    expect(parseWorkspaceManifest('{ nope').errors.length).toBeGreaterThan(0)
    const nonObject = parseWorkspaceManifest('"hi"')
    expect(nonObject.errors[0]?.message).toMatch(/object/)
    expect(parseWorkspaceManifest('{ "folders": [] }').errors[0]?.message).toMatch(/folders/)
    const badEntry = parseWorkspaceManifest('{ "folders": [{ "access": "readWrite" }] }')
    expect(badEntry.errors[0]?.message).toMatch(/path/)
  })

  it('warns (never blocks) on unknown access / version / settings types', () => {
    const soft = parseWorkspaceManifest(`{
      "version": 9,
      "folders": [
        { "path": "/a", "access": "chmod777" },
        { "path": "/b", "name": 42 }
      ],
      "settings": { "defaultAccess": "maybe", "autoActivate": "yes" }
    }`)
    expect(soft.errors).toEqual([])
    expect(soft.manifest).toBeDefined()
    expect(soft.warnings.length).toBeGreaterThanOrEqual(3)
    expect(folderAccessOf(soft.manifest!.folders[0]!, soft.manifest!.settings)).toBe('readOnly')
    expect(autoActivateOf(soft.manifest!.settings)).toBe(true)
  })
})

describe('ws path matching', () => {
  it('normalizes separators and optional case folding', () => {
    expect(normalizeWsPath('C:\\Users\\Me\\Project\\', false)).toBe('C:/Users/Me/Project')
    expect(normalizeWsPath('C:\\Users\\Me\\Project', true)).toBe('c:/users/me/project')
  })

  it('longestWsRoot picks the deepest matching root and ties go first', () => {
    const roots = ['/w', '/w/sub'].map(p => normalizeWsPath(p, false))
    expect(longestWsRoot('/w', roots)).toBe(0)
    expect(longestWsRoot('/w/sub', roots)).toBe(1)
    expect(longestWsRoot('/w/sub/deep/file.ts', roots)).toBe(1)
    expect(longestWsRoot('/other', roots)).toBe(-1)
    // A later duplicate of a shorter root must not shadow an earlier longer one.
    const dup = ['/w/sub', '/w', '/w/sub'].map(p => normalizeWsPath(p, false))
    expect(longestWsRoot('/w/sub/x', dup)).toBe(0)
  })

  it('wsRootContains is exact for the root itself and prefix-bounded for children', () => {
    const root = normalizeWsPath('/w', false)
    expect(wsRootContains(normalizeWsPath('/w', false), root)).toBe(true)
    expect(wsRootContains(normalizeWsPath('/w/a.ts', false), root)).toBe(true)
    expect(wsRootContains(normalizeWsPath('/w2', false), root)).toBe(false)
  })
})
