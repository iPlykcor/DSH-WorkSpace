/**
 * dsh-octopus-operation-space host half.
 *
 * One fenced JSON route — `POST /octopus/api/<method>` — carrying the whole
 * multi-root operation space: the per-session active manifest, its read-only
 * violation scan, and the rollback of one detected violation. Directory
 * listing rides the same route (`fs.tree`), scoped to the active operation
 * space's declared roots.
 *
 * Why the plugin needs its own host half at all: DSH's built-in file service
 * is single-root and refuses anything outside the session's one root, which is
 * exactly the constraint an operation space exists to lift.
 *
 * Read-only is enforced in two independent layers:
 * 1. the plugin itself never writes — there is no write route, so the fence is
 *    structural rather than a check that could be bypassed;
 * 2. `workspace.violations` folds the session's own event log and reports write
 *    calls that landed in a readOnly root — whoever performed them — and
 *    `workspace.rollback` best-effort restores them.
 *
 * The route passes the same browser-trust fence as the /api gateway:
 * Host-header loopback or the web runtime's `trustedHosts`, read per request
 * from the live service value so the fence tracks the same trust source.
 */
import type {
  Context, SidebarHttpRequest, SidebarSessionEvent, SidebarSessionPersistenceService,
} from './context-types.ts'
import { listDirectory, parentOf, requireAbsolute, rootLabel } from './fs-tree.ts'
import { isTrustedApiRequest } from './trust-fence.ts'
import { readJsonBody, requireString, SidebarError, writeError, writeJson, writeOk } from './wire.ts'
import { ensureWsReadTarget } from './workspace-guards.ts'
import { WsManifestError, wsReadBases } from './workspace-policy.ts'
import { rollbackWsViolation, scanWsViolations } from './workspace-detector.ts'
import { hostCaseInsensitive, snapshotOf, WorkspaceRegistry } from './workspace-state.ts'
import { WORKSPACE_SKILL } from './workspace-skill.ts'

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-octopus-operation-space'

/** Services required before mounting: the webserver routes, the session store, the web runtime's trusted hosts. */
export const inject = ['webServer', 'sessions', 'webRuntime']

/** The route prefix every method of this plugin hangs under. */
export const API_PREFIX = '/octopus/api'

/** Directory-listing row cap for one level (no config surface by design). */
const LIST_LIMIT = 1000

/** Structural face of the optional skills registry (mirrored, not imported). */
interface SkillsRegistryFace {
  register(skill: unknown): () => void
}

/** One JSON API method. */
type ApiMethod = (payload: unknown) => Promise<unknown> | unknown

/**
 * Resolve a session's authoritative working directory.
 *
 * Precedence: the session header's cwd, then the client-supplied cwd, then the
 * persisted session metadata, then the host process cwd. The client value is
 * only a fallback: trusting it first would let a stale client stamp classify
 * every real path as "outside the operation space".
 * @param ctx - the host plugin context.
 * @param sessionId - the session whose cwd is resolved.
 * @param clientCwd - the cwd the client believes it has, if any.
 * @returns the absolute working directory.
 */
async function sessionCwdOf(ctx: Context, sessionId: string, clientCwd?: string): Promise<string> {
  const session = ctx.sessions.get(sessionId)
  const headerCwd = session?.header.cwd
  if (headerCwd !== undefined && headerCwd !== '') return headerCwd
  if (clientCwd !== undefined && clientCwd !== '') {
    try {
      return requireAbsolute(clientCwd)
    } catch {
      throw new SidebarError('bad-request', `invalid working directory "${clientCwd}"`)
    }
  }
  const persistence = ctx.get('sessionPersistence') as SidebarSessionPersistenceService | undefined
  if (persistence !== undefined) {
    // `stat` is the metadata-only read (it never loads the event log); the
    // stored header it returns is where cwd lives.
    const snapshot = await persistence.stat(sessionId)
    const metaCwd = snapshot?.header.cwd
    if (metaCwd !== undefined && metaCwd !== '') {
      try {
        return requireAbsolute(metaCwd)
      } catch {
        throw new SidebarError('bad-request', `invalid working directory "${metaCwd}"`)
      }
    }
  }
  return process.cwd()
}

/**
 * The session event log the violation scan and the rollback fold: the live
 * snapshot first, then the persisted log for cold sessions.
 * @param ctx - the host plugin context.
 * @param sessionId - the session whose events are read.
 * @returns the event window (empty when the session never persisted).
 */
async function eventsOfSession(
  ctx: Context,
  sessionId: string,
): Promise<readonly SidebarSessionEvent[]> {
  const live = ctx.sessions.get(sessionId)?.snapshotEvents()
  if (live !== undefined) return live
  const persistence = ctx.get('sessionPersistence') as SidebarSessionPersistenceService | undefined
  if (persistence === undefined) return []
  try {
    // Cold session: open a `read` channel onto its stored log. A read handle
    // observes while another process holds `write`, and `close()` is the one
    // teardown. A session that never persisted rejects as not-found, which is
    // an ordinary empty window rather than a failure.
    const handle = await persistence.open(sessionId, 'read')
    try {
      return (await handle.read()).events
    } finally {
      await handle.close().catch(() => { /* teardown only; nothing to recover */ })
    }
  } catch (error) {
    // An advisory report: a session that never persisted, or an unreadable log,
    // yields an empty window rather than failing the request. It must not be
    // SILENT either — an empty report reads as "no writes happened", and that
    // claim cannot be faked just because the log was unreadable. `warn`, not
    // `info`: this is a degraded answer to a trust-relevant question.
    const detail = error instanceof Error ? error.message : String(error)
    ctx.logger?.warn(`[octopus] violation report degraded for "${sessionId}": event log unreadable (${detail})`)
    return []
  }
}

