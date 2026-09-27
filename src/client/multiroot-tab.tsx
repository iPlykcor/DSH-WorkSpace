/**
 * The operation-space tab in DSH's BUILT-IN right Sidebar.
 *
 * One tab type (`octopusOperationSpace`) contributed through
 * `ctx.sidebarRightTabs` + the two keyed slot seats. The body shows the
 * session's ACTIVE operation space: its declared roots with their read/write
 * permission, an expanding directory tree, the read-only write report, and the
 * apply/deactivate controls.
 *
 * FILE OPENING IS DELEGATED, NOT REIMPLEMENTED. Clicking a file hands a
 * `dsh-resource://file/session/…` address to the Sidebar's own navigation, and
 * DSH's document-preview tab renders it (text, markdown, code, images, PDF,
 * Office, Excel). This works uniformly for every declared root — including
 * folders outside the session workspace — because the host's file route
 * resolves absolute paths in and outside the workspace. That is exactly why
 * this plugin carries no viewer, no byte route and no media handling: the one
 * thing the product could not do when this feature was first written (address
 * a file outside the single session root) it can do now. See
 * ./file-address.ts for the address grammar and how it is pinned.
 *
 * THE DESKTOP HANDOFF IS THE ONE THING NEITHER READ NOR DELEGATED. A hover-only
 * action on every row hands that row's own path to the desktop file manager
 * (`workspace.reveal`): a directory opens, a file is revealed. DSH's built-in
 * open-in-app control cannot serve this — its directory entry is bound to the
 * session cwd — so the host spawns the launcher itself, behind the same
 * containment fence as every read. See ./reveal-button.tsx and
 * ../native-reveal.ts.
 *
 * WHY THE STATE MIRROR EXISTS: the host's per-session registry is in memory, so
 * a host restart empties it. The host is authoritative whenever it reports a
 * workspace; this plugin's own localStorage key exists only to re-activate the
 * manifest the user had applied after such a restart.
 */
import {
  IconCloseFillMedium,
  IconFolderCloseMedium,
  IconFolderOpenMedium,
  IconRefreshOutlineMedium,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useRef, useState, type FocusEvent, type ReactNode } from 'react'
import type { Context, SidebarRightFace, SidebarRightTabsFace } from '../context-types.ts'
import {
  api,
  type FsEntry, type ManifestCandidate, type SessionScope, type WorkspaceSnapshot, type WorkspaceViolation,
} from './api.ts'
import { decideDiscovery } from './discovery-decision.ts'
import { sessionFileAddress } from './file-address.ts'
import { t } from './locales.ts'
import { RevealButton } from './reveal-button.tsx'
import { RootRowMarkers } from './root-markers.tsx'

/** Tab type identity: `id` keys the two slot seats, `kind` is what opens it. */
const TAB_ID = 'octopus-operation-space'

/** The page kind users open (a page type: no `patterns`, so it is opened by kind). */
const TAB_KIND = 'octopusOperationSpace'

/** Left indent per tree depth (px). */
const INDENT = 12

/** Read-only write report refresh cadence (ms). */
const VIOLATION_POLL_MS = 5_000

/** This plugin's own persisted-manifest key prefix (per session). */
const STORAGE_PREFIX = 'dsh-octopus:v1:'

/** Inline row styles shared by the tree (no CSS module reaches this surface). */
const rowBase = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  height: 24,
  fontSize: 13,
  color: 'var(--dsw-alias-label-primary)',
} as const

/** A tooltip/text error message from any thrown value. */
function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

/**
 * The manifest this session last activated, from this plugin's own mirror.
 * @param sessionId - the session whose manifest is read.
 * @returns the manifest path, or undefined when nothing usable is stored.
 */
