/**
 * The markers a root folder row draws.
 *
 * `ReadOnlyLock` is the padlock beside the name, exactly as the pre-collapse
 * workbench drew it, and `PathBadge` is the circled ⓘ that reveals the
 * root's absolute path. The two row-level wrappers are deliberate: the padlock's
 * presence is a permission decision worth testing on its own
 * ({@link RootPermissionMarker}), and the badge's PLACE in the row is a layout
 * decision ({@link RootTrailingBadge}) — it is the last thing in the row, after
 * the desktop action's slot.
 *
 * WHY THE LOCK IS INLINE SVG HERE. The lock glyph used to come from
 * `react-icons/vsc`, which was a RUNTIME dependency; collapsing this package to
 * zero runtime dependencies had to drop it, and the platform module table has
 * no lock of its own (among its 279 exports `Lock` matches only `Clock`). The
 * path below is therefore carried in this file. It is the codicon artwork the
 * old `VscLock` rendered, on the 16-unit grid every other icon in this tab
 * uses, so the marker reads as it did before instead of as a shield.
 *
 * LOCK GLYPH ATTRIBUTION (required by the license, Section 3(a)):
 * - Work: the "lock" icon from VS Code Codicons.
 * - Author / copyright: Microsoft Corporation.
 * - Source: https://github.com/microsoft/vscode-codicons (src/icons/lock.svg).
 * - License: Creative Commons Attribution 4.0 International,
 *   https://creativecommons.org/licenses/by/4.0/ — the license disclaims all
 *   warranties.
 * - Modification: none to the path data; this file only wraps it in a React
 *   component and supplies the rendered size and colour.
 *
 * WHY THE PATH BADGE USES THE PLATFORM TOOLTIP. `Tooltip` needs no provider
 * (`TooltipSuppression` defaults to null and 19 built-in plugins anchor it
 * directly), it reveals on focus as well as hover, and `portal` is REQUIRED
 * here: the root list scrolls inside an `overflow: auto` container, and a
 * non-portaled bubble would be clipped by it.
 */
import { IconInfoOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactElement } from 'react'
import { LABEL_SECONDARY, ROW_TOOL_ICON_SIZE } from './tree-metrics.ts'

/** Keyhole dot of the codicon lock. */
const LOCK_DOT =
  'M8 9C8.55228 9 9 9.44771 9 10C9 10.5523 8.55228 11 8 11C7.44772 11 7 10.5523 7 10C7 9.44771 7.44772 9 8 9Z'

/** Shackle and body of the codicon lock, drawn as one even-odd outline. */
const LOCK_BODY =
  'M8 1C9.654 1 11 2.346 11 4V6H12C13.103 6 14 6.897 14 8V13C14 14.103 13.103 15 12 15H4C2.897 15 2 14.103 2 13V8C2 6.897 2.897 6 4 6H5V4C5 2.346 6.346 1 8 1ZM4 7C3.449 7 3 7.449 3 8V13C3 13.551 3.449 14 4 14H12C12.551 14 13 13.551 13 13V8C13 7.449 12.551 7 12 7H4ZM8 2C6.897 2 6 2.897 6 4V6H10V4C10 2.897 9.103 2 8 2Z'

/**
 * Soft-wrap opportunities for a long absolute path. A Windows path has no break
 * characters and the platform `Tooltip` takes a plain string, so the bubble would
 * otherwise be one unbreakable slab. The injected zero-width spaces are invisible
 * and belong to this display-only label: the row's own `title` and anything that
 * reuses the path as a path keep the raw string.
 */
const AFTER_SEPARATOR = /([\\/])/g

/**
 * The padlock marking a read-only root.
 *
 * IT CARRIES NO SPACING OF ITS OWN. The row's own `gap` (the built-in's 6px,
 * see ./tree-metrics.ts) is what separates it from the name; a `margin-left`
 * here would add to that gap and make the padlock 12px away from the name while
 * every other pair of row elements sits 6px apart.
 * @param props.label - accessible name (the row already explains the permission visually).
 * @param props.size - rendered edge in pixels; 12 matches the pre-collapse marker.
 * @returns the lock glyph.
 */
