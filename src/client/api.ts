/**
 * Typed fetch wrapper over this plugin's JSON API. Every call posts to
 * `/octopus/api/<method>` with the sessionId and — when known — the session's
 * cwd from the client's own list summary. The host prefers its attached
 * session header and uses the summary cwd only while the session is still
 * hydrating at page load (a detached session would otherwise fail the
 * request). Failures surface as {@link SidebarApiError} with the wire code.
 */

/** The route prefix every method hangs under (mirror of `API_PREFIX` in src/index.ts). */
const API_PREFIX = '/octopus/api'

/** One wire failure. */
export class SidebarApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** One request's session scope: the conversation id plus its cwd when known. */
export interface SessionScope {
  sessionId: string
  /** The session's working directory from the client list summary (optional). */
  cwd?: string
}

/** One directory-listing row (host fs-tree shape). */
export interface FsEntry {
  name: string
  path: string
  isDir: boolean
  hidden: boolean
  /** Whether the row is a symlink; `isDir` then describes the link's target. */
  isSymlink: boolean
  /** For symlinks: the target is missing or unreadable (stat failed). */
  broken: boolean
}

/** Write access of one declared root. */
export type WsAccess = 'readWrite' | 'readOnly'

/** One resolved root of the active operation space (host snapshot shape). */
export interface WorkspaceRootSnapshot {
  /** Lexical absolute path of the root. */
  path: string
  /** Display label (folder name override, else the base name). */
  label: string
  access: WsAccess
  /** Whether the canonical directory currently exists. */
  exists: boolean
  /** False = the implicit session-cwd root the host appended. */
  listed: boolean
}

/** The active operation-space snapshot (workspace.state / workspace.activate). */
export interface WorkspaceSnapshot {
  manifestPath: string
  name: string
  /** The session cwd this operation space was built from. */
  cwd: string
  /** Path-match case folding on this host (win32 true). */
  ci: boolean
  roots: WorkspaceRootSnapshot[]
  /** Activation timestamp (epoch ms). */
  activatedAt: number
}

/** One model write that landed in a read-only root (workspace.violations). */
export interface WorkspaceViolation {
  callId: string
  kind: 'write' | 'edit'
  /** Absolute display path of the written file. */
  path: string
  /** Label of the read-only root it landed in. */
  rootLabel: string
  time: number
  canRestore: boolean
}

/**
 * Parse one JSON response envelope into its value. A non-ok status, an
 * unparseable body, or any shape other than `{ok: true, value}` surfaces as
 * {@link SidebarApiError} carrying the wire code (falling back to the HTTP
 * status).
 * @param response - the fetch response.
 * @returns the unwrapped value.
 */
async function readEnvelope<T>(response: Response): Promise<T> {
  const parsed: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } } | null
    = await response.json().catch(() => null)
  if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
    throw new SidebarApiError(
      parsed?.error?.code ?? 'http',
      parsed?.error?.message ?? `HTTP ${response.status}`,
    )
  }
  return parsed.value as T
}

/**
 * POST one method and unwrap its envelope.
 * @param method - the path segment after the route prefix.
 * @param payload - the JSON body.
 * @param signal - optional abort signal.
 * @returns the unwrapped value.
 */
async function call<T>(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_PREFIX}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    })
  } catch (error) {
    throw new SidebarApiError('network', error instanceof Error ? error.message : String(error))
  }
  return readEnvelope<T>(response)
}

/**
 * Fold a scope into a JSON payload ({cwd} only when present).
 * @param scope - the session scope.
 * @param extra - the method's own fields.
 * @returns the request body.
 */
function scopePayload(scope: SessionScope, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    sessionId: scope.sessionId,
    ...(scope.cwd !== undefined && scope.cwd !== '' ? { cwd: scope.cwd } : {}),
    ...extra,
  }
}

/** The operation-space API surface (session scope threaded through every call). */
export const api = {
  sessionCwd: (scope: SessionScope, signal?: AbortSignal) =>
    call<{ sessionId: string; cwd: string; root: string; parent: string | null }>('session.cwd', scopePayload(scope, {}), signal),
  fsTree: (scope: SessionScope, path: string, signal?: AbortSignal) =>
    call<{ path: string; entries: FsEntry[]; truncated: boolean }>('fs.tree', scopePayload(scope, { path }), signal),
  /** The session's active operation space (null = none activated). */
  workspaceState: (scope: SessionScope, signal?: AbortSignal) =>
    call<{ workspace: WorkspaceSnapshot | null }>('workspace.state', scopePayload(scope, {}), signal),
  /** Activate a manifest file (`.dsh-octopus`, or the `.dsh-workspace` alias) for the session. */
  workspaceActivate: (scope: SessionScope, path: string) =>
    call<{ workspace: WorkspaceSnapshot; warnings: string[] }>('workspace.activate', scopePayload(scope, { path })),
  /** Drop the session's active operation space. */
  workspaceDeactivate: (scope: SessionScope) =>
    call<{ ok: true }>('workspace.deactivate', scopePayload(scope, {})),
  /** Writes that landed in read-only roots since activation. */
  workspaceViolations: (scope: SessionScope, signal?: AbortSignal) =>
    call<{ violations: WorkspaceViolation[] }>('workspace.violations', scopePayload(scope, {}), signal),
  /** Best-effort restore of one violation (user-invoked). */
  workspaceRollback: (scope: SessionScope, callId: string) =>
    call<{ ok: boolean; message: string }>('workspace.rollback', scopePayload(scope, { callId })),
}
