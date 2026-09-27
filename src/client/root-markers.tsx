/**
 * The markers a root folder row draws.
 *
 * `Padlock` is the glyph beside the name (closed = read-only, open = read-write,
 * from the codicon `lock` / `unlock` artwork), `PathBadge` is the circled ⓘ that
 * reveals the root's absolute path, and `RootPermissionToggle` is what puts the
 * padlock in a row: a real button for a root the manifest declares, a fixed
 * marker for the implicit cwd root. The two row-level wrappers are deliberate —
 * a permission decision worth testing on its own
 * ({@link RootPermissionToggle}), and the badge's PLACE in the row is a layout
 * decision ({@link RootTrailingBadge}) — it is the last thing in the row, after
 * the desktop action's slot.
 *
 * WHY THE PADLOCKS ARE INLINE SVG HERE. The glyphs used to come from
 * `react-icons/vsc`, which was a RUNTIME dependency; collapsing this package to
 * zero runtime dependencies had to drop it, and the platform module table has
 * no padlock of its own (among its 279 exports `Lock` matches only `Clock`).
 * Both paths below are therefore carried in this file: the closed codicon `lock`
 * that marks a read-only root and the open codicon `unlock` that marks a
 * read-write one, on the 16-unit grid every other icon in this tab uses. They
 * are the SAME artwork family, so the pair reads as one permission state that
 * changed rather than as two unrelated badges.
 *
 * ICON GLYPH ATTRIBUTION (required by the license, Section 3(a)): the "lock" and
 * "unlock" icons from VS Code Codicons, copyright Microsoft Corporation, source
 * https://github.com/microsoft/vscode-codicons (src/icons/lock.svg and
 * src/icons/unlock.svg), licensed under Creative Commons Attribution 4.0
 * International, https://creativecommons.org/licenses/by/4.0/ — the license
 * disclaims all warranties. Modification: none to either path's data; this file
 * only wraps them in React components and supplies the rendered size and colour.
 *
 * WHY THE PATH BADGE USES THE PLATFORM TOOLTIP. `Tooltip` needs no provider
 * (`TooltipSuppression` defaults to null and 19 built-in plugins anchor it
 * directly), it reveals on focus as well as hover, and `portal` is REQUIRED
 * here: the root list scrolls inside an `overflow: auto` container, and a
 * non-portaled bubble would be clipped by it.
 */
import { IconInfoOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CSSProperties, ReactElement } from 'react'
import { LABEL_SECONDARY, ROW_TOOL_ICON_SIZE } from './tree-metrics.ts'

/** Layout shared by both padlock wrappers: content-sized, centred, never shrinking. */
const MARKER_WRAP_STYLE: CSSProperties = { display: 'inline-flex', alignItems: 'center', flex: 'none' }

/** Keyhole dot of the codicon padlocks (its own subpath in both icons). */
const LOCK_DOT =
  'M8 9C8.55228 9 9 9.44771 9 10C9 10.5523 8.55228 11 8 11C7.44772 11 7 10.5523 7 10C7 9.44771 7.44772 9 8 9Z'

/** Shackle and body of the codicon lock, closed: drawn as one even-odd outline. */
const LOCK_BODY =
  'M8 1C9.654 1 11 2.346 11 4V6H12C13.103 6 14 6.897 14 8V13C14 14.103 13.103 15 12 15H4C2.897 15 2 14.103 2 13V8C2 6.897 2.897 6 4 6H5V4C5 2.346 6.346 1 8 1ZM4 7C3.449 7 3 7.449 3 8V13C3 13.551 3.449 14 4 14H12C12.551 14 13 13.551 13 13V8C13 7.449 12.551 7 12 7H4ZM8 2C6.897 2 6 2.897 6 4V6H10V4C10 2.897 9.103 2 8 2Z'

