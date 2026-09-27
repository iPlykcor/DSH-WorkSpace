/**
 * The markers a root folder row draws: the padlock beside its name, and the path
 * badge at the row's trailing edge (after the desktop action's slot).
 *
 * The padlock is the regression this file exists for: it disappeared once
 * already, when the package collapsed to zero runtime dependencies and the
 * glyph's provider (`react-icons/vsc`) had to go, and the replacement was a
 * shield the user read as a different kind of warning. Rendering the marker is
 * what makes "a read-only root carries a real padlock, a read-write root
 * carries no permission marker at all" enforceable instead of a thing reviewers
 * have to notice by eye.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PathBadge, ReadOnlyLock, RootPermissionMarker, RootTrailingBadge } from '../src/client/root-markers.tsx'

/** A root outside the session workspace, with the separators a Windows path has. */
const ROOT = 'C:\\Users\\demo\\Desktop\\新人培养'

/** Zero-width spaces are injected into the tooltip label for wrapping; strip them to compare. */
const visible = (html: string): string => html.replace(/\u200B/g, '')

/** Count the geometry elements of a rendered SVG. */
const paths = (html: string): number => (html.match(/<path/g) ?? []).length

describe('read-only padlock', () => {
  it('draws the glyph instead of rendering an empty placeholder', () => {
    const html = renderToStaticMarkup(<ReadOnlyLock label="只读文件夹（不可写入）" />)
    // Two subpaths: the shackle+body outline and the keyhole dot. A one-path or
    // zero-path marker would mean the artwork was lost again.
    expect(paths(html)).toBe(2)
    expect(html).toContain('viewBox="0 0 16 16"')
    expect(html).toContain('fill="currentColor"')
  })

  it('stays at the pre-collapse size and colour, and is named for assistive tech', () => {
    const html = renderToStaticMarkup(<ReadOnlyLock label="只读文件夹（不可写入）" />)
    expect(html).toContain('width="12"')
    expect(html).toContain('height="12"')
    expect(html).toContain('color:var(--dsw-alias-label-secondary)')
    expect(html).toContain('role="img"')
    expect(html).toContain('aria-label="只读文件夹（不可写入）"')
    // No spacing of its own: the row's 6px gap is what separates the padlock from
    // the name, exactly like every other pair of elements in a row.
    expect(html).not.toContain('margin-left')
  })
})

describe('root row markers', () => {
  it('marks a read-only root with the padlock', () => {
    const html = renderToStaticMarkup(<RootPermissionMarker readOnly label="只读文件夹（不可写入）" />)
    expect(paths(html)).toBe(2)
    expect(html).toContain('aria-label="只读文件夹（不可写入）"')
  })

  it('leaves a read-write root without any permission marker', () => {
    const html = renderToStaticMarkup(<RootPermissionMarker readOnly={false} label="只读文件夹（不可写入）" />)
    expect(html).not.toContain('<svg')
    expect(paths(html)).toBe(0)
    expect(html).not.toContain('只读文件夹（不可写入）')
  })

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
