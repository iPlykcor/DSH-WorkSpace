/**
 * The row list draws every level the user opened — the "only one level" bug,
 * pinned by rendering the real component.
 *
 * @vitest-environment jsdom
 *
 * The bug was not in the walking (that is `tests/tree-rows.spec.ts`) but in the
 * drawing: the tab fetched a folder's level on expand and then rendered nothing
 * beneath it, so the tree stopped at a root's children. Asserting the flattened
 * data alone would not have caught that, and the tab body itself needs a live
 * host to render. {@link FsTreeLevel} is that seam: it takes rows and renders
 * them, so a render of it is the cheapest thing that can prove a fourth level
 * reaches the screen — and, with jsdom, that clicking a folder asks the tab to
 * toggle exactly that path instead of opening it as a file.
 *
 * WHAT THIS CANNOT ASSERT: layout, colour and glyph shapes as pixels — there is
 * no browser lane in this repo (AGENTS.md §2). It asserts the row set, the order,
 * the depth each row carries, the open/closed state the row advertises, the note
 * lines' indent and the click wiring; the visual match to the built-in pane is
 * still a human's call.
 */
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { FsEntry } from '../src/client/api.ts'
import { treeItems } from '../src/client/tree-rows.ts'
import { FsTreeLevel, type FsTreeLevelProps } from '../src/client/tree-view.tsx'

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
 * Render one subtree.
 * @param levels - fetched directory levels.
 * @param expanded - the directories the user opened.
 * @param overrides - prop overrides (a host without a desktop action, …).
 * @returns the rendered HTML.
 */
function render(
  levels: ReadonlyMap<string, readonly FsEntry[]>,
  expanded: readonly string[],
  overrides: Partial<FsTreeLevelProps> = {},
): string {
  const openPaths = new Set(expanded)
  const props: FsTreeLevelProps = {
    items: treeItems(ROOT, 1, levels, openPaths),
    openPaths,
    activeRow: null,
    canReveal: false,
    onToggle: () => {},
    onOpenFile: () => {},
    onReveal: () => {},
    onActiveRowChange: () => {},
    ...overrides,
  }
  return renderToStaticMarkup(<FsTreeLevel {...props} />)
}

/**
 * The `padding-left` each rendered row carries, in row order.
 * @param html - the rendered HTML.
 * @returns the left paddings of the row buttons, in document order.
 */
function paddings(html: string): string[] {
  return [...html.matchAll(/<button[^>]*style="[^"]*padding-left:(\d+)px/g)].map(match => match[1] ?? '')
}

/** The four-level fixture: `VS调试` → `Doc` → `Scripts` → `deploy.ps1`. */
function deepLevels(): ReadonlyMap<string, readonly FsEntry[]> {
  return new Map<string, FsEntry[]>([
    [ROOT, [entry(ROOT, 'VS调试', true), entry(ROOT, 'README.md', false)]],
    [`${ROOT}\\VS调试`, [entry(`${ROOT}\\VS调试`, 'Doc', true)]],
    [`${ROOT}\\VS调试\\Doc`, [entry(`${ROOT}\\VS调试\\Doc`, 'Scripts', true)]],
    [`${ROOT}\\VS调试\\Doc\\Scripts`, [entry(`${ROOT}\\VS调试\\Doc\\Scripts`, 'deploy.ps1', false)]],
  ])
}

/** Every directory of {@link deepLevels}, i.e. "everything is open". */
const ALL_OPEN = [
  ROOT,
  `${ROOT}\\VS调试`,
  `${ROOT}\\VS调试\\Doc`,
  `${ROOT}\\VS调试\\Doc\\Scripts`,
]

