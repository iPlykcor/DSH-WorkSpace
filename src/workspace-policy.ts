/**
 * Host-side `.dsh-workspace` activation: turns a manifest file into an
 * {@link ActiveWorkspace} — resolved, canonical roots with per-root access —
 * plus the containment/classification queries route guards and the model
 * write detector share. Pure policy logic (given a parsed manifest + file
 * directory) is separated from the fs calls so it can be unit-tested without
 * touching disk (see `resolvePolicy`).
 */
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve as resolvePath } from 'node:path'
import {
  folderAccessOf, longestWsRoot, normalizeWsPath,
  parseWorkspaceManifest, WS_MANIFEST_MAX_BYTES,
  type DshWorkspaceAccess, type DshWorkspaceFile,
} from './workspace-schema.ts'
import { SidebarError } from './wire.ts'

/** One applied root of an active workspace (canonical when it exists). */
export interface WsRootView {
  /** Display path (the lexical absolute path the manifest resolved to). */
  path: string
  /** Canonical (`fs.realpath`) form; equals `path` when the folder exists. */
  realPath: string
  /** Root label shown in the tree header (folder `name` or base name). */
  label: string
  access: DshWorkspaceAccess
  /** Whether the canonical directory currently exists. */
  exists: boolean
  /** Whether the root came from the manifest (false = implicit session cwd). */
  listed: boolean
}

/** The resolved, active multi-root workspace of one session. */
export interface ActiveWorkspace {
  /** Absolute lexical path of the manifest file that was activated. */
  manifestPath: string
  /** The manifest file's directory (base for relative folder paths). */
  baseDir: string
  /** Workspace display name (manifest `name` or the file's base name). */
  name: string
  /** Resolved roots, display order (implicit cwd appended unless listed). */
  roots: WsRootView[]
  /** The session cwd this workspace was built from. */
  cwd: string
  /** Whether path matching folds case (true on Windows hosts). */
  ci: boolean
  /** Soft parse warnings surfaced to the caller. */
  warnings: string[]
  activatedAt: number
}

/** Outcome of building a policy from already-read text (fs-free; testable). */
export interface WsPolicyBuild {
  workspace: ActiveWorkspace
}

/** Error thrown for manifest-level failures (wire text for SidebarError). */
export class WsManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WsManifestError'
  }
}

/** Read + size-cap one manifest file. */
export async function readManifestFile(manifestPath: string): Promise<string> {
  let info
  try {
    info = await stat(manifestPath)
  } catch (error) {
    throw new WsManifestError(`cannot stat workspace file "${manifestPath}": ${messageOf(error)}`)
  }
  if (info.isDirectory()) {
    throw new WsManifestError(`"${manifestPath}" is a directory, not a workspace file`)
  }
  if (info.size > WS_MANIFEST_MAX_BYTES) {
    throw new WsManifestError(`workspace file exceeds the ${WS_MANIFEST_MAX_BYTES} byte limit`)
  }
  try {
    return await readFile(manifestPath, 'utf8')
  } catch (error) {
    throw new WsManifestError(`cannot read workspace file "${manifestPath}": ${messageOf(error)}`)
  }
}

