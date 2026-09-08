/**
 * tsdown build for dsh-workspace: the host-half lib (lib/index.js and
 * the lib/invariant.js companion, ESM node) plus the two browser client
 * bundles (lib/client.js and lib/client-registry.js, CJS closure factory) —
 * one per install channel:
 *
 * - `lib/client.js` serves the official profile channel, registering with
 *   the package-name id `dsh-workspace` (the client-modules compose
 *   keys on the package name; keep it in sync with package.json `name`),
 * - `lib/client-registry.js` serves the plugin-registry channel
 *   (dsh.plugin.json), registering with the manifest id
 *   `dsh-external/dsh-workspace` (the registry browser-side `arrive()`
 *   check requires bundle id === plugin id).
 *
 * Both bundles replicate the official DSH client-bundle preset
 * (packages/client/tsdown.client.ts) and are compiled from the same
 * src/client/index.tsx source — only the registered id and the output file
 * name differ, so they cannot drift:
 * - externals resolve through the loader module table at runtime (the
 *   PLATFORM_MODULES seed list from apps/web's platform.ts, plus the
 *   runtime/client exemption),
 * - everything else is inlined into the bundle (xterm, clsx, ...),
 * - the purity gate rejects any other @deepseek-ai value import: cross-plugin
 *   collaboration goes through cordis services, never value imports,
 * - CSS Modules compile to hashed class maps and inject <style data-plugin>
 *   tags at factory execution,
 * - each artifact registers itself via window.__ModuleLoader__.load({id,
 *   factory}) with the (require) => exports CJS closure shape.
 *
 * Lazy chunks (lib/client-<name>.js): the heavy preview/terminal libraries
 * (CodeMirror, xterm) build as two standalone chunk bundles
 * (src/client/chunks/<name>.tsx), shared by both channels. Each script
 * assigns its factory to the plugin-owned global registry
 * (globalThis.__dshChunks__) and is fetched by
 * the client on first use from the plugin's own /sidebar/bundle route —
 * chunks deliberately do NOT go through the module loader (see
 * src/client/chunk-loader.ts). `codeSplitting: false` keeps every chunk a
 * single script; the core client.js must never statically import a chunks/
 * entry.
 *
 * Types ship from lib/types (tsc -p tsconfig.build.json), not from tsdown.
 */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve as resolvePath, sep } from 'node:path'
import { builtinModules, createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

const require = createRequire(import.meta.url)

/** Node builtins must never survive into the browser module-loader factory. */
const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map(id => `node:${id}`),
])

/** Module specifiers the web shell shares into the frozen module table (the official PLATFORM_MODULES list; `dsh-client-runtime` was removed upstream in DSH 0.1.2-alpha and no chunk requires it). */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

/**
 * react-icons' exports map lists `require` BEFORE `import`, so the shared
 * conditionNames resolve the unshakeable CJS entry and the whole icon set
 * lands in the core bundle (~6.4 MB extra). Pin the two sets the client
 * uses to their ESM entries, which tree-shake down to the imported icons.
 */
const reactIconsRoot = dirname(dirname(require.resolve('react-icons/lib')))
const REACT_ICONS_ESM_ALIAS = {
  'react-icons/si': join(reactIconsRoot, 'si/index.mjs'),
  'react-icons/vsc': join(reactIconsRoot, 'vsc/index.mjs'),
}

/**
 * Wire/type layers a client bundle may inline (mirror of the official
 * INLINE_SAFE list): browser-safe contract surfaces with no runtime identity
 * to share. Everything else under @deepseek-ai/* is either a module-table
 * entry (external) or a leak the purity gate rejects.
 */
const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|session|llm|tools|brand)(\/|$)/

/** Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline. */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

const REPOSITORY_ROOT = fileURLToPath(new URL('.', import.meta.url))

