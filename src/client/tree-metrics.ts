/**
 * The measurements this tab shares with DSH's built-in 工作区文件 tab.
 *
 * WHY A MODULE FOR NUMBERS. The requirement is that the operation-space tree
 * look like the built-in file tree, and the only way to meet it is to use the
 * same numbers. Those numbers are not guesses: they are the built-in's own CSS
 * module, inlined into its bundle
 * (`@deepseek-ai/dsh-client-ui-sidebar-files/lib/client.js`, the `k-1LKG_*`
 * block), and they are restated exactly once — here. Every value is a
 * documented copy, and `tests/tree-metrics.spec.ts` pins each one so a later
 * edit cannot drift away from the built-in without failing a test.
 *
 * WHY INLINE STYLES AND NOT THE SAME CSS: no CSS module reaches a third-party
 * sidebar tab (`AGENTS.md` §4), so the built-in's stylesheet cannot be reused
 * or overridden. What CAN be reused is its components: `FileTypeIcon`,
 * `classifyFileType` and `PathLabel` all come from
 * `@deepseek-ai/dsh-client-ui-primitives`, which the client-bundle purity gate
 * already allows — so the icons and the path label are the product's own, not
 * lookalikes.
 *
 * WHAT IS DELIBERATELY NOT IDENTICAL, and why:
 * - the built-in gets its hover highlight from `:hover`, which an inline style
 *   cannot express; this tab paints the same
 *   `--dsw-alias-interactive-bg-hover` from the row-hover state it already
 *   tracks for the desktop action;
 * - the built-in indents by nesting `<ul>` elements; this tab renders one flat
 *   list, so the same 18px step is applied per depth;
 * - the row-height arithmetic belongs to the content, not to a fixed height:
 *   the built-in's rows are 13px text at `line-height: 1.5` (19.5px) plus 5px
 *   of padding on each side, i.e. 29.5px. {@link ROW_TOOL_SIZE} is the one
 *   deliberate give — a 20px clickable action is taller than 19.5px, so a row
 *   carrying an action is 30px instead of 29.5px.
 */
import type { CSSProperties } from 'react'

/** Left padding added per tree depth (px): the built-in nests `<ul>` with this padding. */
export const INDENT_PX = 18

/** Row box: the built-in's `.row` is `padding: 5px 10px` with `gap: 6px` and no fixed height. */
export const ROW_PADDING_Y = 5
/** See {@link ROW_PADDING_Y}. */
export const ROW_PADDING_X = 10
/** See {@link ROW_PADDING_Y}. */
export const ROW_GAP = 6

/** Content font size, straight from the built-in's `.root`; the line height is 1.5. */
export const CONTENT_FONT_SIZE = 'var(--dsh-content-font-size-secondary, 13px)'
/** See {@link CONTENT_FONT_SIZE}. */
export const CONTENT_LINE_HEIGHT = 1.5

/** Scroll body: the built-in's `.body` (`padding: 8px 0 8px 8px`, `margin-right: 2px`). */
export const BODY_PADDING = '8px 0 8px 8px'
/** See {@link BODY_PADDING}. */
export const BODY_MARGIN_RIGHT = 2

/** Header: the built-in's `.header` — fixed 38px, a half-pixel hairline, tools at the right. */
export const HEADER_HEIGHT = 38
/** See {@link HEADER_HEIGHT}. */
export const HEADER_PADDING = '0 6px 0 16px'
/** See {@link HEADER_HEIGHT}. */
export const HEADER_GAP = 4

/** Tool button: the built-in's `.tool` — a 28px box around a 15px glyph with 6px padding. */
export const TOOL_SIZE = 28
/** See {@link TOOL_SIZE}. */
export const TOOL_ICON_SIZE = 15
/** See {@link TOOL_SIZE}. */
export const TOOL_PADDING = 6

/** The row's action box: the same tool look, sized to keep the built-in's row height. */
export const ROW_TOOL_SIZE = 20
/**
 * The glyph inside {@link ROW_TOOL_SIZE}. The row's path badge draws at this same
 * size: the two sit side by side at the row's trailing edge, and a 14/15 mismatch
 * there reads as an oversight rather than as intent.
 */
export const ROW_TOOL_ICON_SIZE = 15
/** Padding inside {@link ROW_TOOL_SIZE}. */
export const ROW_TOOL_PADDING = 2

/** Note lines (loading, empty, failures): the built-in's `.note`. */
export const NOTE_FONT_SIZE = 12
/** See {@link NOTE_FONT_SIZE}. */
export const NOTE_PADDING = '3px 10px'

/** Token names the built-in's CSS uses; reusing them is what keeps the two panes in step. */
export const LABEL_PRIMARY = 'var(--dsw-alias-label-primary)'
/** See {@link LABEL_PRIMARY}. */
export const LABEL_SECONDARY = 'var(--dsw-alias-label-secondary)'
/** See {@link LABEL_PRIMARY}. */
export const LABEL_TERTIARY = 'var(--dsw-alias-label-tertiary)'
/** See {@link LABEL_PRIMARY}. */
export const HOVER_BACKGROUND = 'var(--dsw-alias-interactive-bg-hover)'
/** See {@link LABEL_PRIMARY}. */
export const ROW_RADIUS = 'var(--dsw-radius-md)'
/** See {@link LABEL_PRIMARY}. */
export const TOOL_RADIUS = 'var(--dsw-radius-sm)'
/** See {@link LABEL_PRIMARY}. */
export const HAIRLINE = 'var(--dsw-alias-border-l3)'

