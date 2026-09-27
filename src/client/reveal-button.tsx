/**
 * The desktop handoff a row offers: one icon that hands that row's own path to
 * the desktop file manager (a directory opens, a file is revealed).
 *
 * IT IS A REAL BUTTON, AND IT IS THE ROW BUTTON'S SIBLING. A `<button>` inside
 * another `<button>` is invalid markup and the click would belong to the inner
 * one anyway; keeping the action in a fixed-width slot next to the row button
 * also means the slot can appear on hover without shifting the row's label.
 *
 * Visibility is the CALLER's decision: the row knows whether it is hovered or
 * focused, and this component deliberately knows nothing about that.
 */
import { IconFolderOpenOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'

/** Width of the action slot (px) — reserved whether or not the icon is shown. */
const SLOT = 18

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
    <span style={{ width: SLOT, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {visible && (
        <button
          type="button"
          title={label}
          aria-label={label}
          onClick={(event) => {
            // The row's own handler must not also read this click (the slot is a
            // sibling today, so this is belt-and-braces rather than load-bearing).
            event.stopPropagation()
            onReveal(path)
          }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: SLOT,
            height: 20,
            padding: 0,
            border: 0,
            background: 'transparent',
            color: 'var(--dsw-alias-label-secondary)',
            cursor: 'pointer',
          }}
        >
          <IconFolderOpenOutlineRegular size={14} />
        </button>
      )}
    </span>
  )
}
