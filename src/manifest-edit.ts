/**
 * The ONE place this plugin writes to the user's disk: the three edits to a
 * manifest a session already activated, each reachable only through an explicit
 * operator gesture — appending a folder (the right-click action in the tab body,
 * after the host's native directory chooser returned a folder), rewriting one
 * declared entry's access level (the lock/unlock toggle on a root row) and
 * dropping one declared entry (the row's own menu).
 *
 * WHY A SCANNER AND NOT A PARSER ROUND TRIP. A manifest is JSONC, and its
 * comments are the author's notes — which root is temporary, why one folder is
 * read-only. `JSON.parse` + `JSON.stringify` would silently delete every one of
 * them. So all three edits are textual and surgical: find the `folders` array's `[` and
 * its matching `]` with a string- and comment-aware scan, then move only the bytes
 * the edit is actually about. For the append, the insertion point is the end of
 * the array's LAST SIGNIFICANT item. That last rule is what keeps a trailing
 * `// note` after the final entry a comment: the comma goes behind `"C:/repo/a"`,
 * never behind `// main`, where it would be swallowed by the comment and leave the
 * document unparseable. The access rewrite applies the same rule one level down,
 * to the members of an object entry. Nothing else in the file moves — not a
 * comment, not a blank line, not the newline style, not a byte-order mark.
 *
 * WHICH ENTRY AN ACCESS REWRITE TOUCHES. It matches on the entry's path AS WRITTEN
 * and demands EXACTLY ONE hit. Zero hits and several hits are both refused: only
 * the caller knows what a relative path is relative to, and a permission write
 * that guesses its target is a silent security change in one direction or the
 * other. An object entry that declares an `access` has that string literal
 * replaced in place, so a note behind it and every other member survive; an object
 * entry without one gets `, "access": "..."` after its last member. A
 * string-shorthand entry has nowhere to put a member, so the element itself turns
 * into the object form with the original path token copied VERBATIM — never
 * re-quoted, never unescaped.
 *
 * WHAT A REMOVAL TAKES WITH IT. The same matching rule, and THREE refusals that
 * all move nothing — not a byte, no temporary file, no backup: no entry matches the
 * caller's path (a stale row must not empty an array), more than one matches (only
 * the caller knows what a relative path is relative to, and deleting the wrong
 * entry deletes an authorization), or the array holds exactly ONE located entry —
 * the product's schema requires a non-empty `folders`, so that removal could only
 * produce a manifest the re-read validation refuses, and saying so before the
 * transaction opens gives the operator a reason instead of a validation error. The
 * bytes an allowed removal moves are the entry's own source plus EXACTLY ONE
 * separator comma — the one behind it when the author wrote one there, otherwise
 * the one in front of it, which would otherwise be left dangling before the `]`.
 * Never a comma on BOTH sides: two in a row is exactly the `,,` the parser refuses.
 * An entry that owns its line owns that line: its indentation, its text and (when
 * the author wrote them there) its separator comma and the note behind it all go
 * together — those are exactly the bytes an append introduced, so removing an
 * appended entry reproduces the file the append started from. A comment on a
 * NEIGHBOURING line is not the entry's and stays where it is; a comment or blank
 * line inside a removed object entry is inside that entry's source and goes with
 * it. Nothing else moves.
 *
 * TRANSACTION, NOT A WRITE. Three independent things can go wrong with an edit to
 * the file that decides which paths exist for this plugin, so all three are
 * covered: the original is copied to a timestamped sidecar FIRST, the new text
 * lands in a sibling temporary file and is `rename`d into place (atomic on one
 * volume), and the result is re-read and validated with the product's own parser
 * — on any failure the backup is restored and the caller gets an error instead of
 * a half-edited manifest. A failed edit that restored cleanly deletes its own
 * backup (nothing changed, so there is nothing to keep); a successful edit keeps
 * it, which is how the operator undoes one. An access rewrite that finds the
 * requested level already declared writes nothing at all — no temporary file, no
 * backup, nothing to undo. A removal has no such branch to offer: an entry that is
 * not declared is an error, so a removal that returns at all has written the file
 * and left a backup. The backup name ends in `.octopus-backup`, deliberately NOT
 * one of `WS_MANIFEST_EXTS`: a backup must never be discovered as a manifest
 * candidate in the session cwd.
 *
 * READ-ONLY IS STILL STRUCTURAL ELSEWHERE. This module edits policy; it never
 * writes inside a declared root. The manifest usually lives in the session cwd,
 * which the policy itself treats as a root — so this file is the one documented
 * exception to "nothing outside the plugin writes here", and it is reachable only
 * through a user gesture plus a containment-checked route.
 */
import { copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { parseWorkspaceManifest, WS_MANIFEST_MAX_BYTES } from './workspace-schema.ts'
import type { OctopusAccess } from './workspace-schema.ts'
import { WsManifestError } from './workspace-policy.ts'

/** The sidecar suffix a manifest backup carries (never a claimed manifest extension). */
export const WS_MANIFEST_BACKUP_SUFFIX = '.octopus-backup'

/** One folder to append, exactly as it will be written. */
export interface ManifestFolderEntry {
  /** The `path` value verbatim: absolute, or relative to the manifest's directory. */
  path: string
  /**
   * The permission written EXPLICITLY, always. Omitting it would fall back to
   * `settings.defaultAccess`, so a manifest whose settings say `readWrite` would
   * silently turn an operator's "read-only" pick into a writable root.
   */
  access: OctopusAccess
}

/** What one successful edit produced. */
export interface ManifestEditResult {
  /** Absolute path of the backup taken before the edit. */
  backupPath: string
  /** The file's text after the edit (already validated). */
  text: string
}

/** Indentation added for a fresh item when the array has none to copy. */
const DEFAULT_INDENT = '  '

/**
 * Index of the character after a JSON string that starts at `start` (a `"`).
 * Escapes are honoured, so a `\"` inside the string does not end it.
 * @param text - the document.
 * @param start - index of the opening quote.
 * @returns index just past the closing quote, or the document length when unterminated.
 */
function afterString(text: string, start: number): number {
  let i = start + 1
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '\\') { i += 2; continue }
    if (ch === '"') return i + 1
    i += 1
  }
  return text.length
}

/**
 * The value of a JSON string token: the token's exact source, with its escapes
 * resolved the way the product's parser resolves them, so matching happens on the
 * path a caller can actually resolve and compare.
 * @param token - the token's source, its quotes included.
 * @returns the decoded value, or the raw inner text when the token is not valid JSON.
 */
function stringTokenValue(token: string): string {
  try {
    const parsed: unknown = JSON.parse(token)
    return typeof parsed === 'string' ? parsed : token.slice(1, -1)
  } catch {
    return token.slice(1, -1)
  }
}

/**
 * Index of the first non-trivia character at or after `start`, skipping
 * whitespace and both JSONC comment forms.
 * @param text - the document.
 * @param start - where to start.
 * @param limit - never walk past this index (the array's closing bracket).
 * @returns the index of the first significant character (or `limit`).
 */
function skipTrivia(text: string, start: number, limit: number = text.length): number {
  let i = start
  while (i < limit) {
    const ch = text[i]!
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i += 1; continue }
    if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i)
      i = end === -1 || end >= limit ? limit : end + 1
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 || end + 2 > limit ? limit : end + 2
      continue
    }
    return i
  }
  return limit
}

/** Whether only whitespace separates `index` from the start of its line. */
function isOnlyWhitespaceSinceNewline(text: string, index: number): boolean {
  let i = index - 1
  while (i >= 0) {
    const ch = text[i]!
    if (ch === '\n') return true
    if (ch !== ' ' && ch !== '\t' && ch !== '\r') return false
    i -= 1
  }
  return true
}

/** The indentation of the line `index` sits on. */
function lineIndent(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index - 1) + 1
  const match = /^[ \t]*/.exec(text.slice(start, index))
  return match === null ? '' : match[0]
}

/** The newline style the document already uses (defaults to `\n`). */
function newlineOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/**
 * Locate the `folders` array: the index of its `[` and of its matching `]`.
 *
 * A `"folders"` inside a comment or a string is skipped by construction, and a
 * `"folders"` used as a VALUE (`"name": "folders"`) is rejected because it is not
 * followed by `:` and then `[`.
 * @param text - the document.
 * @returns the two indices.
 * @throws WsManifestError when a `folders` array is opened but never closed.
 */
function locateFoldersArray(text: string): { open: number; close: number } | undefined {
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '"') {
      const end = afterString(text, i)
      const literal = text.slice(i, end)
      i = end
      if (literal !== '"folders"') continue
      const colon = skipTrivia(text, i)
      if (text[colon] !== ':') continue
      const open = skipTrivia(text, colon + 1)
      if (text[open] !== '[') continue
      let depth = 0
      let j = open
      while (j < text.length) {
        const inner = text[j]!
        if (inner === '"') { j = afterString(text, j); continue }
        if (inner === '/' && text[j + 1] === '/') {
          const eol = text.indexOf('\n', j)
          j = eol === -1 ? text.length : eol + 1
          continue
        }
        if (inner === '/' && text[j + 1] === '*') {
          const end2 = text.indexOf('*/', j + 2)
          j = end2 === -1 ? text.length : end2 + 2
          continue
        }
        if (inner === '[') depth += 1
        else if (inner === ']') {
          depth -= 1
          if (depth === 0) return { open, close: j }
        }
        j += 1
      }
      throw new WsManifestError('the "folders" array is not closed')
    }
    if (ch === '/' && text[i + 1] === '/') {
      const eol = text.indexOf('\n', i)
      i = eol === -1 ? text.length : eol + 1
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
      continue
    }
    i += 1
  }
  return undefined
}

