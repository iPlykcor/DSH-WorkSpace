/**
 * The streaming media viewer for audio/video files: renders the file through
 * the dedicated `/sidebar/video` route (`videoUrl`), which streams with HTTP
 * Range (206) support and is not capped by the 20MB mediaLimit of the
 * buffered `/sidebar/file` route — so large files play inline and the
 * browser's progress bar can be scrubbed.
 *
 * Audio extensions render as an <audio> element, video extensions as a
 * <video> element; both fail over to a download link (codec unsupported by
 * the browser or a stream error). Styling is inline (see the note in
 * sidebar.module.css: that file is not UTF-8, so no class is added here).
 */
import { useState, type CSSProperties, type ReactNode } from 'react'
import { downloadUrl, videoUrl } from './api.ts'
import { isAudioExt } from './media.ts'
import { extOf } from './paths.ts'
import type { FileViewerProps } from './service.ts'
import { t } from './locales.ts'

export function VideoView({ scope, path, title }: FileViewerProps): ReactNode {
  const [failed, setFailed] = useState(false)
  const url = videoUrl(scope, path)
  const audio = isAudioExt(extOf(path))
  const stage: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'column',
    gap: 12,
    height: '100%',
    overflow: 'auto',
    padding: 12,
  }
  const media: CSSProperties = audio
    ? { width: '100%', maxWidth: 640 }
    : { maxWidth: '100%', maxHeight: '100%' }
  return (
    <div style={stage}>
      {audio ? (
        <audio
          controls
          preload="metadata"
          src={url}
          aria-label={title}
          onError={() => setFailed(true)}
          style={media}
        />
      ) : (
        <video
          controls
          preload="metadata"
          src={url}
          aria-label={title}
          onError={() => setFailed(true)}
          style={media}
        />
      )}
      {failed && (
        <a style={{ color: 'var(--dsw-accent, #3c6bff)' }} href={downloadUrl(scope, path)} download>
          {t('downloadToView')}
        </a>
      )}
    </div>
  )
}