/**
 * Build the JSON API method table.
 * @param ctx - the host plugin context.
 * @param wsReg - the per-session operation-space registry.
 * @returns the method table keyed by the path segment after the route prefix.
 */
function buildApi(ctx: Context, wsReg: WorkspaceRegistry): Record<string, ApiMethod> {
  /** Resolve the session id and its authoritative cwd from one payload. */
  const cwdOf = async (payload: unknown): Promise<{ sessionId: string; cwd: string }> => {
    const sessionId = requireString(payload, 'sessionId')
    const record = payload as { cwd?: unknown } | null
    const clientCwd = typeof record?.cwd === 'string' && record.cwd !== '' ? record.cwd : undefined
    return { sessionId, cwd: await sessionCwdOf(ctx, sessionId, clientCwd) }
  }
  /**
   * Resolve a read target against the ACTIVE operation space. Without one
   * there is nothing to browse: this plugin owns no single-root mode, so an
   * unactivated session is a 403 rather than a fallback to the session cwd.
   */
  const readTargetOf = async (sessionId: string, cwd: string, raw: string): Promise<string> => {
    const active = wsReg.get(sessionId)
    if (active === undefined) {
      throw new SidebarError('forbidden', 'no operation space is active for this session', 403)
    }
    return ensureWsReadTarget(cwd, raw, wsReadBases(active), active.ci)
  }
  return {
    'session.cwd': async (payload) => {
      const { sessionId, cwd } = await cwdOf(payload)
      return { sessionId, cwd, root: rootLabel(cwd), parent: parentOf(cwd) ?? null }
    },
    'fs.tree': async (payload) => {
      const { sessionId, cwd } = await cwdOf(payload)
      const record = payload as { path?: unknown }
      const raw = record.path === undefined ? cwd : requireString(payload, 'path')
      const target = await readTargetOf(sessionId, cwd, raw)
      return listDirectory(target, LIST_LIMIT)
    },
    // ── Active operation space ─────────────────────────────────────────────
    // The authoritative state lives HERE (per session); the client mirrors the
    // snapshot for rendering and re-activates when the host reports none.
    'workspace.state': async (payload) => {
      const { sessionId } = await cwdOf(payload)
      const active = wsReg.get(sessionId)
      return { workspace: active === undefined ? null : snapshotOf(active) }
    },
    'workspace.activate': async (payload) => {
      const { sessionId, cwd } = await cwdOf(payload)
      try {
        const active = await wsReg.activate(sessionId, requireString(payload, 'path'), cwd, hostCaseInsensitive())
        return { workspace: snapshotOf(active), warnings: active.warnings }
      } catch (error) {
        if (error instanceof WsManifestError) {
          throw new SidebarError('bad-request', error.message, 400)
        }
        throw error
      }
    },
    'workspace.deactivate': async (payload) => {
      const { sessionId } = await cwdOf(payload)
      wsReg.deactivate(sessionId)
      return { ok: true }
    },
    'workspace.violations': async (payload) => {
      const { sessionId, cwd } = await cwdOf(payload)
      const active = wsReg.get(sessionId)
      if (active === undefined) return { violations: [] }
      const events = await eventsOfSession(ctx, sessionId)
      return { violations: await scanWsViolations(active, cwd, events) }
    },
    'workspace.rollback': async (payload) => {
      const { sessionId, cwd } = await cwdOf(payload)
      const active = wsReg.get(sessionId)
      if (active === undefined) {
        throw new SidebarError('forbidden', 'no operation space is active for this session', 403)
      }
      const events = await eventsOfSession(ctx, sessionId)
      return rollbackWsViolation(active, cwd, events, requireString(payload, 'callId'))
    },
  }
}

/**
 * Plugin body: register the bundled manifest skill and mount the fenced route.
 * @param ctx - host plugin context (webServer, sessions, webRuntime).
 */
export function apply(ctx: Context): void {
  // Register the bundled manifest runtime skill (if the host has a skills
  // registry): the model then sees it in its skill catalog and knows the
  // format without scanning for an example. Bundled => one deploy.
  const skillsRegistry = ctx.get('skills') as SkillsRegistryFace | undefined
  if (skillsRegistry?.register !== undefined) {
    ctx.effect(() => skillsRegistry.register(WORKSPACE_SKILL), 'octopus: register the operation-space skill')
  }

  const fence = (req: SidebarHttpRequest): boolean => isTrustedApiRequest(req, ctx.webRuntime.trustedHosts)
  const workspaceRegistry = new WorkspaceRegistry((message) => ctx.logger?.info(`[octopus] ${message}`))
  ctx.effect(() => () => workspaceRegistry.dispose(), 'octopus: operation-space registry teardown')
  const api = buildApi(ctx, workspaceRegistry)

  // ── JSON API ────────────────────────────────────────────────────────────
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      if (!fence(req)) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith(`${API_PREFIX}/`)
        ? pathname.slice(API_PREFIX.length + 1)
        : undefined
      if (method === undefined || method.includes('/')) {
        writeError(res, new SidebarError('not-found', 'unknown operation-space API method', 404))
        return
      }
      try {
        const payload = await readJsonBody(req)
        const handler = api[method]
        if (handler === undefined) {
          throw new SidebarError('not-found', `unknown operation-space API method "${method}"`, 404)
        }
        writeOk(res, await handler(payload))
      } catch (error) {
        writeError(res, error)
      }
    },
  }), 'octopus: /octopus/api routes')
}
