/**
 * The guide capsule's artwork.
 *
 * The capsule draws `guide[].icon` when a tab type declares one and the
 * platform's cube glyph otherwise (`ui-sidebar-right/lib/client.js:461`), so the
 * artwork has to be a COMPONENT - not a URL, and not a file the shell could fail
 * to fetch. These four checks are the parts of that decision a test can hold
 * still: the bytes travel with the bundle, the drawing follows the size the
 * platform asks for, the image stays decorative (the capsule's title carries the
 * meaning), and the payload stays small enough to ship on every client load.
 *
 * Regenerate the module with `scripts\make-guide-artwork.ps1`, never by hand.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OctopusGuideArtwork } from '../src/client/guide-artwork.tsx'

describe('guide artwork', () => {
  it('embeds a JPEG data URL instead of depending on a fetch', () => {
    const html = renderToStaticMarkup(<OctopusGuideArtwork size={26} />)
    expect(html.startsWith('<img')).toBe(true)
    expect(html).toContain('src="data:image/jpeg;base64,')
  })

  it('draws at the size the platform asks for', () => {
    // 26 while the capsule shows its description, 22 when it does not.
    expect(renderToStaticMarkup(<OctopusGuideArtwork size={26} />)).toContain('width="26"')
    expect(renderToStaticMarkup(<OctopusGuideArtwork size={22} />)).toContain('width="22"')
  })

  it('is decorative, square, and leaves the skin alone', () => {
    const html = renderToStaticMarkup(<OctopusGuideArtwork size={26} className="ink" />)
    expect(html).toContain('alt=""')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('class="ink"')
    expect(html).toMatch(/object-fit:\s*cover/)
    expect(html).toMatch(/border-radius:\s*22%/)
    // No colour of our own: the shell's tokens own the skin.
    expect(html).not.toMatch(/color:/)
  })

  it('keeps the embedded payload small enough to ship on every load', () => {
    const html = renderToStaticMarkup(<OctopusGuideArtwork size={26} />)
    const encoded = /base64,([A-Za-z0-9+/=]+)/.exec(html)?.[1] ?? ''
    // Non-empty (the cube placeholder it replaces would have been), and bounded:
    // a future artwork cannot quietly add megabytes to the client bundle.
    expect(encoded.length).toBeGreaterThan(1_000)
    expect(encoded.length).toBeLessThan(40_000)
  })
})
