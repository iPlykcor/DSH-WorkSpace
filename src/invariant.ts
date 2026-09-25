/**
 * Package-owned invariant companion for `dsh-octopus-operation-space`.
 * @module dsh-octopus-operation-space/invariant
 */

/* jscpd:ignore-start */
import type { Context } from './context-types.ts'

const PACKAGE_NAME = 'dsh-octopus-operation-space'

/** Cordis companion plugin name. */
export const name = 'dsh-octopus-operation-space-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this plugin owns no service state or event protocol of
 * its own — the single route is mounted under the host's webServer fence and
 * the operation-space registry is a plain per-session map whose semantics are
 * asserted by the unit specs.
 */
const install: () => void = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
