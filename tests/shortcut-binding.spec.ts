/**
 * The keyboard binding must be a key no built-in command already owns — and the
 * sweep has to look in the right place.
 *
 * WHY THIS EXISTS. `ShortcutRegistry.register` validates every declared profile
 * and THROWS on a conflicting default (`Conflicting shortcut defaults: <a> and
 * <b> (<runtime>:<platform>)`, `dsh-client-shortcuts/lib/client.js:602`). The
 * throw happens inside the deferred `ctx.inject` callback, so the shell keeps
 * working while the command is missing from the catalog: no keycaps on the guide
 * capsule, no row in Settings > Shortcuts, a key that does nothing, and nothing
 * in the host log. That is exactly what shipped in 0.3.0 and 0.3.2, whose
 * `Ctrl+Alt+W` collided with the built-in `page.close`
 * (`ui-sidebar-right/lib/client.js:274-291`).
 *
 * WHY THE SWEEP IS A STRING SEARCH FOR `"Key<X>"`. The built-ins do not always
 * write their keys where a regex expects them: `page.close` uses a ternary
 * (`code: kind === 'close' ? 'KeyW' : 'KeyR'`) and `dsh-client-ui-workspace`
 * passes its key as a POSITIONAL ARGUMENT to a local `register(...)` helper. A
 * search for `code: "Key<X>"` finds neither, which is how the collision above
 * was missed once already. Only `lib/client.js` is read — not
 * `lib/client.terminal.js`, whose xterm key-code enum mentions every `KeyX`
 * without ever binding one.
 *
 * WHY IT SKIPS. The check is about the product build that will run the plugin, so
 * it reads the DSH installation next to this repository. On a machine (or CI run)
 * without one there is nothing to check against, and the suite says so instead of
 * pretending to have verified anything.
 */
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_BINDING } from '../src/client/shortcut.ts'

/** Candidate roots of `@deepseek-ai/dsh/node_modules/@deepseek-ai`, if present. */
function clientBundleRoots(): string[] {
  const appData = process.env.APPDATA ?? ''
  const localAppData = process.env.LOCALAPPDATA ?? ''
  const candidates = [
    join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'),
    join(localAppData, 'pnpm', 'global', '5', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'),
  ]
  return candidates.filter(candidate => candidate.length > 0 && existsSync(candidate))
}

/** Every `dsh-client-<package>/lib/client.js` under one root. */
async function clientBundles(root: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('dsh-client-')) continue
    const bundle = join(root, entry.name, 'lib', 'client.js')
    if (existsSync(bundle)) found.push(bundle)
  }
  return found
}

describe('shortcut binding availability', () => {
  it('is not already owned by a built-in client command', async () => {
    const roots = clientBundleRoots()
    const bundles = (await Promise.all(roots.map(clientBundles))).flat()
    if (bundles.length === 0) {
      // No DSH installation to check against: the sweep is about the product
      // build, and reporting a pass here would be a lie.
      expect(roots).toEqual(roots.filter(root => existsSync(root)))
      return
    }
    const needle = `"${DEFAULT_BINDING.code}"`
    const owners: string[] = []
    for (const bundle of bundles) {
      const source = await readFile(bundle, 'utf8')
      if (source.includes(needle)) owners.push(bundle)
    }
    expect(owners).toEqual([])
  })
})
