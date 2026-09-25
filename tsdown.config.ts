/**
 * tsdown config for dsh-octopus-operation-space.
 *
 * Three bundles:
 * - `lib/index.js` + `lib/invariant.js` — the Node half (ESM).
 * - `lib/client.js` and `lib/client-registry.js` — the SAME client entry
 *   compiled twice with only the registered id and the output file name
 *   differing: the official profile channel registers under the package name,
 *   the plugin-registry channel under the manifest id (dsh.plugin.json `id`).
 *   Both are CJS closure factories wrapped for `window.__ModuleLoader__.load`.
 *
 * There are no lazy chunk bundles: the plugin ships no heavy viewers, so the
 * client is a single small script (no /sidebar/bundle route, no chunk loader).
 */
import { builtinModules } from 'node:module'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TsdownPlugin, UserConfig } from 'tsdown'

/** Every Node builtin specifier (bare and node:-prefixed) the purity gate rejects. */
const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map(id => `node:${id}`),
])

/** Module specifiers the web shell shares into the frozen module table (the official PLATFORM_MODULES list). */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

/** Wire/type layers that are inline-safe by design (structural mirrors, not cross-plugin value imports). */
const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|session|llm|tools|brand)(\/|$)/

const REPOSITORY_ROOT = fileURLToPath(new URL('.', import.meta.url))

/** Rebase a physical lib-relative source onto the repository-shaped URL tree. */
function browserSourcePath(source: string, sourcemapPath: string): string {
  if (!source.startsWith('.')) return source
  const physicalSource = resolve(dirname(sourcemapPath), source)
  const repositoryPath = relative(REPOSITORY_ROOT, physicalSource).split(sep).join('/')
  return `../../../${repositoryPath}`
}

/** The shared client-bundle purity gate (see the clientBundle doc). */
function purityGatePlugin(): TsdownPlugin {
  return {
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (NODE_BUILTINS.has(source)) {
        throw new Error(
          `client bundle purity: Node builtin "${source}" cannot run in the browser module table — `
          + 'select the dependency browser export or add an explicit browser implementation',
        )
      }
      if (!source.startsWith('@deepseek-ai/')) return null
      if (CLIENT_EXTERNALS.includes(source)) return null // platform module: external wins
      if (INLINE_SAFE.test(source)) return null // wire/type layer: inline is the point
      throw new Error(
        `client bundle purity: "${source}" is not a platform module (CLIENT_EXTERNALS) and not an inline-safe wire layer — `
        + 'cross-plugin value imports are forbidden; collaborate through cordis services (type-only imports are erased and never reach this gate)',
      )
    },
  }
}

/**
 * One client bundle build for a plugin id. The same src/client/index.tsx is
 * compiled twice with only the registered id and the output file name
 * differing: the official channel uses the package name
 * (`dsh-octopus-operation-space`) and the registry channel uses the manifest
 * id (`dsh-external/dsh-octopus-operation-space`).
 * @param pluginId - the `__ModuleLoader__.load({ id })` value of this bundle.
 * @param entryFile - the output file name under lib/.
 */
function clientBundle(pluginId: string, entryFile: string): UserConfig {
  return {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    // Module-table entries stay external. Nothing else is imported (the plugin
    // has no third-party code), so the remainder of the graph is the plugin's
    // own source and inlines by default.
    deps: { neverBundle: [...CLIENT_EXTERNALS] },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
      'import.meta.resolve': 'undefined',
    },
    // CJS output otherwise makes some transitive packages resolve their Node
    // entry even though this bundle runs in the browser. Keep browser
    // conditional exports authoritative for both source import() and
    // generated require() edges.
    inputOptions: {
      resolve: {
        conditionNames: ['browser', 'import', 'require', 'default'],
      },
    },
    plugins: [purityGatePlugin()],
    outputOptions: {
      entryFileNames: entryFile,
      sourcemapPathTransform: browserSourcePath,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      // The CJS wrapper factory's `require` only resolves module-table
      // entries (react, cordis, ...); it cannot load relative URLs in the
      // browser. Disable code splitting so the artifact is one script.
      codeSplitting: false,
    },
  }
}

export default [
  {
    entry: { index: 'src/index.ts', invariant: 'src/invariant.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    // clean stays off: the build script removes lib/ wholesale before tsc, so
    // a tsdown clean here would wipe the lib/types declarations tsc just
    // emitted (and `watch` must never touch them).
    clean: false,
  },
  // Official profile channel: bundle id = package name (package.json `name`).
  clientBundle('dsh-octopus-operation-space', 'client.js'),
  // Plugin-registry channel: bundle id = manifest id (dsh.plugin.json `id`).
  clientBundle('dsh-external/dsh-octopus-operation-space', 'client-registry.js'),
] satisfies UserConfig[]
