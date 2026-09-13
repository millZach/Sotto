import { defineConfig } from '@playwright/test'

// Opt-in rendered verification of the composer and queue fixes. It is not part of `npm run test:e2e`: it records
// screenshots and measurements under artifacts/phase-two-composer-fixed and asserts the layout and focus facts fixed.
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.review\.ts/u,
  timeout: 300_000,
  workers: 1,
  fullyParallel: false,
  reporter: 'line',
  outputDir: '../../../test-results/composer-polish-review',
})
