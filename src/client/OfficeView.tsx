/**
 * The office (docx / xlsx / pptx) viewer entry, shared by the sidebar editor
 * and the center-column "Files" view. It lazily loads the `office` chunk
 * (chunk-loader) and hands the file bytes to the matching renderer, which
 * paints into the stage element.
 *
 * Bytes: the editor path passes them as `customData` (the descriptor's `load`
 * fetched them); the center view passes no `customData`, so this component
 * fetches them itself via the buffered `/sidebar/file` route (mediaUrl). The
 * three viewers differ only by `viewerId`: 'docx' → renderDocx,
 * 'spreadsheet' → renderSpreadsheet, 'presentation' → renderPptx.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { loadChunk } from './chunk-loader.ts'
import { mediaUrl, type SessionScope } from './api.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

const RENDER_KEY: Record<string, string> = {
  docx: 'renderDocx',
  spreadsheet: 'renderSpreadsheet',
  presentation: 'renderPptx',
}

type RenderFn = (
  bytes: ArrayBuffer,
  container: HTMLElement,
  signal?: AbortSignal,
) => Promise<(() => void) | void>

/** The slice of props OfficeView actually reads (a subset of FileViewerProps). */
export interface OfficeViewProps {
  scope: SessionScope
  path: string
  title?: string
  viewerId: string
  customData?: unknown
}

export function OfficeView({ viewerId, customData, scope, path }: OfficeViewProps): ReactNode {
  const stageRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const el = stageRef.current
    if (el === null) return
    let cancelled = false
    let dispose: (() => void) | void = undefined
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const bytes = customData === undefined
          ? await fetchBytes(scope, path, controller.signal)
          : (customData as ArrayBuffer)
        const mod = await loadChunk('office')
        const key = RENDER_KEY[viewerId]
        const render = (key === undefined ? undefined : mod[key]) as RenderFn | undefined
        if (render === undefined) throw new Error(`unknown office renderer "${viewerId}"`)
        dispose = await render(bytes, el, controller.signal)
        if (cancelled && typeof dispose === 'function') dispose()
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
      controller.abort()
      if (typeof dispose === 'function') dispose()
    }
  }, [viewerId, customData, scope.sessionId, scope.cwd, path])

  const wrapper: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    position: 'relative',
  }
  const stage: React.CSSProperties = { flex: 1, overflow: 'auto', minHeight: 0 }
  return (
    <div style={wrapper}>
      {loading && <div className={css.editorPlaceholder}>{t('loading')}</div>}
      {error !== null && <div className={css.editorError} role="alert">{error}</div>}
      <div ref={stageRef} style={stage} />
    </div>
  )
}

async function fetchBytes(scope: SessionScope, path: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(mediaUrl(scope, path), { signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.arrayBuffer()
}
