/**
 * Manifest discovery inside one session's working directory.
 *
 * WHY THIS IS NOT `fs.tree`: browsing is deliberately fenced behind an ACTIVE
 * operation space (an unactivated session is a 403), yet discovery runs
 * precisely when nothing is active — it is what lets the tab apply a manifest
 * without the user pasting an absolute path. So this module reads the ONE
 * directory it is allowed to (the session cwd), one level deep, and reports
 * only entries whose NAME carries a claimed manifest extension. It must never
 * grow into a general directory-listing route: that is `fs.tree`'s job, and it
 * stays fenced.
 *
 * Candidates are parsed, not just listed, for two reasons:
 * 1. `settings.autoActivate` is the manifest author's opt-OUT of automatic
 *    activation, so the decision needs the parsed settings;
 * 2. the chooser can show the declared title and explain a file that cannot be
 *    used instead of silently ignoring it.
 * A candidate that fails to parse is still REPORTED (with its error) so the UI
 * can say why — never dropped silently.
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  autoActivateOf, hasClaimedManifestExtension, parseWorkspaceManifest,
} from './workspace-schema.ts'
import { readManifestFile, WsManifestError } from './workspace-policy.ts'

/** Candidate cap for one discovery (bounds parse work; no config surface). */
export const DISCOVERY_LIMIT = 50

/** One manifest file found directly inside the session cwd. */
export interface WsManifestCandidate {
  /** Absolute path of the candidate manifest. */
  path: string
  /** The file's base name (always shown: it is what the user sees on disk). */
  fileName: string
  /** Declared title, or the file's base name when unnamed or unparseable. */
  name: string
  /** The manifest's `settings.autoActivate` (default true). */
  autoActivate: boolean
  /** Read/parse failure: listed, but never eligible for automatic activation. */
  error?: string
}

/**
 * List the manifests directly inside `cwd`, sorted by file name for a stable
 * chooser order.
 * @param cwd - the session's working directory (absolute).
 * @returns the candidates; empty when the directory is unreadable or holds no
 *   manifest. An unreadable cwd is an empty discovery rather than a failure —
 *   the panel keeps its manual path input, which is the feature working.
 */
export async function discoverManifests(cwd: string): Promise<WsManifestCandidate[]> {
  let names: string[]
  try {
    const entries = await readdir(cwd, { withFileTypes: true })
    names = entries
      // Symlinks are included: `readManifestFile` stats the target and reports
      // a broken link as a candidate error rather than hiding the file.
      .filter(entry => entry.isFile() || entry.isSymbolicLink())
      .map(entry => entry.name)
      .filter(hasClaimedManifestExtension)
      // Plain code-unit order, not `localeCompare`: the chooser order must not
      // drift with the host's ICU data.
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .slice(0, DISCOVERY_LIMIT)
  } catch {
    return []
  }
  const candidates: WsManifestCandidate[] = []
  for (const fileName of names) {
    candidates.push(await candidateOf(join(cwd, fileName), fileName))
  }
  return candidates
}

/**
 * Read + parse one candidate into its discovery row.
 * @param path - absolute path of the candidate file.
 * @param fileName - its base name.
 * @returns the row, with `error` set when the file cannot be used.
 */
async function candidateOf(path: string, fileName: string): Promise<WsManifestCandidate> {
  const unusable = (error: string): WsManifestCandidate =>
    ({ path, fileName, name: fileName, autoActivate: false, error })
  try {
    const parsed = parseWorkspaceManifest(await readManifestFile(path))
    if (parsed.errors.length > 0 || parsed.manifest === undefined) {
      return unusable(parsed.errors.map(issue => issue.message).join('; '))
    }
    const manifest = parsed.manifest
    return {
      path,
      fileName,
      name: manifest.name !== undefined && manifest.name !== '' ? manifest.name : fileName,
      autoActivate: autoActivateOf(manifest.settings),
    }
  } catch (error) {
    return unusable(error instanceof WsManifestError ? error.message : String(error))
  }
}
