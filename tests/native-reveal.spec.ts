/**
 * The desktop handoff, tested as data.
 *
 * Nothing here starts a process: `revealInvocation` is the whole decision (which
 * program, which argv), and the argv shape is exactly where this feature can go
 * wrong. Every Windows expectation below is one that was measured by launching
 * Explorer and asking the resulting window which item it had selected — a
 * hidden window and a window showing the desktop both still answer COM, so
 * "a window appeared" would have proven nothing.
 */
import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canRevealNative, revealInvocation } from '../src/native-reveal.ts'

/** A folder with a space and a Chinese segment, as real declared roots have. */
const DIR = 'D:\\现场问题\\子 目录'
/** A file inside it. */
const FILE = 'D:\\现场问题\\子 目录\\报告.md'
/** A file whose own name carries Explorer's switch separator. */
const COMMA_FILE = 'D:\\现场问题\\子 目录\\报告,2026.md'

describe('revealInvocation', () => {
  it('opens a Windows directory with the plain path as one argv element', () => {
    expect(revealInvocation(DIR, true, 'win32')).toEqual({ command: 'explorer.exe', args: [DIR] })
  })

  it('reveals a Windows file with /select and the plain path in ONE argument', () => {
    const invocation = revealInvocation(FILE, false, 'win32')
    expect(invocation?.command).toBe('explorer.exe')
    expect(invocation?.args).toHaveLength(1)
    // Joined, not two elements, and the plain path: this is the form a real
    // Explorer window answered with the file as its selected item. A
    // percent-encoded file URL lands on the desktop for a Chinese path, and a
    // quoted path opens Documents — both measured, both wrong.
    expect(invocation?.args[0]).toBe(`/select,${FILE}`)
    expect(invocation?.args).not.toContain('/select,')
    const joined = invocation?.args.join('') ?? ''
    expect(joined).not.toContain('"')
    expect(joined).not.toContain('file:///')
  })

  it('opens the containing directory for a file whose path holds a comma', () => {
    // `/select,` splits its argument on commas and Explorer answers an
    // unresolvable target by showing the desktop, so no selection can be asked
    // for here. The parent directory is the honest fallback.
    expect(revealInvocation(COMMA_FILE, false, 'win32')).toEqual({
      command: 'explorer.exe',
      args: [dirname(COMMA_FILE)],
    })
  })

  it('never builds a command string: the path stays one argv element', () => {
    const invocation = revealInvocation(DIR, true, 'win32')
    expect(invocation?.args).toHaveLength(1)
    // A shell would have needed quoting around the space; argv needs none.
    expect(invocation?.args.join('')).not.toContain('"')
  })

  it('uses Finder reveal on macOS and the parent directory on Linux', () => {
    expect(revealInvocation(DIR, true, 'darwin')).toEqual({ command: 'open', args: [DIR] })
    expect(revealInvocation(FILE, false, 'darwin')).toEqual({ command: 'open', args: ['-R', FILE] })
    expect(revealInvocation(DIR, true, 'linux')).toEqual({ command: 'xdg-open', args: [DIR] })
    // xdg-open has no selection verb, so a file reveals its containing
    // directory. The split itself uses the HOST's path semantics (a Linux host
    // is the only one that reaches this branch), so the expectation asks for
    // the same computation rather than hard-coding a separator.
    expect(revealInvocation(FILE, false, 'linux')).toEqual({ command: 'xdg-open', args: [dirname(FILE)] })
  })

  it('reports no file manager on a platform it does not know', () => {
    expect(revealInvocation(DIR, true, 'freebsd' as NodeJS.Platform)).toBeUndefined()
    expect(canRevealNative('freebsd' as NodeJS.Platform)).toBe(false)
    for (const platform of ['win32', 'darwin', 'linux'] as NodeJS.Platform[]) {
      expect(canRevealNative(platform)).toBe(true)
    }
  })
})
