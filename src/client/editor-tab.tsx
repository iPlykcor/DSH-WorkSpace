/**
 * Editable-editor tab for the DSH 0.1.5+ built-in right Sidebar.
 *
 * The product's document preview is read-only, so editing gets its own tab
 * type: opened with the file's path in the navigation params (the multi-root
 * tab's preview header offers the entry), it loads the text through the
 * plugin's `fs.read` route and renders the SAME CodeMirror editor the plugin's
 * own shell used — lazily fetched from the `editor` chunk, with its own
 * toolbar, saving through `fs.write` so the per-root read/write policy still
 * applies on the host.
 */
import { useEffect, useState, type ComponentType, type ReactNode } from 'react'
import { api, type SessionScope } from './api.ts'
import { lazyChunkComponent } from './lazy-chunk.tsx'
import { t } from './locales.ts'
import type { Context, SidebarRightTabsFace } from '../context-types.ts'
import type { SidebarStore } from './state.ts'
import type { FileViewerProps } from './service.ts'

/** Tab implementation identity; also the key its body/title register under. */
export const EDITOR_ID = 'dsh-workspace/editor'
/** Type discriminator the tab is opened by. */
export const EDITOR_KIND = 'editor'

/** The lazy CodeMirror editor (same component the plugin's own shell used). */
const LazyTextEditor = lazyChunkComponent<FileViewerProps>(
  'editor',
  (mod) => mod.TextEditor as ComponentType<FileViewerProps> | undefined,
)

/** The file path carried by the tab's navigation params. */
function pathOf(params: unknown): string | undefined {
  if (params === null || typeof params !== 'object') return undefined
  const value = (params as { path?: unknown }).path
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** The last path segment, for the editor's title. */
function baseName(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at === -1 ? path : path.slice(at + 1)
}

/** The slot props a `sidebar.right.pane.tab` body receives. */
interface TabBodyProps {
  useTabInfo: () => { tab: { navigation?: { params?: unknown } } }
}

/**
 * Register the editor tab into the built-in right Sidebar.
 * No-op on hosts without the 0.1.5 extension points.
 * @param ctx - the client cordis context.
 * @param store - the plugin's sidebar store (the editor's persistence host).
 * @returns a disposer unregistering the type, body and title.
 */
export function registerEditorTab(ctx: Context, store: SidebarStore): () => void {
  const tabs = ctx.get('sidebarRightTabs') as SidebarRightTabsFace | undefined
  if (tabs === undefined) return () => {}

  const body = ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: EDITOR_ID,
  }, makeEditorBody(ctx, store)))
  const title = ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title',
    key: EDITOR_ID,
  }, function EditorTitle({ useTabInfo }: TabBodyProps): ReactNode {
    const path = pathOf(useTabInfo().tab.navigation?.params)
    return <span>{path === undefined ? t('edit') : baseName(path)}</span>
  }))
  const type = tabs.register({
    id: EDITOR_ID,
    kind: EDITOR_KIND,
    priority: 'extension',
    title: () => t('edit'),
    guide: [{ order: 21, title: () => t('edit') }],
  })
  return () => { type(); body(); title() }
}

/** Build the editor body bound to the plugin context and store. */
function makeEditorBody(ctx: Context, store: SidebarStore): (props: TabBodyProps) => ReactNode {
  return function EditorTabBody({ useTabInfo }: TabBodyProps): ReactNode {
    const path = pathOf(useTabInfo().tab.navigation?.params)
    const [sessionId, setSessionId] = useState<string | undefined>(() => ctx.sessions.list.getSnapshot().current)
    const [cwd, setCwd] = useState<string | undefined>(() => {
      const snapshot = ctx.sessions.list.getSnapshot()
      const current = snapshot.current
      return current === undefined ? undefined : snapshot.byId[current]?.cwd
    })
    useEffect(() => ctx.sessions.list.subscribe(() => {
      const snapshot = ctx.sessions.list.getSnapshot()
      const current = snapshot.current
      setSessionId(current)
      setCwd(current === undefined ? undefined : snapshot.byId[current]?.cwd)
    }), [])

    const [content, setContent] = useState<string | undefined>(undefined)
    const [failed, setFailed] = useState<string | null>(null)
    useEffect(() => {
      if (path === undefined || sessionId === undefined) return
      let cancelled = false
      setContent(undefined)
      setFailed(null)
      const scope: SessionScope = { sessionId, ...(cwd !== undefined ? { cwd } : {}) }
      api.fsRead(scope, path)
        .then((result) => {
          if (cancelled) return
          if (result.kind === 'text') setContent(result.content)
          else setFailed(t('centerFileBinary'))
        })
        .catch((failure: unknown) => {
          if (!cancelled) setFailed(failure instanceof Error ? failure.message : String(failure))
        })
      return () => { cancelled = true }
    }, [path, sessionId, cwd])

    if (path === undefined) {
      return <div style={{ padding: 12, fontSize: 13, opacity: 0.7 }}>{t('edit')}</div>
    }
    if (failed !== null) {
      return <div style={{ padding: 12, fontSize: 13, opacity: 0.85 }}>{failed}</div>
    }
    if (content === undefined || sessionId === undefined) {
      return <div style={{ padding: 12, fontSize: 13, opacity: 0.7 }}>{t('loading')}</div>
    }
    const scope: SessionScope = { sessionId, ...(cwd !== undefined ? { cwd } : {}) }
    return (
      <LazyTextEditor
        ctx={ctx}
        store={store}
        scope={scope}
        path={path}
        title={baseName(path)}
        viewerId="code"
        content={content}
      />
    )
  }
}
