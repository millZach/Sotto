import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  // The journeys make projects under the temporary folder too: the run stops when that folder is inside a repository.
  globalSetup: './tests/globalSetup.ts',
  timeout: 30_000,
  workers: 1,
  fullyParallel: false,
  use: {
    trace: 'on-first-retry',
  },
})
