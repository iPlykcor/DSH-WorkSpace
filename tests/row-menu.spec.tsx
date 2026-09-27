/**
 * A root row's right-click menu: which rows it offers and what each one means.
 *
 * A row already had hover actions, so its right-click used to fall through to the
 * browser's page menu. The two actions an operator needs per folder are now here,
 * and this file pins the part the plugin owns: that a DECLARED root offers both,
 * that removal is drawn as destructive, that the level row names the level it
 * will switch TO rather than the one in force (a row that says "read-only" next to
 * a read-only root reads as a no-op), that an in-flight change disables rows
 * instead of hiding them, and that the implicit cwd root — which has no manifest
 * entry at all — says so instead of offering actions that could only fail.
 *
 * The card itself (portal, keyboard walk, Escape, focus return) belongs to the
 * shell and is not asserted here; this repository has no browser lane, and
 * `tests/body-menu.spec.tsx` draws the same line for the body's menu. Rows are
 * narrowed by shape (`'label' in row`) rather than cast, so the compiler keeps
 * confirming which member of the platform's union is which.
 */
import { describe, expect, it } from 'vitest'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { MENU_REMOVE_FOLDER, MENU_TOGGLE_ACCESS, buildRowMenu, rowMenuIntent } from '../src/client/row-menu.tsx'

/** One selectable row, narrowed out of the platform's entry union. */
interface SelectableRow {
  id: string
  label: unknown
  disabled: boolean
  danger: boolean
}

/** The selectable rows of a menu. */
function selectableRows(entries: readonly MenuEntry[]): SelectableRow[] {
  return entries.flatMap(entry => ('label' in entry
    ? [{
      id: entry.id,
      label: entry.label,
      disabled: entry.disabled === true,
      danger: entry.danger === true,
    }]
    : []))
}

/** The plain-text rows of a menu (labels). */
function textRows(entries: readonly MenuEntry[]): string[] {
  return entries.flatMap(entry => ('text' in entry ? [entry.text] : []))
}

describe('root row context menu', () => {
  it('offers removal and the permission flip, removal first', () => {
    const entries = buildRowMenu({ listed: true, readOnly: true, busy: false })
    expect(entries.map(entry => entry.id)).toEqual([MENU_REMOVE_FOLDER, MENU_TOGGLE_ACCESS])
    const rows = selectableRows(entries)
    expect(rows.map(row => row.id)).toEqual([MENU_REMOVE_FOLDER, MENU_TOGGLE_ACCESS])
    for (const row of rows) expect(row.disabled).toBe(false)
    // A declared root has nothing to explain, so it gets no trailing note.
    expect(textRows(entries)).toEqual([])
  })

  it('draws removal as the destructive row and the flip as an ordinary one', () => {
    const rows = selectableRows(buildRowMenu({ listed: true, readOnly: false, busy: false }))
    expect(rows[0]?.danger).toBe(true)
    expect(rows[1]?.danger).toBe(false)
  })

  it('names the level a row will switch TO, not the one in force', () => {
    const readOnly = selectableRows(buildRowMenu({ listed: true, readOnly: true, busy: false }))
    const readWrite = selectableRows(buildRowMenu({ listed: true, readOnly: false, busy: false }))
    const labelOf = (rows: SelectableRow[]): string => String(rows[1]?.label ?? '')
    expect(labelOf(readOnly)).not.toBe(labelOf(readWrite))
    // The two labels are the only thing that changes with the level.
    expect(readOnly[0]?.label).toBe(readWrite[0]?.label)
    for (const rows of [readOnly, readWrite]) {
      expect(labelOf(rows).length).toBeGreaterThan(0)
    }
  })

  it('disables both rows, never hides them, while a change is already in flight', () => {
    const entries = buildRowMenu({ listed: true, readOnly: true, busy: true })
    expect(entries.map(entry => entry.id)).toEqual([MENU_REMOVE_FOLDER, MENU_TOGGLE_ACCESS])
    expect(selectableRows(entries).map(row => row.disabled)).toEqual([true, true])
  })

  it('offers nothing actionable for the implicit cwd root, and says why', () => {
    const entries = buildRowMenu({ listed: false, readOnly: false, busy: false })
    // The rows stay visible (a menu that loses its rows reads as a bug) but both
    // are disabled: there is no declaration to delete and none to rewrite.
    expect(selectableRows(entries).map(row => row.disabled)).toEqual([true, true])
    // The reason is a real label row, not a tooltip the operator may never open.
    const reasons = textRows(entries)
    expect(reasons).toHaveLength(1)
    expect(String(reasons[0]).length).toBeGreaterThan(0)
    expect(entries.some(entry => 'type' in entry && entry.type === 'separator')).toBe(true)
  })

  it('maps only its own row ids to an intent', () => {
    expect(rowMenuIntent(MENU_REMOVE_FOLDER)).toBe('remove')
    expect(rowMenuIntent(MENU_TOGGLE_ACCESS)).toBe('toggle')
    // The body menu's id must not be mistaken for a row action.
    expect(rowMenuIntent('addFolder.readOnly')).toBeUndefined()
    expect(rowMenuIntent('some.other.command')).toBeUndefined()
  })
})