/** Canonicalize an existing directory; returns undefined when it is missing. */
async function canonicalDir(path: string): Promise<string | undefined> {
  try {
    const canonical = await realpath(path)
    const info = await stat(canonical)
    return info.isDirectory() ? canonical : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve one manifest folder spec to an absolute path: absolute inputs pass
 * through; relative ones resolve against `baseDir` (the manifest file's
 * directory, VSCode-code-workspace semantics). POSIX-rooted paths in a WSL
 * session project into the distro root via the caller's `cwd` — the host
 * passes already-projected session paths when the manifest lives under a WSL
 * cwd (see session-path.ts).
 */
export function resolveFolderPath(raw: string, baseDir: string): string {
  if (isAbsolute(raw)) return resolvePath(raw)
  return resolvePath(baseDir, raw)
}

/** Base name of a folder path for the default label. */
export function labelOf(path: string): string {
  const base = basename(path)
  return base !== '' ? base : path
}

/**
 * Build an {@link ActiveWorkspace} from a parsed manifest (no disk I/O).
 * Implicit-cwd rule: when the session cwd is not among the resolved roots it
 * is appended as a `readWrite` root, so applying a manifest never locks the
 * current session's own project directory; when listed, its listed access
 * governs. Overlaps between roots are legal and resolved by longest-prefix
 * at query time (a readOnly subfolder of a readWrite root works).
 */
export async function buildWorkspacePolicy(
  manifest: DshWorkspaceFile,
  manifestPath: string,
  baseDir: string,
  cwd: string,
  ci: boolean,
  canonicalize: (path: string) => Promise<string | undefined> = canonicalDir,
  log: (message: string) => void = () => {},
): Promise<WsPolicyBuild> {
  const warnings: string[] = []
  const seen = new Set<string>()
  const roots: WsRootView[] = []

  const addRoot = async (lexical: string, specName: string | undefined, access: DshWorkspaceAccess, listed: boolean): Promise<void> => {
    const real = await canonicalize(lexical)
    if (real !== undefined) {
      // Deduplicate by canonical path: later duplicates keep the FIRST.
      if (seen.has(real)) return
      seen.add(real)
    }
    roots.push({
      path: lexical,
      realPath: real ?? lexical,
      label: specName !== undefined && specName !== '' ? specName : labelOf(lexical),
      access,
      exists: real !== undefined,
      listed,
    })
  }

  const resolveRoots = async (): Promise<void> => {
    for (const folder of manifest.folders) {
      const lexical = resolveFolderPath(folder.path, baseDir)
      await addRoot(lexical, folder.name, folderAccessOf(folder, manifest.settings), true)
    }
    const realCwd = await canonicalize(cwd)
    if (realCwd === undefined) {
      warnings.push(`session working directory "${cwd}" is missing; manifest roots only`)
      // Still append a lexical cwd root so legacy rows inside it resolve.
      await addRoot(cwd, undefined, 'readWrite', false)
      return
    }
    if (!seen.has(realCwd)) {
      await addRoot(cwd, undefined, 'readWrite', false)
    }
  }
  await resolveRoots()
  for (const warning of warnings) log(warning)

  const workspace: ActiveWorkspace = {
    manifestPath,
    baseDir,
    name: manifest.name !== undefined && manifest.name !== '' ? manifest.name : labelOf(manifestPath),
    roots,
    cwd,
    ci,
    warnings,
    activatedAt: Date.now(),
  }
  return { workspace }
}

/**
 * Resolve + validate a manifest file into an {@link ActiveWorkspace}.
 * Throws {@link WsManifestError} for parse/read failures; soft warnings ride
 * on the returned build.
 */
export async function buildWorkspaceFromFile(
  manifestPath: string,
  cwd: string,
  ci: boolean,
  log: (message: string) => void = () => {},
): Promise<WsPolicyBuild> {
  const canonicalManifest = await canonicalDir(dirname(manifestPath))
  const baseDir = canonicalManifest ?? dirname(manifestPath)
  const text = await readManifestFile(manifestPath)
  const parsed = parseWorkspaceManifest(text)
  if (parsed.errors.length > 0 || parsed.manifest === undefined) {
    const detail = parsed.errors.map(issue => issue.message).join('; ')
    throw new WsManifestError(`invalid workspace file: ${detail}`)
  }
  return buildWorkspacePolicy(parsed.manifest, manifestPath, baseDir, cwd, ci, canonicalDir, log)
}

/**
 * Classify an ABSOLUTE, canonical target against an active workspace.
 * @param realTarget - canonical path of the (existing) target.
 * @returns the winning root by longest-prefix match, or undefined when the
 *   target lies outside every root (incl. the implicit cwd root).
 */
export function classifyWsPath(
  workspace: ActiveWorkspace,
  realTarget: string,
): { root: WsRootView; normalized: string } | undefined {
  const target = normalizeWsPath(realTarget, workspace.ci)
  const normalizedRoots = workspace.roots.map(root => normalizeWsPath(root.realPath, workspace.ci))
  const index = longestWsRoot(target, normalizedRoots)
  if (index === -1) return undefined
  return { root: workspace.roots[index]!, normalized: target }
}

/** Whether writing to `realTarget` is allowed by the active workspace. */
export function wsWriteAllowed(workspace: ActiveWorkspace, realTarget: string): boolean {
  const match = classifyWsPath(workspace, realTarget)
  return match !== undefined && match.root.access === 'readWrite'
}

/**
 * Final write gate for an already-canonical target: longest-prefix
 * classification decides (a readOnly nested root inside an implicit readWrite
 * cwd must still refuse), and the refusal names the winning read-only root.
 * @throws SidebarError 'forbidden' when the target lands in a readOnly root
 *   or outside every root.
 */
export function assertWsWriteAllowed(
  workspace: ActiveWorkspace,
  realTarget: string,
  displayTarget: string = realTarget,
): void {
  const match = classifyWsPath(workspace, realTarget)
  if (match === undefined) {
    throw new SidebarError('forbidden', `path "${displayTarget}" is outside the active workspace`, 403)
  }
  if (match.root.access !== 'readWrite') {
    throw new SidebarError(
      'forbidden',
      `"${displayTarget}" is inside the read-only workspace folder "${match.root.path}"`,
      403,
    )
  }
}

/** The canonical read bases of a workspace (every root; incl. missing ones
 *  resolve to their lexical path — containment then still holds for children
 *  of an existing ancestor). */
export function wsReadBases(workspace: ActiveWorkspace): string[] {
  return workspace.roots.map(root => root.realPath)
}

/** The canonical write bases of a workspace (only readWrite roots). */
export function wsWriteBases(workspace: ActiveWorkspace): string[] {
  return workspace.roots.filter(root => root.access === 'readWrite').map(root => root.realPath)
}

/** Error message text of an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