describe('operation-space tree rows, rendered', () => {
  it('draws the fourth level, in order, each one a step further in', () => {
    const html = render(deepLevels(), ALL_OPEN)
    const names = ['VS调试', 'Doc', 'Scripts', 'deploy.ps1', 'README.md']
    const positions = names.map(name => html.indexOf(name))
    for (const [index, position] of positions.entries()) {
      expect(position, `"${names[index]}" is missing from the rendered tree`).toBeGreaterThanOrEqual(0)
      if (index > 0) expect(position).toBeGreaterThan(positions[index - 1] ?? -1)
    }
    // 10px (the built-in's row padding) plus 18px per level: a child sits exactly
    // one indent step inside its parent, which is how a deep row says where it is.
    expect(paddings(html)).toEqual(['28', '46', '64', '82', '28'])
  })

  it('stops drawing a collapsed directory’s level', () => {
    const html = render(deepLevels(), [ROOT, `${ROOT}\\VS调试`])
    expect(html).toContain('VS调试')
    expect(html).toContain('Doc')
    // `Doc` is drawn (it is a child of an open folder) but not opened itself.
    expect(html).not.toContain('Scripts')
    expect(html).not.toContain('deploy.ps1')
    expect(paddings(html)).toEqual(['28', '46', '28'])
  })

  it('advertises open state on directories and nothing on files', () => {
    const html = render(deepLevels(), ALL_OPEN)
    // Three open directories (the root's own level is drawn by the tab, not here).
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(3)
    expect(html).not.toMatch(/aria-expanded="false"/)
    // The file row carries no expansion state at all.
    expect(/aria-expanded[^>]*deploy\.ps1/.test(html)).toBe(false)
  })

  it('draws a loading note under an opened folder whose level is not here yet', () => {
    const levels = new Map<string, FsEntry[]>([[ROOT, [entry(ROOT, 'Doc', true)]]])
    const html = render(levels, [ROOT, `${ROOT}\\Doc`])
    // The note belongs to the level under `Doc`, so it is indented to depth 2.
    expect(html).toContain('padding-left:46px')
    expect(html).not.toContain('padding-left:64px')
  })

  it('offers the desktop action only on the hovered row of a host that has one', () => {
    const levels = new Map<string, FsEntry[]>([
      [ROOT, [entry(ROOT, 'Doc', true), entry(ROOT, 'README.md', false)]],
    ])
    const hovered = `${ROOT}\\Doc`
    const buttons = (html: string): number => (html.match(/<button/g) ?? []).length
    // Its slot is always rendered — that is what keeps a row from shifting when
    // the icon appears — but the button itself only on the hovered row, and only
    // when the host has a desktop file manager to drive.
    expect(buttons(render(levels, [ROOT], { canReveal: true, activeRow: hovered }))).toBe(3)
    expect(buttons(render(levels, [ROOT], { activeRow: hovered }))).toBe(2)
    expect(buttons(render(levels, [ROOT], { canReveal: true }))).toBe(2)
  })

  it('toggles a folder on click and opens a file, at any depth', async () => {
    // The wiring the bug report was about: a click on a nested folder must ask the
    // tab to expand THAT path. If it were routed to `onOpenFile` nothing would
    // happen on screen, which is what a user reads as "this level cannot be
    // opened".
    const toggled: string[] = []
    const opened: string[] = []
    const openPaths = new Set<string>(ALL_OPEN.slice(0, 3))
    const props: FsTreeLevelProps = {
      items: treeItems(ROOT, 1, deepLevels(), openPaths),
      openPaths,
      activeRow: null,
      canReveal: false,
      onToggle: (path) => { toggled.push(path) },
      onOpenFile: (path) => { opened.push(path) },
      onReveal: () => {},
      onActiveRowChange: () => {},
    }
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    // React's own act-environment switch is not in this version's type surface.
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    try {
      await act(async () => { root.render(<FsTreeLevel {...props} />) })
      /**
       * Click the row button whose label is `name`.
       * @param name - the entry name shown on the row.
       */
      const click = async (name: string): Promise<void> => {
        const button = [...container.querySelectorAll('button')]
          .find(candidate => candidate.textContent?.includes(name) === true)
        expect(button, `no row button for "${name}"`).toBeDefined()
        await act(async () => { button?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      }
      await click('Doc')
      await click('README.md')
      expect(toggled).toEqual([`${ROOT}\\VS调试\\Doc`])
      expect(opened).toEqual([`${ROOT}\\README.md`])
    } finally {
      await act(async () => { root.unmount() })
      container.remove()
    }
  })
})
