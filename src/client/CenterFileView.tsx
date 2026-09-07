/**
 * The `conversation.view` entry the sidebar plugin contributes: a "文件" view
 * tab rendered in the CENTER column beside 对话 / 轨迹. It shows the file most
 * recently opened in that session's sidebar (center-file.ts).
 *
 * v2: text files render through the same lazily-loaded editor (TextEditor) so
 * they are EDITABLE (saves go through the host fs.write route, so workspace
 * read-only folders still 403); images/PDF render through the media route.
 * Any editor failure degrades to a plain read-only <pre> so the center
 * conversation can never break.
 */
import { useEffect, useState, type ComponentType, type ReactNode } from 'react'
import { api, mediaUrl, videoUrl } from './api.ts'
import { getCenterFile, subscribeCenterFile } from './center-file.ts'
import { isAudioExt, isMediaExt } from './media.ts'
import { isOfficeExt, officeViewerIdForExt } from './office-detect.ts'
import { lazyChunkComponent } from './lazy-chunk.tsx'
import { OfficeView } from './OfficeView.tsx'
import type { FileViewerProps } from './service.ts'
import type { SidebarStore } from './state.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'])

function extOf(path: string): string {
  const at = Math.max(path.lastIndexOf('.'), -1)
  return at === -1 ? '' : path.slice(at + 1).toLowerCase()
}

/** Lazily-loaded text editor (the same component the sidebar editor uses). */
const LazyTextEditor = lazyChunkComponent<FileViewerProps>('editor', (mod) => mod.TextEditor as ComponentType<FileViewerProps> | undefined)

/** Structural props the conversation.view slot hands the component. */
export interface CenterFileViewProps {
  sessionId: string
  store: SidebarStore
  ctx: unknown
}

export function CenterFileView(props: CenterFileViewProps): ReactNode {
  const { sessionId, store, ctx } = props
  const [path, setPath] = useState<string>(() => getCenterFile(sessionId))
  const [content, setContent] = useState<{ text: string; truncated: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => subscribeCenterFile(() => setPath(getCenterFile(sessionId))), [sessionId])

  useEffect(() => {
    setContent(null)
    setError(null)
    if (path === '') return
    const ext = extOf(path)
    // Media types are previewed through the media route (no fs.read needed).
    if (IMAGE_EXTS.has(ext)) return
    if (ext === 'pdf') return
    if (isMediaExt(ext)) return
    if (isOfficeExt(ext)) return
    let cancelled = false
    api.fsRead({ sessionId }, path)
      .then((result) => {
        if (cancelled) return
        if (result.kind === 'text') setContent({ text: result.content, truncated: result.truncated })
        else setError(t('centerFileBinary'))
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure))
      })
    return () => { cancelled = true }
  }, [sessionId, path])

  if (path === '') {
    return <div className={css.centerFileEmpty}>{t('centerFileEmpty')}</div>
  }

  const scope = { sessionId }
  const ext = extOf(path)

  if (IMAGE_EXTS.has(ext)) {
    return (
      <div className={css.centerFileMedia}>
        <img className={css.centerFileImg} src={mediaUrl(scope, path)} alt={path} />
      </div>
    )
  }
  if (ext === 'pdf') {
    return (
      <div className={css.centerFileMedia}>
        <iframe className={css.centerFilePdf} src={mediaUrl(scope, path)} title={path} />
      </div>
    )
  }
  if (isMediaExt(ext)) {
    const url = videoUrl(scope, path)
    return (
      <div className={css.centerFileMedia}>
        {isAudioExt(ext)
          ? <audio controls className={css.centerFilePdf} src={url} aria-label={path} />
          : <video controls className={css.centerFilePdf} src={url} aria-label={path} />}
      </div>
    )
  }
  const officeViewerId = officeViewerIdForExt(ext)
  if (officeViewerId !== undefined) {
    return (
      <div className={css.centerFileMedia}>
        <OfficeView scope={scope} path={path} viewerId={officeViewerId} title={path} />
      </div>
    )
  }

  if (error !== null) {
    return <div className={css.centerFileError} role="alert">{error}</div>
  }
  if (content === null) {
    return <div className={css.centerFileEmpty}>{t('loading')}</div>
  }
  return (
    <div className={css.centerFileEditor}>
      {content.truncated && <div className={css.centerFileError}>{t('editorSearchTruncated')}</div>}
      <LazyTextEditor
        ctx={ctx as never}
        store={store}
        scope={scope}
        path={path}
        title={path}
        content={content.text}
        viewerId={ext === 'md' || ext === 'markdown' ? 'markdown' : 'code'}
      />
    </div>
  )
}
