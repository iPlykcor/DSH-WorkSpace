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
  guideDescription: '在会话工作区内高效访问工作区外的资源。',
  shortcutNoSession: '当前没有可用的会话面板',
  workspaceApply: '应用此作业区',
  workspaceApplied: '已应用',
  workspaceApplyFailed: '应用失败：{message}',
  menuAddFolderReadOnly: '选择文件夹加入作业区（只读）',
  folderPicking: '等待选择文件夹…',
  folderAdded: '已加入作业区：{label}',
  folderAlready: '该文件夹已在作业区内：{label}',
  folderAddFailed: '加入失败：{message}',
  folderAddUnavailable: '此宿主没有可用的文件夹选择器',
  folderUnlockAction: '点击解锁为读写',
  folderLockAction: '点击锁定为只读',
  folderAccessImplicit: '会话工作区（隐含读写根）；要调整权限请把它写进清单',
  folderUnlocked: '已解锁为读写：{label}',
  folderLocked: '已锁定为只读：{label}',
  folderAccessFailed: '调整权限失败：{message}',
  menuRemoveFolder: '移出作业区',
  menuMakeReadOnly: '改为只读',
  menuMakeReadWrite: '改为读写',
  menuImplicitRoot: '会话工作区（隐含读写根）不在清单里，无法移出或调整权限',
  removeFolderTitle: '移出作业区？',
  removeFolderDescription: '只会从清单里删掉“{label}”这一条声明；磁盘上的文件夹本身不受影响，改动前也会先留一份备份。',
  removeFolderAcknowledge: '我明白这只改清单，不会动磁盘上的文件夹',
  removeFolderConfirm: '移出',
  removeFolderCancel: '取消',
  removeFolderClose: '关闭',
  folderRemoved: '已从作业区移出：{label}（文件夹本身未改动）',
  folderRemovedImplicit: '已移出清单条目：{label}；它仍作为会话工作区（隐含读写根）保留',
  folderRemoveFailed: '移出失败：{message}',
  workspaceDeactivate: '退出作业区',
  workspaceRoots: '{n} 个根目录',
  workspaceFolderReadOnly: '只读文件夹（不可写入）',
  workspaceFolderReadWrite: '读写文件夹（可写入）',
  workspaceFolderPath: '文件夹绝对路径',
  workspaceMissingFolder: '目录缺失',
  workspaceOpenFolder: '在文件资源管理器中打开',
  workspaceShowFile: '在文件资源管理器中选中此文件',
  workspaceRevealFailed: '无法在文件管理器中打开：{message}',
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
  guideDescription: 'Reach resources outside the session workspace, efficiently.',
  shortcutNoSession: 'No session pane is available',
  workspaceApply: 'Apply this space',
  workspaceApplied: 'Applied',
  workspaceApplyFailed: 'Apply failed: {message}',
  menuAddFolderReadOnly: 'Choose a folder to add (read-only)',
  folderPicking: 'Waiting for a folder…',
  folderAdded: 'Added to the operation space: {label}',
  folderAlready: 'Already part of the operation space: {label}',
  folderAddFailed: 'Could not add: {message}',
  folderAddUnavailable: 'This host has no folder chooser',
  folderUnlockAction: 'Click to unlock for writing',
  folderLockAction: 'Click to lock to read-only',
  folderAccessImplicit: 'Session workspace (implicit read-write root); add it to the manifest to change that',
  folderUnlocked: 'Unlocked for writing: {label}',
  folderLocked: 'Locked to read-only: {label}',
  folderAccessFailed: 'Could not change the access: {message}',
  menuRemoveFolder: 'Remove from operation space',
  menuMakeReadOnly: 'Make read-only',
  menuMakeReadWrite: 'Make read-write',
  menuImplicitRoot: 'The session folder (implicit read-write root) is not in the manifest, so it cannot be removed or re-permissioned',
  removeFolderTitle: 'Remove from the operation space?',
  removeFolderDescription: 'This deletes only the “{label}” declaration from the manifest. The folder on disk is not touched, and a backup is kept first.',
  removeFolderAcknowledge: 'I understand this only edits the manifest, not the folder on disk',
  removeFolderConfirm: 'Remove',
  removeFolderCancel: 'Cancel',
  removeFolderClose: 'Close',
  folderRemoved: 'Removed from the operation space: {label} (the folder itself is untouched)',
  folderRemovedImplicit: 'Manifest entry removed: {label}; it stays as the session folder (implicit read-write root)',
  folderRemoveFailed: 'Could not remove it: {message}',
  workspaceDeactivate: 'Leave the operation space',
  workspaceRoots: '{n} roots',
  workspaceFolderReadOnly: 'Read-only folder (writes refused)',
  workspaceFolderReadWrite: 'Read-write folder (writes allowed)',
  workspaceFolderPath: 'Absolute folder path',
  workspaceMissingFolder: 'Missing',
  workspaceOpenFolder: 'Open in the file manager',
  workspaceShowFile: 'Show this file in the file manager',
  workspaceRevealFailed: 'Could not open the file manager: {message}',
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
