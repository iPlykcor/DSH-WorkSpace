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
import { useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconCheckOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, mediaUrl, videoUrl } from './api.ts'
import { getCenterFile, subscribeCenterFile } from './center-file.ts'
import { isAudioExt, isMediaExt } from './media.ts'
import { isOfficeExt, officeViewerIdForExt } from './office-detect.ts'
import { lazyChunkComponent } from './lazy-chunk.tsx'
import { OfficeView } from './OfficeView.tsx'
import type { EditorToolbarControls, EditorToolbarState, FileViewerProps } from './service.ts'
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
  // Fixed editor toolbar (mode toggle / dirty / save / status), fed by the
  // hosted TextEditor via toolbar:'host' — so the toolbar row never scrolls
  // with the content (center-file view scrolls only the editor body).
  const [toolbar, setToolbar] = useState<EditorToolbarState | null>(null)
  const controlsRef = useRef<EditorToolbarControls | null>(null)
  const onToolbarState = useCallback((next: EditorToolbarState) => {
    setToolbar(prev => prev !== null && JSON.stringify(prev) === JSON.stringify(next) ? prev : next)
  }, [])
  const onToolbarControls = useCallback((controls: EditorToolbarControls | null) => {
    controlsRef.current = controls
  }, [])

  useEffect(() => subscribeCenterFile(() => setPath(getCenterFile(sessionId))), [sessionId])

  // A file swap clears any stale hoisted toolbar state (the hosted editor
  // reports its own fresh state on re-render).
  useEffect(() => { setToolbar(null) }, [content])

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
    // Office files fill the whole center area (a document viewer), NOT the
    // centered media wrapper — the pptx fitMode scales against the container
    // width, and the media wrapper's flex centering would give it a tiny box.
    return (
      <div style={{ height: '100%', width: '100%' }}>
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
  const saveLabel = toolbar?.saveState === 'saving'
    ? t('loading')
    : toolbar?.saveState === 'saved'
      ? t('saved')
      : toolbar?.saveState === 'failed' ? t('saveFailed') : ''
  return (
    <div className={css.centerFileEditor}>
      <div className={css.editorHeader}>
        {toolbar?.modes === true && (
          <div className={css.editorModeToggle}>
            <button
              type="button"
              className={clsx(css.editorModeButton, toolbar.mode === 'preview' && css.editorModeActive)}
              onClick={() => { controlsRef.current?.setMode('preview') }}
            >
              {t('preview')}
            </button>
            <button
              type="button"
              className={clsx(css.editorModeButton, toolbar.mode === 'edit' && css.editorModeActive)}
              onClick={() => { controlsRef.current?.setMode('edit') }}
            >
              {t('edit')}
            </button>
          </div>
        )}
        {toolbar?.dirty === true && <span className={css.dirtyDot} title={t('unsaved')} />}
        {toolbar?.editable === true && (
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('save')}
            title={`${t('save')} (Ctrl/Cmd+S)`}
            onClick={() => { controlsRef.current?.save() }}
          >
            <IconCheckOutline16 size={14} />
          </button>
        )}
        {saveLabel !== '' && (
          <span className={clsx(css.editorStatus, toolbar?.saveState === 'failed' && css.editorStatusError)}>
            {saveLabel}
          </span>
        )}
      </div>
      {content.truncated && <div className={css.centerFileError}>{t('editorSearchTruncated')}</div>}
      <div className={css.editorBody}>
        <div className={css.editorMain}>
          <LazyTextEditor
            ctx={ctx as never}
            store={store}
            scope={scope}
            path={path}
            title={path}
            content={content.text}
            viewerId={ext === 'md' || ext === 'markdown' ? 'markdown' : 'code'}
            toolbar="host"
            onToolbarState={onToolbarState}
            onToolbarControls={onToolbarControls}
          />
        </div>
      </div>
    </div>
  )
}
