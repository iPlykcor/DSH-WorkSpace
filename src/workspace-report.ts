/**
 * The model-facing report of an active operation space.
 *
 * WHY A SECOND RENDERING EXISTS AT ALL. `snapshotOf` is the CLIENT's wire format:
 * it carries `sessionId`, `cwd`, `ci`, `activatedAt` and per-root `exists` and
 * `listed` flags, because the tab needs all of that to draw a row and to re-apply
 * a space. The MODEL needs three facts per root — the label the user says, the
 * absolute path to use, and whether it may write there — so serializing the wire
 * format at it pays for everything else on every call. Measured on a ten-root
 * space: ~385 tokens as the wire JSON, ~144 as this report. The wire format is
 * therefore untouched (seven routes depend on it) and the tool renders its own
 * view through this module.
 *
 * WHY GROUPED BY ACCESS. Access is a property of the GROUP, which is what lets one
 * root be a single line of `label = path`: the level is stated once per heading
 * instead of once per root, and "where may I write?" is answered by one heading.
 * Read-write is printed first because that is the set an agent can act on.
 *
 * WHY NOTHING ELSE IS PRINTED. `cwd`, `ci` and `activatedAt` say nothing a model
 * can use, and the tool's description already states that nothing outside a
 * declared root is covered. Exactly two conditions earn a marker, because both
 * change what the model should do next: a declared root whose folder is gone right
 * now (`missing`), and the session cwd's implicit root, which no manifest entry
 * declares and which therefore cannot be re-permissioned or removed on request
 * (`implicit`). Ordering inside a group is the manifest's own, so the report,
 * the tab and the file agree.
 *
 * This module is PURE and owns every word of the report: the tool registration
 * next door only hands it the snapshot, which is what keeps the model-facing copy
 * testable without a host.
 */
import type { WsRootSnapshot, WsSnapshot } from './workspace-state.ts'

/** Marker for a declared root whose folder is not on disk right now. */
const MISSING = 'missing'
/** Marker for the session cwd's implicit root (no manifest entry to edit). */
const IMPLICIT = 'implicit'

/**
 * Render one root as `label = path`, plus its markers.
 * @param root - the root to render.
 * @returns one line's worth of text (no indentation; the caller adds it).
 */
function renderRoot(root: WsRootSnapshot): string {
  const marks: string[] = []
  // `implicit` first: it explains why a manifest the user is looking at does not
  // mention this folder, which is the more surprising of the two facts.
  if (!root.listed) marks.push(IMPLICIT)
  if (!root.exists) marks.push(MISSING)
  return `${root.label} = ${root.path}${marks.length === 0 ? '' : ` (${marks.join(', ')})`}`
}

/**
 * Render one access group, or nothing when no root has that level.
 * @param heading - the group's access level, as the model should read it.
 * @param roots - the roots in that group, in manifest order.
 * @returns the group's lines.
 */
function renderGroup(heading: string, roots: readonly WsRootSnapshot[]): string[] {
  if (roots.length === 0) return []
  return [`${heading} (${roots.length}):`, ...roots.map(root => `  ${renderRoot(root)}`)]
}

/**
 * Render the report for a session whose operation space is active.
 * @param snapshot - the active space's wire snapshot.
 * @returns the model-facing report.
 */
export function renderSpaceReport(snapshot: WsSnapshot): string {
  const readWrite = snapshot.roots.filter(root => root.access === 'readWrite')
  const readOnly = snapshot.roots.filter(root => root.access === 'readOnly')
  return [
    `Operation space "${snapshot.name}" is ACTIVE in this session.`,
    `Manifest: ${snapshot.manifestPath}`,
    ...renderGroup('read-write', readWrite),
    ...renderGroup('read-only', readOnly),
  ].join('\n')
}

/**
 * Render the report for a session with no active operation space.
 *
 * It says where a space comes from, because "not active" is actionable: the user
 * applies one from the tab, and a model that knows this can tell them so instead
 * of hunting for a folder it was never granted.
 * @returns the model-facing report.
 */
export function renderNoSpaceReport(): string {
  return 'No operation space is active in this session, so no folder outside DSH\'s own workspace is granted. '
    + 'One is applied from the 章鱼作业区 tab (or by pointing it at a .dsh-octopus manifest).'
}
