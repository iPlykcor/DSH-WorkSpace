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
 * The icons the operation-space tab and its row actions render with. The
 * `PermissionIcon*` pair is gone from both the tab and this stub (the tab draws
 * its own padlock and uses the circled exclamation below), while every name the
 * client half imports must exist here or the named import throws at load time.
 */
export const IconCloseFillMedium = StubIcon
export const IconFolderCloseMedium = StubIcon
export const IconFolderOpenMedium = StubIcon
export const IconFolderOpenOutlineRegular = StubIcon
export const IconRefreshOutlineMedium = StubIcon
export const IconWarningOutlineRegular = StubIcon

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
