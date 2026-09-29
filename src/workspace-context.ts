/**
 * The operation space as RUNTIME CONTEXT: the model's per-turn view of the labels.
 *
 * WHY THIS EXISTS. `octopus_space` answers "which folders are granted?" on demand,
 * but the model has to KNOW TO ASK. A manifest names its folders by label — `./demo/rw`
 * becomes "rw", `D:/现场问题` becomes "现场问题" — and those labels are the words users
 * actually type. With the table only behind a tool, the first turn of a session
 * whose space is already applied reads "看一下 VS调试" as an unknown token, and the
 * model either guesses a path or asks a question the user finds obvious. Contributing
 * the labels as dynamic context is what makes the user's own words resolvable.
 *
 * WHY LABELS ONLY, NOT THE TOOL'S REPORT. Dynamic context is paid on EVERY
 * assembly; a tool result is paid once. Putting the paths here would buy one saved
 * tool call per session at the price of the whole report on every turn — on the
 * same ten-root fixture the size guard in `tests/workspace-report.spec.ts` holds
 * this table below half the report. Paths stay behind the tool, which
 * `renderSpaceLabels` names for exactly that reason.
 *
 * WHY IT CONTRIBUTES NOTHING WHEN THERE IS NO SPACE. `context({ text })` drops
 * empty text, so a session with no active space pays nothing and reads nothing
 * extra. A space applied later starts appearing from the next turn, because the
 * text is a provider evaluated per assembly, not a string captured at registration.
 *
 * WHY THE REGISTRATION ITSELF LIVES IN index.ts. This module stays PURE — a factory
 * plus the model-facing placement — so the wording is testable without a host, and
 * the one line that touches the service sits next to the tool registration.
 */
// The `agent` field of `AssembleContext` is not declared by the system-prompt
// package itself: `dsh-agent` MERGE-EXTENDS that interface with it, and the
// augmentation only reaches a program that loads that module. This type-only,
// binding-free import is what pulls it in — without it a src-only build
// (`tsconfig.build.json`) has no `agent` property at all, while the test program
// happens to see one through its own imports. It is erased at runtime, so both
// packages stay devDependencies and the plugin stays zero-dependency.
import type {} from '@deepseek-ai/dsh-agent'
import type { PromptContext } from '@deepseek-ai/dsh-system-prompt'
import { renderSpaceLabels } from './workspace-report.ts'
import { WORKSPACE_TOOL_NAME } from './workspace-tool.ts'
import { snapshotOf, type WorkspaceRegistry } from './workspace-state.ts'

/**
 * Stable context name. A second registration under the same name throws, so this
 * is the identity a duplicate would collide on.
 */
export const WORKSPACE_CONTEXT_NAME = 'octopus-space'

/**
 * Placement among the runtime contexts. The service's own are 110 (sandbox
 * policy), 115 (approval policy) and 120 (subagent delegation); the space says
 * what this session may touch at all, so it follows the policies rather than
 * interleaving with them.
 */
export const WORKSPACE_CONTEXT_ORDER = 130

/**
 * Build the runtime-context contribution bound to one registry.
 *
 * A factory, not a module constant: the space can be applied or dropped while the
 * plugin stays mounted, and the provider must read the LIVE registry each time.
 * @param registry - the per-session operation-space registry.
 * @returns the context contribution to hand to `systemPrompt.context`.
 */
export function createSpaceContext(registry: WorkspaceRegistry): PromptContext {
  return {
    name: WORKSPACE_CONTEXT_NAME,
    order: WORKSPACE_CONTEXT_ORDER,
    text: (context) => {
      // `agent` is absent on diagnostics (the field arrives through
      // `dsh-agent`'s merge extension of `AssembleContext`), and an assembly with
      // no agent has no session to key a space by — in both cases the honest
      // answer is to contribute nothing rather than guess a session.
      const sessionId = context.agent?.session.id
      if (sessionId === undefined) return ''
      const active = registry.get(sessionId)
      if (active === undefined) return ''
      return renderSpaceLabels(snapshotOf(active), WORKSPACE_TOOL_NAME)
    },
  }
}
