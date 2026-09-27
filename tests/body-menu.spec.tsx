/**
 * The body's right-click menu: which rows it offers and what a row means.
 *
 * ONE row, and it is read-only. Adding a folder is the moment trust is granted,
 * so the menu no longer offers a second, read-write answer: it says read-only out
 * loud, and upgrading later is a separate, visible gesture on the row's padlock
 * (`tests/root-markers.spec.tsx`). That also means a manifest whose
 * `settings.defaultAccess` is `readWrite` cannot silently upgrade the pick — the
 * host writes the level explicitly.
 *
 * The rendering half (the platform `Menu` card, its keyboard walk, Escape, and the
 * focus return) belongs to the shell and is not asserted here — this repository has
 * no browser lane, and `tests/client-tab.spec.ts` likewise locks registration, not
 * pixels. What IS asserted is the part this plugin owns: the row's existence and
 * level, that it is disabled rather than hidden while a chooser is in flight, and
 * that only this menu's own row id can name an access level.
 *
 * The spec imports the module directly, so it also proves the primitives alias in
 * `vitest.config.ts` resolves the platform menu parts this module value-imports.
 * Rows are narrowed by shape (`'label' in row`) rather than cast: the real
 * `MenuEntry` is a union, and the compiler must keep confirming which member is
 * which.
 */
import { describe, expect, it } from 'vitest'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { MENU_ADD_FOLDER, accessOfMenuId, buildBodyMenu } from '../src/client/body-menu.tsx'

/** One selectable row, narrowed out of the entry union. */
interface SelectableRow {
  id: string
  label: unknown
  disabled: boolean
}

/** The selectable rows of a menu. */
function selectableRows(entries: readonly MenuEntry[]): SelectableRow[] {
  return entries.flatMap(entry => ('label' in entry
    ? [{ id: entry.id, label: entry.label, disabled: entry.disabled === true }]
    : []))
}

/** The plain-text rows of a menu (headings). */
function textRows(entries: readonly MenuEntry[]): string[] {
  return entries.flatMap(entry => ('text' in entry ? [entry.text] : []))
}

describe('body context menu', () => {
  it('offers exactly one row, and it asks for a read-only folder', () => {
    const entries = buildBodyMenu({ picking: false })
    expect(entries.map(entry => entry.id)).toEqual([MENU_ADD_FOLDER])
    // No group heading any more: with a single row the row's own label carries
    // the whole meaning, and a heading would only repeat it.
    expect(textRows(entries)).toHaveLength(0)
    const rows = selectableRows(entries)
    expect(rows.map(row => row.id)).toEqual([MENU_ADD_FOLDER])
    expect(rows[0]?.disabled).toBe(false)
  })

  it('labels the row', () => {
    const rows = selectableRows(buildBodyMenu({ picking: false }))
    expect(typeof rows[0]?.label).toBe('string')
    expect((rows[0]?.label as string).length).toBeGreaterThan(0)
  })

  it('disables the row, never hides it, while a chooser is already open', () => {
    const entries = buildBodyMenu({ picking: true })
    expect(entries).toHaveLength(1)
    expect(selectableRows(entries).map(row => row.disabled)).toEqual([true])
  })

  it('maps only its own row id to an access level, and never to read-write', () => {
    expect(accessOfMenuId(MENU_ADD_FOLDER)).toBe('readOnly')
    // The retired read-write row id must not come back to life by accident.
    expect(accessOfMenuId('addFolder.readWrite')).toBeUndefined()
    expect(accessOfMenuId('addFolder')).toBeUndefined()
    expect(accessOfMenuId('some.other.command')).toBeUndefined()
  })
})
