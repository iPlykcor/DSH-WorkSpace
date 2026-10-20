/**
 * The operation-space tree, FLATTENED into the rows one render draws.
 *
 * WHY THIS IS A MODULE WITH TESTS, AND NOT A RECURSIVE JSX CALL. The tab draws
 * the tree as ONE flat list indented by depth, because no CSS module reaches a
 * third-party tab and the built-in's nested `<ul>` cannot be reused
 * (./tree-metrics.ts carries that argument). A flat list makes "render the
 * children of an expanded row" a place where a whole level can go missing
 * without any error: the first version of this tab fetched a directory's level
 * on expand and then simply drew nothing below depth 1 — `VS调试` opened,
 * `VS调试\Doc` did not, and no test noticed because the recursion lived inside
 * JSX. Flattening is therefore pure data work: {@link treeItems} returns the
 * exact sequence of rows and notes to draw, at any depth, and
 * `tests/tree-rows.spec.ts` pins it.
 *
 * LAZY, NOT EAGER. Nothing here touches the disk. It only walks the child map
 * the view has already fetched (one listing per expanded directory, fetched on
 * the first expand), so a collapsed subtree costs nothing and a deep path costs
 * one host call per click.
 *
 * TERMINATION. A child's path always EXTENDS its parent's path, so no path can
 * ever appear beneath itself and no cycle is representable — the walk ends at
 * the deepest expanded directory. In practice the depth is bounded by the
 * maximum path length, and every level past the first needs an explicit click.
 */
import type { FsEntry } from './api.ts'
import { orderEntries } from './entry-order.ts'

/**
 * One drawn row: either a listed entry, or the note that stands in for a level
 * that is loading (expanded, listing not here yet) or empty.
 */
export type TreeItem =
  | {
    kind: 'entry'
    /** The listed entry this row shows. */
    entry: FsEntry
    /** Depth below a declared root: a root's own children are depth 1. */
    depth: number
  }
  | {
    kind: 'note'
    /** `loading` = expanded, listing not arrived yet. `empty` = the level has no entries. */
    note: 'loading' | 'empty'
    /** The depth the note is drawn at — the depth its rows would have had. */
    depth: number
  }

/**
 * Flatten one directory's visible subtree, depth-first, in display order.
 *
 * A directory contributes its own row and then — only when it is in `expanded`
 * — the flattened rows of its level, one depth deeper. An expanded directory
 * whose level has not been fetched yet contributes a `loading` note, and an
 * empty one an `empty` note, both at that deeper depth so the note lines up
 * with the rows it stands in for.
 * @param parent - absolute path of the directory whose level is drawn.
 * @param depth - depth of that directory's CHILDREN (a declared root's are 1).
 * @param children - fetched levels, keyed by the absolute path of the directory.
 * @param expanded - absolute paths of the directories the user opened.
 * @returns the rows to draw, in order; empty only when the tree has no roots.
 */
export function treeItems(
  parent: string,
  depth: number,
  children: ReadonlyMap<string, readonly FsEntry[]>,
  expanded: ReadonlySet<string>,
): TreeItem[] {
  const level = children.get(parent)
  if (level === undefined) return [{ kind: 'note', note: 'loading', depth }]
  if (level.length === 0) return [{ kind: 'note', note: 'empty', depth }]
  const items: TreeItem[] = []
  for (const entry of orderEntries(level)) {
    items.push({ kind: 'entry', entry, depth })
    // Only directories open, and only the ones the user opened: a file path in
    // `expanded` (stale, or a directory that has since become a file) is ignored
    // rather than trusted.
    if (!entry.isDir || !expanded.has(entry.path)) continue
    items.push(...treeItems(entry.path, depth + 1, children, expanded))
  }
  return items
}
