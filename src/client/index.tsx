/**
 * Client half of dsh-octopus-operation-space.
 *
 * Three responsibilities, nothing else:
 * 1. register the plugin's zh/en dictionaries into the DSH locale registry;
 * 2. contribute the operation-space tab into DSH's BUILT-IN right Sidebar;
 * 3. register the keyboard command that opens that tab (./shortcut.ts).
 *
 * The plugin deliberately ships no panel of its own. The built-in Sidebar owns
 * the right column on DSH 0.1.5+, so mounting a second portal would draw the
 * same column twice; and file opening / rendering stays with the product
 * rather than being reimplemented here.
 */
import type { Context } from '../context-types.ts'
import { registerMultiRootTab } from './multiroot-tab.tsx'
import { LOCALE_NS, attachLocale, en, zh } from './locales.ts'
import { registerOctopusShortcut } from './shortcut.ts'

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
 *
 * THIS LIST MUST NOT GROW. 0.3.1 added `shortcuts` and `sidebarRight` to it and
 * DSH stopped starting altogether — nothing short of removing the installed
 * plugin brought the GUI back. This plugin is mounted from a PROFILE PATCH LAYER,
 * not from a base bundle, and declaring a service owned by a plugin it does not
 * already depend on is not the move the base bundle makes (the built-in right
 * Sidebar declares `shortcuts` from inside the bundle — `ui-sidebar-right/
 * lib/client.js:9015` — which is a different situation). Services needed LATER
 * are fetched with `ctx.get(name)` inside a `ctx.inject` wrapper; see the
 * keyboard entry at the end of `apply`.
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

  // The keyboard entry. `shortcuts` is reached through `ctx.inject` — NEVER by
  // adding it to the inject array above (see the note there) — and the services
  // are read with `ctx.get`, the one route cordis allows for a name this plugin
  // does not declare. Both halves are load-time safe by construction: the wrapper
  // waits, so a registry that never appears costs the keybinding and nothing
  // else, and anything thrown in here is thrown in a DEFERRED callback — which is
  // why 0.3.0 kept starting while its registration silently died.
  ctx.inject(['shortcuts'], () => {
    ctx.effect(() => registerOctopusShortcut(ctx), 'octopus: shortcut')
  })
}