/**
 * The insertion point for a new item: just past the array's last significant
 * character, skipping strings and BOTH comment forms forward. Scanning forward is
 * what makes a trailing `// note` after the final entry safe — a backward scan
 * would see the comment's text as the last "content" and put the comma inside it.
 * @param text - the document.
 * @param open - index of the array's `[`.
 * @param close - index of the array's matching `]`.
 * @returns the index to insert at.
 */
function insertionPoint(text: string, open: number, close: number): number {
  let at = open + 1
  let cursor = skipTrivia(text, open + 1, close)
  while (cursor < close) {
    const ch = text[cursor]!
    if (ch === '"') {
      at = afterString(text, cursor)
      cursor = skipTrivia(text, at, close)
      continue
    }
    if (ch === '/' && text[cursor + 1] === '/') {
      const eol = text.indexOf('\n', cursor)
      cursor = eol === -1 || eol >= close ? close : skipTrivia(text, eol + 1, close)
      continue
    }
    if (ch === '/' && text[cursor + 1] === '*') {
      const end = text.indexOf('*/', cursor + 2)
      cursor = end === -1 || end + 2 > close ? close : skipTrivia(text, end + 2, close)
      continue
    }
    at = cursor + 1
    cursor = skipTrivia(text, at, close)
  }
  return at
}

/**
 * Where the NEW ENTRY itself goes: past the trivia that follows the last item.
 *
 * The comma and the entry cannot share an insertion point, because a trailing
 * `// primary` owns its line: `"C:/repo/a", // primary` is valid only if the comma
 * goes behind the entry and the new entry starts on the NEXT line. So this returns
 * the index after the last trailing comment (a line comment's newline, or a block
 * comment's closing marker), and the caller keeps everything in between — the
 * comment and its line — exactly where the author put it.
 * @param text - the document.
 * @param at - the comma's insertion point (see {@link insertionPoint}).
 * @param close - index of the array's matching `]`.
 * @returns the index the new entry starts at.
 */
function afterTrailingTrivia(text: string, at: number, close: number): number {
  let bodyAt = at
  let i = at
  while (i < close) {
    const ch = text[i]!
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i += 1; continue }
    if (ch === '/' && text[i + 1] === '/') {
      const eol = text.indexOf('\n', i)
      if (eol === -1 || eol >= close) break
      bodyAt = eol + 1
      i = eol + 1
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end === -1 || end + 2 > close) break
      bodyAt = end + 2
      i = end + 2
      continue
    }
    break
  }
  return bodyAt
}

/**
 * Insert a comma and one item at `at`, keeping the trivia that follows the
 * previous item (a trailing `// note`, its line) exactly where the author put it.
 *
 * The comma and the item's text cannot share an insertion point, because a
 * trailing `// primary` owns its line: `"C:/repo/a", // primary` is valid only if
 * the comma goes behind the item and the new item's text starts on the NEXT line.
 * So `at` is the comma's point (see {@link insertionPoint}) and `bodyAt` is where
 * the item's text starts (see {@link afterTrailingTrivia}), and everything between
 * them — the comment and its line — is copied verbatim. Shared by the array append
 * and by the access-member insert, which is the same problem one level down.
 *
 * An insertion point that already sits behind a comma (JSONC documents may keep a
 * trailing one) reuses that comma as the separator instead of adding a second:
 * that is what `at` being just past a comma means, and two separators in a row
 * would leave the document unparseable.
 * @param text - the document.
 * @param at - the comma's insertion point.
 * @param bodyAt - the index the new item's text starts at.
 * @param indent - the indentation a fresh line for the item carries.
 * @param item - the item's text, without a trailing newline.
 * @returns the new text.
 */
function insertItem(text: string, at: number, bodyAt: number, indent: string, item: string): string {
  const kept = text.slice(at, bodyAt)
  const brokenLine = kept.endsWith('\n') || kept.endsWith('\r')
  const newline = newlineOf(text)
  const before = brokenLine ? '' : newline
  const after = brokenLine ? newline : ''
  const comma = separatedByComma(text, at) ? '' : ','
  return `${text.slice(0, at)}${comma}${kept}${before}${indent}${item}${after}${text.slice(bodyAt)}`
}

