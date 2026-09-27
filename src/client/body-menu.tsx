/**
 * Pointer-anchored context menus for the operation-space body.
 *
 * The body is a plain list of roots, so a right-click on the blank area used to
 * open the browser's own page menu — which offers nothing this pane can use. It
 * now opens the product's menu instead, built from the platform's own parts
 * (`Menu` + data rows) so the card, the keyboard walk, Escape/outside-click
 * closing and the focus return after a selection are the shell's behaviour
 * rather than a reimplementation. A right-click on a ROW opens the same card with
 * the row's own rows (`./row-menu.tsx`); only the entries differ, so the card
 * itself lives here once, as {@link PointerContextMenu}.
 *
 * WHY THE PLANE IS ANCHORED TO THE POINTER. `Menu` normally hangs off a trigger
 * element it renders itself; a context menu has no such element. The platform
 * documents `getAnchorRect` for exactly this ("supply the anchor rect directly
 * (e.g. from a host-owned trigger button)"), so the click point becomes a 1x1
 * rect and the menu opens where the operator right-clicked, then stays there.
 *
 * ONE ROW, AND IT IS ALWAYS READ-ONLY. Adding a folder is the moment trust is
 * granted, so the menu does not ask a question with two answers: the row says
 * read-only out loud, and the write path states the level explicitly, which is
 * what keeps a manifest whose `settings.defaultAccess` is `readWrite` from
 * silently upgrading the pick. Upgrading later is a deliberate second gesture on
 * the row's padlock (see ./root-markers.tsx), where the operator can see exactly
 * which folder is being unlocked.
 */
import { useCallback, type ReactElement } from 'react'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OctopusAccess } from '../workspace-schema.ts'
import { t } from './locales.ts'

/** Where the operator right-clicked, in viewport coordinates. */
export interface MenuPoint {
  x: number
  y: number
}

/** Row id asking for a folder; the level it asks for is read-only. */
export const MENU_ADD_FOLDER = 'addFolder.readOnly'

/**
 * Build the menu's rows.
 *
 * The single row is DISABLED while the host's chooser is already in flight
 * rather than hidden: a menu that silently loses its row makes the operator think
 * the feature vanished. There is no "no operation space" case to model, because
 * this menu only exists inside a rendered operation-space body.
 * @param options.picking - whether a chooser is already in flight.
 * @returns the menu entries, in display order.
 */
export function buildBodyMenu(options: { picking: boolean }): readonly MenuEntry[] {
  return [{ id: MENU_ADD_FOLDER, label: t('menuAddFolderReadOnly'), disabled: options.picking }]
}

/**
 * Translate a selected row id into the access level it asks for.
 * @param id - the row id the platform reports.
 * @returns the access level, or undefined for a row this menu does not own.
 */
export function accessOfMenuId(id: string): OctopusAccess | undefined {
  return id === MENU_ADD_FOLDER ? 'readOnly' : undefined
}

/**
 * Render a pointer-anchored context menu at the recorded point.
 * @param props.at - the click point, or null while the menu is closed.
 * @param props.entries - the rows to show.
 * @param props.onSelect - called with the selected row id; the owner closes the menu itself.
 * @param props.onClose - called when the platform decides the list should close (outside click or Escape).
 * @returns the portaled menu card.
 */
export function PointerContextMenu(props: {
  at: MenuPoint | null
  entries: readonly MenuEntry[]
  onSelect: (id: string) => void
  onClose: () => void
}): ReactElement {
  const { at } = props
  const anchorRect = useCallback(
    (): DOMRect | null => (at === null ? null : new DOMRect(at.x, at.y, 1, 1)),
    [at],
  )
  return (
    <Menu
      open={at !== null}
      portal
      autoFocus
      side="bottom"
      align="start"
      anchor={<span style={{ display: 'none' }} />}
      getAnchorRect={anchorRect}
      items={props.entries}
      onSelect={props.onSelect}
      onClose={props.onClose}
    />
  )
}
