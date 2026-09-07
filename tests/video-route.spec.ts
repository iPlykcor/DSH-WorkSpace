import { describe, expect, it } from 'vitest'
import { parseByteRange } from '../src/index.ts'

/**
 * HTTP Range parsing for the streaming /sidebar/video route. The browser
 * requests byte ranges to seek/stream; the host answers 206 (partial) with a
 * Content-Range, 200 (full) when no header, or 416 when unsatisfiable.
 */
describe('parseByteRange (the /sidebar/video streaming route)', () => {
  it('serves the whole resource when no header is present', () => {
    expect(parseByteRange(undefined, 1000)).toEqual({ kind: 'full', start: 0, end: 999 })
  })

  it('serves a partial 206 for a satisfiable range', () => {
    expect(parseByteRange('bytes=100-199', 1000)).toEqual({ kind: 'partial', start: 100, end: 199 })
  })

  it('clamps an open-ended range to the end of the file', () => {
    expect(parseByteRange('bytes=500-', 1000)).toEqual({ kind: 'partial', start: 500, end: 999 })
  })

  it('treats a suffix range as the last N bytes', () => {
    expect(parseByteRange('bytes=-50', 1000)).toEqual({ kind: 'partial', start: 950, end: 999 })
  })

  it('reports unsatisfiable for a start past the end', () => {
    expect(parseByteRange('bytes=2000-', 1000)).toEqual({ kind: 'unsatisfiable' })
  })

  it('reports unsatisfiable for an inverted range', () => {
    expect(parseByteRange('bytes=200-100', 1000)).toEqual({ kind: 'unsatisfiable' })
  })

  it('falls back to the whole resource for a malformed header', () => {
    expect(parseByteRange('chicken', 1000)).toEqual({ kind: 'full', start: 0, end: 999 })
  })

  it('handles an empty file as unsatisfiable', () => {
    expect(parseByteRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' })
  })
})
