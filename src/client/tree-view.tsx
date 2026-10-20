/**
 * The operation-space tree's row list: one flat, depth-indented list of every
 * level the user has opened.
 *
 * WHY THIS IS ITS OWN COMPONENT. "Only one level opens" was the first version's
 * bug, and it lived exactly here: the recursion that drew an expanded folder's
 * own level was missing, so a root listed its children and stopped. Nothing
 * could catch that while the rows were built inline inside the tab body, which
 * needs the whole host to render. Split out, the list is a plain component over
 * plain data — flattening in ./tree-rows.ts, drawing here — and
 * `tests/tree-view.spec.tsx` renders it and counts the levels.
 *
 * It owns no state and asks no questions: which rows exist, which are open and
 * what a click means all come from the caller. That is what makes it renderable
 * outside a browser.
 */
import {
  FileTypeIcon,
  IconFolderCloseRegular,
  IconFolderOpenRegular,
  classifyFileType,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { FocusEvent, ReactNode } from 'react'
import { t } from './locales.ts'
import { RevealButton } from './reveal-button.tsx'
import type { TreeItem } from './tree-rows.ts'
import {
  dirIconStyle,
  fileIconStyle,
  nameStyle,
  noteStyleAt,
  rowStyle,
  rowWrapperStyle,
} from './tree-metrics.ts'

/** Everything the row list needs from the tab that owns the state. */
export interface FsTreeLevelProps {
  /** The flattened rows to draw, in order (from `treeItems`). */
  items: readonly TreeItem[]
  /** Absolute paths of the directories the user has opened. */
  openPaths: ReadonlySet<string>
  /** The row whose hover/focus desktop action is showing; null = none. */
  activeRow: string | null
  /** Whether this host has a desktop file manager the reveal action could drive. */
  canReveal: boolean
  /** Toggle one directory's expansion. */
  onToggle: (path: string) => void
  /** Open one file through DSH's own viewer (delegated, never reimplemented). */
  onOpenFile: (path: string) => void
  /** Hand one row's path to the desktop file manager. */
  onReveal: (path: string) => void
  /**
   * Report the row that gained or lost pointer/focus, as an updater rather than
   * a value: a `mouseleave` from the row that was just left must not clear the
   * row the pointer has already entered.
   */
  onActiveRowChange: (update: (current: string | null) => string | null) => void
}

/**
 * Draw the flattened tree rows.
 * @param props - see {@link FsTreeLevelProps}.
 * @returns the rows, a note line standing in for a loading or empty level, all at
 * their own depth.
 */
export function FsTreeLevel(props: FsTreeLevelProps): ReactNode {
  /**
   * Pointer/focus plumbing for the hover-only desktop action. Focus has to show
   * it too, or the action would be keyboard-unreachable; the blur handler asks
   * whether focus stayed INSIDE the row, because moving it from the row button
   * onto the action button must not hide the button being reached.
   * @param path - the row's path.
   * @returns the handlers a row wrapper spreads.
   */
  const rowActivity = (path: string): {
    onMouseEnter: () => void
    onMouseLeave: () => void
    onFocus: () => void
    onBlur: (event: FocusEvent<HTMLDivElement>) => void
  } => ({
    onMouseEnter: () => { props.onActiveRowChange(() => path) },
    onMouseLeave: () => { props.onActiveRowChange((current) => (current === path ? null : current)) },
    onFocus: () => { props.onActiveRowChange(() => path) },
    onBlur: (event) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
      props.onActiveRowChange((current) => (current === path ? null : current))
    },
  })

  return props.items.map((item) => {
    // The built-in's own states, at its own metrics: a note line, never a row,
    // indented to the level it stands in for.
    if (item.kind === 'note') {
      return (
        <div key={`note:${item.note}:${item.depth}`} style={noteStyleAt(item.depth)}>
          {item.note === 'loading' ? t('loading') : t('emptyFolder')}
        </div>
      )
    }
    const entry = item.entry
    const open = props.openPaths.has(entry.path)
    return (
      <div key={entry.path} style={rowWrapperStyle(props.activeRow === entry.path)} {...rowActivity(entry.path)}>
        <button
          type="button"
          title={entry.path}
          aria-expanded={entry.isDir ? open : undefined}
          style={rowStyle(item.depth, { opacity: entry.broken ? 0.5 : 1 })}
          onClick={() => { if (entry.isDir) props.onToggle(entry.path); else props.onOpenFile(entry.path) }}
        >
          {entry.isDir
            ? (
              // Regular weight, no explicit size and the tertiary colour: this is
              // the glyph the built-in file tree draws for a directory.
              <span style={dirIconStyle}>
                {open ? <IconFolderOpenRegular /> : <IconFolderCloseRegular />}
              </span>
            )
            : (
              // The product's own classifier and category-coloured glyph, which is
              // exactly what the built-in pane shows for the same file name.
              <span style={fileIconStyle}>
                <FileTypeIcon kind={classifyFileType(entry.name)} size={16} />
              </span>
            )}
          <span style={nameStyle}>{entry.name}</span>
          {entry.isSymlink && <span style={{ fontSize: 11, opacity: 0.5 }}>↗</span>}
        </button>
        {/* A broken link has no target to hand to the desktop, and the host
            would refuse it anyway: the row simply offers no action. */}
        {props.canReveal && !entry.broken && (
          <RevealButton
            path={entry.path}
            label={entry.isDir ? t('workspaceOpenFolder') : t('workspaceShowFile')}
            onReveal={props.onReveal}
            visible={props.activeRow === entry.path}
          />
        )}
      </div>
    )
  })
}
