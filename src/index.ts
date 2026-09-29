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
 * 1. the plugin writes to exactly ONE thing — the manifest itself, through
 *    `workspace.addFolder`, on an operator gesture after the host's native
 *    directory chooser returned a folder (see manifest-edit.ts). It never writes
 *    inside a declared root, so content in a readOnly root is still protected
 *    structurally rather than by a check that could be bypassed;
 * 2. `workspace.violations` folds the session's own event log and reports write
 *    calls that landed in a readOnly root — whoever performed them — and
 *    `workspace.rollback` best-effort restores them. A manifest edit is not a
 *    model call and never appears in that report; it is auditable in the file and
 *    in the timestamped sidecar backup written next to it.
 *
 * The route passes the same browser-trust fence as the /api gateway:
 * Host-header loopback or the web runtime's `trustedHosts`, read per request
 * from the live service value so the fence tracks the same trust source.
 *
 * `workspace.reveal` is the one method that reaches outside this process: it
 * hands a path INSIDE the active space to the desktop file manager. It is not a
 * file operation — nothing is read or written through it — and it passes the
 * same containment fence as every read, so the active manifest stays the only
 * thing that decides which paths exist for this plugin at all.
 */
import { realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative } from 'node:path'
import type {
  Context, SidebarHttpRequest, SidebarSessionEvent, SidebarSessionPersistenceService,
} from './context-types.ts'
import { listDirectory, parentOf, requireAbsolute, rootLabel } from './fs-tree.ts'
import { addFolderToManifest, removeFolderEntryInManifest, restoreManifestBackup, setFolderAccessInManifest } from './manifest-edit.ts'
import { canRevealNative, revealInvocation, revealNative } from './native-reveal.ts'
import { resolveSessionPath } from './session-path.ts'
import { isTrustedApiRequest } from './trust-fence.ts'
import { readJsonBody, requireString, SidebarError, writeError, writeJson, writeOk } from './wire.ts'
import { ensureWsReadTarget } from './workspace-guards.ts'
import { labelOf, resolveFolderPath, WsManifestError, wsReadBases } from './workspace-policy.ts'
import { DEFAULT_WS_FOLDER_ACCESS, isWsAccess, normalizeWsPath } from './workspace-schema.ts'
import { rollbackWsViolation, scanWsViolations } from './workspace-detector.ts'
import { discoverManifests } from './workspace-discovery.ts'
import { hostCaseInsensitive, snapshotOf, WorkspaceRegistry } from './workspace-state.ts'
import { WORKSPACE_SKILL } from './workspace-skill.ts'
import { createSpaceContext } from './workspace-context.ts'
import { createWorkspaceTool } from './workspace-tool.ts'

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-octopus-operation-space'

/**
 * Services required before mounting: the webserver routes, the session store,
 * the web runtime's trusted hosts, and the tool registry.
 *
 * `tools` is a HARD dependency, not a probe. The trap AGENTS.md §3.1 records for
 * `sidebarRightTabs` applies here identically: a `ctx.get('tools')` that runs
 * before the provider is activated reads `undefined`, the no-op is permanent,
 * and nothing is logged. Every DSH tool plugin declares it the same way, and the
 * base bundle mounts the service — a host without it cannot use this plugin.
 */
export const inject = ['webServer', 'sessions', 'webRuntime', 'tools']

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
 * The `path` value written for a folder the operator picked: relative to the
 * manifest's own directory when it stays inside it (the portable form the
 * plugin's schema documents), absolute otherwise.
 * @param target - canonical absolute path of the picked folder.
 * @param baseDir - the manifest's directory.
 * @returns the value to write into `folders[]`.
 */