/**
 * Whether the significant character just before `at` is a comma — i.e. the author
 * already wrote the separator this insert would otherwise add. Only a TRAILING
 * comma can be the last significant character of a container: any other one is
 * followed by another item.
 * @param text - the document.
 * @param at - an insertion point returned by {@link insertionPoint}.
 * @returns whether the insert must reuse that comma rather than write its own.
 */
function separatedByComma(text: string, at: number): boolean {
  return text[at - 1] === ','
}

/**
 * Insert one entry into the document's `folders` array, preserving everything
 * else byte for byte.
 * @param text - the manifest's current text.
 * @param entry - the folder to append.
 * @returns the new text.
 * @throws WsManifestError when the document has no usable `folders` array.
 */
export function appendFolderEntry(text: string, entry: ManifestFolderEntry): string {
  const located = locateFoldersArray(text)
  if (located === undefined) {
    throw new WsManifestError('the manifest has no "folders" array to append to; add the folder by hand')
  }
  const { open, close } = located
  const newline = newlineOf(text)
  const empty = skipTrivia(text, open + 1, close) === close
  const closeIndent = lineIndent(text, open)
  const itemIndent = empty
    ? closeIndent + DEFAULT_INDENT
    : lineIndent(text, skipTrivia(text, open + 1, close))
  const body = `{ "path": ${JSON.stringify(entry.path)}, "access": ${JSON.stringify(entry.access)} }`

  if (empty) {
    // Give the closing bracket its own line only when it does not already have
    // one; an array written `[]` or `[ ]` gets expanded, a multi-line one keeps
    // its shape — and a comment inside it stays inside it, after the new entry.
    const tail = isOnlyWhitespaceSinceNewline(text, close) ? '' : `${newline}${closeIndent}`
    return `${text.slice(0, open + 1)}${newline}${itemIndent}${body}${tail}${text.slice(open + 1)}`
  }
  // A `// note` keeps its line, so the entry starts on the next line and has to
  // close its own line again before the array's closing bracket — which is what
  // the text resuming at `bodyAt` expects to find there.
  const at = insertionPoint(text, open, close)
  const bodyAt = afterTrailingTrivia(text, at, close)
  return insertItem(text, at, bodyAt, itemIndent, body)
}

/** One located `access` member of an object entry. */
interface AccessMember {
  /** Index of the member's value's first character. */
  start: number
  /** Index just past the member's value's last character. */
  end: number
  /** The value when it is a string (escapes resolved), otherwise undefined. */
  value: string | undefined
}

/**
 * One top-level `folders` array element located in the source. An element whose
 * shape this module cannot read (a bare token, a nested array) is stepped over and
 * never reported: an access rewrite may not guess what such an element declares,
 * and the product's own parser refuses such a manifest anyway.
 */
type LocatedEntry =
  | {
    /** The string shorthand, e.g. `"D:/shared"`. */
    kind: 'string'
    /** Index of the element's first character. */
    start: number
    /** Index just past the element's last character. */
    end: number
    /** The path the entry declares, escapes resolved. */
    path: string
    /** The element's exact source, its quotes and escapes included. */
    token: string
  }
  | {
    /** The object form, e.g. `{ "path": "D:/shared" }`. */
    kind: 'object'
    /** Index of the element's first character (its `{`). */
    start: number
    /** Index just past the element's last character (its `}`). */
    end: number
    /** The `path` member's decoded value, when the object has a readable one. */
    path: string | undefined
    /** Index of the object's `{`. */
    open: number
    /** Index of the object's `}`. */
    close: number
    /** The `access` member, when the object declares one. */
    access: AccessMember | undefined
  }

/**
 * Index just past the value that starts at `start`, never past `limit`: strings,
 * nested objects and arrays (with their own comments) and bare literals are all
 * stepped over by the same scanner the rest of this module uses.
 * @param text - the document.
 * @param start - the value's first character.
 * @param limit - index of the bracket that closes the enclosing container.
 * @returns the index just past the value, or `limit` when it never ends.
 */
function afterValue(text: string, start: number, limit: number): number {
  if (text[start] === '"') return Math.min(afterString(text, start), limit)
  if (text[start] === '{' || text[start] === '[') {
    let depth = 0
    let i = start
    while (i < limit) {
      const ch = text[i]!
      if (ch === '"') { i = afterString(text, i); continue }
      if (ch === '/' && text[i + 1] === '/') {
        const eol = text.indexOf('\n', i)
        i = eol === -1 || eol >= limit ? limit : eol + 1
        continue
      }
      if (ch === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2)
        i = end === -1 || end + 2 > limit ? limit : end + 2
        continue
      }
      if (ch === '{' || ch === '[') depth += 1
      else if (ch === '}' || ch === ']') {
        depth -= 1
        if (depth === 0) return i + 1
      }
      i += 1
    }
    return limit
  }
  let i = start
  while (i < limit) {
    const ch = text[i]!
    if (ch === ',' || ch === '}' || ch === ']' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') break
    if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) break
    i += 1
  }
  return i
}