/** The style-injection prologue shared by module css and plain css loads. */
function injectTag(pluginId: string, fileId: string, cssText: string): string {
  const tagId = `${pluginId}/${basename(fileId)}`
  return [
    `const css = ${JSON.stringify(cssText)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    `if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {`,
    `  const tag = document.createElement('style');`,
    `  tag.dataset.plugin = ${JSON.stringify(pluginId)};`,
    `  tag.dataset.pluginCss = tagId;`,
    `  tag.textContent = css;`,
    `  document.head.appendChild(tag);`,
    `}`,
  ].join('\n')
}

/** Rebase a physical lib-relative source onto the repository-shaped URL tree. */
function browserSourcePath(source: string, sourcemapPath: string): string {
  if (!source.startsWith('.')) return source
  const physicalSource = resolvePath(dirname(sourcemapPath), source)
  const repositoryPath = relative(REPOSITORY_ROOT, physicalSource).split(sep).join('/')
  return `../../../${repositoryPath}`
}

/**
 * One client bundle build for a plugin id. The same src/client/index.tsx is
 * compiled twice with only the registered id and the output file name
 * differing: the official channel uses the package name (`dsh-workspace`)
 * and the registry channel uses the manifest id
 * (`dsh-external/dsh-workspace`).
 * @param pluginId - the `__ModuleLoader__.load({ id })` value and the
 *   data-plugin style-tag prefix of this bundle.
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
    external: [...CLIENT_EXTERNALS],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
      // No bundled chunk uses import.meta.resolve; keep the stub so a stray
      // reference cannot resolve to Node's loader (browser CJS has none).
      'import.meta.resolve': 'undefined',
    },
    // CJS output otherwise makes some transitive packages resolve their
    // Node entry even though this bundle runs in the browser. Keep browser
    // conditional exports authoritative for both source import() and
    // generated require() edges.
    inputOptions: {
      resolve: {
        conditionNames: ['browser', 'import', 'require', 'default'],
        alias: REACT_ICONS_ESM_ALIAS,
      },
    },
    // External wins for module-table entries; every other dependency inlines.
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    plugins: [purityGatePlugin(), makeCssPlugin(pluginId)],
    outputOptions: {
      entryFileNames: entryFile,
      sourcemapPathTransform: browserSourcePath,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, factory: (require) => {`,
      footer: `return module.exports; } });`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      // The CJS wrapper factory's `require` only resolves module-table entries
      // (react, cordis, ...); it cannot load relative chunk URLs in the browser.
      // Disable code splitting so every artifact is one script (the lazy chunk
      // files themselves are separate bundles — see chunkBundle below).
      codeSplitting: false,
    },
  }
}

/**
 * One lazy chunk bundle: a heavy feature slice of the client built as a
 * standalone single script (lib/client-<name>.js), fetched by the client on
 * first use through the plugin's /sidebar/bundle route. The core bundle must
 * never statically import the chunk entry.
 *
 * Chunks do NOT register with window.__ModuleLoader__: the module loader's
 * import() resolves seed words / shell-own modules / registered factories /
 * boot graph rows, and a chunk id is none of those — resolution would be
 * version-dependent. Instead each script assigns its CJS factory to the
 * plugin-owned global registry `globalThis.__dshChunks__[<name>]`, and the
 * loader (src/client/chunk-loader.ts) materializes it with a require built
 * from the module table's seed words.
 *
 * Chunk css tags use the constant plugin id `dsh-workspace` (matching
 * the official channel; the registry channel re-injects an identical copy
 * of the shared module css — same content, no functional impact).
 * @param name - chunk name; entry src/client/chunks/<name>.tsx, output
 *   lib/client-<name>.js. Keep in sync with CHUNK_NAMES in src/bundle-route.ts.
 */
function chunkBundle(name: string): UserConfig {
  return {
    entry: { [name]: `src/client/chunks/${name}.tsx` },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
      'import.meta.resolve': 'undefined',
    },
    inputOptions: {
      resolve: {
        conditionNames: ['browser', 'import', 'require', 'default'],
      },
    },
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    plugins: [
      ...(name === 'office' || name === 'zip' || name === 'archive' ? [browserNodeShims()] : []),
      ...(name === 'archive' ? [archiveChunkAliases(), inlineWasmPlugin()] : []),
      ...(name === 'archive' ? [archiveEnvPatch()] : []),
      purityGatePlugin(),
      makeCssPlugin('dsh-workspace'),
      ...(name === 'mermaid' ? [mermaidChunkAliases()] : []),
    ],
    outputOptions: {
      entryFileNames: `client-${name}.js`,
      sourcemapPathTransform: browserSourcePath,
      banner: `globalThis.__dshChunks__ = globalThis.__dshChunks__ || {}; globalThis.__dshChunks__[${JSON.stringify(name)}] = (require) => {`,
      footer: 'return module.exports; };',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      codeSplitting: false,
    },
  }
}

