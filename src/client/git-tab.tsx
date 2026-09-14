/**
 * Git-panel tab for the DSH 0.1.5+ built-in right Sidebar.
 *
 * The product ships no Git surface, so the plugin's existing changes panel
 * (status / diff / stage / commit / log, with its session lens) is exposed as
 * its own tab type in the built-in Sidebar. The component and its host routes
 * are reused unchanged; this module only registers the type and supplies the
 * plugin-model props the component consumes.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { ChangesTab } from './changes/ChangesTab.tsx'
import { t } from './locales.ts'
import type { Context, SidebarRightTabsFace } from '../context-types.ts'
import type { SidebarStore } from './state.ts'
import type { SessionScope } from './api.ts'
import type { TabComponentProps } from './service.ts'

/** Tab implementation identity; also the key its body/title register under. */
export const GIT_ID = 'dsh-workspace/git'
/** Type discriminator the tab is opened by. */
export const GIT_KIND = 'git'

/** The plugin tab type the changes panel expects (`SidebarTab.type`). */
const CHANGES_TAB_TYPE = 'changes'

/**
 * Register the Git panel tab into the built-in right Sidebar.
 * No-op on hosts without the 0.1.5 extension points.
 * @param ctx - the client cordis context.
 * @param store - the plugin's sidebar store (the panel's persistence host).
 * @returns a disposer unregistering the type, body and title.
 */
export function registerGitTab(ctx: Context, store: SidebarStore): () => void {
  const tabs = ctx.get('sidebarRightTabs') as SidebarRightTabsFace | undefined
  if (tabs === undefined) return () => {}

  const body = ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: GIT_ID,
  }, makeGitBody(ctx, store)))
  const title = ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title',
    key: GIT_ID,
  }, function GitTitle(): ReactNode {
    return <span>{t('changes')}</span>
  }))
  const type = tabs.register({
    id: GIT_ID,
    kind: GIT_KIND,
    priority: 'extension',
    title: () => t('changes'),
    guide: [{ order: 22, title: () => t('changes') }],
  })
  return () => { type(); body(); title() }
}

/**
 * Build the Git body. The panel is a plugin-model tab component, so the body
 * synthesizes the tab record it expects and tracks the current session for its
 * scope (the panel's own routes are conversation-scoped, exactly as before).
 */
function makeGitBody(ctx: Context, store: SidebarStore): () => ReactNode {
  return function GitTabBody(): ReactNode {
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

    if (sessionId === undefined) {
      return <div style={{ padding: 12, fontSize: 13, opacity: 0.7 }}>{t('loading')}</div>
    }
    const scope: SessionScope = { sessionId, ...(cwd !== undefined ? { cwd } : {}) }
    const tab = { id: GIT_ID, type: CHANGES_TAB_TYPE, title: t('changes') } as unknown as TabComponentProps['tab']
    return <ChangesTab ctx={ctx} store={store} scope={scope} tab={tab} visible />
  }
}
