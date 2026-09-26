/**
 * The auto-activation RULE for manifests discovered in the session cwd.
 *
 * WHY THIS LIVES OUTSIDE THE COMPONENT: it is the whole policy of the
 * auto-detect feature — which found manifest gets applied without asking — and
 * a rule buried in a React body is unreachable by tests. `client-tab.spec.ts`
 * can pin the tab's registration and its copy, but not a branch inside an
 * event handler; and this is exactly the kind of behaviour that must not drift
 * silently, because getting it wrong means applying a manifest the user never
 * chose.
 *
 * The rule (deliberately conservative):
 * - exactly one candidate, usable, and not opted out => apply it, which is what
 *   makes merely opening the tab enough;
 * - anything else => list the candidates and let the user pick. That covers all
 *   three ambiguous cases: several manifests (never guess), one manifest whose
 *   author set `settings.autoActivate: false` (never override an explicit
 *   opt-out), and one manifest that failed to parse (a broken file must never
 *   auto-apply, and it is listed with its badge so the mistake is visible).
 *
 * The input is a structural subset of the wire type on purpose: the rule needs
 * three fields, so tests can state cases without building a full candidate.
 */

/** The fields the rule reads (structurally satisfied by the wire candidate). */
export interface DiscoverableCandidate {
  /** Absolute path of the candidate manifest (what gets applied). */
  path: string
  /** The manifest's `settings.autoActivate` (host defaults it to true). */
  autoActivate: boolean
  /** Set when the file cannot be used; such a candidate never auto-applies. */
  error?: string
}

/** What the tab should do with one discovery result. */
export type DiscoveryDecision =
  /** Apply this manifest path immediately. */
  | { kind: 'apply'; path: string }
  /**
   * Show these candidates for the user to choose.
   * `autoOff` = the single candidate is usable but explicitly opted out, so the
   * panel also explains why it was not applied automatically.
   */
  | { kind: 'list'; candidates: readonly DiscoverableCandidate[]; autoOff: boolean }

/**
 * Decide what to do with the manifests found in the session cwd.
 * @param candidates - the discovery result (already sorted by the host).
 * @returns the decision: apply one, or list them.
 */
export function decideDiscovery(
  candidates: readonly DiscoverableCandidate[],
): DiscoveryDecision {
  const only = candidates.length === 1 ? candidates[0] : undefined
  if (only !== undefined && only.error === undefined) {
    if (only.autoActivate) return { kind: 'apply', path: only.path }
    return { kind: 'list', candidates, autoOff: true }
  }
  return { kind: 'list', candidates, autoOff: false }
}
