import { defineConfig } from '@playwright/test'

/**
 * Main's code that a spec runs in this process uses Lingui's macros and reads its catalogs with Vite's import.meta.glob
 * (ADR-0123). The build and Vitest compile both through Vite; Playwright's own Babel transform gets the same macro
 * transform and a stand-in for the glob (#1579). Playwright reads extra Babel plugins from this key, which its component
 * testing uses and its public config type does not name. `npm run e2e:list`, a gate in CI, loads every spec to keep it so.
 */
const transform = {
  '@playwright/test': {
    babelPlugins: [[require.resolve('@lingui/babel-plugin-lingui-macro')], [require.resolve('./tests/e2e/support/viteGlobPlugin.cjs')]],
  },
}

export default defineConfig({
  testDir: './tests/e2e',
  // The journeys make projects under the temporary folder too: the run stops when that folder is inside a repository.
  globalSetup: './tests/globalSetup.ts',
  timeout: 30_000,
  workers: 1,
  fullyParallel: false,
  ...transform,
  use: {
    trace: 'on-first-retry',
  },
})