/**
 * Index of the next member of an object, for a member this scanner cannot read: it
 * steps over the malformed part without interpreting it, so a later `"path"` is
 * still found rather than silently missed.
 * @param text - the document.
 * @param start - where to start looking.
 * @param close - index of the object's `}`.
 * @returns the index just past the next comma, or `close` when there is none.
 */
function skipToNextMember(text: string, start: number, close: number): number {
  let i = start
  while (i < close) {
    const ch = text[i]!
    if (ch === '"') { i = afterString(text, i); continue }
    if (ch === '/' && text[i + 1] === '/') {
      const eol = text.indexOf('\n', i)
      i = eol === -1 || eol >= close ? close : eol + 1
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 || end + 2 > close ? close : end + 2
      continue
    }
    if (ch === ',') return skipTrivia(text, i + 1, close)
    i += 1
  }
  return close
}

/**
 * What one object entry declares: the value of its `path` member and, when it has
 * one, its `access` member. Both are read with the same string/comment-aware walk
 * as the rest of the module, so a `"path"` inside a comment or a nested object is
 * never mistaken for the entry's own.
 * @param text - the document.
 * @param open - index of the object's `{`.
 * @param close - index of the object's `}`.
 * @returns the `path` value (undefined when unreadable) and the `access` member.
 */
function locateObjectMembers(
  text: string,
  open: number,
  close: number,
): { path: string | undefined; access: AccessMember | undefined } {
  let path: string | undefined
  let access: AccessMember | undefined
  let cursor = skipTrivia(text, open + 1, close)
  while (cursor < close) {
    if (text[cursor] !== '"') {
      cursor = skipToNextMember(text, cursor, close)
      continue
    }
    const keyEnd = afterString(text, cursor)
    const name = stringTokenValue(text.slice(cursor, keyEnd))
    const colon = skipTrivia(text, keyEnd, close)
    if (text[colon] !== ':') {
      cursor = skipToNextMember(text, keyEnd, close)
      continue
    }
    const valueStart = skipTrivia(text, colon + 1, close)
    const valueEnd = afterValue(text, valueStart, close)
    const literal = text[valueStart] === '"' ? stringTokenValue(text.slice(valueStart, valueEnd)) : undefined
    if (name === 'path' && path === undefined) path = literal
    if (name === 'access' && access === undefined) {
      access = { start: valueStart, end: valueEnd, value: literal }
    }
    cursor = skipTrivia(text, valueEnd, close)
    if (text[cursor] === ',') cursor = skipTrivia(text, cursor + 1, close)
    if (cursor <= valueStart) cursor = valueEnd + 1
  }
  return { path, access }
}

/**
 * Walk the `folders` array's top-level elements in source order.
 * @param text - the document.
 * @param open - index of the array's `[`.
 * @param close - index of the array's `]`.
 * @returns one record per readable element, in source order.
 */
function locateFoldersEntries(text: string, open: number, close: number): LocatedEntry[] {
  const entries: LocatedEntry[] = []
  let cursor = skipTrivia(text, open + 1, close)
  while (cursor < close) {
    const start = cursor
    // Assigned on every path that reaches the use below; a branch that cannot
    // read the element leaves the loop instead of reading an unset index.
    let end: number
    if (text[start] === '"') {
      end = Math.min(afterString(text, start), close)
      const token = text.slice(start, end)
      entries.push({ kind: 'string', start, end, path: stringTokenValue(token), token })
    } else if (text[start] === '{') {
      end = afterValue(text, start, close)
      const objectClose = end - 1
      if (text[objectClose] !== '}') {
        // Only a document the product's parser already rejects can land here; the
        // rewrite still reports nothing rather than pretending to read the object.
        break
      }
      const members = locateObjectMembers(text, start, objectClose)
      entries.push({
        kind: 'object',
        start,
        end,
        path: members.path,
        open: start,
        close: objectClose,
        access: members.access,
      })
    } else {
      end = afterValue(text, start, close)
    }
    let next = skipTrivia(text, end, close)
    if (text[next] === ',') next = skipTrivia(text, next + 1, close)
    cursor = next > start ? next : start + 1
  }
  return entries
}

