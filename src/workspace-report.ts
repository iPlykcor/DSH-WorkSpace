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
 * The markers a root earns, in render order.
 *
 * Exactly two conditions earn one, because both change what a model should do
 * next: a declared root whose folder is gone right now (`missing`), and the
 * session cwd's implicit root, which no manifest entry declares and which
 * therefore cannot be re-permissioned or removed on request (`implicit`).
 * `implicit` comes first because it explains why a manifest the user is looking
 * at does not mention this folder — the more surprising of the two facts.
 * @param root - the root to describe.
 * @returns the markers, or an empty array when it earns none.
 */
function markersOf(root: WsRootSnapshot): string[] {
  const marks: string[] = []
  if (!root.listed) marks.push(IMPLICIT)
  if (!root.exists) marks.push(MISSING)
  return marks
}

/**
 * Attach markers to a name: `VS调试 (missing)`, or the name alone.
 * @param name - the label, or the `label = path` text.
 * @param marks - markers from {@link markersOf}.
 * @returns the decorated name.
 */
function withMarkers(name: string, marks: readonly string[]): string {
  return marks.length === 0 ? name : `${name} (${marks.join(', ')})`
}

/**
 * Render one root as `label = path`, plus its markers.
 * @param root - the root to render.
 * @returns one line's worth of text (no indentation; the caller adds it).
 */
function renderRoot(root: WsRootSnapshot): string {
  return withMarkers(`${root.label} = ${root.path}`, markersOf(root))
}

/**
 * Render one root for the label table: the word the user says, nothing else.
 * @param root - the root to render.
 * @returns the label, plus its markers.
 */
function renderLabel(root: WsRootSnapshot): string {
  return withMarkers(root.label, markersOf(root))
}

/**
 * Split a snapshot's roots by access, read-write first.
 *
 * Read-write leads because that is the set an agent can act on.
 * @param snapshot - the active space's wire snapshot.
 * @returns one `[heading, roots]` pair per access level, empty groups included.
 */
function groupByAccess(snapshot: WsSnapshot): Array<[string, WsRootSnapshot[]]> {
  return [
    ['read-write', snapshot.roots.filter(root => root.access === 'readWrite')],
    ['read-only', snapshot.roots.filter(root => root.access === 'readOnly')],
  ]
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
  return [
    `Operation space "${snapshot.name}" is ACTIVE in this session.`,
    `Manifest: ${snapshot.manifestPath}`,
    ...groupByAccess(snapshot).flatMap(([heading, roots]) => renderGroup(heading, roots)),
  ].join('\n')
}

/**
 * Render the LABEL TABLE: every declared label, grouped by access, on one line.
 *
 * WHY A THIRD RENDERING, AND WHY IT OMITS THE PATHS. This text is not a tool
 * result but a runtime-context contribution, so the model pays for it on EVERY
 * assembly instead of once per call. It exists because the words a user types
 * ("看一下 VS调试") are the manifest's LABELS: without them in front of the model a
 * label is an unknown token, and the model either guesses a path or asks a
 * question the user finds obvious. The absolute paths stay behind the tool for
 * exactly that cost reason — on the same ten-root fixture the test's size guard
 * pins this table below half the report's length, and the tool remains the only
 * place that can answer "what is the path".
 * @param snapshot - the active space's wire snapshot.
 * @param toolName - the tool that reports the absolute paths, named so the reader
 *   knows where to get them. Passed in because this module must not import the
 *   registration module that owns the name (that would be an import cycle).
 * @returns the model-facing label table, or `''` when the space declares no roots.
 */
export function renderSpaceLabels(snapshot: WsSnapshot, toolName: string): string {
  const groups = groupByAccess(snapshot)
    .filter(([, roots]) => roots.length > 0)
    .map(([heading, roots]) => `${heading} - ${roots.map(renderLabel).join(', ')}`)
  if (groups.length === 0) return ''
  return `Operation space "${snapshot.name}" is active in this session. Roots by label: ${groups.join('; ')}. `
    + `Absolute paths: call the \`${toolName}\` tool.`
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