/** Shackle and body of the codicon unlock, open: the same grid and outline style. */
const UNLOCK_BODY =
  'M13 1C14.654 1 16 2.346 16 4V4.5C16 4.776 15.776 5 15.5 5C15.224 5 15 4.776 15 4.5V4C15 2.897 14.103 2 13 2C11.897 2 11 2.897 11 4V6H12C13.103 6 14 6.897 14 8V13C14 14.103 13.103 15 12 15H4C2.897 15 2 14.103 2 13V8C2 6.897 2.897 6 4 6H10V4C10 2.346 11.346 1 13 1ZM4 7C3.449 7 3 7.449 3 8V13C3 13.551 3.449 14 4 14H12C12.551 14 13 13.551 13 13V8C13 7.449 12.551 7 12 7H4Z'

/**
 * Soft-wrap opportunities for a long absolute path. A Windows path has no break
 * characters and the platform `Tooltip` takes a plain string, so the bubble would
 * otherwise be one unbreakable slab. The injected zero-width spaces are invisible
 * and belong to this display-only label: the row's own `title` and anything that
 * reuses the path as a path keep the raw string.
 */
const AFTER_SEPARATOR = /([\\/])/g

/**
 * The padlock a root row draws: closed for a read-only root, open for a read-write one.
 *
 * IT CARRIES NO SPACING OF ITS OWN. The row's own `gap` (the built-in's 6px,
 * see ./tree-metrics.ts) is what separates it from the name; a `margin-left`
 * here would add to that gap and make the padlock 12px away from the name while
 * every other pair of row elements sits 6px apart.
 * @param props.open - true for the open (read-write) padlock.
 * @param props.label - accessible name; the two states must be distinguishable by name.
 * @param props.size - rendered edge in pixels; 12 matches the pre-collapse marker.
 * @returns the padlock glyph.
 */
export function Padlock({ open, label, size = 12 }: { open: boolean; label: string; size?: number }): ReactElement {
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
      <path fillRule="evenodd" clipRule="evenodd" d={open ? UNLOCK_BODY : LOCK_BODY} />
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
 * The padlock as it sits in a row — one of the two places a root's access level
 * changes (the other is the same row's right-click menu, which ends in the same
 * host route so the row can never depend on which gesture was used).
 *
 * WHY THE TOGGLE IS THIS SIBLING AND NOT PART OF THE ROW BUTTON. The row's own
 * button expands the folder, and a `<button>` inside another one is invalid
 * markup (and would expand the folder on every click at the padlock), so the
 * padlock cannot live inside it and be clickable at the same time: the row
 * renders THIS, immediately after the name. A root the manifest does not declare
 * — the session cwd's implicit root — has no entry to rewrite, so it gets the
 * same padlock with no handler and a tooltip that says why, instead of a click
 * that would silently do nothing.
 *
 * The platform `Tooltip` is used unchanged (no provider needed, `portal` is
 * required because the root list scrolls inside an `overflow: auto` container),
 * so the bubble, the focus behaviour and the styling stay the shell's.
 * @param props.readOnly - whether the root is read-only right now.
 * @param props.label - accessible name for the padlock (the STATE, not the action).
 * @param props.toggle - tooltip (the action), in-flight flag and handler for a declared root.
 * @param props.fixedTitle - tooltip for a root whose level cannot be changed here.
 * @returns the padlock in its toggle wrapper or its fixed wrapper.
 */
export function RootPermissionToggle(props: {
  readOnly: boolean
  label: string
  toggle?: { title: string; busy: boolean; onClick: () => void }
  fixedTitle?: string
}): ReactElement {
  const glyph = <Padlock open={!props.readOnly} label={props.label} />
  const toggle = props.toggle
  if (toggle === undefined) {
    return (
      <Tooltip label={props.fixedTitle ?? props.label} side="bottom" portal>
        <span style={MARKER_WRAP_STYLE}>{glyph}</span>
      </Tooltip>
    )
  }
  return (
    <Tooltip label={toggle.title} side="bottom" portal>
      <button
        type="button"
        disabled={toggle.busy}
        aria-label={props.label}
        title={toggle.title}
        onClick={toggle.onClick}
        style={{ ...MARKER_WRAP_STYLE, border: 0, padding: 0, background: 'transparent', color: 'inherit', cursor: 'pointer' }}
      >
        {glyph}
      </button>
    </Tooltip>
  )
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
