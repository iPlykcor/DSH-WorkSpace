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
/** The subset of the real `IconProps` the tab passes. */
interface IconProps {
  size?: number
  className?: string
}

/** A stand-in icon: renders nothing (icons are decoration, never behaviour). */
const StubIcon = (_props: IconProps): null => null

/** The six icons the operation-space tab renders with. */
export const IconCloseFillMedium = StubIcon
export const IconFolderCloseMedium = StubIcon
export const IconFolderOpenMedium = StubIcon
export const IconRefreshOutlineMedium = StubIcon
export const PermissionIconFullAccessRegular = StubIcon
export const PermissionIconReadOnlyRegular = StubIcon
