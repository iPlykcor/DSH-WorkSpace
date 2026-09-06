/**
 * The file viewer behind `*.dsh-workspace` (multi-root workspace manifests).
 * Shows the parsed document (name, per-folder access, warnings/errors) and —
 * by default, per the manifest's `settings.autoActivate` — applies it to the
 * sidebar on open: the host reads + validates the file and returns an
 * authoritative snapshot that replaces the session's tree with one root per
 * folder. Applying is idempotent; the manifest file stays the single source
 * of truth (host restarts re-activate from this path via the persisted
 * snapshot in SidebarState).
 */
import { useEffect, useState, type ReactNode } from 'react'
import { IconRefreshOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { api } from './api.ts'
import { sanitizeWorkspaceState, setWorkspaceState } from './state.ts'
import { t } from './locales.ts'
import {
  autoActivateOf, parseWorkspaceManifest, WS_MANIFEST_EXTS,
  type DshWorkspaceAccess,
} from '../workspace-schema.ts'
import type { FileViewerProps } from './service.ts'
import css from './sidebar.module.css'

/** The workspace-manifest viewer (a registered file viewer). */
export function WorkspaceFileView(props: FileViewerProps): ReactNode {
  const { ctx, scope, path, content, store } = props
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const parsed = content === undefined ? undefined : parseWorkspaceManifest(content)
  const manifestName = parsed?.manifest?.name ?? path.split(/[\\/]/).pop() ?? path
  const autoApply = parsed?.manifest !== undefined && autoActivateOf(parsed.manifest.settings)

  /** Ask the host to (re)activate this manifest for the session. */
  const apply = (): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    setNote(null)
    api.workspaceActivate({ sessionId: scope.sessionId, cwd: scope.cwd }, path)
      .then((result) => {
        store.reduce(s => setWorkspaceState(s, sanitizeWorkspaceState(result.workspace)))
        setNote(result.warnings.length > 0 ? result.warnings.join('; ') : t('workspaceApplied'))
        // Bring the multi-root tree into sight (a path-less editor tab IS the
        // files window): the file tab stays open, the explorer shows one root
        // per folder, and the window is titled after the workspace name.
        ctx.get('betterSidebar')?.openTab({
          type: 'editor',
          title: result.workspace.name,
          meta: { treeOpen: true },
        })
      })
      .catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure))
      })
      .finally(() => { setBusy(false) })
  }

  // Auto-apply once per open unless the manifest opts out.
  useEffect(() => { if (autoApply) apply() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={css.wsView}>
      <div className={css.wsViewHeader}>
        <span className={css.wsViewTitle}>{manifestName}</span>
        <span className={css.wsViewPath}>{path}</span>
      </div>
      {content === undefined ? (
        <div className={css.editorSearchHint}>{t('loading')}</div>
      ) : parsed?.manifest === undefined ? (
        <div className={css.editorSearchHint} role="alert">
          {parsed !== undefined && parsed.errors.length > 0
            ? parsed.errors.map(issue => issue.message).join('; ')
            : t('workspaceInvalidManifest')}
        </div>
      ) : (
        <>
          {error !== null && <div className={css.wsViewError} role="alert">{error}</div>}
          {note !== null && <div className={css.editorSearchHint}>{note}</div>}
          {parsed.warnings.length > 0 && (
            <div className={css.editorSearchHint}>{parsed.warnings.map(w => w.message).join('; ')}</div>
          )}
          <div className={css.wsViewList}>
            {parsed.manifest.folders.map((folder, index) => {
              const access: DshWorkspaceAccess = folder.access ?? parsed.manifest?.settings?.defaultAccess ?? 'readOnly'
              return (
                <div key={`${folder.path}:${index}`} className={css.wsViewRow}>
                  <span className={css.wsViewRowName} title={folder.path}>
                    {folder.name ?? folder.path}
                  </span>
                  <span
                    className={access === 'readOnly' ? css.wsViewRowLocked : css.wsViewRowWritable}
                  >
                    {access === 'readOnly' ? t('workspaceFolderReadOnly') : 'readWrite'}
                  </span>
                </div>
              )
            })}
          </div>
        </>
      )}
      <div className={css.wsViewActions}>
        <button
          type="button"
          className={css.wsViewActionButton}
          disabled={busy || parsed?.manifest === undefined}
          onClick={apply}
        >
          {busy ? t('loading') : t('workspaceApply')}
        </button>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('refresh')}
          title={t('refresh')}
          disabled={busy || parsed?.manifest === undefined}
          onClick={apply}
        >
          <IconRefreshOutline16 size={14} />
        </button>
      </div>
      <div className={css.wsViewNote}>
        {WS_MANIFEST_EXTS.map(ext => `.${ext}`).join(', ')} · {autoApply ? t('workspaceAutoApplyOn') : t('workspaceAutoApplyOff')}
      </div>
    </div>
  )
}
