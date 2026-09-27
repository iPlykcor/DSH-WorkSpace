/**
 * The row's desktop action, at the one level that can be rendered without a
 * host: the slot itself.
 *
 * Two properties are worth pinning here. The action is a REAL `<button>` (the
 * padlock next to it is a plain `<span role="img">`, which is fine for a marker
 * but unreachable for an action), and it is `aria-label`led — the icon carries
 * no text, so without the name the control would be silent to assistive tech.
 * The slot's width is reserved whether or not the icon is shown, which is what
 * keeps a hover from shifting the row's label sideways.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RevealButton } from '../src/client/reveal-button.tsx'

/** The row path under test. */
const PATH = 'C:\\Users\\demo\\Desktop\\新人培养'

/** A no-op reveal sink: nothing here clicks anything. */
const onReveal = (): void => { /* intentionally empty */ }

describe('row reveal action', () => {
  it('renders nothing interactive until the row asks for it, and keeps the slot width', () => {
    const html = renderToStaticMarkup(
      <RevealButton path={PATH} label="在文件资源管理器中打开" onReveal={onReveal} visible={false} />,
    )
    expect(html).not.toContain('<button')
    expect(html).not.toContain('<svg')
    // The reserved gap: the row must not reflow when the icon appears.
    expect(html).toContain('width:18px')
  })

  it('is a real, named button that does not carry the path as its visible text', () => {
    const html = renderToStaticMarkup(
      <RevealButton path={PATH} label="在文件资源管理器中打开" onReveal={onReveal} visible />,
    )
    expect(html).toContain('<button type="button"')
    expect(html).toContain('title="在文件资源管理器中打开"')
    expect(html).toContain('aria-label="在文件资源管理器中打开"')
    // The glyph itself is deliberately NOT asserted: the platform module is
    // stubbed in tests (its stand-in icons render null), and the real names are
    // already pinned by `pnpm typecheck` against the package's declarations.
    expect(html).not.toContain(PATH)
  })
})
