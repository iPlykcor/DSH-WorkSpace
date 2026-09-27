/**
 * Compile-time contract for the host APIs this plugin mirrors by hand.
 *
 * `src/context-types.ts` cannot import the host packages: it sits in the
 * client-reachable declaration graph, where a `@deepseek-ai/*` import would be
 * rejected by the client-bundle purity gate (whose job is to keep runtime
 * symbols out) and would drag Node types into browser code. So its service
 * faces are structural mirrors, and the plugin reaches them through
 * `ctx.get(...)`, which is untyped at the call site.
 *
 * That combination let a real defect past `pnpm typecheck`: the plugin called
 * `sessionPersistence.inspect(id)`, which the 0.1.7 host no longer has (it is
 * `stat(id)` plus `open(id, access)` → handle `read()`/`close()`). Only a real
 * mount smoke against a real host caught it, as an HTTP 500 on the cold path.
 *
 * The assertions below turn every mirrored face into a COMPILE-TIME
 * obligation: when a host release renames or drops a member, `pnpm typecheck`
 * fails here rather than a user meeting it. Runtime cost is zero — types are
 * erased, so the suite only exists to report the compiler's verdict.
 */
import type { SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { ShortcutCommand } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import type {
  SidebarSessionPersistenceService, SidebarSessionStore, SidebarShortcutCommand, SidebarToolDefinition,
} from '../src/context-types.ts'

/**
 * Resolves to `true` when `A` is assignable to `B`: the `A extends B`
 * constraint is what enforces the mirror, and a mismatch is a compile error at
 * the declaration that uses it. The tuple comparison keeps both parameters
 * genuinely used (a bare `true` body leaves `A` unused, which lint rejects).
 */
type Satisfies<A extends B, B> = [A] extends [B] ? true : never

/** The host session store must still provide what the live-cwd and event reads use. */
const _store: Satisfies<SessionStore, SidebarSessionStore> = true

/** The host persistence service must still provide the cold-session reads. */
const _persistence: Satisfies<SessionPersistence, SidebarSessionPersistenceService> = true

/**
 * The registry must still ACCEPT what this plugin registers. This guard's
 * direction is the one that matters: a renamed `output.render`, a widened
 * `execute` parameter or a newly required member must fail `pnpm typecheck`
 * here, not leave the one model-visible capability silently unregistered.
 */
const _tool: Satisfies<SidebarToolDefinition, ToolDefinition> = true

/**
 * The shortcut registry must still ACCEPT what this plugin registers. The
 * direction is forced: the real command's `id` is a branded string, so only
 * "real → mirror" compiles. The runtime half — that this plugin's own command
 * satisfies the registry's validation — is pinned in `client-tab.spec.ts`.
 */
const _shortcut: Satisfies<ShortcutCommand, SidebarShortcutCommand> = true

describe('host type contract', () => {
  it('mirrors the installed dsh-session, dsh-session-persistence and dsh-tools faces', () => {
    // Every assertion is already resolved by the compiler; this reports them.
    expect([_store, _persistence, _tool, _shortcut]).toEqual([true, true, true, true])
  })
})
