/**
 * The desktop handoff a row offers: one icon that hands that row's own path to
 * the desktop file manager (a directory opens, a file is revealed).
 *
 * IT IS A REAL BUTTON, AND IT IS THE ROW BUTTON'S SIBLING. A `<button>` inside
 * another `<button>` is invalid markup and the click would belong to the inner
 * one anyway; keeping the action in a fixed-width slot next to the row button
 * also means the slot can appear on hover without shifting the row's label — or
 * the row's trailing path badge, which is rendered after this slot for exactly
 * that reason.
 *
 * IT WEARS THE BUILT-IN'S TOOL TREATMENT. `FileTypeIcon`, `PathLabel` and the
 * row metrics that make this tab look like DSH's own 工作区文件 pane come from
 * ./tree-metrics.ts; the action is the same button as that pane's header tools
 * (./tool-button.tsx), only sized to fit a row ({@link ROW_TOOL_SIZE}) instead
 * of a header.
 *
 * Visibility is the CALLER's decision: the row knows whether it is hovered or
 * focused, and this component deliberately knows nothing about that.
 */
import { IconFolderOpenOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import { ROW_TOOL_ICON_SIZE, ROW_TOOL_PADDING, ROW_TOOL_SIZE } from './tree-metrics.ts'
import { ToolButton } from './tool-button.tsx'

/** Props of one row's reveal action. */
export interface RevealButtonProps {
  /** Absolute path the host will hand to the file manager. */
  path: string
  /** Tooltip and accessible name (a folder opens, a file is revealed). */
  label: string
  /** Invoked with the row's path. */
  onReveal: (path: string) => void
  /** Whether the icon is shown; the slot keeps its width either way. */
  visible: boolean
}

/**
 * One reveal action inside a fixed-width slot.
 * @param props - row path, copy, the reveal callback, and visibility.
 * @returns the slot, with the icon when visible.
 */
export function RevealButton({ path, label, onReveal, visible }: RevealButtonProps): ReactNode {
  return (
    <span
      style={{
        width: ROW_TOOL_SIZE,
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {visible && (
        <ToolButton
          icon={IconFolderOpenOutlineRegular}
          label={label}
          // The row's own click handler lives on a sibling, never an ancestor,
          // so the click needs no propagation guard.
          onClick={() => { onReveal(path) }}
          boxSize={ROW_TOOL_SIZE}
          glyphSize={ROW_TOOL_ICON_SIZE}
          padding={ROW_TOOL_PADDING}
        />
      )}
    </span>
  )
}
