/**
 * Test stub for the DSH platform module `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * The plugin consumes that package as a PLATFORM MODULE: it is a peerDependency
 * and the client-bundle purity gate keeps it external, because the host injects
 * it at mount time. Its own transitive dependencies (`clsx`, katex css, …)
 * belong to the HOST's install, not to this repo's dev tree — so importing the
 * real built bundle from a test would make this suite depend on the host's
 * internal dependency graph, and in practice it does not even resolve
 * (`Cannot find package 'clsx'`).
 *
 * `vitest.config.ts` therefore aliases the specifier here. TypeScript still
 * type-checks the JSX against the REAL package's declarations — only the test
 * runtime uses these stand-ins, which is exactly how the host supplies them.
 */
import { createElement, type ReactElement, type ReactNode } from 'react'

/** The subset of the real `IconProps` the tab passes. */
interface IconProps {
  size?: number
  className?: string
}

/** A stand-in icon: renders nothing (icons are decoration, never behaviour). */
const StubIcon = (_props: IconProps): null => null

/**
 * The icons the operation-space tab and its row actions render with. Every name
 * the client half imports must exist here or the named import throws at load
 * time. The `Medium` folder/refresh/close set is gone: the tab now draws the
 * SAME glyphs DSH's built-in 工作区文件 pane draws — `Regular` folders and the
 * product's own `FileTypeIcon` for files — so the stub follows it.
 */
export const IconCloseFillRegular = StubIcon
export const IconFolderCloseRegular = StubIcon
export const IconFolderOpenRegular = StubIcon
export const IconFolderOpenOutlineRegular = StubIcon
export const IconRefreshOutlineRegular = StubIcon
export const IconInfoOutlineRegular = StubIcon

/**
 * Stand-in for the platform's file-type glyph. The real component draws a
 * category-coloured SVG chosen by the product's classifier; a test only needs to
 * know WHICH kind reached it (that is the part this plugin chooses), so the
 * stand-in exposes it as an attribute instead of drawing anything.
 * @param props.kind - the resolved category the tab asked for.
 * @returns a span carrying the kind.
 */
export function FileTypeIcon({ kind }: { kind?: string; path?: string; size?: number }): ReactElement {
  return createElement('span', { 'data-file-type': kind ?? '' })
}

/**
 * Stand-in classifier. The real one is the product's own table of name and
 * extension rules (hundreds of entries); re-implementing it here would test a
 * copy instead of a contract, so every path answers with the fallback category —
 * which is all a row test needs.
 * @returns the fallback category.
 */
export function classifyFileType(_path: string, _context?: unknown): string {
  return 'other'
}

/**
 * Stand-in for the platform path label. The real component splits a path into
 * subdued directories and a primary filename and owns its own tooltip; a test
 * only needs the exact path the pane put in its header, so the stand-in renders
 * it as text and as an attribute.
 * @param props.path - the absolute path to show.
 * @returns the label.
 */
export function PathLabel({ path }: { path: string; className?: string; style?: unknown }): ReactElement {
  return createElement('span', { 'data-path-label': path }, path)
}

/**
 * Stand-in for the platform Tooltip. The real component renders a
 * fixed-position bubble (and needs a DOM); a test only needs to know WHICH label
 * the badge handed it, so this renders the anchor and exposes the label as a
 * data attribute — which is exactly the part of the contract this plugin owns.
 * @param props.label - bubble text, or the resolver the real component evaluates while visible.
 * @param props.children - the single anchor element.
 * @returns the anchor, carrying the label for assertions.
 */
export function Tooltip({ label, children }: {
  label?: string | (() => string) | undefined
  children?: ReactNode | undefined
}): ReactElement {
  const text = typeof label === 'function' ? label() : label
  return createElement('span', { 'data-tooltip-label': text ?? '' }, children)
}
