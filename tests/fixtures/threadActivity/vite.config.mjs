// Test-only build of the real Threads page with a stubbed agent connection, for rendered activity checks.
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const root = resolve(import.meta.dirname, '../../..')

export default defineConfig({
  root: import.meta.dirname,
  base: './',
  logLevel: 'warn',
  esbuild: { jsx: 'automatic' },
  resolve: { alias: [{ find: /^\.\/AgentContext$/u, replacement: resolve(import.meta.dirname, 'agentContextStub.ts') }] },
  build: { outDir: resolve(root, 'test-results/thread-activity-fixture'), emptyOutDir: true, minify: false, modulePreload: false },
})