function manifestPathValue(target: string, baseDir: string): string {
  const rel = relative(baseDir, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return target
  return rel.replace(/\\/g, '/')
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
      // `canReveal` travels with the snapshot so the client hides the desktop
      // affordance on a host with no file manager, instead of offering a button
      // whose only possible outcome is a failure.
      return {
        workspace: active === undefined ? null : snapshotOf(active),
        canReveal: canRevealNative(),
      }
    },
    // Discovery answers the question `workspace.state` just answered with
    // "nothing", so it must NOT go through `readTargetOf` (which 403s while no
    // space is active). It reads exactly one directory — the session cwd — and
    // returns only claimed manifest files, never a general listing.
    'workspace.discover': async (payload) => {
      const { cwd } = await cwdOf(payload)
      return { cwd, candidates: await discoverManifests(cwd) }
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
    // ── The one route that writes to the user's disk ────────────────────────
    // The client supplies ONLY the directory the operator picked in the host's
    // native chooser. The manifest it lands in is the one this session already
    // activated, so no request can aim the write at a file of its choosing, and
    // the path is checked to be a real directory before anything is written.
    'workspace.addFolder': async (payload) => {
      const { sessionId, cwd } = await cwdOf(payload)
      const active = wsReg.get(sessionId)
      if (active === undefined) {
        throw new SidebarError('forbidden', 'no operation space is active for this session', 403)
      }
      const requestedAccess = (payload as { access?: unknown } | null)?.access
      if (requestedAccess !== undefined && !isWsAccess(requestedAccess)) {
        throw new SidebarError('bad-request', `unknown access "${String(requestedAccess)}"`)
      }
      const requested = requireAbsolute(resolveSessionPath(cwd, requireString(payload, 'path')))
      const info = await stat(requested).catch(() => undefined)
      if (info === undefined || !info.isDirectory()) {
        throw new SidebarError('bad-request', `"${requested}" is not a directory`, 400)
      }
      const canonical = await realpath(requested).catch(() => requested)
      const normalized = normalizeWsPath(canonical, active.ci)
      const declared = active.roots.find(root => normalizeWsPath(root.realPath, active.ci) === normalized)
      if (declared !== undefined) {
        // Already part of the space: an ordinary answer, not a failure.
        return { workspace: snapshotOf(active), added: false, label: declared.label }
      }
      const edit = await addFolderToManifest(active.manifestPath, {
        path: manifestPathValue(canonical, dirname(active.manifestPath)),
        access: requestedAccess ?? DEFAULT_WS_FOLDER_ACCESS,
      })
      // Re-activate with the ORIGINAL timestamp: the violation scan uses it as a
      // time floor, and adding a folder must not hide earlier writes. A policy
      // that cannot be built from the edited file restores the backup, so the
      // operator is never left with a manifest the plugin refuses.
      const rebuilt = await wsReg
        .activate(sessionId, active.manifestPath, cwd, active.ci, active.activatedAt)
        .catch(async (error: unknown) => {
          await restoreManifestBackup(edit.backupPath, active.manifestPath).catch(() => { /* reported below */ })
          throw error
        })
      return {
        workspace: snapshotOf(rebuilt),
        added: true,
        label: labelOf(canonical),
        backup: edit.backupPath,
      }
    },
    // ── The same write point, reached from a row's padlock ──────────────────
    // Clicking the padlock on a declared root asks for the SAME kind of edit as
    // adding a folder does, one entry at a time: the client names a path the
    // snapshot already showed it plus the level it wants, and the host decides
    // which manifest entry that is. A root the manifest does not declare — the
    // session cwd's implicit root — is refused rather than guessed at, because
    // there would be no entry to persist the change in.
    'workspace.setFolderAccess': async (payload) => {
      const { sessionId, cwd } = await cwdOf(payload)
      const active = wsReg.get(sessionId)
      if (active === undefined) {
        throw new SidebarError('forbidden', 'no operation space is active for this session', 403)
      }
      const requestedAccess = (payload as { access?: unknown } | null)?.access
      if (!isWsAccess(requestedAccess)) {
        throw new SidebarError('bad-request', `unknown access "${String(requestedAccess)}"`)
      }
      const requested = requireAbsolute(resolveSessionPath(cwd, requireString(payload, 'path')))
      const normalized = normalizeWsPath(requested, active.ci)
      const target = active.roots.find(root => normalizeWsPath(root.path, active.ci) === normalized
        || normalizeWsPath(root.realPath, active.ci) === normalized)
      if (target === undefined) {
        throw new SidebarError('bad-request', `"${requested}" is not a root of the active operation space`, 400)
      }
      if (!target.listed) {
        throw new SidebarError('bad-request', `"${target.path}" is not declared in the manifest`, 400)
      }
      // The entry is found with the SAME resolution rule the policy used to build
      // this root, so a relative `path` in the manifest still matches its entry.
      const baseDir = dirname(active.manifestPath)
      const matches = (rawPath: string): boolean =>
        normalizeWsPath(resolveFolderPath(rawPath, baseDir), active.ci) === normalized
      const edit = await setFolderAccessInManifest(active.manifestPath, matches, requestedAccess)
        .catch((error: unknown) => {
          if (error instanceof WsManifestError) throw new SidebarError('bad-request', error.message, 400)
          throw error
        })
      if (!edit.changed) {
        // Already declared at that level: an ordinary answer, not a failure — and
        // nothing was written, so there is no backup to report either.
        return { workspace: snapshotOf(active), changed: false, label: target.label }
      }
      // Re-activated with the ORIGINAL timestamp, for the same reason the add
      // route does: the violation scan uses it as a time floor, and changing a
      // permission must not hide (or invent) writes around the moment of change.
      const rebuilt = await wsReg
        .activate(sessionId, active.manifestPath, cwd, active.ci, active.activatedAt)
        .catch(async (error: unknown) => {
          await restoreManifestBackup(edit.backupPath, active.manifestPath).catch(() => { /* reported below */ })
          throw error
        })
      return {
        workspace: snapshotOf(rebuilt),
        changed: true,
        label: target.label,
        backup: edit.backupPath,
      }
    },
    // ── The same write point again, reached from a row's context menu ───────
    // Removing a folder deletes ONE DECLARATION; the folder on disk is never
    // touched. A root the manifest does not declare cannot be removed at all:
    // the schema has no way to say "not this folder", so the implicit cwd root
    // is refused rather than pretended away. (Removing a declared entry that
    // happens to BE the cwd makes the policy append that implicit root again —
    // the answer's snapshot shows it, and the client says so out loud.)
    'workspace.removeFolder': async (payload) => {
      const { sessionId, cwd } = await cwdOf(payload)
      const active = wsReg.get(sessionId)
      if (active === undefined) {
        throw new SidebarError('forbidden', 'no operation space is active for this session', 403)
      }
      const requested = requireAbsolute(resolveSessionPath(cwd, requireString(payload, 'path')))
      const normalized = normalizeWsPath(requested, active.ci)
      const target = active.roots.find(root => normalizeWsPath(root.path, active.ci) === normalized
        || normalizeWsPath(root.realPath, active.ci) === normalized)
      if (target === undefined) {
        throw new SidebarError('bad-request', `"${requested}" is not a root of the active operation space`, 400)
      }
      if (!target.listed) {
        throw new SidebarError('bad-request', `"${target.path}" is not declared in the manifest`, 400)
      }
      const baseDir = dirname(active.manifestPath)
      const matches = (rawPath: string): boolean =>
        normalizeWsPath(resolveFolderPath(rawPath, baseDir), active.ci) === normalized
      const edit = await removeFolderEntryInManifest(active.manifestPath, matches)
        .catch((error: unknown) => {
          if (error instanceof WsManifestError) throw new SidebarError('bad-request', error.message, 400)
          throw error
        })
      // Same rule as the two paths above: re-activate with the ORIGINAL
      // timestamp, so the violation scan's time floor does not move.
      const rebuilt = await wsReg
        .activate(sessionId, active.manifestPath, cwd, active.ci, active.activatedAt)
        .catch(async (error: unknown) => {
          await restoreManifestBackup(edit.backupPath, active.manifestPath).catch(() => { /* reported below */ })
          throw error
        })
      return {
        workspace: snapshotOf(rebuilt),
        changed: true,
        label: target.label,
        backup: edit.backupPath,
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
    // Hand one path inside the active space to the desktop file manager. The
    // fence is the READ fence reused verbatim: `ensureWsReadTarget` realpaths
    // the target (so a symlink cannot smuggle a path out of the space) and
    // requires containment in a declared root before anything is launched.
    'workspace.reveal': async (payload) => {
      const { sessionId, cwd } = await cwdOf(payload)
      const target = await readTargetOf(sessionId, cwd, requireString(payload, 'path'))
      // `stat`, not `lstat`: the target is already canonical, and the row must
      // be told what it is — a directory opens, a file is revealed.
      const info = await stat(target).catch(() => undefined)
      if (info === undefined) {
        throw new SidebarError('fs-error', `cannot read "${target}"`, 400)
      }
      const invocation = revealInvocation(target, info.isDirectory())
      if (invocation === undefined) {
        // Not a failure of the request but of the deployment: no launcher for
        // this platform exists, so the route itself cannot be served here.
        throw new SidebarError('bad-request', 'this host has no desktop file manager', 400)
      }
      await revealNative(invocation)
      return { ok: true, path: target, kind: info.isDirectory() ? 'dir' : 'file' }
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

  // Make the active space MODEL-visible. The tab has always known which absolute
  // path a label like "rw" stands for; this is how the model learns it instead of
  // guessing. The registration sits inside `ctx.effect` and returns the disposer
  // `register` hands back, so unmount and HMR both unregister the tool.
  ctx.effect(
    () => ctx.tools.register(createWorkspaceTool(workspaceRegistry)),
    'octopus: register the operation-space tool',
  )

  // Make the LABELS visible from the first turn, not only when the model thinks to
  // ask. The words a user types ("看一下 VS调试") are the manifest's labels, so a
  // model that has not been shown them cannot resolve one — see workspace-context.ts
  // for why this carries the labels but not the absolute paths.
  //
  // Wrapped in `ctx.inject` rather than named in the plugin-level `inject` array:
  // declaring a base-bundle service there is fatal for an external plugin mounted
  // from the patch layer (AGENTS §3.1, measured in 0.3.1). The `ctx.effect` inside
  // owns the registration, so unmount and HMR both withdraw it, and the
  // contribution is silent for a session with no active space.
  ctx.inject(['systemPrompt'], (scope) => {
    ctx.effect(
      () => scope.systemPrompt.context(createSpaceContext(workspaceRegistry)),
      'octopus: register the operation-space runtime context',
    )
  })

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
