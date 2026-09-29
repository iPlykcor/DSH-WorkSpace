/**
 * The model-visible half of the operation space: one tool that reports what the
 * ACTIVE space declares.
 *
 * WHY IT EXISTS. A manifest names its folders by label — `./demo/rw` becomes
 * "rw", `D:/现场问题` becomes "现场问题" — and those labels are the words a user
 * actually types ("看一下 rw 里的东西"). The plugin's UI has always known the
 * mapping; without this tool the MODEL could only recover it by happening to
 * read the manifest file, so "rw" was a guess and "现场问题" was unresolvable.
 * Reporting the labels WITH their absolute paths and access mode is what turns
 * an ambiguous instruction into a bounded one.
 *
 * IT REPORTS, IT DOES NOT ACT. Reading is the whole job: a tool that also
 * opened, wrote or applied anything would be a second, unchecked write path
 * next to the manifest, which is the one source of truth this package allows.
 *
 * WHAT IT SAYS lives in ./workspace-report.ts. `snapshotOf` is the CLIENT's wire
 * format (seven routes and the whole tab depend on its shape), and serializing it
 * at the model would charge it for `sessionId`, `cwd`, `activatedAt` and per-root
 * flags it cannot use — roughly 385 tokens for a ten-root space against 144 for
 * the report. So the tool renders its own, smaller view, and the model-facing
 * words are tested there rather than here.
 */
import type { SidebarToolDefinition } from './context-types.ts'
import { renderNoSpaceReport, renderSpaceReport } from './workspace-report.ts'
import { snapshotOf, type WorkspaceRegistry } from './workspace-state.ts'

/** The tool name the model sees (and the only one this plugin registers). */
export const WORKSPACE_TOOL_NAME = 'octopus_space'

/**
 * The description is the model's ENTIRE contract: no schema comment or README
 * reaches it, so it names the labels' role, when to call, and what "not active"
 * means, in that order.
 */
const DESCRIPTION = [
  'Report the operation space (章鱼作业区) currently active in this session:',
  'every declared root with its LABEL, absolute path, read/write access and whether it exists now.',
  'Call it before touching a folder the user names by label alone (for example "rw" or "现场问题")',
  '— the label is what the manifest declared, and this is the only place its absolute path is stated —',
  'and whenever the answer depends on which folders are read-only.',
  'If no operation space is active, it says so; nothing outside a declared root is ever covered by it.',
].join(' ')

/**
 * Build the tool definition bound to one registry.
 *
 * Kept as a factory (rather than a module constant) because the definition must
 * read the LIVE registry: the space can be applied or dropped while the plugin
 * stays mounted.
 * @param registry - the per-session operation-space registry.
 * @returns the definition to hand to `ctx.tools.register`.
 */
export function createWorkspaceTool(registry: WorkspaceRegistry): SidebarToolDefinition {
  return {
    name: WORKSPACE_TOOL_NAME,
    description: DESCRIPTION,
    // Raw JSON Schema with no arguments: the only input this tool needs is the
    // calling session, which arrives in `exec`, not in the arguments.
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      // A JSON *string*: the value is the payload serialized, and `render` hands
      // it to the model verbatim (the plugin-manager precedent). Declaring this
      // is not optional — a tool without `output` does not register at all.
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    // `async` on purpose: the declared contract is `Promise<unknown>`, so a
    // refusal has to arrive as a REJECTION. A synchronous `throw` would escape
    // before any promise exists, which is not a shape the caller expects.
    execute: async (_args, exec) => {
      const sessionId = exec.agent?.session.id
      if (sessionId === undefined) {
        // A non-agent caller (no owning session) cannot be answered: the space
        // is keyed by session, and guessing one would answer for somebody else.
        throw new Error(`${WORKSPACE_TOOL_NAME} needs the calling session`)
      }
      const active = registry.get(sessionId)
      if (active === undefined) {
        // "Not active" is actionable, so the answer says where a space comes
        // from instead of naming fields (`active: false`) the model cannot use.
        return renderNoSpaceReport()
      }
      return renderSpaceReport(snapshotOf(active))
    },
  }
}