function persistedManifestPath(sessionId: string): string | undefined {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${sessionId}`)
    return raw === null || raw === '' ? undefined : raw
  } catch {
    return undefined
  }
}

/**
 * Mirror the active manifest for post-restart re-activation.
 * @param sessionId - the session to remember it for.
 * @param manifestPath - the manifest's absolute path.
 */
function rememberManifest(sessionId: string, manifestPath: string): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${sessionId}`, manifestPath)
  } catch {
    // Storage unavailable (private mode/quota): restore-after-restart is a
    // convenience, never a correctness requirement.
  }
}

/**
 * Forget a session's mirrored manifest (deactivated, or the file is gone).
 * @param sessionId - the session to forget.
 */
function forgetManifest(sessionId: string): void {
  try {
    localStorage.removeItem(`${STORAGE_PREFIX}${sessionId}`)
  } catch {
    // See rememberManifest.
  }
}

/**
 * Register the operation-space tab into the built-in right Sidebar.
 * @param ctx - the client cordis context.
 * @returns a disposer unregistering the type, body and title.
 */
export function registerMultiRootTab(ctx: Context): () => void {
  // Belt-and-braces probe on top of the `sidebarRightTabs` dependency declared
  // by the client entry. By the time apply runs the service exists, so this
  // guard only matters for a host that lacks the 0.1.5 extension points
  // entirely (where `ctx.get` returns undefined but direct property access
  // would throw). It must never be the ONLY gate: a probe that happens to run
  // before the providing plugin activates registers nothing and never retries.
  const tabs = ctx.get('sidebarRightTabs') as SidebarRightTabsFace | undefined
  if (tabs === undefined) return () => {}

  const body = ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: TAB_ID,
  }, makeBody(ctx)))
  const title = ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title',
    key: TAB_ID,
  }, OperationSpaceTitle))
  const type = tabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    priority: 'extension',
    title: () => t('operationSpace'),
    guide: [{ order: 20, title: () => t('operationSpace') }],
  })
  return () => { type(); body(); title() }
}

/** The tab chip label. */
function OperationSpaceTitle(): ReactNode {
  return <span>{t('operationSpace')}</span>
}

/** Props DSH passes to a `sidebar.right.pane.tab` body (the subset this tab reads). */
interface BodyProps {
  /** The Session this tab lives in; DSH supplies it and it follows session switches. */
  sessionId?: string
}

/**
 * Build the tab body bound to the plugin context.
 * @param ctx - the client cordis context.
 * @returns the body component.
 */