/** The tab's outer column: the built-in's `.root`. */
export const tabRootStyle: CSSProperties = {
  height: '100%',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  flex: 'auto',
  color: LABEL_PRIMARY,
  fontSize: CONTENT_FONT_SIZE,
  lineHeight: CONTENT_LINE_HEIGHT,
}

/** The pane header: the built-in's `.header`. */
export const headerStyle: CSSProperties = {
  boxSizing: 'border-box',
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: HEADER_GAP,
  height: HEADER_HEIGHT,
  padding: HEADER_PADDING,
  borderBottom: `.5px solid ${HAIRLINE}`,
}

/** The scrolling tree container: the built-in's `.body`. */
export const bodyStyle: CSSProperties = {
  flex: 'auto',
  minHeight: 0,
  overflow: 'auto',
  marginRight: BODY_MARGIN_RIGHT,
  padding: BODY_PADDING,
  scrollbarGutter: 'stable',
}

/**
 * The hoverable wrapper around one row. The built-in's `.row:hover` paints the
 * whole row width, so the highlight lives on the wrapper (which spans the full
 * width) rather than on the button (which leaves the trailing items unpainted).
 *
 * THE WRAPPER OWNS THE ROW'S TRAILING SPACING, and that is what keeps a row with
 * a desktop action and a path badge on the built-in's grid: {@link ROW_GAP}
 * between the row button, the action's slot and the badge, then the built-in's
 * {@link ROW_PADDING_X} at the row's right edge — the same 10px the built-in's own
 * `.row` padding leaves after its content. Without this the badge sat flush against
 * the row's edge (0px) and the two trailing glyphs were ~2px apart.
 * @param hovered - whether this row is hovered or focused.
 * @returns the wrapper style.
 */
export function rowWrapperStyle(hovered: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: ROW_GAP,
    boxSizing: 'border-box',
    width: '100%',
    paddingRight: ROW_PADDING_X,
    borderRadius: ROW_RADIUS,
    background: hovered ? HOVER_BACKGROUND : 'transparent',
  }
}

/**
 * One row's button, indented to its depth: the built-in's 5px vertical padding and
 * its 10px left padding, plus {@link INDENT_PX} per level, which is what nesting
 * its `<ul>` elements amounts to.
 *
 * THE RIGHT PADDING IS NOT HERE. It lives on {@link rowWrapperStyle} so that a
 * row's trailing items (the desktop action's slot, the path badge) end at the same
 * 10px from the row's right edge as the built-in's content does — and a plain row,
 * which has no trailing item, still ends there.
 * @param depth - tree depth (0 for a declared root).
 * @param extra - per-row overrides (opacity for a broken link, cursor, …).
 * @returns the row button style.
 */
export function rowStyle(depth: number, extra?: CSSProperties): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: ROW_GAP,
    flex: 1,
    minWidth: 0,
    textAlign: 'left',
    color: 'inherit',
    font: 'inherit',
    cursor: 'pointer',
    border: 0,
    background: 'transparent',
    borderRadius: ROW_RADIUS,
    padding: `${ROW_PADDING_Y}px 0`,
    paddingLeft: ROW_PADDING_X + depth * INDENT_PX,
    ...extra,
  }
}

/** The row's name: the built-in's `.name` (single line, ellipsis, shrinkable). */
export const nameStyle: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
}

/** A directory glyph: the built-in's `.icon` (tertiary, never shrinks). */
export const dirIconStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  flex: 'none',
  color: LABEL_TERTIARY,
}

/** A file-type glyph: the built-in's `.fileIcon` (its own category colour, never shrinks). */
export const fileIconStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  flex: 'none',
}

/** A note line: the built-in's `.note`. */
export const noteStyle: CSSProperties = {
  margin: 0,
  padding: NOTE_PADDING,
  fontSize: NOTE_FONT_SIZE,
  color: LABEL_TERTIARY,
}

/** The centred status panel: the built-in's `.status`. */
export const statusStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  padding: '12px 10px',
}

/** The status panel's prose: the built-in's `.statusLine`. */
export const statusLineStyle: CSSProperties = {
  margin: 0,
  lineHeight: 1.6,
  color: LABEL_SECONDARY,
  fontSize: CONTENT_FONT_SIZE,
}

/**
 * A tool button's box: the built-in's `.tool`, with its hover treatment.
 * @param hovered - whether the pointer or focus is on the button.
 * @param boxSize - the box edge in pixels (defaults to the built-in's header tool).
 * @param padding - inner padding around the glyph (defaults to the header tool's).
 * @returns the button style.
 */
export function toolStyle(
  hovered: boolean,
  boxSize: number = TOOL_SIZE,
  padding: number = TOOL_PADDING,
): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 'none',
    boxSizing: 'border-box',
    width: boxSize,
    height: boxSize,
    padding,
    lineHeight: 1,
    border: 'none',
    borderRadius: TOOL_RADIUS,
    cursor: 'pointer',
    background: hovered ? HOVER_BACKGROUND : 'transparent',
    color: hovered ? LABEL_PRIMARY : LABEL_SECONDARY,
  }
}
