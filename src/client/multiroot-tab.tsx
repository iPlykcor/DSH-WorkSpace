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
 *
 * IT IS DRAWN LIKE DSH'S OWN 工作区文件 PANE. Same shared components (the
 * product's `FileTypeIcon` + `classifyFileType` for files, its Regular folder
 * glyphs for directories, its `PathLabel` in the header), same row order, and
 * the same numbers — which live in exactly one place, ./tree-metrics.ts, where
 * the built-in's own CSS is cited and pinned by tests.
 */
import {
  FileTypeIcon,
  IconCloseFillRegular,
  IconFolderCloseRegular,
  IconFolderOpenRegular,
  IconRefreshOutlineRegular,
  PathLabel,
  RiskConfirmation,
  classifyFileType,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useRef, useState, type FocusEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import type { Context, SidebarRightFace, SidebarRightTabsFace, UiWorkspaceFace } from '../context-types.ts'
import type { OctopusAccess } from '../workspace-schema.ts'
import {
  api,
  type FsEntry, type ManifestCandidate, type SessionScope, type WorkspaceSnapshot, type WorkspaceViolation,
} from './api.ts'
import { PointerContextMenu, accessOfMenuId, buildBodyMenu, type MenuPoint } from './body-menu.tsx'
import { decideDiscovery } from './discovery-decision.ts'
import { orderEntries } from './entry-order.ts'
import { sessionFileAddress } from './file-address.ts'
import { OctopusGuideArtwork } from './guide-artwork.tsx'
import { t } from './locales.ts'
import { RevealButton } from './reveal-button.tsx'
import { RootPermissionToggle, RootTrailingBadge } from './root-markers.tsx'
import { buildRowMenu, rowMenuIntent } from './row-menu.tsx'
import { ToolButton } from './tool-button.tsx'
import {
  LABEL_PRIMARY,
  LABEL_SECONDARY,
  LABEL_TERTIARY,
  NOTE_FONT_SIZE,
  TOOL_RADIUS,
  bodyStyle,
  dirIconStyle,
  fileIconStyle,
  headerStyle,
  nameStyle,
  noteStyle,
  rowStyle,
  rowWrapperStyle,
  statusLineStyle,
  statusStyle,
  tabRootStyle,
} from './tree-metrics.ts'

/** Tab type identity: `id` keys the two slot seats, `kind` is what opens it. */
const TAB_ID = 'octopus-operation-space'

/** The page kind users open (a page type: no `patterns`, so it is opened by kind). */
export const TAB_KIND = 'octopusOperationSpace'
/**
 * The keyboard command that opens this tab. The start-page capsule looks the
 * command up by this exact id (`guide[].commandId`), so the two must stay one
 * constant — `tests/client-tab.spec.ts` pins the equality.
 */
export const COMMAND_ID = 'octopus.operationSpace'

/** Read-only write report refresh cadence (ms). */
const VIOLATION_POLL_MS = 5_000

/** This plugin's own persisted-manifest key prefix (per session). */
const STORAGE_PREFIX = 'dsh-octopus:v1:'

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
    guide: [{
      id: 'operationSpace',
      commandId: COMMAND_ID,
      // The capsule's artwork; without it the platform draws a cube glyph.
      icon: OctopusGuideArtwork,
      order: 20,
      title: () => t('operationSpace'),
      description: () => t('guideDescription'),
    }],
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
    /** Where the body's right-click menu was opened; null = closed. */
    const [menuAt, setMenuAt] = useState<MenuPoint | null>(null)
    /** Whether the host's folder chooser is in flight. */
    const [picking, setPicking] = useState(false)
    /** The root whose access change is in flight, so only that padlock is busy. */
    const [accessPath, setAccessPath] = useState<string | null>(null)
    /** The row whose context menu is open; null while the body's menu is the one up. */
    const [menuRoot, setMenuRoot] = useState<WorkspaceSnapshot['roots'][number] | null>(null)
    /** The root whose removal confirmation is up, or null when none is. */
    const [pendingRemove, setPendingRemove] = useState<{ path: string; label: string } | null>(null)
    /** Whether the removal confirmation's acknowledgement box has been ticked. */
    const [removeAcknowledged, setRemoveAcknowledged] = useState(false)

    /**
     * The context menu's one action: ask the HOST for a folder — its own native
     * chooser returns an absolute path the page could never learn on its own —
     * then let the host append it to the manifest this session already activated.
     * The client never names the manifest, and cancelling the chooser is not an
     * error: it just closes.
     */
    const addFolder = useCallback((access: OctopusAccess): void => {
      setMenuAt(null)
      if (sessionId === undefined || sessionId === '') return
      const chooser = ctx.get('uiWorkspace') as UiWorkspaceFace | undefined
      if (chooser === undefined) {
        setError(t('folderAddUnavailable'))
        return
      }
      const target: SessionScope = { sessionId, ...(cwd !== undefined && cwd !== '' ? { cwd } : {}) }
      setPicking(true)
      setError(null)
      setNotice(t('folderPicking'))
      void chooser.pickDirectory()
        .then(async (picked) => {
          if (picked === null) {
            setPicking(false)
            setNotice(null)
            return
          }
          const result = await api.workspaceAddFolder(target, picked, access)
          // The host re-activated the edited manifest, so ITS snapshot — never a
          // local guess about what the file now says — is what the list renders.
          setWorkspace(result.workspace)
          setPicking(false)
          setNotice(result.added
            ? t('folderAdded', { label: result.label })
            : t('folderAlready', { label: result.label }))
        })
        .catch((failure: unknown) => {
          setPicking(false)
          setNotice(null)
          setError(t('folderAddFailed', { message: messageOf(failure) }))
        })
    }, [sessionId, cwd])

    /**
     * The padlock's action: flip one DECLARED root between read-only and
     * read-write. The host finds that root's manifest entry itself and rewrites
     * only its `access`, then re-activates the space with the original
     * `activatedAt` — so the row's marker, the write fence and the violation
     * floor all follow the file rather than a local guess.
     */
    const toggleAccess = useCallback((root: WorkspaceSnapshot['roots'][number]): void => {
      if (sessionId === undefined || sessionId === '') return
      const access: OctopusAccess = root.access === 'readOnly' ? 'readWrite' : 'readOnly'
      const target: SessionScope = { sessionId, ...(cwd !== undefined && cwd !== '' ? { cwd } : {}) }
      setAccessPath(root.path)
      setError(null)
      setNotice(null)
      void api.workspaceSetFolderAccess(target, root.path, access)
        .then((result) => {
          setWorkspace(result.workspace)
          setAccessPath(null)
          // Both keys stay literal calls: the dead-key scan in
          // `tests/client-tab.spec.ts` matches `t('...')` by text, so a key
          // chosen inside an expression would look unreferenced.
          setNotice(access === 'readOnly'
            ? t('folderLocked', { label: result.label })
            : t('folderUnlocked', { label: result.label }))
        })
        .catch((failure: unknown) => {
          setAccessPath(null)
          setError(t('folderAccessFailed', { message: messageOf(failure) }))
        })
    }, [sessionId, cwd])

    /**
     * The row menu's destructive action: delete one DECLARED root's declaration.
     * The folder on disk is never touched — the confirmation says so before this
     * runs — and the host keeps a backup and re-activates the space with the
     * original `activatedAt`, so the answer's snapshot is what the list renders.
     */
    const removeFolder = useCallback((root: { path: string; label: string }): void => {
      if (sessionId === undefined || sessionId === '') return
      const target: SessionScope = { sessionId, ...(cwd !== undefined && cwd !== '' ? { cwd } : {}) }
      setAccessPath(root.path)
      setError(null)
      setNotice(null)
      void api.workspaceRemoveFolder(target, root.path)
        .then((result) => {
          setWorkspace(result.workspace)
          setAccessPath(null)
          // Removing the entry that WAS the session cwd makes the policy append
          // its implicit read-write root again. Say that out loud rather than
          // letting the operator believe the folder left the space. The compare
          // is case-insensitive on purpose: it only chooses which of two notices
          // to show (a display heuristic, never a decision), and the paths can
          // legitimately differ in case when the entry was declared that way.
          const implicit = result.workspace.roots.some(candidate =>
            !candidate.listed && candidate.path.toLowerCase() === root.path.toLowerCase())
          setNotice(implicit
            ? t('folderRemovedImplicit', { label: result.label })
            : t('folderRemoved', { label: result.label }))
        })
        .catch((failure: unknown) => {
          setAccessPath(null)
          setError(t('folderRemoveFailed', { message: messageOf(failure) }))
        })
    }, [sessionId, cwd])

    /**
     * Right-click handling for a ROW: the row's own menu replaces the browser's
     * page menu. The body handler below never competes with it — its
     * `target === currentTarget` guard cannot hold for a click that started
     * inside a row — so the row's menu is the only one that opens.
     */
    const openRowMenu = useCallback((
      root: WorkspaceSnapshot['roots'][number],
      event: ReactMouseEvent<HTMLDivElement>,
    ): void => {
      event.preventDefault()
      setMenuRoot(root)
      setMenuAt({ x: event.clientX, y: event.clientY })
    }, [])

    /**
     * Right-click handling for the body's BLANK area: the add-folder menu. It
     * clears any row menu, because the two share one card and one anchor.
     */
    const openBodyMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>): void => {
      if (event.target !== event.currentTarget) return
      event.preventDefault()
      setMenuRoot(null)
      setMenuAt({ x: event.clientX, y: event.clientY })
    }, [])

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

    /** Render one directory's children (indented by depth, ordered like the built-in tree). */
    const renderRows = (parent: string, depth: number): ReactNode => {
      const entries = children.get(parent)
      // The built-in's own states, at its own metrics: a note line, never a row.
      if (entries === undefined) return <div style={noteStyle}>{t('loading')}</div>
      if (entries.length === 0) return <div style={noteStyle}>{t('emptyFolder')}</div>
      return orderEntries(entries).map((entry) => {
        const open = expanded.has(entry.path)
        return (
          <div key={entry.path} style={rowWrapperStyle(activeRow === entry.path)} {...rowActivity(entry.path)}>
            <button
              type="button"
              title={entry.path}
              aria-expanded={entry.isDir ? open : undefined}
              style={rowStyle(depth, { opacity: entry.broken ? 0.5 : 1 })}
              onClick={() => { if (entry.isDir) toggle(entry.path); else openFile(entry.path) }}
            >
              {entry.isDir
                ? (
                  // Regular weight, no explicit size and the tertiary colour: this is
                  // the glyph the built-in file tree draws for a directory.
                  <span style={dirIconStyle}>
                    {open ? <IconFolderOpenRegular /> : <IconFolderCloseRegular />}
                  </span>
                )
                : (
                  // The product's own classifier and category-coloured glyph, which is
                  // exactly what the built-in pane shows for the same file name.
                  <span style={fileIconStyle}>
                    <FileTypeIcon kind={classifyFileType(entry.name)} size={16} />
                  </span>
                )}
              <span style={nameStyle}>{entry.name}</span>
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
      return (
        <div style={statusStyle}>
          <p style={statusLineStyle}>{t('loading')}</p>
        </div>
      )
    }
    if (workspace === null) {
      // The built-in's status panel, with this plugin's own controls inside it.
      return (
        <div style={{ ...statusStyle, height: '100%', overflow: 'auto' }}>
          <p style={{ ...statusLineStyle, color: LABEL_PRIMARY, marginBottom: 6 }}>{t('operationSpace')}</p>
          <p style={{ ...statusLineStyle, marginBottom: 10 }}>{t('noWorkspace')}</p>
          {/* Auto-detection: opening this tab already scanned the session cwd,
              so a manifest sitting there needs no hand-typed path. The input
              below stays as the fallback for one that lives elsewhere. */}
          {scanning && <div style={noteStyle}>{t('scanning')}</div>}
          {!scanning && candidates !== undefined && (candidates.length === 0
            ? <div style={noteStyle}>{t('scanNone')}</div>
            : (
              <div style={{ marginBottom: 10 }}>
                <div style={noteStyle}>
                  {candidates.length === 1 ? t('scanOne') : t('scanPick', { n: candidates.length })}
                </div>
                {candidates.map((candidate) => (
                  <button
                    key={candidate.path}
                    type="button"
                    title={candidate.path}
                    onClick={() => { applyManifest(candidate.path) }}
                    style={rowStyle(0, {
                      width: '100%',
                      paddingLeft: 2,
                      borderRadius: TOOL_RADIUS,
                      cursor: candidate.error === undefined ? 'pointer' : 'default',
                      opacity: candidate.error === undefined ? 1 : 0.6,
                    })}
                  >
                    <span style={dirIconStyle}><IconFolderOpenRegular /></span>
                    <span style={nameStyle}>
                      {candidate.name}
                    </span>
                    {candidate.name !== candidate.fileName && (
                      <span style={{ fontSize: 11, opacity: 0.5, ...nameStyle }}>
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
          {notice !== null && <div style={noteStyle}>{notice}</div>}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              value={manifestInput}
              onChange={(event) => { setManifestInput(event.target.value) }}
              onKeyDown={(event) => { if (event.key === 'Enter') applyManifest(manifestInput) }}
              placeholder="C:\repo\demo.dsh-octopus"
              spellCheck={false}
              style={{
                flex: 1, minWidth: 0, fontSize: NOTE_FONT_SIZE, padding: '4px 6px', color: 'inherit',
                background: 'transparent', border: '1px solid var(--dsw-alias-border-secondary, #666)', borderRadius: 4,
              }}
            />
            <button
              type="button"
              onClick={() => { applyManifest(manifestInput) }}
              style={{ fontSize: NOTE_FONT_SIZE, padding: '4px 10px', cursor: 'pointer' }}
            >
              {t('workspaceApply')}
            </button>
            <ToolButton icon={IconRefreshOutlineRegular} label={t('scanAgain')} onClick={() => { scan(scope) }} />
          </div>
          {error !== null && <div style={{ ...noteStyle, marginTop: 8 }}>{error}</div>}
        </div>
      )
    }
    return (
      <div style={tabRootStyle}>
        <div style={headerStyle}>
          {/* The built-in puts its ROOT PATH here through the shared `PathLabel`
              (subdued directories, primary last segment, full path on hover).
              This pane's root-equivalent is the manifest: it is the single source
              of truth for every root below it, so it takes that slot. */}
          <PathLabel path={workspace.manifestPath} style={{ flex: 1, minWidth: 0, marginRight: 12 }} />
          <span style={{ flex: 'none', fontSize: NOTE_FONT_SIZE, color: LABEL_TERTIARY }}>
            {t('workspaceRoots', { n: workspace.roots.length })}
          </span>
          {violations.length > 0 && (
            <button
              type="button"
              title={t('workspaceViolationsTitle')}
              aria-expanded={violationsOpen}
              onClick={() => { setViolationsOpen((open) => !open) }}
              style={{
                flex: 'none', fontSize: NOTE_FONT_SIZE, padding: '3px 6px', cursor: 'pointer', border: 0,
                background: 'transparent', borderRadius: TOOL_RADIUS,
                color: 'var(--dsw-alias-state-error-primary, #f2a1a1)',
              }}
            >
              {t('workspaceViolations', { n: violations.length })}
            </button>
          )}
          <ToolButton icon={IconRefreshOutlineRegular} label={t('refresh')} onClick={refresh} />
          <ToolButton icon={IconCloseFillRegular} label={t('workspaceDeactivate')} onClick={deactivate} />
        </div>
        {violationsOpen && violations.length > 0 && (
          <div style={{ flex: 'none', padding: '0 10px 6px' }}>
            {violations.map((item) => (
              <div key={item.callId} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: NOTE_FONT_SIZE, padding: '3px 0' }}>
                <span style={{ ...nameStyle, color: LABEL_SECONDARY }} title={item.path}>
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
        {notice !== null && <div style={{ ...noteStyle, flex: 'none' }}>{notice}</div>}
        {error !== null && <div style={{ ...noteStyle, flex: 'none' }}>{error}</div>}
        <div style={bodyStyle} onContextMenu={openBodyMenu}>
          <PointerContextMenu
            at={menuAt}
            entries={menuRoot === null
              ? buildBodyMenu({ picking })
              : buildRowMenu({
                listed: menuRoot.listed,
                readOnly: menuRoot.access === 'readOnly',
                busy: accessPath === menuRoot.path,
              })}
            onSelect={(id) => {
              // The body's menu and a row's menu share this one card, so both id
              // spaces are consulted; an id neither owns does nothing.
              const access = accessOfMenuId(id)
              const root = menuRoot
              setMenuAt(null)
              setMenuRoot(null)
              if (access !== undefined) {
                addFolder(access)
                return
              }
              const intent = rowMenuIntent(id)
              if (intent === undefined || root === null) return
              if (intent === 'toggle') {
                toggleAccess(root)
                return
              }
              // Removing is the one action that asks first: the platform's own
              // confirmation keeps its primary button disabled until the
              // acknowledgement box is ticked, which is where "only the
              // declaration goes, not the folder" gets said.
              setRemoveAcknowledged(false)
              setPendingRemove({ path: root.path, label: root.label })
            }}
            onClose={() => { setMenuAt(null); setMenuRoot(null) }}
          />
          {workspace.roots.map((root) => {
            const open = expanded.has(root.path)
            const readOnly = root.access === 'readOnly'
            const missing = root.exists === false
            const permission = readOnly ? t('workspaceFolderReadOnly') : root.path
            // Literal calls only, for the same dead-key reason as above.
            const permissionLabel = readOnly ? t('workspaceFolderReadOnly') : t('workspaceFolderReadWrite')
            const toggleProps = root.listed
              ? {
                toggle: {
                  title: readOnly ? t('folderUnlockAction') : t('folderLockAction'),
                  busy: accessPath === root.path,
                  onClick: () => { toggleAccess(root) },
                },
              }
              : { fixedTitle: t('folderAccessImplicit') }
            return (
              <div key={root.path}>
                <div
                  style={rowWrapperStyle(activeRow === root.path)}
                  {...rowActivity(root.path)}
                  onContextMenu={(event) => { openRowMenu(root, event) }}
                >
                  <button
                    type="button"
                    title={missing ? `${permission} — ${t('workspaceMissingFolder')}` : permission}
                    aria-expanded={open}
                    style={rowStyle(0, { opacity: missing ? 0.5 : 1, flex: 'none' })}
                    onClick={() => { toggle(root.path) }}
                  >
                    <span style={dirIconStyle}>
                      {open ? <IconFolderOpenRegular /> : <IconFolderCloseRegular />}
                    </span>
                    <span style={nameStyle}>{root.label}</span>
                    {missing && <span style={{ fontSize: 11, opacity: 0.55 }}>{t('workspaceMissingFolder')}</span>}
                  </button>
                  {/* The padlock is its OWN control, so it cannot live inside the
                      row button (a button may not nest, and every click would also
                      expand the folder). It sits right after the name, where the
                      row's own 6px gap keeps the spacing the old marker had. */}
                  <RootPermissionToggle
                    readOnly={readOnly}
                    label={permissionLabel}
                    {...toggleProps}
                  />
                  {/* An empty shim so that clicking the blank area to the RIGHT of
                      the padlock still expands the folder, the way it did while the
                      row button filled the row. Decorative: the real control keeps
                      its own name and expanded state. */}
                  <span
                    aria-hidden="true"
                    onClick={() => { toggle(root.path) }}
                    style={{ flex: 'auto', alignSelf: 'stretch', cursor: 'pointer' }}
                  />
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
                  <RootTrailingBadge path={root.path} pathLabel={t('workspaceFolderPath')} />
                </div>
                {open && renderRows(root.path, 1)}
              </div>
            )
          })}
        </div>
        {/* Removing a folder edits the MANIFEST, never the disk, so this
            confirmation exists to say that out loud — not because the change is
            hard to undo (the sidecar backup is right there). */}
        <RiskConfirmation
          open={pendingRemove !== null}
          title={t('removeFolderTitle')}
          description={t('removeFolderDescription', { label: pendingRemove?.label ?? '' })}
          acknowledgeLabel={t('removeFolderAcknowledge')}
          cancelLabel={t('removeFolderCancel')}
          closeLabel={t('removeFolderClose')}
          confirmLabel={t('removeFolderConfirm')}
          acknowledged={removeAcknowledged}
          disabled={accessPath !== null}
          onAcknowledgedChange={setRemoveAcknowledged}
          onCancel={() => { setPendingRemove(null); setRemoveAcknowledged(false) }}
          onConfirm={() => {
            const root = pendingRemove
            setPendingRemove(null)
            setRemoveAcknowledged(false)
            if (root !== null) removeFolder(root)
          }}
        />
      </div>
    )
  }
}
