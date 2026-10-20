/**
 * The tree's visible rows, at ANY depth.
 *
 * THIS IS THE REGRESSION GUARD FOR "ONLY ONE LEVEL OPENS". The tab draws one
 * flat list; the recursion that turns "this directory is expanded" into "draw
 * its level, and then whatever of its own levels is expanded" used to live
 * inside the JSX, where nothing could assert it — and it was missing, so the
 * tab listed a root's children and stopped. Every `depth` expectation below is
 * that bug: `VS调试` (depth 1) → `Doc` (2) → `Scripts` (3) → `deploy.ps1` (4)
 * has to be in the same rendered sequence.
 */
import { describe, expect, it } from 'vitest'
import type { FsEntry } from '../src/client/api.ts'
import { treeItems } from '../src/client/tree-rows.ts'

/** Root path every case builds on. */
const ROOT = 'D:\\demo'

/**
 * One listing row.
 * @param parent - absolute path of the directory holding it.
 * @param name - entry name.
 * @param isDir - whether it is a directory.
 * @returns the entry.
 */
function entry(parent: string, name: string, isDir: boolean): FsEntry {
  return { name, path: `${parent}\\${name}`, isDir, hidden: false, isSymlink: false, broken: false }
}

/**
 * Build the child map from `[parent, entries]` pairs.
 * @param levels - one pair per fetched directory level.
 * @returns the map the view keeps.
 */
function levels(...levels: Array<[string, FsEntry[]]>): ReadonlyMap<string, readonly FsEntry[]> {
  return new Map(levels)
}

/**
 * A row sequence, as `path@depth` strings plus `note:kind@depth` for notes —
 * one string per drawn line, which is what the pane actually shows.
 * @param items - the flattened rows.
 * @returns the comparable rendering.
 */
function drawn(items: ReturnType<typeof treeItems>): string[] {
  return items.map((item) => (item.kind === 'entry'
    ? `${item.entry.path}@${item.depth}`
    : `note:${item.note}@${item.depth}`))
}

describe('operation-space tree rows', () => {
  it('walks every expanded level, four deep and in display order', () => {
    const children = levels(
      [ROOT, [entry(ROOT, 'VS调试', true), entry(ROOT, 'README.md', false)]],
      [`${ROOT}\\VS调试`, [entry(`${ROOT}\\VS调试`, 'Doc', true), entry(`${ROOT}\\VS调试`, 'notes.txt', false)]],
      [`${ROOT}\\VS调试\\Doc`, [entry(`${ROOT}\\VS调试\\Doc`, 'Scripts', true), entry(`${ROOT}\\VS调试\\Doc`, 'manual.pdf', false)]],
      [`${ROOT}\\VS调试\\Doc\\Scripts`, [entry(`${ROOT}\\VS调试\\Doc\\Scripts`, 'deploy.ps1', false)]],
    )
    const expanded: ReadonlySet<string> = new Set([
      ROOT,
      `${ROOT}\\VS调试`,
      `${ROOT}\\VS调试\\Doc`,
      `${ROOT}\\VS调试\\Doc\\Scripts`,
    ])
    expect(drawn(treeItems(ROOT, 1, children, expanded))).toEqual([
      `${ROOT}\\VS调试@1`,
      `${ROOT}\\VS调试\\Doc@2`,
      `${ROOT}\\VS调试\\Doc\\Scripts@3`,
      `${ROOT}\\VS调试\\Doc\\Scripts\\deploy.ps1@4`,
      `${ROOT}\\VS调试\\Doc\\manual.pdf@3`,
      `${ROOT}\\VS调试\\notes.txt@2`,
      `${ROOT}\\README.md@1`,
    ])
  })

  it('stops at the deepest opened directory, leaving collapsed subtrees out', () => {
    const children = levels(
      [ROOT, [entry(ROOT, 'a', true)]],
      [`${ROOT}\\a`, [entry(`${ROOT}\\a`, 'b', true)]],
      // Fetched earlier, then collapsed: it must not be drawn.
      [`${ROOT}\\a\\b`, [entry(`${ROOT}\\a\\b`, 'c.txt', false)]],
    )
    expect(drawn(treeItems(ROOT, 1, children, new Set([ROOT, `${ROOT}\\a`])))).toEqual([
      `${ROOT}\\a@1`,
      `${ROOT}\\a\\b@2`,
    ])
  })

  it('shows a loading note under a directory whose level has not arrived', () => {
    const children = levels([ROOT, [entry(ROOT, 'doc', true)]])
    expect(drawn(treeItems(ROOT, 1, children, new Set([ROOT, `${ROOT}\\doc`])))).toEqual([
      `${ROOT}\\doc@1`,
      'note:loading@2',
    ])
  })

  it('shows an empty note for an opened but empty directory', () => {
    const children = levels([ROOT, [entry(ROOT, 'empty', true)]], [`${ROOT}\\empty`, []])
    expect(drawn(treeItems(ROOT, 1, children, new Set([ROOT, `${ROOT}\\empty`])))).toEqual([
      `${ROOT}\\empty@1`,
      'note:empty@2',
    ])
  })

  it('notes loading for the root level itself when nothing is fetched yet', () => {
    expect(drawn(treeItems(ROOT, 1, new Map(), new Set()))).toEqual(['note:loading@1'])
  })

  it('orders an opened level like the built-in pane: directories first, then natural order', () => {
    const children = levels(
      [ROOT, [entry(ROOT, 'file10.md', false), entry(ROOT, 'docs', true), entry(ROOT, 'File2.md', false)]],
      [`${ROOT}\\docs`, [entry(`${ROOT}\\docs`, 'z.txt', false)]],
    )
    expect(drawn(treeItems(ROOT, 1, children, new Set([ROOT, `${ROOT}\\docs`])))).toEqual([
      `${ROOT}\\docs@1`,
      `${ROOT}\\docs\\z.txt@2`,
      `${ROOT}\\File2.md@1`,
      `${ROOT}\\file10.md@1`,
    ])
  })

  it('never opens a file, even when its path is in the expanded set', () => {
    const children = levels(
      [ROOT, [entry(ROOT, 'a.txt', false)]],
      // Stale state: a path that used to be a directory, listed as a file now.
      [`${ROOT}\\a.txt`, [entry(`${ROOT}\\a.txt`, 'x', true)]],
    )
    expect(drawn(treeItems(ROOT, 1, children, new Set([ROOT, `${ROOT}\\a.txt`])))).toEqual([
      `${ROOT}\\a.txt@1`,
    ])
  })

  it('handles a deep chain (24 levels) without losing a level', () => {
    const children = new Map<string, FsEntry[]>()
    const expanded = new Set<string>()
    let parent = ROOT
    for (let level = 1; level <= 24; level += 1) {
      const dir = entry(parent, `d${level}`, true)
      children.set(parent, [dir])
      expanded.add(parent)
      parent = dir.path
    }
    // The last directory is opened too, but its level was never fetched.
    expanded.add(parent)
    const items = treeItems(ROOT, 1, children, expanded)
    expect(items).toHaveLength(25)
    const last = items.at(-1)
    expect(last?.kind).toBe('note')
    expect(last?.depth).toBe(25)
  })

  it('does not mutate the state it reads', () => {
    const listed = [entry(ROOT, 'b', true), entry(ROOT, 'a', false)]
    const children = levels([ROOT, listed])
    const expanded = new Set([ROOT])
    treeItems(ROOT, 1, children, expanded)
    expect(listed.map((item) => item.name)).toEqual(['b', 'a'])
    expect([...expanded]).toEqual([ROOT])
    expect(children.get(ROOT)).toBe(listed)
  })
})
