/**
 * The markers a root folder row draws: the padlock beside its name, and the path
 * badge at the row's trailing edge (after the desktop action's slot).
 *
 * The padlock is the regression this file exists for: it disappeared once
 * already, when the package collapsed to zero runtime dependencies and the
 * glyph's provider (`react-icons/vsc`) had to go, and the replacement was a
 * shield the user read as a different kind of warning. It then carried the
 * opposite invariant — "a read-write root shows nothing at all" — until the
 * padlock itself became the way to CHANGE a root's access. Both states are now
 * drawn, from the same artwork family (codicon lock / unlock), and the pair is
 * what makes "closed means read-only, open means read-write" enforceable instead
 * of a thing reviewers have to notice by eye.
 *
 * The toggle is a REAL `<button>` and it is a SIBLING of the row's own button:
 * a button may not nest inside another one, and the row's button expands the
 * folder on every click. A root the manifest does not declare (the session cwd's
 * implicit root) gets the same padlock with no button at all, because there is
 * no entry that could persist the change.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Padlock, PathBadge, RootPermissionToggle, RootTrailingBadge } from '../src/client/root-markers.tsx'

/** A root outside the session workspace, with the separators a Windows path has. */
const ROOT = 'C:\\Users\\demo\\Desktop\\新人培养'

/** Zero-width spaces are injected into the tooltip label for wrapping; strip them to compare. */
const visible = (html: string): string => html.replace(/\u200B/g, '')

/** Count the geometry elements of a rendered SVG. */
const paths = (html: string): number => (html.match(/<path/g) ?? []).length

/** The body path of the first rendered padlock (the dot comes second). */
function bodyPath(html: string): string {
  return /<path fill-rule="evenodd"[^>]*d="([^"]*)"/.exec(html)?.[1] ?? ''
}

describe('padlock glyphs', () => {
  it('draws the closed glyph instead of rendering an empty placeholder', () => {
    const html = renderToStaticMarkup(<Padlock open={false} label="只读文件夹（不可写入）" />)
    // Two subpaths: the shackle+body outline and the keyhole dot. A one-path or
    // zero-path marker would mean the artwork was lost again.
    expect(paths(html)).toBe(2)
    expect(html).toContain('viewBox="0 0 16 16"')
    expect(html).toContain('fill="currentColor"')
    // The closed codicon's shackle starts at the middle of the grid.
    expect(bodyPath(html).startsWith('M8 1')).toBe(true)
  })

  it('draws the OPEN glyph for a read-write root, from the same grid and family', () => {
    const html = renderToStaticMarkup(<Padlock open label="读写文件夹（可写入）" />)
    expect(paths(html)).toBe(2)
    expect(html).toContain('viewBox="0 0 16 16"')
    // The open codicon hangs its shackle off to the right; a marker that reused
    // the closed path here would be the old "nothing to see" bug wearing a lock.
    expect(bodyPath(html).startsWith('M13 1')).toBe(true)
    expect(bodyPath(html)).not.toBe(bodyPath(renderToStaticMarkup(<Padlock open={false} label="x" />)))
  })

  it('stays at the pre-collapse size and colour, and is named for assistive tech', () => {
    for (const open of [false, true]) {
      const html = renderToStaticMarkup(<Padlock open={open} label="只读文件夹（不可写入）" />)
      expect(html).toContain('width="12"')
      expect(html).toContain('height="12"')
      expect(html).toContain('color:var(--dsw-alias-label-secondary)')
      expect(html).toContain('role="img"')
      expect(html).toContain('aria-label="只读文件夹（不可写入）"')
      // No spacing of its own: the row's 6px gap is what separates the padlock from
      // the name, exactly like every other pair of elements in a row.
      expect(html).not.toContain('margin-left')
    }
  })
})