function makeBody(ctx: Context): (props: BodyProps) => ReactNode {
  return function OperationSpaceBody(props: BodyProps): ReactNode {
    // Session source: the prop DSH injects tracks the tab's own session; the
    // client list is the fallback for a host that does not pass it, and its
    // snapshot also carries the cwd the host needs for a still-hydrating
    // session. Holding the whole snapshot keeps `cwd` correct across switches.
    const [list, setList] = useState(() => ctx.sessions.list.getSnapshot())
    useEffect(() => ctx.sessions.list.subscribe(() => { setList(ctx.sessions.list.getSnapshot()) }), [])
    const sessionId = props.sessionId ?? list.current
    const cwd = sessionId === undefined ? undefined : list.byId[sessionId]?.cwd

    /** The active operation space; undefined = still loading, null = none applied. */
    const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null | undefined>(undefined)
    /** Whether this host can hand a path to a desktop file manager at all. */
    const [canReveal, setCanReveal] = useState(false)
    /**
     * The one row whose hover (or focus) reveals its desktop action. A single
     * value for the whole tree rather than per-row state: the action is
     * hover-only, and per-row state would re-render every row on each move.
     */
    const [activeRow, setActiveRow] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [notice, setNotice] = useState<string | null>(null)
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
    const [children, setChildren] = useState<ReadonlyMap<string, readonly FsEntry[]>>(new Map())
    const [manifestInput, setManifestInput] = useState('')
    const [violations, setViolations] = useState<readonly WorkspaceViolation[]>([])
    const [violationsOpen, setViolationsOpen] = useState(false)
    /** Manifests found in the session cwd; undefined = not scanned yet. */
    const [candidates, setCandidates] = useState<readonly ManifestCandidate[] | undefined>(undefined)
    const [scanning, setScanning] = useState(false)

    const scope: SessionScope = {
      sessionId: sessionId ?? '',
      ...(cwd !== undefined && cwd !== '' ? { cwd } : {}),
    }

    // Latest session id, readable from an async callback that outlived its own
    // render: a discovery answer must never apply one session's manifest to a
    // different session after a switch.
    const sessionIdRef = useRef(sessionId)
    useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])

    // Poll the read-only write report while a space is active. The host scans
    // the session event log, so nothing here depends on who performed the write.
    const activeManifest = workspace === undefined || workspace === null ? undefined : workspace.manifestPath
    useEffect(() => {
      if (sessionId === undefined || sessionId === '' || activeManifest === undefined) {
        setViolations([])
        return
      }
      let cancelled = false
      const sessionScope: SessionScope = { sessionId, ...(cwd !== undefined && cwd !== '' ? { cwd } : {}) }
      const load = (): void => {
        void api.workspaceViolations(sessionScope)
          .then((result) => { if (!cancelled) setViolations(result.violations) })
          .catch(() => { /* transient host error: keep the last report on screen */ })
      }
      load()
      const timer = setInterval(load, VIOLATION_POLL_MS)
      return () => { cancelled = true; clearInterval(timer) }
    }, [sessionId, cwd, activeManifest])

    /**
     * Activate (or re-activate) one manifest file and reset the tree.
     * `useCallback`, not a plain function, because the load effect below applies
     * a DISCOVERED manifest through it — the dependency array is what keeps
     * react-hooks/exhaustive-deps satisfied without a blanket disable comment.
     * The scope is rebuilt from `sessionId`/`cwd` rather than closing over the
     * render's `scope` object: that object is new on every render, so depending
     * on it would re-create this callback each render and re-run that effect
     * forever.
     */
    const applyManifest = useCallback((path: string): void => {
      if (sessionId === undefined || sessionId === '') return
      const target: SessionScope = { sessionId, ...(cwd !== undefined && cwd !== '' ? { cwd } : {}) }
      setError(null)
      setNotice(null)
      void api.workspaceActivate(target, path)
        .then((result) => {
          setWorkspace(result.workspace)
          setExpanded(new Set())
          setChildren(new Map())
          rememberManifest(sessionId, result.workspace.manifestPath)
          setNotice(t('workspaceApplied'))
        })
        .catch((failure: unknown) => { setError(t('workspaceApplyFailed', { message: messageOf(failure) })) })
    }, [sessionId, cwd])

    /**
     * Scan the session cwd (one level) for manifests and carry out
     * {@link decideDiscovery}'s verdict. The rule itself — which single manifest
     * may be applied without asking — lives in ./discovery-decision.ts, where it
     * is tested; this function only wires it to the view.
     * @param sessionScope - the scope this scan belongs to.
     */
    const scan = useCallback((sessionScope: SessionScope): void => {
      const isCurrent = (): boolean => sessionIdRef.current === sessionScope.sessionId
      setScanning(true)
      void api.workspaceDiscover(sessionScope)
        .then((result) => {
          // A scan outlives a session switch; a stale answer must not apply one
          // session's manifest to another.
          if (!isCurrent()) return
          setScanning(false)
          setCandidates(result.candidates)
          const decision = decideDiscovery(result.candidates)
          if (decision.kind === 'apply') { applyManifest(decision.path); return }
          if (decision.autoOff) setNotice(t('scanAutoOff'))
          setWorkspace(null)
        })
        .catch((failure: unknown) => {
          if (!isCurrent()) return
          setScanning(false)
          setCandidates([])
          setWorkspace(null)
          setError(messageOf(failure))
        })
    }, [applyManifest, sessionIdRef])

    // Load the session's active operation space. When the host has none (a host
    // restart emptied its in-memory registry) re-activate from this plugin's own
    // mirror — the host wins whenever it has state, so this never overrides it.
    // Only when there is neither host state nor a usable mirror does the tab
    // discover a manifest in the session cwd, which is what makes simply opening
    // this tab enough to apply one.
    // Declared AFTER `scan` on purpose: the IIFE below runs immediately, so a
    // later declaration would be a temporal-dead-zone read (TS2448), not a
    // harmless forward reference.
    useEffect(() => {
      if (sessionId === undefined || sessionId === '') { setWorkspace(null); return }
      let cancelled = false
      const sessionScope: SessionScope = { sessionId, ...(cwd !== undefined && cwd !== '' ? { cwd } : {}) }
      /** Whether this run is still the live one (its session and cwd unchanged). */
      const live = (): boolean => !cancelled
      setWorkspace(undefined)
      setError(null)
      setNotice(null)
      setCandidates(undefined)
      setScanning(false)
      setExpanded(new Set())
      setChildren(new Map())
      setViolations([])
      setViolationsOpen(false)
      setCanReveal(false)
      setActiveRow(null)
      void (async () => {
        try {
          const result = await api.workspaceState(sessionScope)
          if (!live()) return
          setCanReveal(result.canReveal)
          if (result.workspace !== null) { setWorkspace(result.workspace); return }
          const manifestPath = persistedManifestPath(sessionId)
          if (manifestPath !== undefined) {
            try {
              const activated = await api.workspaceActivate(sessionScope, manifestPath)
              if (!live()) return
              setWorkspace(activated.workspace)
              return
            } catch {
              // A mirror whose file no longer applies is stale: forget it and
              // fall through to discovery rather than surfacing an error.
              if (!live()) return
              forgetManifest(sessionId)
            }
          }
          if (!live()) return
          scan(sessionScope)
        } catch (failure: unknown) {
          if (!live()) return
          setWorkspace(null)
          setError(messageOf(failure))
        }
      })()
      // `scan` is a `useCallback` whose identity changes only with sessionId/cwd,
      // so listing it here cannot re-run this effect on its own.
      return () => { cancelled = true }
    }, [sessionId, cwd, scan])

    /** Leave the operation space (back to DSH's ordinary single root). */
    const deactivate = (): void => {
      if (sessionId === undefined || sessionId === '') return
      setError(null)
      setNotice(null)
      void api.workspaceDeactivate(scope)
        .then(() => {
          forgetManifest(sessionId)
          setWorkspace(null)
          setExpanded(new Set())
          setChildren(new Map())
          setViolations([])
        })
        .catch((failure: unknown) => { setError(messageOf(failure)) })
    }

    /** Re-read the manifest file: it is the single source of truth. */
    const refresh = (): void => {
      if (activeManifest === undefined) return
      applyManifest(activeManifest)
    }

    /** Best-effort restore of one detected read-only write. */
    const rollback = (callId: string): void => {
      void api.workspaceRollback(scope, callId)
        .then((result) => {
          if (!result.ok) { setError(result.message); return }
          setViolations((current) => current.filter((item) => item.callId !== callId))
        })
        .catch((failure: unknown) => { setError(messageOf(failure)) })
    }

    /** Fetch one directory level into the child map. */
    const loadChildren = (path: string): void => {
      void api.fsTree(scope, path)
        .then((listing) => { setChildren((current) => new Map(current).set(path, listing.entries)) })
        .catch((failure: unknown) => { setError(messageOf(failure)) })
    }

    /** Expand/collapse one directory, fetching its level on first expand. */
    const toggle = (path: string): void => {
      setExpanded((current) => {
        const next = new Set(current)
        if (next.has(path)) { next.delete(path); return next }
        next.add(path)
        return next
      })
      if (!children.has(path)) loadChildren(path)
    }

    /**
     * Delegate file viewing to DSH: hand the Sidebar a resource address and let
     * its document-preview tab render the file. The plugin owns no viewer.
     * @param path - absolute path of the clicked file.
     * @param line - optional 1-based line to reveal.
     */
    const openFile = (path: string, line?: number): void => {
      if (sessionId === undefined || sessionId === '') return
      const nav = ctx.get('sidebarRight') as SidebarRightFace | undefined
      if (nav === undefined) { setError(t('openUnavailable')); return }
      try {
        nav.openResource(
          sessionFileAddress(sessionId, path),
          line === undefined ? undefined : { params: { line } },
        )
      } catch (failure) {
        setError(messageOf(failure))
      }
    }

    /**
     * Hand one row's path to the desktop file manager. A failure is reported
     * where every other failure in this tab is reported: an action that cannot
     * work must say so rather than look like a dead icon.
     * @param path - the row's absolute path.
     */
    const reveal = (path: string): void => {
      if (sessionId === undefined || sessionId === '') return
      const target: SessionScope = { sessionId, ...(cwd !== undefined && cwd !== '' ? { cwd } : {}) }
      void api.workspaceReveal(target, path)
        .catch((failure: unknown) => { setError(t('workspaceRevealFailed', { message: messageOf(failure) })) })
    }

    /**
     * Hover/focus plumbing for the hover-only reveal action. Focus has to show
     * it too, or the action would be keyboard-unreachable; the blur handler asks
     * whether focus stayed INSIDE the row, because moving it from the row button
     * onto the action button must not hide the button being reached.
     * @param path - the row's path.
     * @returns the handlers a row wrapper spreads.
     */
    const rowActivity = (path: string): {
      onMouseEnter: () => void
      onMouseLeave: () => void
      onFocus: () => void
      onBlur: (event: FocusEvent<HTMLDivElement>) => void
    } => ({
      onMouseEnter: () => { setActiveRow(path) },
      onMouseLeave: () => { setActiveRow((current) => (current === path ? null : current)) },
      onFocus: () => { setActiveRow(path) },
      onBlur: (event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setActiveRow((current) => (current === path ? null : current))
      },
    })

    /** Render one directory's children (indented by depth). */
    const renderRows = (parent: string, depth: number): ReactNode => {
      const entries = children.get(parent)
      if (entries === undefined) {
        return <div style={{ ...rowBase, paddingLeft: 10 + depth * INDENT, fontSize: 12, opacity: 0.6 }}>{t('loading')}</div>
      }
      if (entries.length === 0) {
        return <div style={{ ...rowBase, paddingLeft: 10 + depth * INDENT, fontSize: 12, opacity: 0.5 }}>{t('emptyFolder')}</div>
      }
      return entries.map((entry) => {
        const open = expanded.has(entry.path)
        return (
          <div key={entry.path} style={{ ...rowBase, width: '100%' }} {...rowActivity(entry.path)}>
            <button
              type="button"
              title={entry.path}
              aria-expanded={entry.isDir ? open : undefined}
              style={{
                ...rowBase,
                flex: 1, minWidth: 0, border: 0, background: 'transparent', cursor: 'pointer', textAlign: 'left',
                paddingLeft: 10 + depth * INDENT, opacity: entry.broken ? 0.5 : 1,
              }}
              onClick={() => { if (entry.isDir) toggle(entry.path); else openFile(entry.path) }}
            >
              {entry.isDir
                ? (open ? <IconFolderOpenMedium size={14} /> : <IconFolderCloseMedium size={14} />)
                : <span style={{ width: 14, flex: 'none' }} />}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</span>
              {entry.isSymlink && <span style={{ fontSize: 11, opacity: 0.5 }}>↗</span>}
            </button>
            {/* A broken link has no target to hand to the desktop, and the host
                would refuse it anyway: the row simply offers no action. */}
            {canReveal && !entry.broken && (
              <RevealButton
                path={entry.path}
                label={entry.isDir ? t('workspaceOpenFolder') : t('workspaceShowFile')}
                onReveal={reveal}
                visible={activeRow === entry.path}
              />
            )}
          </div>
        )
      })
    }

    if (sessionId === undefined || sessionId === '' || workspace === undefined) {
      return <div style={{ padding: 12, fontSize: 13, opacity: 0.7, color: 'var(--dsw-alias-label-primary)' }}>{t('loading')}</div>
    }
    if (workspace === null) {
      return (
        <div style={{ padding: 12, fontSize: 13, color: 'var(--dsw-alias-label-primary)' }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{t('operationSpace')}</div>
          <div style={{ opacity: 0.75, marginBottom: 10, lineHeight: 1.5 }}>{t('noWorkspace')}</div>
          {/* Auto-detection: opening this tab already scanned the session cwd,
              so a manifest sitting there needs no hand-typed path. The input
              below stays as the fallback for one that lives elsewhere. */}
          {scanning && <div style={{ opacity: 0.7, marginBottom: 10 }}>{t('scanning')}</div>}
          {!scanning && candidates !== undefined && (candidates.length === 0
            ? <div style={{ opacity: 0.6, marginBottom: 10 }}>{t('scanNone')}</div>
            : (
              <div style={{ marginBottom: 10 }}>
                <div style={{ opacity: 0.75, marginBottom: 6 }}>
                  {candidates.length === 1 ? t('scanOne') : t('scanPick', { n: candidates.length })}
                </div>
                {candidates.map((candidate) => (
                  <button
                    key={candidate.path}
                    type="button"
                    title={candidate.path}
                    onClick={() => { applyManifest(candidate.path) }}
                    style={{
                      ...rowBase,
                      width: '100%', border: 0, background: 'transparent', textAlign: 'left',
                      cursor: candidate.error === undefined ? 'pointer' : 'default',
                      paddingLeft: 2, opacity: candidate.error === undefined ? 1 : 0.6,
                    }}
                  >
                    <IconFolderOpenMedium size={14} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {candidate.name}
                    </span>
                    {candidate.name !== candidate.fileName && (
                      <span style={{ fontSize: 11, opacity: 0.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {candidate.fileName}
                      </span>
                    )}
                    {candidate.error !== undefined && (
                      <span style={{ marginLeft: 'auto', fontSize: 11, opacity: 0.8 }} title={candidate.error}>
                        {t('candidateBroken')}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            ))}
          {notice !== null && <div style={{ marginBottom: 10, opacity: 0.8 }}>{notice}</div>}
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              value={manifestInput}
              onChange={(event) => { setManifestInput(event.target.value) }}
              onKeyDown={(event) => { if (event.key === 'Enter') applyManifest(manifestInput) }}
              placeholder="C:\repo\demo.dsh-octopus"
              spellCheck={false}
              style={{
                flex: 1, minWidth: 0, fontSize: 12, padding: '4px 6px', color: 'inherit',
                background: 'transparent', border: '1px solid var(--dsw-alias-border-secondary, #666)', borderRadius: 4,
              }}
            />
            <button type="button" onClick={() => { applyManifest(manifestInput) }} style={{ fontSize: 12, padding: '4px 10px', cursor: 'pointer' }}>
              {t('workspaceApply')}
            </button>
            <button
              type="button"
              title={t('scanAgain')}
              aria-label={t('scanAgain')}
              onClick={() => { scan(scope) }}
              style={{ display: 'flex', alignItems: 'center', fontSize: 12, padding: '4px 8px', cursor: 'pointer' }}
            >
              <IconRefreshOutlineMedium size={14} />
            </button>
          </div>
          {error !== null && <div style={{ marginTop: 8, opacity: 0.85 }}>{error}</div>}
        </div>
      )
    }
    return (
      <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', flex: 'none' }}>
          <span style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={workspace.manifestPath}>
            {workspace.name}
          </span>
          <span style={{ fontSize: 12, opacity: 0.6 }}>{t('workspaceRoots', { n: workspace.roots.length })}</span>
          {violations.length > 0 && (
            <button
              type="button"
              title={t('workspaceViolationsTitle')}
              aria-expanded={violationsOpen}
              onClick={() => { setViolationsOpen((open) => !open) }}
              style={{ fontSize: 11, padding: '2px 8px', cursor: 'pointer', color: 'var(--dsw-alias-state-error-primary, #f2a1a1)' }}
            >
              {t('workspaceViolations', { n: violations.length })}
            </button>
          )}
          <button
            type="button"
            title={t('refresh')}
            aria-label={t('refresh')}
            onClick={refresh}
            style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', border: 0, background: 'transparent', cursor: 'pointer', color: 'inherit' }}
          >
            <IconRefreshOutlineMedium size={14} />
          </button>
          <button
            type="button"
            title={t('workspaceDeactivate')}
            aria-label={t('workspaceDeactivate')}
            onClick={deactivate}
            style={{ display: 'flex', alignItems: 'center', border: 0, background: 'transparent', cursor: 'pointer', color: 'inherit' }}
          >
            <IconCloseFillMedium size={14} />
          </button>
        </div>
        {violationsOpen && violations.length > 0 && (
          <div style={{ flex: 'none', padding: '0 10px 6px' }}>
            {violations.map((item) => (
              <div key={item.callId} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '3px 0' }}>
                <span style={{ opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.path}>
                  {t('workspaceViolationMeta', { root: item.rootLabel, kind: item.kind })}
                </span>
                {item.canRestore && (
                  <button type="button" onClick={() => { rollback(item.callId) }} style={{ fontSize: 11, padding: '1px 6px', cursor: 'pointer' }}>
                    {t('workspaceRollback')}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {notice !== null && <div style={{ flex: 'none', padding: '0 10px 6px', fontSize: 12, opacity: 0.7 }}>{notice}</div>}
        {error !== null && <div style={{ flex: 'none', padding: '0 10px 6px', fontSize: 12, opacity: 0.85 }}>{error}</div>}
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', paddingBottom: 8 }}>
          {workspace.roots.map((root) => {
            const open = expanded.has(root.path)
            const readOnly = root.access === 'readOnly'
            const missing = root.exists === false
            const permission = readOnly ? t('workspaceFolderReadOnly') : root.path
            return (
              <div key={root.path}>
                <div style={{ ...rowBase, width: '100%' }} {...rowActivity(root.path)}>
                  <button
                    type="button"
                    title={missing ? `${permission} — ${t('workspaceMissingFolder')}` : permission}
                    aria-expanded={open}
                    style={{
                      ...rowBase,
                      flex: 1, minWidth: 0, border: 0, background: 'transparent', cursor: 'pointer', textAlign: 'left',
                      fontWeight: 600, opacity: missing ? 0.5 : 1,
                    }}
                    onClick={() => { toggle(root.path) }}
                  >
                    {open ? <IconFolderOpenMedium size={16} /> : <IconFolderCloseMedium size={16} />}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{root.label}</span>
                    {missing && <span style={{ fontSize: 11, opacity: 0.55 }}>{t('workspaceMissingFolder')}</span>}
                    <RootRowMarkers
                      readOnly={readOnly}
                      path={root.path}
                      lockLabel={t('workspaceFolderReadOnly')}
                      pathLabel={t('workspaceFolderPath')}
                    />
                  </button>
                  {/* A root that does not exist has nothing to open, and the host
                      would refuse it: the row offers no desktop action. */}
                  {canReveal && !missing && (
                    <RevealButton
                      path={root.path}
                      label={t('workspaceOpenFolder')}
                      onReveal={reveal}
                      visible={activeRow === root.path}
                    />
                  )}
                </div>
                {open && renderRows(root.path, 1)}
              </div>
            )
          })}
        </div>
      </div>
    )
  }
}
