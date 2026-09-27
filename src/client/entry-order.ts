/**
 * The row order this tab shares with DSH's built-in 工作区文件 tab: directories
 * first, then everything else, each group by a natural, case-insensitive name
 * comparison. The built-in's own `orderEntries` is the reference
 * (`@deepseek-ai/dsh-client-ui-sidebar-files/lib/client.js`).
 *
 * WHY NOT THE HOST'S ORDER. A host listing is a fact about the directory; this
 * is a fact about the reader. The two trees must present the same folder the
 * same way, and "the same way" includes which row comes first — a side-by-side
 * comparison of the two tabs is exactly what this is for.
 *
 * WHY NOT `localeCompare`. The built-in sorts with a `numeric` collator, so
 * `file2` precedes `file10`; `localeCompare` would put `file10` first and the
 * two panes would disagree on real directory names.
 */
import type { FsEntry } from './api.ts'

/** Natural, case-insensitive name order: `file2` sorts before `file10`. */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * Order one directory level's entries for display.
 * @param entries - the host's listing order.
 * @returns a new array: directories first, then by name within each group.
 */
export function orderEntries(entries: readonly FsEntry[]): FsEntry[] {
  return [...entries].sort((left, right) => {
    const group = Number(right.isDir) - Number(left.isDir)
    return group !== 0 ? group : byName.compare(left.name, right.name)
  })
}
