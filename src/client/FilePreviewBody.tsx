/**
 * Shared file-preview body: renders one file's bytes by extension, reusing the
 * plugin's existing lazy chunks.
 *
 * Two surfaces share it:
 * - the document-preview implementations registered into the built-in right
 *   Sidebar (`ctx.documentPreviews`), whose owner hands over the file's
 *   complete bytes;
 * - the multi-root tab's own in-tab preview, which fetches bytes through the
 *   plugin's `/sidebar/blob` route (the only channel that reaches a root the
 *   built-in single-root file service refuses).
 *
 * Archives render as the plugin's read-only listing (`ZipView` with the bytes
 * supplied); Office goes through the `office` chunk; images/PDF/media become
 * Blob URLs (media may stream through the plugin's `/sidebar/video` route when
 * the caller supplies `mediaUrl`); everything else decodes as text.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { loadChunk } from './chunk-loader.ts'
import { extOfPath, isArchiveExt } from './archive-format.ts'
import { isAudioExt, isMediaExt } from './media.ts'
import { ZipView } from './ZipView.tsx'
import css from './sidebar.module.css'
import type { SessionScope } from './api.ts'

/** Image extensions rendered through a Blob URL. */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'])
/** Office extensions rendered through the `office` chunk. */
const OFFICE_EXTS = new Set(['docx', 'xlsx', 'pptx'])

const mimeForImage = (ext: string): string => {
  const mime: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  }
  return mime[ext] ?? 'application/octet-stream'
}

/** Props shared by every surface that previews one file's bytes. */
export interface FilePreviewBodyProps {
  scope: SessionScope
  /** Display path (its extension selects the renderer). */
  path: string
  /** The file's complete bytes. */
  bytes: ArrayBuffer
  /**
   * Streaming URL for audio/video, when the caller has one (the in-tab preview
   * passes the plugin's `/sidebar/video` route). Without it, media falls back
   * to a Blob URL over `bytes`.
   */
  mediaUrl?: string
}

/**
 * Render one file's bytes by extension.
 * @param props - the session scope, the path, the bytes, and an optional media URL.
 * @returns the rendered preview.
 */
export function FilePreviewBody({ scope, path, bytes, mediaUrl }: FilePreviewBodyProps): ReactNode {
  const stageRef = useRef<HTMLDivElement>(null)
  const ext = extOfPath(path)
  const archive = isArchiveExt(ext)

  useEffect(() => {
    if (archive) return
    const stage = stageRef.current
    if (stage === null) return
    let dispose: (() => void) | void
    const controller = new AbortController()
    void (async () => {
      stage.replaceChildren()
      if (OFFICE_EXTS.has(ext)) {
        const office = await loadChunk('office')
        const key = ext === 'docx' ? 'renderDocx' : ext === 'xlsx' ? 'renderSpreadsheet' : 'renderPptx'
        const render = (office as Record<string, unknown>)[key] as
          | ((b: ArrayBuffer, c: HTMLElement, s?: AbortSignal) => Promise<(() => void) | void>)
          | undefined
        if (render !== undefined) dispose = await render(bytes, stage, controller.signal)
        return
      }
      if (IMAGE_EXTS.has(ext)) {
        const url = URL.createObjectURL(new Blob([bytes], { type: mimeForImage(ext) }))
        const img = document.createElement('img')
        img.src = url
        img.alt = path
        img.style.maxWidth = '100%'
        img.style.maxHeight = '100%'
        img.style.objectFit = 'contain'
        stage.append(img)
        dispose = () => URL.revokeObjectURL(url)
        return
      }
      if (ext === 'pdf') {
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
        const frame = document.createElement('iframe')
        frame.src = url
        frame.title = path
        frame.style.cssText = 'width:100%;height:100%;border:0'
        stage.append(frame)
        dispose = () => URL.revokeObjectURL(url)
        return
      }
      if (isMediaExt(ext)) {
        const owned = mediaUrl === undefined
        const url = mediaUrl ?? URL.createObjectURL(new Blob([bytes]))
        const media = document.createElement(isAudioExt(ext) ? 'audio' : 'video')
        media.controls = true
        media.src = url
        media.style.cssText = 'max-width:100%;max-height:100%'
        stage.append(media)
        if (owned) dispose = () => URL.revokeObjectURL(url)
        return
      }
      const zip = await loadChunk('zip')
      const text = (zip as { textOf?: (data: Uint8Array) => string }).textOf?.(new Uint8Array(bytes))
        ?? new TextDecoder().decode(bytes)
      const pre = document.createElement('pre')
      pre.textContent = text
      pre.style.cssText = 'white-space:pre-wrap;padding:12px 16px;font-size:13px;margin:0'
      stage.append(pre)
    })().catch((failure: unknown) => {
      stage.replaceChildren()
      const notice = document.createElement('div')
      notice.className = css.editorError ?? ''
      notice.textContent = failure instanceof Error ? failure.message : String(failure)
      stage.append(notice)
    })
    return () => { controller.abort(); if (typeof dispose === 'function') dispose() }
  }, [path, bytes, archive, ext, mediaUrl])

  if (archive) {
    // The archive reader owns the whole surface: a read-only folder listing.
    return <ZipView scope={scope} path={path} customData={bytes} />
  }
  return <div ref={stageRef} style={{ flex: 1, minHeight: 0, overflow: 'auto' }} />
}
