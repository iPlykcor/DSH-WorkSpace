/**
 * Vitest config: inline the npm-published `@deepseek-ai/*` packages whose
 * BUILT lib bundles reach css side-effect imports (e.g. `dsh-client-ui-primitives`
 * imports `katex/dist/katex.min.css` at the top of its `lib/index.js`).
 *
 * Installed from the npm registry these packages live under
 * `node_modules/.pnpm` and are externalized by vitest — Node then chokes on
 * the `.css` import. Inlining routes them through Vite's transform, which
 * stubs css imports (the default `css: false`).
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    server: {
      deps: {
        inline: [/@deepseek-ai\/dsh-client-ui-primitives/],
      },
    },
    // `*.e2e.ts` specs would belong to a browser lane; this package has none
    // (the Playwright config was removed with the workbench). The *.spec.*
    // naming convention already keeps them out of vitest — this exclude makes
    // that explicit so a future lane cannot be collected by accident.
    // NOTE: `exclude` REPLACES vitest's defaults, so the standard
    // node_modules/dist/etc. excludes must be restated here.
    exclude: [
      'tests/e2e/**',
      // Local dev worktrees (pnpm/DSH-style task branches) may carry stale
      // code against this checkout's node_modules — never collect them.
      '**/.worktrees/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
    ],
  },
})
