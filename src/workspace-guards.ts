/**
 * Path canonicalization over an ACTIVE multi-root workspace's canonical
 * bases (read = every root, write = the readWrite roots). Mirrors the
 * single-workspace semantics of path-security.ts (realpath through symlinks,
 * nearest-existing-ancestor walks for not-yet-existing write targets) but
 * checks containment against a SET of canonical bases instead of one cwd, so
 * the sidebar routes can serve manifest-declared folders outside the session
 * cwd while still refusing anything the manifest did not grant. The legacy
 * no-workspace path (path-security.ts) is untouched.
 */
import { realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { requireAbsolute } from './fs-tree.ts'
import { resolveSessionPath } from './session-path.ts'
import { longestWsRoot, normalizeWsPath } from './workspace-schema.ts'
import { SidebarError } from './wire.ts'

/** Realpath of one existing path; converts resolution failures to an API error. */
async function realOf(path: string, label: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    throw new SidebarError('fs-error', `cannot resolve ${label} "${path}": ${error instanceof Error ? error.message : String(error)}`, 400)
  }
}

/** Canonical target (already real) lies under at least one canonical base. */
function withinBases(realTarget: string, bases: readonly string[], ci: boolean): boolean {
  const target = normalizeWsPath(realTarget, ci)
  const normalized = bases.map(base => normalizeWsPath(base, ci))
  return longestWsRoot(target, normalized) !== -1
}

/**
 * Resolve a read target against canonical workspace bases: absolute-ize
 * (session-namespace aware), realpath, and require containment inside at
 * least one base. Returns the canonical target.
 */
export async function ensureWsReadTarget(
  cwd: string,
  target: string,
  bases: readonly string[],
  ci: boolean,
): Promise<string> {
  const absolute = requireAbsolute(resolveSessionPath(cwd, target))
  const realTarget = await realOf(absolute, 'target')
  if (!withinBases(realTarget, bases, ci)) {
    throw new SidebarError('forbidden', `path "${target}" is outside the active workspace`, 403)
  }
  return realTarget
}

/**
 * Resolve a write target (which may not exist yet) against canonical write
 * bases: nearest existing ancestor is realpath'd, containment checked against
 * those bases, then the missing segments are rebuilt onto it — so a symlink
 * is never left inside the returned path (mirror of
 * ensureWorkspaceWritePath, multi-base).
 */
export async function ensureWsWriteTarget(
  cwd: string,
  target: string,
  bases: readonly string[],
  ci: boolean,
): Promise<string> {
  const absolute = requireAbsolute(resolveSessionPath(cwd, target))
  let existing = absolute
  const missing: string[] = []
  for (;;) {
    let real: string
    try {
      real = await realpath(existing)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new SidebarError('fs-error', `cannot resolve target "${existing}": ${error instanceof Error ? error.message : String(error)}`, 400)
      }
      const parent = dirname(existing)
      if (parent === existing) {
        throw new SidebarError('fs-error', `cannot resolve target "${absolute}"`, 400)
      }
      missing.unshift(existing.slice(parent.length + 1))
      existing = parent
      continue
    }
    if (!withinBases(real, bases, ci)) {
      throw new SidebarError('forbidden', `path "${target}" is outside the active workspace`, 403)
    }
    return missing.reduce((path, segment) => join(path, segment), real)
  }
}