/**
 * Rewrite one declared folder entry's access level, preserving every other byte.
 * @param text - the manifest's current text.
 * @param matches - decides which entry to rewrite, given the entry's path AS WRITTEN (may be relative).
 * @param access - the access level to write explicitly (`readOnly` / `readWrite`).
 * @returns the new text and whether anything changed.
 * @throws WsManifestError when there is no usable `folders` array, when no entry matches, or when more than one does.
 */
export function setFolderAccess(
  text: string,
  matches: (rawPath: string) => boolean,
  access: string,
): { text: string; changed: boolean } {
  const located = locateFoldersArray(text)
  if (located === undefined) {
    throw new WsManifestError('the manifest has no "folders" array to rewrite; edit the access level by hand')
  }
  const hits = locateFoldersEntries(text, located.open, located.close)
    .filter(entry => entry.path !== undefined && matches(entry.path))
  if (hits.length === 0) {
    throw new WsManifestError('no declared folder matches the entry to rewrite; nothing was changed')
  }
  if (hits.length > 1) {
    throw new WsManifestError(
      `${hits.length} declared folders match the entry to rewrite; refusing to guess which access level to change`,
    )
  }
  const hit = hits[0]!
  const literal = JSON.stringify(access)

  if (hit.kind === 'string') {
    // The shorthand has nowhere to put a member, so the element itself becomes the
    // object form — with the path token copied verbatim, so a rewrite never
    // re-quotes or unescapes what the author wrote.
    const body = `{ "path": ${hit.token}, "access": ${literal} }`
    return { text: `${text.slice(0, hit.start)}${body}${text.slice(hit.end)}`, changed: true }
  }

  if (hit.access !== undefined) {
    // Only the string literal moves: the member's key, its indentation, a note
    // behind it and every other member stay exactly where they are.
    if (hit.access.value === access) return { text, changed: false }
    return {
      text: `${text.slice(0, hit.access.start)}${literal}${text.slice(hit.access.end)}`,
      changed: true,
    }
  }

  const at = insertionPoint(text, hit.open, hit.close)
  const bodyAt = afterTrailingTrivia(text, at, hit.close)
  const member = `"access": ${literal}`
  const kept = text.slice(at, bodyAt)
  const comma = separatedByComma(text, at) ? '' : ','
  if (!text.slice(hit.open, hit.close).includes('\n')) {
    // A one-line object stays one line: the comma and the new member go right
    // behind the last member's value, and anything the author left between that
    // value and the `}` (a block comment) keeps its place after them.
    return { text: `${text.slice(0, at)}${comma}${kept} ${member}${text.slice(bodyAt)}`, changed: true }
  }
  const indent = lineIndent(text, skipTrivia(text, hit.open + 1, hit.close))
  return { text: insertItem(text, at, bodyAt, indent, member), changed: true }
}

/**
 * The line an entry owns, as a deletion span, when it has one to itself.
 *
 * Removing an appended entry has to reproduce the file the append started from,
 * and an append writes a whole fresh line (`\n    { … }`). So an entry that starts
 * its line and ends it — nothing but whitespace before it, nothing but its own
 * separator comma and trivia after it — takes that entire line with it, its
 * indentation and a note behind its comma included. An entry that shares its line
 * with a neighbour (a one-line array) has no line of its own, and then only its own
 * source moves.
 * @param text - the document.
 * @param start - index of the entry's first character.
 * @param end - index just past the entry's last character.
 * @param close - index of the array's `]`.
 * @returns the span to delete, or undefined when the entry shares its line.
 */
function ownLineSpan(
  text: string,
  start: number,
  end: number,
  close: number,
): { from: number; to: number } | undefined {
  if (!isOnlyWhitespaceSinceNewline(text, start)) return undefined
  const newline = text.indexOf('\n', end)
  if (newline === -1 || newline >= close) return undefined
  // A block comment straddling that newline does not end there, so the line does
  // not either: cutting it would leave an unterminated comment behind.
  if (text.lastIndexOf('/*', newline) > text.lastIndexOf('*/', newline)) return undefined
  // `skipTrivia` is the module's comment-aware way to ask what else is on the line,
  // and it has to look PAST the separator comma: a note behind that comma is still
  // part of the entry's own line.
  const rest = skipTrivia(text, end, close)
  const afterRest = text[rest] === ',' && rest < newline ? skipTrivia(text, rest + 1, close) : rest
  if (afterRest <= newline) return undefined
  return { from: text.lastIndexOf('\n', start - 1) + 1, to: newline + 1 }
}