/** A rolldown plugin as tsdown's config accepts it (contextual `this` for load/resolveId). */
type BuildPlugin = NonNullable<UserConfig['plugins']>

/**
 * Mermaid-chunk-only alias: pin uuid's BROWSER entry. The mermaid core
 * (mindmap definition) imports the bare `uuid` specifier, which rolldown
 * resolves to uuid's node entry — its dist-node modules import
 * `node:crypto` and trip the client purity gate. The browser entry
 * (uuid/dist/index.js, Web Crypto based) carries no Node builtins, so alias
 * the specifier there instead of special-casing the gate. Resolved relative
 * to mermaid's own dependency tree (pnpm/npm layout agnostic).
 */
/** Node-only builtins the office/zip libs import (SheetJS stubs these via its own
 *  `browser` field: `{ fs:false, stream:false, buffer:false, crypto:false,
 *  process:false }`; fflate references `module`). The chunks replace them with an
 *  empty module before the purity gate so a browser bundle can build — those code
 *  paths are Node-only and never run in the browser. */
const BROWSER_NODE_STUBS = new Set([
  'fs', 'stream', 'buffer', 'crypto', 'path', 'os', 'util', 'events', 'zlib',
  'url', 'querystring', 'readable-stream', 'child_process', 'module', 'process',
  'assert', 'tty', 'net', 'http', 'https',
])
function browserNodeShims(): BuildPlugin {
  return {
    name: 'dsh-browser-node-shims',
    resolveId(source: string) {
      if (BROWSER_NODE_STUBS.has(source)) return `\0dsh-browser-stub:${source}`
      return null
    },
    load(id: string) {
      if (id.startsWith('\0dsh-browser-stub:')) return 'export default {};'
      return null
    },
  }
}

/**
 * Archive-chunk-only alias: pin `7z-wasm` to its ESM-free UMD build. The
 * package `module` entry (`7zz.es6.js`) uses `import.meta.url` and a
 * dynamic `await import("module")` for its Node branch — bundling it into a
 * CJS browser chunk trips rolldown. The UMD build (`7zz.umd.js`) is a plain
 * CommonJS closure that exports the factory and references no `import.meta`,
 * so it bundles cleanly. The chunk source still writes `import SevenZip from
 * '7z-wasm'` (typed via the package index.d.ts); the alias is build-only.
 */
function archiveChunkAliases(): BuildPlugin {
  const sevenZipUmd = resolvePath(
    dirname(require.resolve('7z-wasm/package.json')),
    '7zz.umd.js',
  )
  return {
    name: 'dsh-archive-7z-umd-alias',
    resolveId(source: string) {
      if (source === '7z-wasm') return sevenZipUmd
      return null
    },
  }
}

/**
 * Archive-chunk-only plugin: inline each wasm payload as a base64 default
 * export so the chunk is self-contained (offline/intranet single-install).
 * The virtual modules `dsh-wasm/7z` and `dsh-wasm/unrar` resolve to the
 * .wasm files in the plugin's own dependency tree at build time.
 */
const ARCHIVE_WASM: Record<string, string> = {
  'dsh-wasm/7z': resolvePath(dirname(require.resolve('7z-wasm/package.json')), '7zz.wasm'),
  'dsh-wasm/unrar': resolvePath(dirname(require.resolve('node-unrar-js/package.json')), 'dist', 'js', 'unrar.wasm'),
}
function inlineWasmPlugin(): BuildPlugin {
  return {
    name: 'dsh-archive-inline-wasm',
    resolveId(source: string) {
      if (source in ARCHIVE_WASM) return `\0dsh-wasm:${source}`
      return null
    },
    load(id: string) {
      const match = /^\0dsh-wasm:(dsh-wasm\/.+)$/.exec(id)
      if (match === null || match[1] === undefined) return null
      const file = ARCHIVE_WASM[match[1]]
      if (file === undefined) return null
      return `export default ${JSON.stringify(readFileSync(file).toString('base64'))};`
    },
  }
}