describe('root permission toggle', () => {
  it('offers a real button for a declared root, named for its state and tooltipped with the action', () => {
    const html = renderToStaticMarkup(
      <RootPermissionToggle
        readOnly
        label="只读文件夹（不可写入）"
        toggle={{ title: '点击解锁为读写', busy: false, onClick: () => { /* the row under test does not need it */ } }}
      />,
    )
    expect(html).toContain('<button')
    expect(html).toContain('type="button"')
    expect(html).toContain('aria-label="只读文件夹（不可写入）"')
    expect(html).toContain('data-tooltip-label="点击解锁为读写"')
    expect(html).not.toContain('disabled')
    // The button must not paint a UA border/background over the glyph.
    expect(html).toContain('border:0')
    expect(html).toContain('background:transparent')
    // Closed padlock: read-only.
    expect(bodyPath(html).startsWith('M8 1')).toBe(true)
  })

  it('draws the open padlock for a read-write root rather than leaving it unmarked', () => {
    const html = renderToStaticMarkup(
      <RootPermissionToggle
        readOnly={false}
        label="读写文件夹（可写入）"
        toggle={{ title: '点击锁定为只读', busy: false, onClick: () => { /* not needed here */ } }}
      />,
    )
    expect(paths(html)).toBe(2)
    expect(bodyPath(html).startsWith('M13 1')).toBe(true)
    expect(html).toContain('aria-label="读写文件夹（可写入）"')
  })

  it('disables the button, never hides it, while a change is in flight', () => {
    const html = renderToStaticMarkup(
      <RootPermissionToggle
        readOnly
        label="只读文件夹（不可写入）"
        toggle={{ title: '点击解锁为读写', busy: true, onClick: () => { /* not needed here */ } }}
      />,
    )
    expect(html).toContain('<button')
    expect(html).toContain('disabled')
  })

  it('renders no button at all for a root no manifest entry declares', () => {
    const html = renderToStaticMarkup(
      <RootPermissionToggle readOnly={false} label="读写文件夹（可写入）" fixedTitle="会话工作区（隐含读写根）" />,
    )
    expect(html).not.toContain('<button')
    // The glyph is still drawn — the root really is read-write — and the fixed
    // explanation, not the state name, is what the bubble carries.
    expect(bodyPath(html).startsWith('M13 1')).toBe(true)
    expect(html).toContain('data-tooltip-label="会话工作区（隐含读写根）"')
  })
})

describe('root row markers', () => {
  it('puts the path badge at the row trailing edge and hands it the absolute path verbatim', () => {
    const html = renderToStaticMarkup(<RootTrailingBadge path={ROOT} pathLabel="文件夹绝对路径" />)
    expect(html).toContain('role="img"')
    expect(html).toContain('aria-label="文件夹绝对路径"')
    // The badge must not grow or shrink: it and the desktop action's slot are the
    // row's two fixed trailing elements, and the row button takes the free space
    // (the wrapper's gap and right padding, not an auto margin, place them).
    expect(html).toContain('flex:none')
    // Its weight is a token, not an opacity: the badge and the desktop action it
    // stands next to must rest at the same grey.
    expect(html).toContain('color:var(--dsw-alias-label-secondary)')
    expect(html).not.toContain('opacity')
    // The bubble text is the path itself: stripping the wrapping hints must
    // reproduce it exactly, so no separator or character was altered.
    const label = /data-tooltip-label="([^"]*)"/.exec(html)?.[1] ?? ''
    expect(visible(label)).toBe(ROOT)
  })

  it('inserts wrapping hints and nothing else into the bubble text', () => {
    const html = renderToStaticMarkup(<PathBadge path={ROOT} label="文件夹绝对路径" />)
    const label = /data-tooltip-label="([^"]*)"/.exec(html)?.[1] ?? ''
    // One zero-width space per separator (four in ROOT): invisible in the
    // bubble, and stripping them reproduces the path byte for byte.
    expect(label.length).toBe(ROOT.length + 4)
    expect(visible(label)).toBe(ROOT)
    expect(html).toContain('cursor:help')
  })
})