/**
 * Remove one declared folder entry from the document's `folders` array, preserving
 * every other byte.
 * @param text - the manifest's current text.
 * @param matches - decides which entry to remove, given the entry's path AS WRITTEN (may be relative).
 * @returns the new text and whether anything changed (`changed` is always true here:
 *   a removal that found its entry always moves bytes, and both other answers are
 *   errors — the shape is shared with {@link setFolderAccess} so callers can read
 *   all three edits the same way).
 * @throws WsManifestError when there is no usable `folders` array, when no entry matches,
 *   when more than one does, or when the array holds only the entry to be removed
 *   (a manifest must declare at least one folder).
 */
export function removeFolderEntry(
  text: string,
  matches: (rawPath: string) => boolean,
): { text: string; changed: boolean } {
  const located = locateFoldersArray(text)
  if (located === undefined) {
    throw new WsManifestError('the manifest has no "folders" array to remove from; edit the manifest by hand')
  }
  const { open, close } = located
  const entries = locateFoldersEntries(text, open, close)
  const hits = entries.filter(entry => entry.path !== undefined && matches(entry.path))
  if (hits.length === 0) {
    throw new WsManifestError('no declared folder matches the entry to remove; nothing was changed')
  }
  if (hits.length > 1) {
    throw new WsManifestError(
      `${hits.length} declared folders match the entry to remove; refusing to guess which one to remove`,
    )
  }
  if (entries.length === 1) {
    // The product's own schema is the reason, not taste: `folders` must be a
    // non-empty array, so removing this entry could only ever produce a manifest the
    // transactional re-read refuses. Saying that HERE keeps the operator's answer a
    // reason instead of a validation error — and, like the two refusals above, it
    // moves nothing: no byte, no temporary file, no backup.
    throw new WsManifestError(
      'this is the only declared folder, and a manifest must declare at least one; nothing was changed',
    )
  }
  const hit = hits[0]!
  // EXACTLY ONE separator comma, found with the module's own helpers: the following
  // one when the author wrote one, otherwise the preceding one — the one that would
  // be left dangling before the `]`. Both cuts would be `,,`; neither cut would be a
  // dangling comma.
  const after = skipTrivia(text, hit.end, close)
  let comma = text[after] === ',' ? after : -1
  if (comma === -1) {
    // `insertionPoint` stops just past the last significant character before the
    // entry, which is where the preceding separator sits — if there is one.
    const before = insertionPoint(text, open, hit.start)
    if (text[before - 1] === ',') comma = before - 1
  }
  const span = ownLineSpan(text, hit.start, hit.end, close) ?? { from: hit.start, to: hit.end }
  const ranges = [span]
  // A comma on the entry's own line is already inside the span; only a comma
  // outside it — the preceding one, on the previous line — is a second cut.
  if (comma !== -1 && (comma < span.from || comma >= span.to)) {
    ranges.push({ from: comma, to: comma + 1 })
  }
  ranges.sort((left, right) => left.from - right.from)
  let out = ''
  let cursor = 0
  for (const range of ranges) {
    out += text.slice(cursor, range.from)
    cursor = range.to
  }
  return { text: out + text.slice(cursor), changed: true }
}