export function ReadOnlyLock({ label, size = 12 }: { label: string; size?: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      role="img"
      aria-label={label}
      style={{ flex: 'none', color: LABEL_SECONDARY }}
    >
      <path d={LOCK_DOT} />
      <path fillRule="evenodd" clipRule="evenodd" d={LOCK_BODY} />
    </svg>
  )
}

/**
 * The absolute-path affordance: a circled ⓘ that reveals the path.
 *
 * WHY THE ⓘ, AND WHY NOT THE OTHER TWO. The platform ships three glyphs that could
 * carry "there is something to know about this row": a circled exclamation
 * (`IconWarningOutlineRegular`), a circled triangle
 * (`IconWarningTriangleOutlineRegular`) and a circled ⓘ (`IconInfoOutlineRegular`).
 * This badge is neither a fault nor a warning — nothing is wrong with the root, the
 * badge only says "hover me for the absolute path" — so it wears the annotation
 * glyph and leaves the two warning glyphs meaning what they mean everywhere else in
 * DSH. It is drawn at {@link ROW_TOOL_ICON_SIZE} so it matches the desktop action it
 * stands next to, and coloured with the same token that action rests at.
 * @param props.path - the root's absolute path, shown verbatim in the bubble.
 * @param props.label - accessible name for the glyph.
 * @returns the badge.
 */
export function PathBadge({ path, label }: { path: string; label: string }): ReactElement {
  return (
    <Tooltip label={path.replace(AFTER_SEPARATOR, '$1\u200B')} side="bottom" align="end" portal maxWidth={360}>
      <span
        role="img"
        aria-label={label}
        style={{ display: 'inline-flex', alignItems: 'center', flex: 'none', cursor: 'help', color: LABEL_SECONDARY }}
      >
        <IconInfoOutlineRegular size={ROW_TOOL_ICON_SIZE} />
      </span>
    </Tooltip>
  )
}

/**
 * The padlock a READ-ONLY root shows — and nothing at all for a read-write root.
 *
 * WHY THE CHOICE LIVES HERE. A read-write root must carry NO permission marker
 * (the platform glyphs that briefly replaced the padlock read as two different
 * kinds of warning rather than as one permission state), and that is the exact
 * invariant that regressed once already. Keeping the decision in a component the
 * suite can render on its own is what keeps it enforceable instead of something a
 * reviewer has to notice by eye.
 * @param props.readOnly - whether the root was declared read-only.
 * @param props.label - accessible name for the padlock.
 * @returns the padlock, or nothing.
 */
export function RootPermissionMarker({ readOnly, label }: { readOnly: boolean; label: string }): ReactElement | null {
  return readOnly ? <ReadOnlyLock label={label} /> : null
}

/**
 * The path badge as it sits in a row: OUTSIDE the row's own button, after the
 * desktop action's fixed slot, at the row's trailing edge.
 *
 * WHY THERE. The desktop action has to be a real `<button>`, and a `<button>`
 * inside another one is invalid markup, so it lives in a slot beside the row
 * button. The badge therefore comes after that slot — which is the order the user
 * asked for: the desktop action first, the path badge last. Three consequences are
 * load-bearing: the row wrapper owns the 6px gap and the 10px right edge padding,
 * so the badge ends exactly where the built-in's row content ends and sits the
 * built-in's 6px away from the action; because the slot keeps its width whether or
 * not the action is shown, the badge never moves on hover; and because the badge is
 * not inside the row button, clicking it no longer toggles the folder underneath.
 * @param props.path - the root's absolute path, shown verbatim in the bubble.
 * @param props.pathLabel - accessible name for the glyph.
 * @returns the badge in its row wrapper.
 */
export function RootTrailingBadge({ path, pathLabel }: { path: string; pathLabel: string }): ReactElement {
  return (
    <span style={{ display: 'flex', alignItems: 'center', flex: 'none' }}>
      <PathBadge path={path} label={pathLabel} />
    </span>
  )
}
