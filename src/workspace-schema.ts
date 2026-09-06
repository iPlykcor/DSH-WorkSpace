/**
 * Shared `.dsh-workspace` manifest vocabulary: types, JSONC-tolerant parsing
 * and pure path-matching helpers. Consumed by BOTH halves — the host parses
 * and activates manifests (workspace-policy.ts / index.ts) and the client
 * renders the resolved snapshot and derives read-only rows from it
 * (client/workspace-model.ts). Kept free of Node.js and schemastery so the
 * browser bundle can inline it unchanged.
 *
 * Format (VSCode-code-workspace-like, JSONC tolerated):
 *
 * ```jsonc
 * {
 *   "version": 1,                            // optional
 *   "name": "My multi-root workspace",       // optional
 *   "folders": [
 *     { "path": "C:/repo/a", "access": "readWrite" },
 *     { "path": "../docs" },                 // relative to the manifest file
 *     "C:/repo/b"                            // string shorthand (default access)
 *   ],
 *   "settings": {
 *     "defaultAccess": "readWrite",          // readWrite | readOnly (default readOnly)
 *     "autoActivate": true                   // open file => apply (default true)
 *   }
 * }
 * ```
 *
 * Security default (product decision): a folder WITHOUT an explicit `access`
 * is `readOnly` unless `settings.defaultAccess` flips the default. Activation
 * is an explicit trust action; the host then enforces per-folder access on
 * every sidebar filesystem route.
 */

/** Per-folder permission: writable, or read-only. */
export type DshWorkspaceAccess = 'readWrite' | 'readOnly'

export interface DshWorkspaceSettings {
  /** Default `access` of folders without their own; defaults to readOnly. */
  defaultAccess?: DshWorkspaceAccess
  /** Open the manifest file => apply it to the sidebar (default true). */
  autoActivate?: boolean
}

/** One `folders[]` entry: the object form (string shorthand expands to this). */
export interface DshWorkspaceFolderSpec {
  /** Absolute path, or a path relative to the manifest file's directory. */
  path: string
  /** Optional display label overriding the folder's base name. */
  name?: string
  /** Per-folder permission; absent => `defaultAccess` => readOnly. */
  access?: DshWorkspaceAccess
}

/** The parsed manifest document (validation-passed shape). */
export interface DshWorkspaceFile {
  /** Format version; 1 is the only accepted value (others warn and continue). */
  version?: number
  /** Optional workspace title; defaults to the manifest file's base name. */
  name?: string
  /** The multi-root folder list (order = display order). */
  folders: DshWorkspaceFolderSpec[]
  settings?: DshWorkspaceSettings
}

/** One parse/validation finding (entry-level reference, e.g. `folders[2]`). */
export interface WsManifestIssue {
  message: string
}

/** Strict vs. soft outcome of a parse attempt. */
export interface WsManifestParseResult {
  /** Present only when the document parsed with no blocking errors. */
  manifest?: DshWorkspaceFile
  /** Blocking errors: the document must not be activated. */
  errors: WsManifestIssue[]
  /** Soft warnings: applied with the stated fallbacks (never blocking). */
  warnings: WsManifestIssue[]
}

/** The security default: unlabeled folders are read-only. */
export const DEFAULT_WS_FOLDER_ACCESS: DshWorkspaceAccess = 'readOnly'

/** Open-a-manifest auto-applies by default. */
export const DEFAULT_WS_AUTO_ACTIVATE = true

/** Accepted manifest format version. */
export const WS_MANIFEST_VERSION = 1

/** Byte cap of one manifest file read by the host (config files stay small). */
export const WS_MANIFEST_MAX_BYTES = 256 * 1024

/** The manifest file extensions the workspace viewer claims. */
export const WS_MANIFEST_EXTS = ['dsh-workspace'] as const

const ACCESS_VALUES: readonly DshWorkspaceAccess[] = ['readWrite', 'readOnly']

/** Normalize an `access` value; undefined/unknown fall back to the default. */
export function isWsAccess(value: unknown): value is DshWorkspaceAccess {
  return typeof value === 'string' && (ACCESS_VALUES as readonly string[]).includes(value)
}

/**
 * JSONC normalization in two passes, both string-literal aware: first the
 * comments go (a comment is replaced by nothing but keeps its newlines so
 * source line hints do not drift), then trailing commas drop (the comma must
 * be followed — ignoring whitespace — by the closing brace/bracket). Strings
 * keep their full contents, including escaped quotes and sequences that
 * would otherwise look like comments, such as "//x" or a slash-star pair
 * inside a string. Malformed input is returned as-is and left to
 * `JSON.parse` to reject.
 */
