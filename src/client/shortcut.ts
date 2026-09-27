/**
 * The operation space's keyboard entry: one command that opens (or focuses) the
 * tab inside the sidebar pane the keystroke came from.
 *
 * WHY `Ctrl+Alt+S`, AND WHAT THE TWO EARLIER CHOICES COST. The binding is not a
 * matter of taste: `register` validates every declared profile AT REGISTRATION
 * TIME and THROWS on anything it does not like, and that throw lands in a
 * deferred callback — so the tab and the guide capsule keep working while the
 * command is silently absent from the catalog (no keycaps on the capsule, no row
 * in Settings > Shortcuts, and a key that does nothing). Both earlier choices
 * died exactly that way, and both were settled by reading the INSTALLED bundles
 * rather than by reasoning:
 *
 * 1. `Ctrl+O`. On the DESKTOP runtime the built-in `workspace.add` (add
 *    workspace / open folder) already holds `primary+KeyO`, and on the WEB
 *    runtime `isWebBindingAllowed` admits a ONE-modifier combination only for
 *    `primary+Comma`, `primary+Backslash` and `control+Backquote` — everything
 *    else throws `Unsupported Web shortcut`. Other `O` combinations are taken
 *    too (`workspace.openLocal`), and `Ctrl+O` is the browser's own "open file"
 *    besides.
 * 2. `Ctrl+Alt+W` (0.3.0 and 0.3.2, both shipped). `dsh-client-ui-sidebar-right`
 *    registers `page.close` with `primary+KeyW` on the desktop and
 *    `primary+alt+KeyW` on the web — the SAME combination — so the conflict
 *    check threw `Conflicting shortcut defaults: octopus.operationSpace and
 *    page.close (web:windows)`. The `KeyW` is written as a TERNARY there
 *    (`code: kind === 'close' ? 'KeyW' : 'KeyR'`, `ui-sidebar-right/lib/client.js:
 *    275`), which a grep for `code: "KeyW"` cannot see; the same trap exists in
 *    `dsh-client-ui-workspace`, which passes its key as a POSITIONAL ARGUMENT to
 *    a local `register(...)` helper. **Grep the INSTALLED tree for the bare
 *    string `"Key<X>"` across the installed `dsh-client-<package>/lib/client.js`
 *    files, never for `code: "Key<X>"`, and never only inside this repository's
 *    `node_modules` (which holds a handful of the client packages).**
 *
 * `KeyS` survives that sweep: no `"KeyS"` binding exists anywhere in the
 * installed client bundles (the only hit is xterm's key-code enum inside
 * `dsh-client-ui-sidebar-terminal/lib/client.terminal.js`, which is not a
 * binding). The shape is legal on every declared profile: `primary+alt` is the
 * two-modifier web shape (`dsh-client-shortcuts/lib/client.js:115`), `KeyS` is
 * absent from the reserved set (`:222-240` reserves `Escape/Tab/Space/Backspace/
 * Delete/Arrows`, `Enter` without Alt, `primary` + `KeyC/V/X/Z/Y/Q/H`, and
 * `primary+KeyA` without Shift), and the desktop Windows/macOS profiles skip the
 * reservation checks entirely (`:216`). `web:linux` is deliberately NOT declared,
 * exactly as in the built-in files pane: the web rule admits Linux only for a
 * tiny fixed set, so declaring one there would throw. `tests/shortcut-binding.spec.ts`
 * re-runs the "is this key already taken" sweep against whatever DSH is
 * installed next to this repository.
 *
 * THE KEYCAP IS NOT DISPATCH. The guide draws its `ShortcutKeys` from the
 * catalog row (`ui-sidebar-right/lib/client.js:489`, matched by `entry.commandId`
 * at `:528`), whereas actual delivery goes through a separate dispatch map that
 * is only filled while the shortcut configuration is usable
 * (`dsh-client-shortcuts/lib/client.js:622-623` gates it on
 * `config.status !== 'loading'`). In the shell this plugin was reported against,
 * the BUILT-IN `workspace.files` capsule shows its keycaps while its own key does
 * nothing — so that shell's delivery path is the open question, not this
 * command's defaults. What the defaults below decide is what the catalog, the
 * capsule and Settings > Shortcuts show, and that is what is pinned here.
 *
 * HOW THE SERVICES ARE REACHED, AND WHY NOT THROUGH `inject`. They are read with
 * `ctx.get(name)`, and the registration runs inside a `ctx.inject` wrapper (see
 * ./index.tsx) — the same shape the built-in files pane uses. Cordis 4.0.4
 * throws `cannot get property "<name>" without inject` for an undeclared service
 * read as a property (measured; `ctx.get(name)` is the only route that works
 * undeclared and returns `undefined` for a missing service instead of throwing),
 * and declaring these names in the client entry's plugin-level `inject` array is
 * FATAL: 0.3.1 did that and DSH stopped starting until the installed plugin was
 * removed. This plugin is mounted from a profile patch layer, not from a base
 * bundle, so it must not declare services owned by plugins it does not already
 * depend on.
 */
import type { Context, SidebarRightFace, SidebarShortcutsService } from '../context-types.ts'
import { t } from './locales.ts'
import { COMMAND_ID, TAB_KIND } from './multiroot-tab.tsx'

/**
 * The one default: `primary+alt+S` — `Ctrl+Alt+S` on Windows and Linux, `⌘⌥S` on
 * macOS. Copied per profile so no two catalog rows share a binding object (the
 * registry normalizes on registration; sharing one would make any in-place
 * normalization visible in the other profiles).
 */
export const DEFAULT_BINDING = { code: 'KeyS', modifiers: ['primary', 'alt'] } as const

/**
 * Register the operation space's keyboard command.
 * @param ctx - the client context; the two faces are read through `ctx.get`, the
 * one route cordis allows for a service this plugin does not declare.
 * @returns the disposer unregistering the command.
 */
export function registerOctopusShortcut(ctx: Context): () => void {
  // `ctx.get` on purpose — see the header. The casts mirror the one
  // `multiroot-tab.tsx` already uses for the same navigation face.
  const shortcuts = ctx.get('shortcuts') as SidebarShortcutsService | undefined
  const navigation = ctx.get('sidebarRight') as SidebarRightFace | undefined
  if (shortcuts === undefined || navigation === undefined) return () => {}
  return shortcuts.register({
    id: COMMAND_ID,
    label: () => t('operationSpace'),
    aliases: ['operation space', 'octopus', 'operation space tab'],
    defaults: {
      'desktop:macos': { ...DEFAULT_BINDING },
      'desktop:windows': { ...DEFAULT_BINDING },
      'desktop:linux': { ...DEFAULT_BINDING },
      'web:macos': { ...DEFAULT_BINDING },
      'web:windows': { ...DEFAULT_BINDING },
      // `web:linux` is deliberately absent, exactly as in the built-in files
      // pane: the web rule admits Linux only for a tiny fixed set of
      // combinations, so declaring one here would throw at registration.
    },
    regions: ['page', 'editable', 'terminal'],
    modals: [],
    resolve: (context) => {
      // The captured pane is what keeps this honest with several Sessions
      // mounted: the keystroke opens the tab where the user actually is, and
      // "no mounted Session" is a refusal with a reason rather than a guess at
      // somebody else's pane.
      const target = navigation.commandTarget(context.target)
      if (target === undefined) return { status: 'blocked', reason: t('shortcutNoSession') }
      return {
        status: 'handled',
        run: () => { navigation.openTabFromTarget(TAB_KIND, target) },
      }
    },
  })
}
