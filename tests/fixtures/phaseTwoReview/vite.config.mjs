// Review-only build of the real Threads workspace (ThreadWorkspace, panes, composer, queue, picker, transcript,
// activity and diagrams) with a synthetic agent connection. Output lives in the gitignored .cache so Playwright's
// test-results clean-up never removes it.
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const root = resolve(import.meta.dirname, '../../..')

export default defineConfig({
  root: import.meta.dirname,
  base: './',
  logLevel: 'warn',
  esbuild: { jsx: 'automatic' },
  resolve: { alias: [{ find: /^\.\/AgentContext$/u, replacement: resolve(import.meta.dirname, 'agentContextStub.ts') }] },
  build: { outDir: resolve(root, '.cache/phase-two-review-fixture'), emptyOutDir: true, minify: false, modulePreload: false },
})
