/**
 * The two markers at the end of a root folder row.
 *
 * `ReadOnlyLock` marks a read-only root, exactly as the pre-collapse workbench
 * drew it, and `PathBadge` is the circled exclamation that reveals the root's
 * absolute path on hover.
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
import { IconWarningOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactElement } from 'react'

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
      style={{ flex: 'none', marginLeft: 6, color: 'var(--dsw-alias-label-secondary)' }}
    >
      <path d={LOCK_DOT} />
      <path fillRule="evenodd" clipRule="evenodd" d={LOCK_BODY} />
    </svg>
  )
}

/**
 * The absolute-path affordance: a circled exclamation that reveals the path.
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
        style={{ display: 'inline-flex', alignItems: 'center', flex: 'none', cursor: 'help' }}
      >
        <IconWarningOutlineRegular size={14} />
      </span>
    </Tooltip>
  )
}

/**
 * Everything a root folder row shows after its label: the padlock for a
 * read-only root, then the path badge pinned to the row's right edge. A
 * read-write root deliberately shows NO permission marker — that is the
 * pre-collapse behaviour, and the platform glyphs that briefly replaced it
 * (a shield with a check, and a shield with an exclamation) read as two
 * different kinds of warning rather than as one permission state.
 * @param props.readOnly - whether the root was declared read-only.
 * @param props.path - the root's absolute path.
 * @param props.lockLabel - accessible name for the padlock.
 * @param props.pathLabel - accessible name for the path badge.
 * @returns the marker pair.
 */
export function RootRowMarkers({ readOnly, path, lockLabel, pathLabel }: {
  readOnly: boolean
  path: string
  lockLabel: string
  pathLabel: string
}): ReactElement {
  return (
    <>
      {readOnly && <ReadOnlyLock label={lockLabel} />}
      <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', opacity: 0.6 }}>
        <PathBadge path={path} label={pathLabel} />
      </span>
    </>
  )
}
