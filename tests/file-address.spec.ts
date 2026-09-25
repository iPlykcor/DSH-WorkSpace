/**
 * Pins {@link sessionFileAddress} against the PRODUCT'S OWN address parser.
 *
 * The client bundle cannot import `@deepseek-ai/dsh-util-workspace-path` (it is
 * not part of the frozen client module table, so the bundle purity gate rejects
 * it), which means the address grammar is reimplemented in
 * src/client/file-address.ts. A hand-rolled builder is only trustworthy if the
 * product agrees with it, so every case here is round-tripped through the real
 * `parseFileAddress` — the exact function the built-in document-preview tab
 * uses in its `canOpen` check.
 *
 * This spec is HOST-side (plain Node, no bundle): the purity gate does not
 * apply to tests, so the real package is used as a devDependency.
 */
import { parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { describe, expect, it } from 'vitest'
import { FILE_ADDRESS_PREFIX, sessionFileAddress } from '../src/client/file-address.ts'

/** A session id carrying a character that must survive encoding. */
const SESSION_ID = 'sess 1/2'

describe('sessionFileAddress', () => {
  it('produces a session-scoped address the product parser round-trips', () => {
    const paths = [
      'D:\\DSH_WorkSpace\\demo\\a.txt',
      '/home/me/notes.md',
      'C:/repo/子目录/文件.txt',
      '\\\\server\\share\\x y.txt',
      'D:\\a b\\c#d?e.txt',
    ]
    for (const path of paths) {
      const address = sessionFileAddress(SESSION_ID, path)
      expect(address.startsWith(FILE_ADDRESS_PREFIX)).toBe(true)
      expect(parseFileAddress(address)).toEqual({
        scope: 'session',
        sessionId: SESSION_ID,
        path: path.replace(/\\/g, '/'),
      })
    }
  })

  it('stays in the only scope the built-in document viewer claims', () => {
    // dsh-client-ui-sidebar-documentpreview registers the sole file-claiming tab
    // type with `canOpen: address => parseFileAddress(address)?.scope === 'session'`.
    // An `absolute`-scoped address is claimed by NO type and makes openResource
    // throw, so this must hold for every path the tree can produce — including
    // the absolute paths of roots OUTSIDE the session workspace.
    for (const path of ['/a/b.txt', 'C:\\a\\b.txt', '\\\\srv\\share\\b.txt']) {
      expect(parseFileAddress(sessionFileAddress(SESSION_ID, path))?.scope).toBe('session')
    }
  })

  it('keeps a drive letter literal and escapes spaces, # and ?', () => {
    expect(sessionFileAddress('s1', 'C:\\repo\\a b#c?.txt'))
      .toBe('dsh-resource://file/session/s1/C:/repo/a%20b%23c%3F.txt')
  })

  it('encodes the session id', () => {
    expect(sessionFileAddress('a/b', '/x.txt')).toBe('dsh-resource://file/session/a%2Fb//x.txt')
  })
})
