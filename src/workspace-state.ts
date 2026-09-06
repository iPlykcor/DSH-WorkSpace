/**
 * Per-session active-workspace registry (host half). One {@link ActiveWorkspace}
 * per session id, built by reading + validating the `.dsh-workspace` manifest
 * the client activated. Route guards ask `get(sessionId)` and fall back to
 * the legacy single-cwd behavior when undefined. Not durable by design: after
 * a host restart the client re-activates from its persisted snapshot
 * (SidebarState.workspace.manifestPath) — the manifest file stays the single
 * source of truth.
 */
import { requireAbsolute } from './fs-tree.ts'
import { resolveSessionPath } from './session-path.ts'
import {
  buildWorkspaceFromFile, type ActiveWorkspace, type WsRootView,
} from './workspace-policy.ts'
import type { DshWorkspaceAccess } from './workspace-schema.ts'

/** One snapshot root the client renders (policy facts, no host internals). */
export interface WsRootSnapshot {
  path: string
  label: string
  access: DshWorkspaceAccess
  exists: boolean
  listed: boolean
}

/** The wire snapshot of an active workspace (stored by the client). */
export interface WsSnapshot {
  manifestPath: string
  name: string
  /** The session cwd this workspace was built from. */
  cwd: string
  /** Case folding used by path matching on this host (win32 true). */
  ci: boolean
  roots: WsRootSnapshot[]
  /** Activation timestamp (epoch ms) — client display only. */
  activatedAt: number
}

/** Flatten an active workspace into its wire snapshot. */
export function snapshotOf(workspace: ActiveWorkspace): WsSnapshot {
  const rootOf = (root: WsRootView): WsRootSnapshot => ({
    path: root.path,
    label: root.label,
    access: root.access,
    exists: root.exists,
    listed: root.listed,
  })
  return {
    manifestPath: workspace.manifestPath,
    name: workspace.name,
    cwd: workspace.cwd,
    ci: workspace.ci,
    roots: workspace.roots.map(rootOf),
    activatedAt: workspace.activatedAt,
  }
}

/** Whether this host folds path case (Windows). */
export function hostCaseInsensitive(): boolean {
  return process.platform === 'win32'
}

/**
 * The registry. Created once per plugin mount; disposed on unmount so HMR
 * never leaks stale workspaces.
 */
export class WorkspaceRegistry {
  private readonly bySession = new Map<string, ActiveWorkspace>()

  constructor(private readonly log: (message: string) => void) {}

  /** The active workspace of a session, or undefined (legacy single root). */
  get(sessionId: string): ActiveWorkspace | undefined {
    return this.bySession.get(sessionId)
  }

  /**
   * Activate (or re-activate) a manifest for a session. `path` is resolved in
   * the session namespace first; the file is read, parsed and validated into
   * a policy, then stored. Throws `WsManifestError` / `SidebarError` for
   * invalid input — the session keeps its previous workspace (if any) on a
   * failed activation, so a bad edit never silently drops the active setup.
   */
  async activate(sessionId: string, path: string, cwd: string, ci: boolean): Promise<ActiveWorkspace> {
    const absolute = requireAbsolute(resolveSessionPath(cwd, path))
    const workspace = (await buildWorkspaceFromFile(absolute, cwd, ci, this.log)).workspace
    this.bySession.set(sessionId, workspace)
    this.log(`activate session=${sessionId} file="${absolute}" roots=${workspace.roots.map(r => `${r.label}(${r.access}${r.exists ? '' : ',missing'})`).join(', ')}`)
    return workspace
  }

  /** Drop the active workspace of a session (back to the legacy single root). */
  deactivate(sessionId: string): void {
    if (this.bySession.delete(sessionId)) this.log(`deactivate session=${sessionId}`)
  }

  /** Drop every workspace (plugin teardown). */
  dispose(): void {
    if (this.bySession.size > 0) {
      this.log(`dispose: cleared ${this.bySession.size} active workspace(s)`)
      this.bySession.clear()
    }
  }
}
