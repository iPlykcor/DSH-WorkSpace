/**
 * The `conversation.view` entry the sidebar plugin contributes: a "文件" view
 * tab rendered in the CENTER column beside 对话 / 轨迹. It shows the file most
 * recently opened in that session's sidebar (via center-file.ts). v1 is a
 * read-only text preview; editing/preview-for-binary comes next. Rendered
 * inside an error boundary so it can never break the center conversation.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { api } from './api.ts'
import { getCenterFile, subscribeCenterFile } from './center-file.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

/** Structural props the slot hands the component (inject result merged in). */
export interface CenterFileViewProps {
  sessionId: string
}

export function CenterFileView(props: CenterFileViewProps): ReactNode {
  const { sessionId } = props
  const [path, setPath] = useState<string>(() => getCenterFile(sessionId))
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => subscribeCenterFile(() => setPath(getCenterFile(sessionId))), [sessionId])

  useEffect(() => {
    setText(null)
    setError(null)
    if (path === '') return
    let cancelled = false
    api.fsRead({ sessionId }, path)
      .then((result) => {
        if (cancelled) return
        if (result.kind === 'text') setText(result.content)
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

  return (
    <div className={css.centerFile}>
      <div className={css.centerFilePath} title={path}>{path}</div>
      {error !== null && <div className={css.centerFileError} role="alert">{error}</div>}
      {error === null && text === null && <div className={css.centerFileEmpty}>{t('loading')}</div>}
      {error === null && text !== null && (
        <pre className={css.centerFilePre}>{text}</pre>
      )}
    </div>
  )
}
