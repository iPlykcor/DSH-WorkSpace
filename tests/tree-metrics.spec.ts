/**
 * The parity contract with DSH's built-in 工作区文件 pane, pinned as numbers.
 *
 * THIS SUITE CANNOT ASSERT "LOOKS THE SAME". That needs a browser, and this repo
 * has no browser automation (AGENTS.md §2). What it CAN do is refuse to let the
 * numbers drift: every expectation below is a copy of a declaration in
 * `@deepseek-ai/dsh-client-ui-sidebar-files/lib/client.js` (its inlined
 * `k-1LKG_*` CSS module). If the built-in changes, this fails and forces that
 * file to be re-read instead of letting the two panes diverge in silence.
 */
import { describe, expect, it } from 'vitest'
import {
  BODY_MARGIN_RIGHT,
  BODY_PADDING,
  CONTENT_FONT_SIZE,
  CONTENT_LINE_HEIGHT,
  HEADER_GAP,
  HEADER_HEIGHT,
  HEADER_PADDING,
  HOVER_BACKGROUND,
  INDENT_PX,
  NOTE_FONT_SIZE,
  NOTE_PADDING,
  ROW_GAP,
  ROW_PADDING_X,
  ROW_PADDING_Y,
  ROW_RADIUS,
  ROW_TOOL_ICON_SIZE,
  ROW_TOOL_SIZE,
  TOOL_ICON_SIZE,
  TOOL_PADDING,
  TOOL_RADIUS,
  TOOL_SIZE,
  bodyStyle,
  headerStyle,
  noteStyle,
  rowStyle,
  rowWrapperStyle,
  tabRootStyle,
  toolStyle,
} from '../src/client/tree-metrics.ts'

describe('metrics shared with the built-in file pane', () => {
  it('copies the row box, the gap and the per-level indent', () => {
    expect(ROW_PADDING_Y).toBe(5)
    expect(ROW_PADDING_X).toBe(10)
    expect(ROW_GAP).toBe(6)
    expect(INDENT_PX).toBe(18)
    expect(ROW_RADIUS).toBe('var(--dsw-radius-md)')
  })

  it('copies the body, the header and the tool box', () => {
    expect(BODY_PADDING).toBe('8px 0 8px 8px')
    expect(BODY_MARGIN_RIGHT).toBe(2)
    expect(HEADER_HEIGHT).toBe(38)
    expect(HEADER_PADDING).toBe('0 6px 0 16px')
    expect(HEADER_GAP).toBe(4)
    expect(TOOL_SIZE).toBe(28)
    expect(TOOL_ICON_SIZE).toBe(15)
    expect(TOOL_PADDING).toBe(6)
    expect(TOOL_RADIUS).toBe('var(--dsw-radius-sm)')
  })

  it('copies the content type scale and the note line', () => {
    expect(CONTENT_FONT_SIZE).toBe('var(--dsh-content-font-size-secondary, 13px)')
    expect(CONTENT_LINE_HEIGHT).toBe(1.5)
    expect(NOTE_FONT_SIZE).toBe(12)
    expect(NOTE_PADDING).toBe('3px 10px')
  })

  it('indents by depth and leaves the row height to its content', () => {
    const root = rowStyle(0)
    const grandchild = rowStyle(2)
    // Vertical padding and the left indent belong to the row; the RIGHT padding is
    // the wrapper's, so a trailing item ends where the built-in's content ends
    // instead of hanging off the row's edge.
    expect(root.padding).toBe('5px 0')
    expect(root.paddingRight).toBeUndefined()
    expect(root.paddingLeft).toBe(ROW_PADDING_X)
    expect(grandchild.paddingLeft).toBe(ROW_PADDING_X + 2 * INDENT_PX)
    // The built-in sets no row height either: 13px at line-height 1.5 plus 5px
    // of padding is 29.5px, and a fixed height would break that arithmetic.
    expect(root.height).toBeUndefined()
    expect(root.lineHeight).toBeUndefined()
    // The action box is the one deliberate give: 20px is taller than the 19.5px
    // text line, so a row carrying an action is 30px rather than 29.5px.
    expect(ROW_TOOL_SIZE).toBe(20)
  })

  it('keeps the trailing pair on the built-in grid', () => {
    const wrapper = rowWrapperStyle(false)
    // The 6px the built-in leaves between a row's elements, and the 10px its own
    // `.row` padding leaves at the row's right edge.
    expect(wrapper.gap).toBe(ROW_GAP)
    expect(wrapper.paddingRight).toBe(ROW_PADDING_X)
    // Without border-box that 10px would push every row 10px past the pane.
    expect(wrapper.boxSizing).toBe('border-box')
    // The desktop action's glyph and the path badge are the same size, side by side.
    expect(ROW_TOOL_ICON_SIZE).toBe(15)
  })

  it('paints hover and colour with the built-in tokens', () => {
    expect(HOVER_BACKGROUND).toBe('var(--dsw-alias-interactive-bg-hover)')
    expect(rowWrapperStyle(true).background).toBe(HOVER_BACKGROUND)
    expect(rowWrapperStyle(false).background).toBe('transparent')
    expect(toolStyle(true).background).toBe(HOVER_BACKGROUND)
    expect(toolStyle(true).color).toBe('var(--dsw-alias-label-primary)')
    expect(toolStyle(false, TOOL_SIZE, TOOL_PADDING).color).toBe('var(--dsw-alias-label-secondary)')
    expect(toolStyle(false, TOOL_SIZE, TOOL_PADDING).width).toBe(TOOL_SIZE)
    expect(headerStyle.borderBottom).toBe('.5px solid var(--dsw-alias-border-l3)')
    expect(bodyStyle.scrollbarGutter).toBe('stable')
    expect(noteStyle.padding).toBe(NOTE_PADDING)
    expect(tabRootStyle.fontSize).toBe(CONTENT_FONT_SIZE)
  })
})
