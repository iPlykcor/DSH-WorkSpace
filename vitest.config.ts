/**
 * Vitest config.
 *
 * The only resolution override is the DSH PLATFORM MODULE the client bundle
 * consumes: `@deepseek-ai/dsh-client-ui-primitives` is a peerDependency that
 * the host injects at mount time (the purity gate keeps it external), and its
 * own transitive dependencies live in the host's install rather than this
 * repo's — so importing the real built bundle from a test cannot be resolved.
 * It is aliased to a no-op stub; see the stub's doc for the reasoning.
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@deepseek-ai\/dsh-client-ui-primitives$/,
        replacement: fileURLToPath(new URL('./tests/stubs/dsh-client-ui-primitives.ts', import.meta.url)),
      },
    ],
  },
  test: {
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
