/**
 * The plugin's zh/en copy. The copy follows the DSH i18n system: the client
 * apply attaches the locale service (`ctx.locale`, provided by
 * `@deepseek-ai/dsh-client-locale`) through {@link attachLocale}, and
 * `t()`/`isZh()` resolve the active locale from it — the Host-backed
 * `locale.preference` wins over the raw browser language and switches live.
 * Without an attached service (standalone/test compositions) the browser
 * language is used. The dictionaries are also registered into the DSH locale
 * registry under {@link LOCALE_NS}.
 *
 * There is deliberately no third-language override path here: the plugin has
 * no external consumers of its copy, so a zh/en pair registered through the
 * documented `ctx.locale` API is the whole surface.
 */

/** The zh dictionary (also registered into the DSH locale registry under {@link LOCALE_NS}). */
export const zh = {
  loading: '载入中…',
  refresh: '重新读取清单',
  operationSpace: '章鱼作业区',
  workspaceApply: '应用此作业区',
  workspaceApplied: '已应用',
  workspaceApplyFailed: '应用失败：{message}',
  workspaceDeactivate: '退出作业区',
  workspaceRoots: '{n} 个根目录',
  workspaceFolderReadOnly: '只读文件夹（不可写入）',
  workspaceMissingFolder: '目录缺失',
  workspaceViolations: '只读越权写入 {n} 处',
  workspaceViolationsTitle: '模型写入只读文件夹的记录',
  workspaceViolationMeta: '只读根 {root} · {kind}',
  workspaceRollback: '还原',
  noWorkspace: '本会话尚未应用作业区',
  scanning: '正在扫描当前文件夹…',
  scanNone: '当前文件夹未发现作业区清单',
  scanOne: '当前文件夹发现 1 个清单',
  scanPick: '当前文件夹发现 {n} 个清单，请选择要应用的一个',
  scanAgain: '重新扫描',
  scanAutoOff: '该清单声明 autoActivate: false，需你手动应用',
  candidateBroken: '无法解析',
  emptyFolder: '空目录',
  openUnavailable: '无法调用侧边栏文件视图',
}

/** The copy keys the plugin owns (zh is the source of truth). */
export type CopyKey = keyof typeof zh

/** The en dictionary — every zh key must appear here (enforced by the type). */
export const en: Record<CopyKey, string> = {
  loading: 'Loading…',
  refresh: 'Re-read the manifest',
  operationSpace: 'Operation Space',
  workspaceApply: 'Apply this space',
  workspaceApplied: 'Applied',
  workspaceApplyFailed: 'Apply failed: {message}',
  workspaceDeactivate: 'Leave the operation space',
  workspaceRoots: '{n} roots',
  workspaceFolderReadOnly: 'Read-only folder (writes refused)',
  workspaceMissingFolder: 'Missing',
  workspaceViolations: '{n} write(s) into read-only roots',
  workspaceViolationsTitle: 'Model writes recorded inside read-only folders',
  workspaceViolationMeta: 'read-only root {root} · {kind}',
  workspaceRollback: 'Restore',
  noWorkspace: 'No operation space is applied in this session',
  scanning: 'Scanning the current folder…',
  scanNone: 'No operation-space manifest in the current folder',
  scanOne: '1 manifest found in the current folder',
  scanPick: '{n} manifests found in the current folder — pick one to apply',
  scanAgain: 'Scan again',
  scanAutoOff: 'This manifest sets autoActivate: false, so it needs a manual apply',
  candidateBroken: 'Unparseable',
  emptyFolder: 'Empty folder',
  openUnavailable: 'The Sidebar file view is unavailable',
}

/**
 * The dictionary namespace this plugin owns in the DSH locale registry
 * (`'sidebar'` is taken by DSH's own ui-sidebar).
 */
export const LOCALE_NS = 'octopus'

/** The DSH locale service attached by the client apply (absent → browser detection). */
let localeService: { getSnapshot(): { active: string } } | undefined

/**
 * Attach (or detach, with undefined) the DSH locale service. Components keep
 * calling the plain `t()` function; the tab body subscribes to the locale
 * service itself so a language switch re-renders it.
 * @param service - the locale service, or undefined to detach.
 */
export function attachLocale(service: { getSnapshot(): { active: string } } | undefined): void {
  localeService = service
}

/**
 * The active locale id ('zh' | 'en'): the DSH locale service's snapshot when
 * attached, else the browser language.
 * @returns the active locale id.
 */
function activeLocale(): string {
  return localeService?.getSnapshot().active
    ?? (typeof navigator !== 'undefined' ? navigator.language : '')
    ?? 'en'
}

/**
 * Translate a copy key in the active locale (zh → zh, else en).
 * @param key - the copy key.
 * @param params - optional `{name}` placeholder values.
 * @returns the localized text (the key itself when no dictionary has it).
 */
export function t(key: CopyKey, params?: Record<string, string | number>): string {
  const dict = activeLocale().toLowerCase().startsWith('zh') ? zh : en
  let text: string | undefined = dict[key]
  if (text === undefined) {
    // Key missing from the active dict (should not happen — zh is the source
    // of truth and en is checked against it). Return the key itself so the UI
    // shows something identifiable rather than `undefined`.
    text = key
  }
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return text
}

/**
 * Whether the active locale is Chinese (used for selectors).
 * @returns true when the active locale is a Chinese variant.
 */
export function isZh(): boolean {
  return activeLocale().toLowerCase().startsWith('zh')
}