/**
 * Archive-chunk-only plugin: undo the build-time environment folding of the
 * emscripten glues. oxc constant-folds `ENVIRONMENT_IS_NODE` /
 * `ENVIRONMENT_IS_WEB` from the BUILD-time `process`/`window` (Node), so the
 * unrar glue ships `ENVIRONMENT_IS_NODE = true` and takes its Node branch in
 * the browser — which reads `__dirname` / `require("fs")` and throws
 * "`__dirname` is not defined". After bundling, force the browser environment
 * on the output so both glues take the WEB branch (they still get their bytes
 * via the inlined `wasmBinary`, never a URL/fs fetch).
 */
function archiveEnvPatch(): BuildPlugin {
  return {
    name: 'dsh-archive-env-patch',
    renderChunk(code: string, chunk: { name?: string }) {
      if (chunk.name !== 'archive') return null
      return code
        .replace(/var ENVIRONMENT_IS_NODE\s*=\s*(true|!0);/g, 'var ENVIRONMENT_IS_NODE = false;')
        .replace(/var ENVIRONMENT_IS_WEB\s*=\s*false;/g, 'var ENVIRONMENT_IS_WEB = true;')
    },
  }
}

function mermaidChunkAliases(): BuildPlugin {
  const uuidBrowserEntry = resolvePath(
    dirname(require.resolve('uuid/package.json', { paths: [dirname(require.resolve('mermaid/package.json'))] })),
    'dist/index.js',
  )
  return {
    name: 'dsh-mermaid-uuid-browser-alias',
    resolveId(source: string) {
      if (source === 'uuid') return uuidBrowserEntry
      return null
    },
  }
}

/** The shared client-bundle purity gate (see the clientBundle doc). */
function purityGatePlugin(): BuildPlugin {
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

/** The shared CSS-inline virtual-module plugin (one <style data-plugin> per file). */
function makeCssPlugin(pluginId: string): BuildPlugin {
  return {
    name: 'dsh-css-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.css')) return null
      // Relative/absolute paths resolve against the importer; bare
      // specifiers (e.g. '@xterm/xterm/css/xterm.css') resolve from the package.
      let abs: string
      if (source.startsWith('.') || source.startsWith('/') || /^[A-Za-z]:[\\/]/.test(source)) {
        abs = importer === undefined ? source : resolvePath(dirname(importer), source)
      } else {
        abs = require.resolve(source)
      }
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      // CSS Modules (x.module.css) become hashed class maps; plain css
      // (xterm's stylesheet) is inlined verbatim.
      if (fileId.endsWith('.module.css')) {
        const { code, exports: cssExports } = transform({
          filename: fileId,
          code: source,
          cssModules: { pattern: `[hash]_[local]` },
          minify: true,
        })
        const classMap: Record<string, string> = {}
        for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
        return [
          injectTag(pluginId, fileId, code.toString()),
          `export default ${JSON.stringify(classMap)};`,
        ].join('\n')
      }
      return [
        injectTag(pluginId, fileId, source.toString('utf8')),
        'export default "";',
      ].join('\n')
    },
  }
}

/** The lazy chunk names (keep in sync with src/bundle-route.ts CHUNK_NAMES). */
const CHUNKS = ['terminal', 'editor', 'mermaid', 'locale', 'office', 'zip', 'archive']

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
  clientBundle('dsh-workspace', 'client.js'),
  // Plugin-registry channel: bundle id = manifest id (dsh.plugin.json `id`).
  clientBundle('dsh-external/dsh-workspace', 'client-registry.js'),
  // Lazy chunks: shared by both channels, fetched on first use through the
  // plugin's /sidebar/bundle route (see src/client/chunk-loader.ts).
  ...CHUNKS.map(chunkBundle),
] satisfies UserConfig[]