/** A filesystem-safe timestamp for a backup name. */
function stamp(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/**
 * The backup path for one manifest edit (timestamped, next to the manifest).
 * @param manifestPath - the manifest being edited.
 * @returns the sidecar path.
 */
export function backupPathFor(manifestPath: string): string {
  return `${manifestPath}.${stamp()}${WS_MANIFEST_BACKUP_SUFFIX}`
}

/**
 * Restore a manifest from its backup (used when a later step fails).
 * @param backupPath - a sidecar written by {@link commitManifestEdit}.
 * @param manifestPath - the file to restore.
 */
export async function restoreManifestBackup(backupPath: string, manifestPath: string): Promise<void> {
  await copyFile(backupPath, manifestPath)
}

/**
 * Read one manifest, refusing anything past the byte cap the schema claims.
 * @param manifestPath - absolute path of the manifest.
 * @returns the file's text.
 * @throws WsManifestError when it is larger than {@link WS_MANIFEST_MAX_BYTES}.
 */
async function readManifestText(manifestPath: string): Promise<string> {
  const original = await readFile(manifestPath)
  if (original.byteLength > WS_MANIFEST_MAX_BYTES) {
    throw new WsManifestError(`"${basename(manifestPath)}" is larger than the ${WS_MANIFEST_MAX_BYTES} byte limit`)
  }
  return original.toString('utf8')
}

/**
 * Land one already-computed edit on disk, transactionally: backup the original,
 * write a sibling temporary file, `rename` it into place, then re-read and
 * validate the result with the product's own parser.
 * @param manifestPath - absolute path of the manifest to edit.
 * @param next - the text to write.
 * @returns the backup path and the validated text as it was written.
 * @throws WsManifestError when the result is rejected (the original is restored
 *   first and the backup is removed).
 */
async function commitManifestEdit(manifestPath: string, next: string): Promise<ManifestEditResult> {
  const backupPath = backupPathFor(manifestPath)
  await copyFile(manifestPath, backupPath)

  const temporary = `${manifestPath}.octopus-edit-${process.pid}`
  try {
    await writeFile(temporary, next, 'utf8')
    await rename(temporary, manifestPath)
    const written = await readFile(manifestPath, 'utf8')
    const parsed = parseWorkspaceManifest(written)
    if (parsed.errors.length > 0 || parsed.manifest === undefined) {
      const detail = parsed.errors.map(issue => issue.message).join('; ')
      throw new WsManifestError(`the edit would produce an invalid manifest: ${detail}`)
    }
    return { backupPath, text: written }
  } catch (error) {
    // Put the user's file back exactly as it was: a failed edit must not leave a
    // half-applied manifest behind, and the caller still gets the reason. When the
    // restore succeeds there is nothing left to undo, so the backup goes too — and
    // the temporary file never stays behind in either case.
    await rm(temporary, { force: true }).catch(() => { /* the rename already moved it */ })
    await restoreManifestBackup(backupPath, manifestPath)
      .then(() => rm(backupPath, { force: true }))
      .catch(() => { /* the sidecar is now the only copy of the original: keep it */ })
    throw error
  }
}

/**
 * Append one folder to a manifest, transactionally.
 * @param manifestPath - absolute path of the manifest to edit.
 * @param entry - the folder to append.
 * @returns the backup path and the validated new text.
 * @throws WsManifestError on an unreadable/oversized manifest, a missing
 *   `folders` array, or a result the product's own parser rejects (in which case
 *   the original file is restored first and the backup is removed).
 */
export async function addFolderToManifest(
  manifestPath: string,
  entry: ManifestFolderEntry,
): Promise<ManifestEditResult> {
  const original = await readManifestText(manifestPath)
  return commitManifestEdit(manifestPath, appendFolderEntry(original, entry))
}

/**
 * Rewrite one entry's access level in a manifest, transactionally.
 * @param manifestPath - absolute path of the manifest to edit.
 * @param matches - decides which entry to rewrite, given the entry's path AS WRITTEN (may be relative).
 * @param access - the access level to write explicitly (`readOnly` / `readWrite`).
 * @returns `{ changed: false }` when the entry already declared exactly that access
 *   (nothing is written, no backup is left behind), otherwise the backup path and the validated text.
 * @throws WsManifestError on an unreadable/oversized manifest, a missing `folders`
 *   array, no matching entry, more than one matching entry, or a result the
 *   product's own parser rejects (in which case the original file is restored
 *   first and the backup is removed).
 */
export async function setFolderAccessInManifest(
  manifestPath: string,
  matches: (rawPath: string) => boolean,
  access: string,
): Promise<{ changed: false } | { changed: true; backupPath: string; text: string }> {
  const original = await readManifestText(manifestPath)
  const next = setFolderAccess(original, matches, access)
  // Nothing to do means nothing to write: no temporary file and, above all, no
  // backup — a sidecar next to an untouched manifest would suggest it changed.
  if (!next.changed) return { changed: false }
  const written = await commitManifestEdit(manifestPath, next.text)
  return { changed: true, backupPath: written.backupPath, text: written.text }
}

/**
 * Remove one entry from a manifest, transactionally.
 * @param manifestPath - absolute path of the manifest to edit.
 * @param matches - decides which entry to remove, given the entry's path AS WRITTEN (may be relative).
 * @returns the backup path and the validated new text. There is no "already there"
 *   answer to give here, unlike {@link setFolderAccessInManifest}: an entry that is
 *   not declared is an error, so a call that returns at all has written the file.
 * @throws WsManifestError on an unreadable/oversized manifest, a missing `folders`
 *   array, no matching entry, more than one matching entry, or an attempt to remove
 *   the only declared entry (the schema requires at least one root — the pure edit
 *   refuses that before the transaction opens), or a result the product's own parser
 *   rejects (in which case the original file is restored first and the backup is
 *   removed).
 */
export async function removeFolderEntryInManifest(
  manifestPath: string,
  matches: (rawPath: string) => boolean,
): Promise<{ changed: true; backupPath: string; text: string }> {
  const original = await readManifestText(manifestPath)
  const next = removeFolderEntry(original, matches)
  const written = await commitManifestEdit(manifestPath, next.text)
  return { changed: true, backupPath: written.backupPath, text: written.text }
}

/** The directory a manifest's relative folder paths resolve against. */
export function manifestBaseDir(manifestPath: string): string {
  return dirname(manifestPath)
}
