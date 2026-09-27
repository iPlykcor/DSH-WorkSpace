/**
 * One tool button in the shape of the built-in 工作区文件 tab's `.tool`: a fixed
 * box around a glyph, secondary colour, hover treatment.
 *
 * WHY THIS IS A COMPONENT AND NOT A STYLE OBJECT. The built-in gets its hover
 * colour and background from CSS (`:hover`, `:focus`), and no CSS module reaches
 * a third-party sidebar tab, so here the hover has to be React state. Keeping
 * that state in one component means the pane header's reload/deactivate buttons
 * and the row's desktop action cannot drift apart from each other — they are the
 * same button at two sizes, with their numbers coming from ./tree-metrics.ts.
 */
import { useState, type CSSProperties, type ReactNode } from 'react'
import { TOOL_ICON_SIZE, TOOL_PADDING, TOOL_SIZE, toolStyle } from './tree-metrics.ts'

/** A glyph from the platform module table (this button only ever sizes it). */
export type ToolGlyph = (props: { size?: number }) => ReactNode

/** Props of one tool button. */
export interface ToolButtonProps {
  /** The glyph to draw; its size comes from this button, not from the caller. */
  icon: ToolGlyph
  /** Tooltip and accessible name. */
  label: string
  /** Invoked on click. */
  onClick: () => void
  /** Box edge in pixels (default: the built-in's header tool). */
  boxSize?: number
  /** Glyph edge in pixels (default: the built-in's header tool glyph). */
  glyphSize?: number
  /** Inner padding in pixels (default: the built-in's header tool padding). */
  padding?: number
  /** Extra style, merged last. */
  style?: CSSProperties
}

/**
 * The shared tool button.
 * @param props - glyph, copy, handler and the box metrics.
 * @returns the button.
 */
export function ToolButton({
  icon: Icon,
  label,
  onClick,
  boxSize = TOOL_SIZE,
  glyphSize = TOOL_ICON_SIZE,
  padding = TOOL_PADDING,
  style,
}: ToolButtonProps): ReactNode {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      onMouseEnter={() => { setHovered(true) }}
      onMouseLeave={() => { setHovered(false) }}
      // Focus gets the hover treatment too: the built-in's `.tool` colours on
      // `:hover` alone, but a keyboard user must be able to see the button they
      // are on, and this surface has no `:focus-visible` to fall back on.
      onFocus={() => { setHovered(true) }}
      onBlur={() => { setHovered(false) }}
      style={{ ...toolStyle(hovered, boxSize, padding), ...style }}
    >
      <Icon size={glyphSize} />
    </button>
  )
}
