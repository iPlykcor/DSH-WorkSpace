/**
 * Multi-root workspace tab for the DSH 0.1.5+ BUILT-IN right Sidebar.
 *
 * The plugin's own sidebar shell is a `document.body` portal that collides
 * with the built-in right Sidebar, so on 0.1.5+ hosts the plugin contributes
 * its multi-root workspace as a TAB in the built-in Sidebar instead and leaves
 * the built-in Files tab untouched.
 *
 * Registration follows the official two-stage contract (see
 * `@deepseek-ai/dsh-client-ui-sidebar-files`):
 *   1. the tab TYPE into `ctx.sidebarRightTabs`;
 *   2. the tab BODY into the keyed `sidebar.right.pane.tab` seat and the chip
 *      TITLE into `sidebar.right.pane.tab.title`, both under the type `id`.
 *
 * Browsing reads the plugin's own host routes (`workspace.state` /
 * `workspace.activate` / `workspace.deactivate` / `fs.tree`), which already
 * resolve the active multi-root workspace across every declared root — the
 * built-in `workspaceFiles` service is single-root and refuses anything
 * outside the session's one root, which is exactly why multi-root needs its
 * own surface. Read-only write detection rides `workspace.violations` /
 * `workspace.rollback` (the host scans the session event log, independent of
 * who performed the write).
 *
 * The tree deliberately mirrors the built-in Files tab's look: a coloured
 * folder icon (open/closed) toggles a directory and `FileTypeIcon` +
 * `classifyFileType` draws each file — no chevron column. Copy reuses the
 * plugin's EXISTING locale keys, so no dictionary needs a new entry.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { VscLock } from 'react-icons/vsc'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { IconCloseFill14, IconFolderClose16, IconFolderOpen16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, blobUrl, videoUrl, type FsEntry, type SessionScope, type WorkspaceSnapshot, type WorkspaceViolation } from './api.ts'
import { extOfPath } from './archive-format.ts'
import { isMediaExt } from './media.ts'
import { FilePreviewBody } from './FilePreviewBody.tsx'
import { EDITOR_KIND } from './editor-tab.tsx'
import { t } from './locales.ts'
import css from './sidebar.module.css'
import type { Context, SidebarRightFace, SidebarRightTabsFace } from '../context-types.ts'

/** Tab implementation identity; also the key its body/title register under. */
export const MULTIROOT_ID = 'dsh-workspace/multiroot-files'
/** Type discriminator the tab is opened by. */
export const MULTIROOT_KIND = 'multiroot'

/** How often the read-only violation list refreshes while a workspace is active. */
const VIOLATION_POLL_MS = 15_000

/** The 0.1.5-only file-type icon (absent from older shells; the tab itself is 0.1.5-gated). */
type FileIconComponent = (props: { kind: string; size?: number; className?: string }) => ReactNode
const FileTypeIcon = (primitives as unknown as { FileTypeIcon?: FileIconComponent }).FileTypeIcon
const classifyFileType = (primitives as unknown as { classifyFileType?: (name: string) => string }).classifyFileType

/**
 * Register the multi-root tab into the built-in right Sidebar.
 * No-op on hosts without the 0.1.5 extension points (the plugin's own portal
 * is used there instead).
 * @param ctx - the client cordis context.
 * @returns a disposer unregistering the type, body and title.
 */
export function registerMultiRootTab(ctx: Context): () => void {
  // Non-reactive optional-service probe: `ctx.get` returns undefined when the
  // service is absent, where direct property access would throw (cordis guards
  // unavailable services). Mirrors the plugin's other optional probes.
  const tabs = ctx.get('sidebarRightTabs') as SidebarRightTabsFace | undefined
  if (tabs === undefined) return () => {}

  const body = ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: MULTIROOT_ID,
  }, makeMultiRootBody(ctx)))
  const title = ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title',
    key: MULTIROOT_ID,
  }, MultiRootTitle))
  const type = tabs.register({
    id: MULTIROOT_ID,
    kind: MULTIROOT_KIND,
    priority: 'extension',
    title: () => t('viewerWorkspace'),
    guide: [{ order: 20, title: () => t('viewerWorkspace') }],
  })
  return () => { type(); body(); title() }
}

/** The tab chip label. */
function MultiRootTitle(): ReactNode {
  return <span>{t('viewerWorkspace')}</span>
}

/**
 * The multi-root manifest this session last activated, read from the plugin's
 * own persisted sidebar state (state.ts writes `dsh-sidebar:v1:<sessionId>`
 * with the workspace snapshot under `workspace`). Used to re-activate after a
 * host restart, exactly like the sidebar's own restore path.
 * @param sessionId - the session whose persisted manifest is read.
 * @returns the manifest path, or undefined when nothing usable is stored.
 */
