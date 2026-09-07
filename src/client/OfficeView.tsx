/**
 * The office (docx / xlsx / pptx) viewer entry. The descriptor's `load` returns
 * the raw file bytes as `customData`; this component lazily loads the `office`
 * chunk (chunk-loader) and hands the bytes to the matching renderer, which
 * paints into the stage element.
 *
 * The three viewers share this component and differ only by `viewerId`:
 * 'docx' → renderDocx, 'spreadsheet' → renderSpreadsheet, 'presentation' →
 * renderPptx.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { loadChunk } from './chunk-loader.ts'
import type { FileViewerProps } from './service.ts'
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

export function OfficeView({ viewerId, customData }: FileViewerProps): ReactNode {
  const stageRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (customData === undefined) return
    const el = stageRef.current
    if (el === null) return
    let cancelled = false
    let dispose: (() => void) | void = undefined
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const mod = await loadChunk('office')
        const key = RENDER_KEY[viewerId]
        const render = (key === undefined ? undefined : mod[key]) as RenderFn | undefined
        if (render === undefined) throw new Error(`unknown office renderer "${viewerId}"`)
        dispose = await render(customData as ArrayBuffer, el, controller.signal)
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
  }, [viewerId, customData])

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
