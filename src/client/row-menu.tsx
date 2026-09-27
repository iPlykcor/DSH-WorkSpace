/**
 * The right-click menu of ONE root row.
 *
 * A row already has hover actions (the padlock, the desktop reveal) but no menu,
 * so a right-click on it used to open the browser's own page menu. The two
 * actions an operator actually needs per folder are now here, built from the
 * same platform parts as the body's menu (`./body-menu.tsx`) so the card, the
 * keyboard walk and the focus return stay the shell's behaviour.
 *
 * WHY THE MENU MIRRORS THE PADLOCK INSTEAD OF REPLACING IT. The padlock is the
 * one-click gesture on a row the operator is already looking at; the menu is the
 * deliberate, discoverable one. Both end in the SAME host route and therefore the
 * same transaction, so a row's state can never depend on which gesture was used.
 *
 * WHY "REMOVE" IS `danger` AND WHY THE IMPLICIT ROOT SHOWS NO ACTIONS. Removing a
 * folder sounds like it deletes the folder, so the row is drawn in the product's
 * destructive colour and the confirmation (a platform `RiskConfirmation`, see the
 * tab) says out loud that only the declaration goes. The session folder the
 * manifest does not declare has no declaration to delete and no entry whose
 * `access` could be rewritten, so BOTH rows are disabled rather than hidden, with
 * a label explaining why — a menu that quietly loses its rows reads as a bug.
 */
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { t } from './locales.ts'

/** Row id asking to delete this root's declaration. */
export const MENU_REMOVE_FOLDER = 'row.removeFolder'
/** Row id asking to flip this root's access level. */
export const MENU_TOGGLE_ACCESS = 'row.toggleAccess'

/** What a selected row id asks the tab to do. */
export type RowMenuIntent = 'remove' | 'toggle'

/**
 * Build one root row's menu.
 * @param options.listed - whether the manifest declares this root (only declared roots have an entry to edit).
 * @param options.readOnly - the root's current level, so the row names the level it will switch TO.
 * @param options.busy - whether a change to this root is already in flight (rows are disabled, never hidden).
 * @returns the menu entries, in display order.
 */
export function buildRowMenu(options: { listed: boolean; readOnly: boolean; busy: boolean }): readonly MenuEntry[] {
  const entries: MenuEntry[] = [
    { id: MENU_REMOVE_FOLDER, label: t('menuRemoveFolder'), danger: true, disabled: options.busy || !options.listed },
    {
      id: MENU_TOGGLE_ACCESS,
      // Both keys stay literal `t('...')` calls: the dead-key scan in
      // `tests/client-tab.spec.ts` finds keys by text, so one chosen inside an
      // expression would look unreferenced.
      label: options.readOnly ? t('menuMakeReadWrite') : t('menuMakeReadOnly'),
      disabled: options.busy || !options.listed,
    },
  ]
  if (options.listed) return entries
  // Disabled rows alone leave the operator guessing, so an undeclared root gets
  // the reason too. A separator first keeps it visually out of the action group.
  return [
    ...entries,
    { type: 'separator', id: 'row.implicit' },
    { type: 'label', id: 'row.implicitWhy', text: t('menuImplicitRoot') },
  ]
}

/**
 * Translate a selected row id into the action it asks for.
 * @param id - the row id the platform reports.
 * @returns the intent, or undefined for a row this menu does not own.
 */
export function rowMenuIntent(id: string): RowMenuIntent | undefined {
  if (id === MENU_REMOVE_FOLDER) return 'remove'
  if (id === MENU_TOGGLE_ACCESS) return 'toggle'
  return undefined
}
