/**
 * Client half of dsh-octopus-operation-space.
 *
 * Two responsibilities, nothing else:
 * 1. register the plugin's zh/en dictionaries into the DSH locale registry;
 * 2. contribute the operation-space tab into DSH's BUILT-IN right Sidebar.
 *
 * The plugin deliberately ships no panel of its own. The built-in Sidebar owns
 * the right column on DSH 0.1.5+, so mounting a second portal would draw the
 * same column twice; and file opening / rendering stays with the product
 * rather than being reimplemented here.
 */
import type { Context } from '../context-types.ts'
import { registerMultiRootTab } from './multiroot-tab.tsx'
import { LOCALE_NS, attachLocale, en, zh } from './locales.ts'

/**
 * Services required before mounting (provided by the client runtime).
 *
 * `sidebarRightTabs` belongs HERE, not only in the optional probe inside
 * `registerMultiRootTab`: cordis activates a fiber as soon as its declared deps
 * exist, and the built-in right Sidebar's own inject list is longer (`layout`,
 * `resources`, `uiSession`, `shortcuts` are in it), so this plugin can reach
 * `apply` FIRST and find the service missing. That failure is silent — the
 * registration returns a no-op and never retries — which is exactly how the tab
 * ends up missing with no error anywhere. Every built-in DSH plugin that uses
 * this service declares it as a dependency for the same reason. A host older
 * than 0.1.5 simply leaves the fiber inactive instead of crashing, and
 * `dsh.plugin.json` already states `engines.dsh: >=0.1.5`.
 */
export const inject = ['slots', 'sessions', 'locale', 'sidebarRightTabs']

/**
 * Client plugin body.
 * @param ctx - the client cordis context (slots, sessions, locale).
 */
export function apply(ctx: Context): void {
  // The copy follows the DSH i18n system: attach the locale service so the
  // module-level t()/isZh() resolve the Host-backed language preference, and
  // register the dictionaries into the shared locale registry. The disposers
  // run on fiber disposal, so re-activation (HMR) re-registers cleanly.
  attachLocale(ctx.locale)
  ctx.effect(() => {
    const offZh = ctx.locale.register(LOCALE_NS, 'zh', zh)
    const offEn = ctx.locale.register(LOCALE_NS, 'en', en)
    return () => { offZh(); offEn() }
  }, 'octopus: dictionaries')

  // The built-in right Sidebar's tab registry is this plugin's only surface.
  // registerMultiRootTab no-ops on a host that does not publish
  // `ctx.sidebarRightTabs`, so no version gate is needed here.
  ctx.effect(() => registerMultiRootTab(ctx), 'octopus: operation-space tab (built-in Sidebar)')
}