function persistedManifestPath(sessionId: string): string | undefined {
  try {
    const raw = localStorage.getItem(`dsh-sidebar:v1:${sessionId}`)
    if (raw === null) return undefined
    const parsed = JSON.parse(raw) as { workspace?: { manifestPath?: unknown } } | null
    const path = parsed?.workspace?.manifestPath
    return typeof path === 'string' && path !== '' ? path : undefined
  } catch {
    return undefined
  }
}

/** One directory-child row. */
interface Row { name: string; path: string; dir: boolean }

/** Inline styles shared by the tree (no CSS module reaches this surface). */
const rowBase = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  height: 24,
  fontSize: 13,
  color: 'var(--dsw-alias-label-primary)',
} as const

/** Build the tab body bound to the plugin context (session id source). */
function makeMultiRootBody(ctx: Context): () => ReactNode {
  return function MultiRootBody(): ReactNode {
    const [sessionId, setSessionId] = useState<string | undefined>(() => ctx.sessions.list.getSnapshot().current)
    const [cwd, setCwd] = useState<string | undefined>(() => {
      const snapshot = ctx.sessions.list.getSnapshot()
      const current = snapshot.current
      return current === undefined ? undefined : snapshot.byId[current]?.cwd
    })
    // Follow the current session so the tab re-roots when the user switches.
    useEffect(() => ctx.sessions.list.subscribe(() => {
      const snapshot = ctx.sessions.list.getSnapshot()
      const current = snapshot.current
      setSessionId(current)
      setCwd(current === undefined ? undefined : snapshot.byId[current]?.cwd)
    }), [])

    const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null | undefined>(undefined)
    const [error, setError] = useState<string | null>(null)
    const [expanded, setExpanded] = useState<Set<string>>(new Set())
    const [children, setChildren] = useState<Map<string, Row[]>>(new Map())
    const [manifestInput, setManifestInput] = useState('')
    const [violations, setViolations] = useState<WorkspaceViolation[]>([])
    const [violationsOpen, setViolationsOpen] = useState(false)
    // The file currently previewed inside the tab. Roots beyond the session's
    // one built-in workspace root cannot be addressed by the product's
    // `dsh-resource://file/...` scheme, so this tab previews them itself over
    // the plugin's own `/sidebar/blob` (bytes) or `/sidebar/video` (streaming).
    const [preview, setPreview] = useState<
      { path: string; bytes?: ArrayBuffer; mediaUrl?: string; loading: boolean; error?: string } | null
    >(null)

    const scope: SessionScope = { sessionId: sessionId ?? '', ...(cwd !== undefined ? { cwd } : {}) }

    // Load the session's active multi-root workspace snapshot; when the host
    // has lost it (restart) re-activate from the plugin's persisted manifest,
    // mirroring the sidebar's own restore path.
    useEffect(() => {
      if (sessionId === undefined) { setWorkspace(null); return }
      let cancelled = false
      setWorkspace(undefined); setError(null); setExpanded(new Set()); setChildren(new Map())
      setViolations([]); setViolationsOpen(false)
      api.workspaceState(scope)
        .then((result) => {
          if (cancelled) return
          if (result.workspace !== null) { setWorkspace(result.workspace); return }
          const manifestPath = persistedManifestPath(sessionId)
          if (manifestPath === undefined) { setWorkspace(null); return }
          api.workspaceActivate(scope, manifestPath)
            .then((activated) => { if (!cancelled) setWorkspace(activated.workspace) })
            .catch(() => { if (!cancelled) setWorkspace(null) })
        })
        .catch((failure: unknown) => {
          if (cancelled) return
          setWorkspace(null)
          setError(failure instanceof Error ? failure.message : String(failure))
        })
      return () => { cancelled = true }
    }, [sessionId, cwd])

    // Poll the read-only write report while a workspace is active (the host
    // scans the session event log; nothing here depends on who wrote).
    useEffect(() => {
      if (workspace === null || workspace === undefined || sessionId === undefined) return
      let cancelled = false
      const refresh = (): void => {
        api.workspaceViolations(scope)
          .then((result) => { if (!cancelled) setViolations(result.violations) })
          .catch(() => { /* a failed poll keeps the last report */ })
      }
      refresh()
      const timer = window.setInterval(refresh, VIOLATION_POLL_MS)
      return () => { cancelled = true; window.clearInterval(timer) }
    }, [workspace, sessionId, cwd])

    // Seed the activation box with the session's persisted manifest, so a
    // re-opened tab offers the last workspace one click away.
    useEffect(() => {
      if (sessionId === undefined) { setManifestInput(''); return }
      setManifestInput(persistedManifestPath(sessionId) ?? '')
    }, [sessionId])

    const load = useCallback((dir: string): void => {
      if (sessionId === undefined) return
      api.fsTree(scope, dir)
        .then((listing) => {
          const rows: Row[] = listing.entries
            .map((entry: FsEntry) => ({ name: entry.name, path: entry.path, dir: entry.isDir }))
            .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
          setChildren(prev => new Map(prev).set(dir, rows))
        })
        .catch((failure: unknown) => { setError(failure instanceof Error ? failure.message : String(failure)) })
    }, [sessionId, cwd])

    const toggle = (path: string): void => {
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(path)) next.delete(path)
        else { next.add(path); if (!children.has(path)) load(path) }
        return next
      })
    }

    const activate = (): void => {
      const target = manifestInput.trim()
      if (target === '' || sessionId === undefined) return
      setError(null); setWorkspace(undefined)
      api.workspaceActivate(scope, target)
        .then((result) => setWorkspace(result.workspace))
        .catch((failure: unknown) => {
          setWorkspace(null)
          setError(String(t('workspaceApplyFailed', { message: failure instanceof Error ? failure.message : String(failure) })))
        })
    }

    const deactivate = (): void => {
      if (sessionId === undefined) return
      api.workspaceDeactivate(scope)
        .then(() => { setWorkspace(null); setExpanded(new Set()); setChildren(new Map()); setViolations([]) })
        .catch((failure: unknown) => { setError(failure instanceof Error ? failure.message : String(failure)) })
    }

    const rollback = (callId: string): void => {
      api.workspaceRollback(scope, callId)
        .then(() => {
          setViolations(prev => prev.filter(item => item.callId !== callId))
        })
        .catch((failure: unknown) => { setError(failure instanceof Error ? failure.message : String(failure)) })
    }

    /**
     * Preview one file inside the tab. Media streams through the plugin's
     * `/sidebar/video` range route; everything else loads its bytes through
     * `/sidebar/blob` (both resolve paths under ANY declared root, which the
     * product's single-root file service cannot).
     */
    const openFile = (row: Row): void => {
      if (sessionId === undefined) return
      if (isMediaExt(extOfPath(row.path))) {
        setPreview({ path: row.path, mediaUrl: videoUrl(scope, row.path), loading: false })
        return
      }
      setPreview({ path: row.path, loading: true })
      fetch(blobUrl(scope, row.path))
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          return response.arrayBuffer()
        })
        .then((bytes) => {
          setPreview(current => (current?.path === row.path ? { path: row.path, bytes, loading: false } : current))
        })
        .catch((failure: unknown) => {
          setPreview(current => (current?.path === row.path
            ? { path: row.path, loading: false, error: failure instanceof Error ? failure.message : String(failure) }
            : current))
        })
    }

    /** The coloured file-type icon (falls back to a neutral dot on older shells). */
    const fileIcon = (name: string): ReactNode => {
      if (FileTypeIcon === undefined) return <span style={{ width: 16, fontSize: 10, opacity: 0.6 }}>·</span>
      const kind = classifyFileType?.(name) ?? 'file'
      return <FileTypeIcon kind={kind} size={16} />
    }

    const renderRows = (dir: string, depth: number): ReactNode => {
      const rows = children.get(dir)
      if (rows === undefined) {
        return <div style={{ padding: '4px 10px', fontSize: 12, opacity: 0.6 }}>{t('loading')}</div>
      }
      return rows.map((row) => {
        const pad = { paddingLeft: depth * 16 + 8 }
        if (!row.dir) {
          return (
            <button
              key={`f:${row.path}`}
              type="button"
              title={row.path}
              style={{ ...rowBase, ...pad, width: '100%', border: 0, background: 'transparent', cursor: 'pointer', textAlign: 'left' }}
              onClick={() => openFile(row)}
            >
              {fileIcon(row.name)}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name}</span>
            </button>
          )
        }
        const open = expanded.has(row.path)
        return (
          <div key={`d:${row.path}`}>
            <button
              type="button"
              title={row.path}
              style={{ ...rowBase, ...pad, width: '100%', border: 0, background: 'transparent', cursor: 'pointer', textAlign: 'left' }}
              aria-expanded={open}
              onClick={() => toggle(row.path)}
            >
              {open ? <IconFolderOpen16 size={16} /> : <IconFolderClose16 size={16} />}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name}</span>
            </button>
            {open && renderRows(row.path, depth + 1)}
          </div>
        )
      })
    }

    if (sessionId === undefined) {
      return <div style={{ padding: 12, fontSize: 13, opacity: 0.7 }}>{t('loading')}</div>
    }
    if (workspace === undefined) {
      return <div style={{ padding: 12, fontSize: 13, opacity: 0.7 }}>{t('loading')}</div>
    }
    if (workspace === null) {
      return (
        <div style={{ padding: 12, fontSize: 13, lineHeight: 1.7 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{t('viewerWorkspace')}</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              value={manifestInput}
              onChange={(e) => setManifestInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') activate() }}
              placeholder={'D:\\path\\to\\xxx.dsh-workspace'}
              spellCheck={false}
              style={{
                flex: 1, minWidth: 0, fontSize: 12, padding: '4px 6px', color: 'inherit',
                background: 'transparent', border: '1px solid var(--dsw-alias-border-secondary, #666)', borderRadius: 4,
              }}
            />
            <button type="button" onClick={activate} style={{ fontSize: 12, padding: '4px 10px', cursor: 'pointer' }}>
              {t('workspaceApply')}
            </button>
          </div>
          {error !== null && <div style={{ marginTop: 8, opacity: 0.85 }}>{error}</div>}
        </div>
      )
    }
    if (preview !== null) {
      return (
        <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', flex: 'none' }}>
            <button
              type="button"
              onClick={() => setPreview(null)}
              aria-label={t('viewerWorkspace')}
              style={{ display: 'flex', alignItems: 'center', border: 0, background: 'transparent', cursor: 'pointer', color: 'inherit' }}
            >
              ←
            </button>
            <span style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={preview.path}>
              {preview.path.split(/[\\/]/).pop()}
            </span>
            <button
              type="button"
              onClick={() => {
                const nav = ctx.get('sidebarRight') as SidebarRightFace | undefined
                nav?.openTab(EDITOR_KIND, { params: { path: preview.path } })
              }}
              style={{ marginLeft: 'auto', fontSize: 11, padding: '2px 8px', cursor: 'pointer' }}
            >
              {t('edit')}
            </button>
          </div>
          {preview.loading ? (
            <div style={{ padding: 12, fontSize: 13, opacity: 0.7 }}>{t('loading')}</div>
          ) : preview.error !== undefined ? (
            <div style={{ padding: 12, fontSize: 13, opacity: 0.85 }}>{preview.error}</div>
          ) : (
            <FilePreviewBody
              scope={scope}
              path={preview.path}
              bytes={preview.bytes ?? new ArrayBuffer(0)}
              {...(preview.mediaUrl !== undefined ? { mediaUrl: preview.mediaUrl } : {})}
            />
          )}
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
              onClick={() => { setViolationsOpen(open => !open) }}
              style={{ fontSize: 11, padding: '2px 8px', cursor: 'pointer', color: 'var(--dsw-alias-state-error-primary, #f2a1a1)' }}
            >
              {t('workspaceViolations', { n: violations.length })}
            </button>
          )}
          <button
            type="button"
            title={t('workspaceDeactivate')}
            aria-label={t('workspaceDeactivate')}
            onClick={deactivate}
            style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', border: 0, background: 'transparent', cursor: 'pointer', color: 'inherit' }}
          >
            <IconCloseFill14 size={14} />
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
                  <button type="button" onClick={() => rollback(item.callId)} style={{ fontSize: 11, padding: '1px 6px', cursor: 'pointer' }}>
                    {t('workspaceRollback')}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {error !== null && <div style={{ flex: 'none', padding: '0 10px 6px', fontSize: 12, opacity: 0.85 }}>{error}</div>}
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', paddingBottom: 8 }}>
          {workspace.roots.map((root) => {
            const open = expanded.has(root.path)
            const readOnly = root.access === 'readOnly'
            const missing = root.exists === false
            return (
              <div key={root.path}>
                <button
                  type="button"
                  title={readOnly ? t('workspaceFolderReadOnly') : root.path}
                  aria-expanded={open}
                  style={{
                    ...rowBase,
                    width: '100%', border: 0, background: 'transparent', cursor: 'pointer', textAlign: 'left',
                    fontWeight: 600, opacity: missing ? 0.5 : 1,
                  }}
                  onClick={() => toggle(root.path)}
                >
                  {open ? <IconFolderOpen16 size={16} /> : <IconFolderClose16 size={16} />}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{root.label}</span>
                  {missing && <span style={{ fontSize: 11, opacity: 0.55 }}>{t('workspaceMissingFolder')}</span>}
                  {readOnly && <VscLock size={12} className={css.explorerLock} aria-label={t('workspaceFolderReadOnly')} />}
                </button>
                {open && renderRows(root.path, 1)}
              </div>
            )
          })}
        </div>
      </div>
    )
  }
}
