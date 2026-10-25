// Test-only build of the real Threads page with a stubbed agent connection, for rendered activity checks.
import { resolve } from 'node:path'
import { lingui } from '@lingui/vite-plugin'
import { defineConfig } from 'vite'

const root = resolve(import.meta.dirname, '../../..')

export default defineConfig({
  root: import.meta.dirname,
  base: './',
  logLevel: 'warn',
  esbuild: { jsx: 'automatic' },
  // Lingui's macros become message lookups at build time, as in the app's own renderer build (ADR-0123).
  plugins: [lingui({ macroTransform: true, failOnCompileError: true })],
  resolve: { alias: [{ find: /^\.\/AgentContext$/u, replacement: resolve(import.meta.dirname, 'agentContextStub.ts') }] },
  build: { outDir: resolve(root, 'test-results/thread-activity-fixture'), emptyOutDir: true, minify: false, modulePreload: false },
})
