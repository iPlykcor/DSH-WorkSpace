/**
 * The auto-activation rule (`decideDiscovery`): which manifest found in the
 * session cwd gets applied without the user touching anything.
 *
 * This is the one piece of the auto-detect feature that is pure POLICY, and it
 * is the piece where being wrong is worst — applying a manifest the user never
 * chose silently grants whatever access that file declares. It is pinned here
 * (not in `client-tab.spec.ts`, which owns the tab's registration and copy)
 * because a rule inside a React body is unreachable by any test.
 */
import { describe, expect, it } from 'vitest'
import {
  decideDiscovery, type DiscoverableCandidate, type DiscoveryDecision,
} from '../src/client/discovery-decision.ts'

/** A usable candidate; `autoActivate` defaults to the manifest default (true). */
function usable(path: string, autoActivate = true): DiscoverableCandidate {
  return { path, autoActivate }
}

/** A candidate that could not be parsed (never usable, never an opt-out). */
function broken(path: string): DiscoverableCandidate {
  return { path, autoActivate: false, error: 'unexpected token' }
}

/** Narrow a decision to its 'list' arm, failing the test otherwise. */
function expectList(decision: DiscoveryDecision): Extract<DiscoveryDecision, { kind: 'list' }> {
  if (decision.kind !== 'list') {
    throw new Error(`expected a list decision, got apply(${decision.path})`)
  }
  return decision
}

describe('decideDiscovery', () => {
  it('applies the only usable manifest that did not opt out', () => {
    expect(decideDiscovery([usable('a.dsh-octopus')]))
      .toEqual({ kind: 'apply', path: 'a.dsh-octopus' })
  })

  it('never overrides an explicit autoActivate: false', () => {
    const decision = expectList(decideDiscovery([usable('a.dsh-octopus', false)]))
    expect(decision.autoOff).toBe(true)
    expect(decision.candidates.map(candidate => candidate.path)).toEqual(['a.dsh-octopus'])
  })

  it('never auto-applies a manifest that failed to parse', () => {
    // A broken file is not an opt-out: it must be listed, but without claiming
    // the author asked for a manual apply.
    const decision = expectList(decideDiscovery([broken('a.dsh-octopus')]))
    expect(decision.autoOff).toBe(false)
    expect(decision.candidates[0]!.error).toBe('unexpected token')
  })

  it('lists every candidate when the folder holds several', () => {
    const candidates = [usable('a.dsh-octopus'), usable('b.dsh-octopus')]
    const decision = expectList(decideDiscovery(candidates))
    expect(decision.autoOff).toBe(false)
    expect(decision.candidates).toEqual(candidates)
  })

  it('does not guess even when only one of several candidates is usable', () => {
    // Ambiguity is about what is in the FOLDER, not about which files parse.
    expect(decideDiscovery([broken('a.dsh-octopus'), usable('b.dsh-octopus')]).kind).toBe('list')
    expect(decideDiscovery([usable('a.dsh-octopus'), broken('b.dsh-octopus')]).kind).toBe('list')
  })

  it('lists nothing to apply when the folder holds no manifest', () => {
    expect(decideDiscovery([])).toEqual({ kind: 'list', candidates: [], autoOff: false })
  })
})
