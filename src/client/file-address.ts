/**
 * Build the `dsh-resource://file/…` address that delegates file viewing to
 * DSH's own document viewer.
 *
 * WHY THIS FILE EXISTS (and why it builds the string itself):
 * DSH's Sidebar navigation takes a resource ADDRESS, and the address grammar
 * has two file scopes:
 * - `dsh-resource://file/session/<sessionId>/<path>` — a file named in a
 *   Session; `<path>` may be workspace-relative OR absolute;
 * - `dsh-resource://file/absolute/<path>` — a file named by absolute path,
 *   carrying no Session.
 *
 * Only the built-in document-preview tab claims file addresses, and its
 * `canOpen` is `parseFileAddress(address)?.scope === 'session'` — the
 * `absolute` scope is claimed by NOTHING, so opening one throws. The address
 * this plugin needs must therefore stay in the `session` scope while carrying
 * an ABSOLUTE path, which is exactly what the product's own `fileAddressFor`
 * produces for a path outside the session workspace ("an absolute path outside
 * it … keeps its absolute path in that Session's address").
 *
 * The product helper lives in `@deepseek-ai/dsh-util-workspace-path`. That
 * package is browser-safe, but it is NOT part of the frozen client module
 * table, so importing it from the client bundle is exactly the cross-package
 * value import the bundle purity gate forbids. The grammar is short and
 * fully specified, so it is implemented here instead and PINNED by
 * tests/file-address.spec.ts, which round-trips every case through the
 * product's real `parseFileAddress`.
 *
 * @module
 */

/** The scope prefix every address produced here shares. */
export const FILE_ADDRESS_PREFIX = 'dsh-resource://file/session/'

/**
 * Component-encode one path segment the way the address grammar requires.
 *
 * `encodeURIComponent` escapes `:` as `%3A`, but the grammar keeps a colon
 * literal so a Windows drive letter reads as written (`…/C:/x/y.txt`).
 * @param segment - one `/`-separated path segment (possibly empty).
 * @returns the encoded segment.
 */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ':')
}

/**
 * Build the session-scoped address of an absolute file path.
 *
 * The path is kept ABSOLUTE rather than made workspace-relative: the host's
 * file route resolves absolute paths both inside and outside the Session's
 * workspace, and keeping one uniform spelling avoids depending on which
 * workspace root the Session currently holds.
 * @param sessionId - the Session the file is opened in.
 * @param path - an absolute path in either separator spelling.
 * @returns the `dsh-resource://file/session/<sessionId>/<path>` address.
 */
export function sessionFileAddress(sessionId: string, path: string): string {
  // Backslashes normalize to `/` (the grammar is `/`-separated); a POSIX
  // absolute path then contributes its own empty first segment, which is the
  // double slash the product's builder produces too.
  const segments = path.replace(/\\/g, '/').split('/').map(encodeSegment).join('/')
  return `${FILE_ADDRESS_PREFIX}${encodeURIComponent(sessionId)}/${segments}`
}