export function stripJsonc(input: string): string {
  return stripWsTrailingCommas(stripWsComments(input))
}

/** Pass 1: remove `//` and slash-star block comments outside strings. */
function stripWsComments(input: string): string {
  let out = ''
  let i = 0
  let inString = false
  while (i < input.length) {
    const ch = input[i]!
    const next = input[i + 1]
    if (inString) {
      out += ch
      if (ch === '\\' && next !== undefined) {
        // Escaped char belongs to the string: copy it verbatim (handles
        // `\"` and `\\`; an escaped newline continuation just copies too).
        out += next
        i += 1
      } else if (ch === '"') {
        inString = false
      }
      i += 1
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      // Line comment: drop through (but not including) the newline.
      while (i < input.length && input[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      // Block comment: drop until `*/`, preserving newlines inside it.
      i += 2
      while (i < input.length) {
        if (input[i] === '\n') out += '\n'
        if (input[i] === '*' && input[i + 1] === '/') {
          i += 2
          break
        }
        i += 1
      }
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/** Pass 2: drop trailing commas (`,}` / `,]`) outside strings. */
function stripWsTrailingCommas(input: string): string {
  let out = ''
  let i = 0
  let inString = false
  while (i < input.length) {
    const ch = input[i]!
    const next = input[i + 1]
    if (inString) {
      out += ch
      if (ch === '\\' && next !== undefined) {
        out += next
        i += 1
      } else if (ch === '"') {
        inString = false
      }
      i += 1
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      i += 1
      continue
    }
    if (ch === ',') {
      // Look past whitespace: if the value closes next, the comma is trailing.
      let j = i + 1
      while (j < input.length && (input[j] === ' ' || input[j] === '\t' || input[j] === '\n' || input[j] === '\r')) j += 1
      if (j < input.length && (input[j] === '}' || input[j] === ']')) {
        i += 1
        continue
      }
    }
    out += ch
    i += 1
  }
  return out
}

/** A plain (non-array, non-null) object guard for manifest fields. */
function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Parse + validate one `.dsh-workspace` document (JSONC tolerated).
 * Blocking errors (malformed JSON, a non-object root, a missing/non-array
 * `folders`, an entry without a usable `path`) leave `manifest` undefined;
 * soft warnings (unknown version, non-string name, unknown access, wrong
 * settings types) fall back to documented defaults.
 */
export function parseWorkspaceManifest(text: string): WsManifestParseResult {
  const errors: WsManifestIssue[] = []
  const warnings: WsManifestIssue[] = []
  let root: unknown
  try {
    root = JSON.parse(stripJsonc(text)) as unknown
  } catch (error) {
    errors.push({ message: `not valid JSON (JSONC comments allowed): ${error instanceof Error ? error.message : String(error)}` })
    return { errors, warnings }
  }
  if (!plainRecord(root)) {
    errors.push({ message: 'top level must be a JSON object' })
    return { errors, warnings }
  }
  const foldersRaw = root.folders
  if (!Array.isArray(foldersRaw) || foldersRaw.length === 0) {
    errors.push({ message: '"folders" must be a non-empty array' })
  }
  const folders: DshWorkspaceFolderSpec[] = []
  if (Array.isArray(foldersRaw)) {
    foldersRaw.forEach((entry, index) => {
      const at = `folders[${index}]`
      let spec: DshWorkspaceFolderSpec
      if (typeof entry === 'string') {
        if (entry.trim() === '') {
          errors.push({ message: `${at}: a folder path must not be empty` })
          return
        }
        spec = { path: entry }
      } else if (plainRecord(entry)) {
        const path = entry.path
        if (typeof path !== 'string' || path.trim() === '') {
          errors.push({ message: `${at}: "path" must be a non-empty string` })
          return
        }
        const access = entry.access
        if (access !== undefined && !isWsAccess(access)) {
          warnings.push({ message: `${at}: unknown access "${String(access)}"; using the default` })
        }
        if (entry.name !== undefined && typeof entry.name !== 'string') {
          warnings.push({ message: `${at}: "name" must be a string; ignoring it` })
        }
        spec = {
          path,
          ...(typeof entry.name === 'string' && entry.name !== '' ? { name: entry.name } : {}),
          ...(isWsAccess(access) ? { access } : {}),
        }
      } else {
        errors.push({ message: `${at}: each folder must be a path string or an object with a "path"` })
        return
      }
      folders.push(spec)
    })
  }
  if (errors.length > 0) return { errors, warnings }

  // Version / name / settings are advisory — warn and continue.
  if (root.version !== undefined) {
    if (typeof root.version !== 'number') {
      warnings.push({ message: '"version" must be a number; ignoring it' })
    } else if (root.version !== WS_MANIFEST_VERSION) {
      warnings.push({ message: `unsupported "version" ${String(root.version)} (expected ${WS_MANIFEST_VERSION}); continuing` })
    }
  }
  if (root.name !== undefined && typeof root.name !== 'string') {
    warnings.push({ message: '"name" must be a string; ignoring it' })
  }
  let settings: DshWorkspaceSettings | undefined
  if (root.settings !== undefined) {
    if (!plainRecord(root.settings)) {
      warnings.push({ message: '"settings" must be an object; ignoring it' })
    } else {
      const defaultAccess = root.settings.defaultAccess
      if (defaultAccess !== undefined && !isWsAccess(defaultAccess)) {
        warnings.push({ message: `"settings.defaultAccess" must be "readWrite" or "readOnly"; using "readOnly"` })
      }
      const autoActivate = root.settings.autoActivate
      if (autoActivate !== undefined && typeof autoActivate !== 'boolean') {
        warnings.push({ message: '"settings.autoActivate" must be a boolean; using true' })
      }
      settings = {
        ...(isWsAccess(defaultAccess) ? { defaultAccess } : {}),
        ...(typeof autoActivate === 'boolean' ? { autoActivate } : {}),
      }
    }
  }
  const manifest: DshWorkspaceFile = {
    ...(typeof root.version === 'number' ? { version: root.version } : {}),
    ...(typeof root.name === 'string' && root.name !== '' ? { name: root.name } : {}),
    folders,
    ...(settings !== undefined && Object.keys(settings).length > 0 ? { settings } : {}),
  }
  return { manifest, errors, warnings }
}

/** The `access` a folder resolves to (folder > settings.defaultAccess > readOnly). */
export function folderAccessOf(
  folder: DshWorkspaceFolderSpec,
  settings: DshWorkspaceSettings | undefined,
): DshWorkspaceAccess {
  return folder.access ?? settings?.defaultAccess ?? DEFAULT_WS_FOLDER_ACCESS
}

/** Whether opening a manifest file should auto-apply it (settings default true). */
export function autoActivateOf(settings: DshWorkspaceSettings | undefined): boolean {
  return settings?.autoActivate ?? DEFAULT_WS_AUTO_ACTIVATE
}

/**
 * Pure path normalization for containment/matching: both separators collapse
 * to `/`, the root `C:/x/` keeps its trailing slash stripped except a bare
 * volume/root edge is preserved (`C:/`, `/`), and the result is lower-cased
 * when the caller's platform treats paths case-insensitively (`ci`).
 */
export function normalizeWsPath(path: string, ci: boolean): string {
  let value = path.replace(/[\\/]+/g, '/').replace(/\/$/, '')
  const edge = value === '' ? '/' : value
  return ci ? edge.toLowerCase() : edge
}

/**
 * Index of the root that longest-prefix-matches `path` (its own root counts),
 * or -1 when none does. Ties (equal prefix length) resolve to the EARLIER
 * root, so a later duplicate never shadows the first. `roots` are matched
 * pre-normalized by the caller (see {@link normalizeWsPath}).
 * @param path - absolute target path, normalized by the caller.
 * @param normalizedRoots - roots normalized with the same `ci` as `path`.
 * @returns matched root index or -1.
 */
export function longestWsRoot(path: string, normalizedRoots: readonly string[]): number {
  let best = -1
  let bestLen = -1
  for (let i = 0; i < normalizedRoots.length; i += 1) {
    const root = normalizedRoots[i]!
    if (path === root || path.startsWith(`${root}/`)) {
      if (root.length > bestLen) {
        best = i
        bestLen = root.length
      }
    }
  }
  return best
}

/** Whether `target` (normalized) lies under `root` (normalized) or equals it. */
export function wsRootContains(target: string, root: string): boolean {
  return target === root || target.startsWith(`${root}/`)
}
