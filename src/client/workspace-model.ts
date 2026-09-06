/**
 * Client-side read-only lookup for an active multi-root workspace. The HOST
 * policy is authoritative (route guards 403); this module only mirrors the
 * longest-prefix decision so the tree UI can lock rows, gate menus and gate
 * drops without a round trip. The functions accept any structurally matching
 * snapshot (the persisted SidebarWorkspaceState or the wire
 * WorkspaceSnapshot), so no client module needs to import the host types.
 */
import type { WsAccess } from './api.ts'

/** The minimal snapshot shape the matchers need. */
export interface WsLike {
  /** Path-match case folding on this host (win32 true). */
  ci: boolean
  roots: readonly { path: string; access: WsAccess }[]
}

/** Normalize a path for matching (both separators; optional case fold). */
function norm(path: string, ci: boolean): string {
  const value = path.replace(/[\\/]+/g, '/').replace(/\/+$/, '') || '/'
  return ci ? value.toLowerCase() : value
}

/** The index of the root that longest-prefix-matches `path`, or -1. */
export function wsRootIndexOf(path: string, workspace: WsLike): number {
  const target = norm(path, workspace.ci)
  const roots = workspace.roots
  let best = -1
  let bestLen = -1
  for (let i = 0; i < roots.length; i += 1) {
    const root = norm(roots[i]!.path, workspace.ci)
    if (target === root || target.startsWith(`${root}/`)) {
      if (root.length > bestLen) {
        best = i
        bestLen = root.length
      }
    }
  }
  return best
}

/** The winning root of `path`, or undefined when it lies outside every root. */
export function wsRootOf(path: string, workspace: WsLike): { path: string; access: WsAccess } | undefined {
  const index = wsRootIndexOf(path, workspace)
  return index === -1 ? undefined : workspace.roots[index]
}

/** Whether `path` lives inside a read-only root (or IS a read-only root). */
export function isWsLockedPath(path: string, workspace: WsLike): boolean {
  return wsRootOf(path, workspace)?.access === 'readOnly'
}

/** The access of one exact root path (used for the root header lock badge). */
export function wsRootAccess(path: string, workspace: WsLike): WsAccess | undefined {
  const target = norm(path, workspace.ci)
  for (const root of workspace.roots) {
    if (norm(root.path, workspace.ci) === target) return root.access
  }
  return undefined
}
