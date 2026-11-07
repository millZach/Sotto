// Test-only build of the rich message components inside the real Threads layout classes.
import { resolve } from 'node:path'
import { lingui } from '@lingui/vite-plugin'
import { defineConfig } from 'vite'

const root = resolve(import.meta.dirname, '../../..')

/** Same inventory rule as electron.vite.config.ts, so the notices audit can read what these components bundle. */
function bundledDependencyInventory() {
  return {
    name: 'rich-fixture-bundled-dependency-inventory',
    generateBundle(_options, bundle) {
      const packages = new Set()
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        for (const id of Object.keys(output.modules ?? {})) {
          const normalized = id.replaceAll('\\', '/')
          const offset = normalized.lastIndexOf('/node_modules/')
          if (offset < 0) continue
          const parts = normalized.slice(offset + '/node_modules/'.length).split('/')
          packages.add(parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1] ?? ''}` : parts[0])
        }
      }
      this.emitFile({ type: 'asset', fileName: 'bundled-dependencies.json', source: `${JSON.stringify({ version: 1, packages: [...packages].sort() }, null, 2)}\n` })
    },
  }
}

export default defineConfig({
  root: import.meta.dirname,
  base: './',
  logLevel: 'warn',
  esbuild: { jsx: 'automatic' },
  // The components ask for their words as the renderer does: Lingui's macros and the `.po` catalogs compile at build time (ADR-0123).
  plugins: [lingui({ macroTransform: true, failOnCompileError: true }), bundledDependencyInventory()],
  build: { outDir: resolve(root, 'test-results/rich-messages-fixture'), emptyOutDir: true, minify: false, modulePreload: false },
})
