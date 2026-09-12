import { resolve } from 'node:path'

import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'

// Preview code is inert unless the renderer was built with this exact test-only gate.
const visualPreviewEnvironment = process.env.SOTTO_VISUAL_PREVIEW === '1' ? '1' : '0'

function externalDependencyInventory(scope: 'main' | 'preload'): Plugin {
  return {
    name: `sotto-${scope}-external-dependency-inventory`,
    generateBundle(_options, bundle) {
      const outputFiles = new Set(Object.keys(bundle))
      const imports = new Set<string>()
      const dynamicImports = new Set<string>()
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        for (const specifier of output.imports) {
          if (!outputFiles.has(specifier)) imports.add(specifier)
        }
        for (const specifier of output.dynamicImports) {
          if (!outputFiles.has(specifier)) dynamicImports.add(specifier)
        }
      }
      this.emitFile({
        type: 'asset',
        fileName: 'external-dependencies.json',
        source: `${JSON.stringify({
          version: 1,
          scope,
          imports: [...imports].sort(),
          dynamicImports: [...dynamicImports].sort(),
        }, null, 2)}\n`,
      })
    },
  }
}

/**
 * Vite builds workers in their own rollup pass, so a library reachable only
 * from a worker never appears in the renderer's own inventory. The natural
 * speech worker is the only importer of transformers now, and app.asar still
 * redistributes it, so the worker pass writes an inventory of its own.
 */
function bundledDependencyInventory(fileName = 'bundled-dependencies.json'): Plugin {
  return {
    name: `sotto-bundled-dependency-inventory-${fileName}`,
    generateBundle(_options, bundle) {
      const packages = new Set<string>()
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        for (const id of Object.keys(output.modules ?? {})) {
          const normalized = id.replaceAll('\\', '/')
          const marker = '/node_modules/'
          const offset = normalized.lastIndexOf(marker)
          if (offset < 0) continue
          const parts = normalized.slice(offset + marker.length).split('/')
          const packageName = parts[0]?.startsWith('@')
            ? `${parts[0]}/${parts[1] ?? ''}`
            : parts[0]
          if (packageName) packages.add(packageName)
        }
      }
      this.emitFile({
        type: 'asset',
        fileName,
        source: `${JSON.stringify({ version: 1, packages: [...packages].sort() }, null, 2)}\n`,
      })
    },
  }
}

export default defineConfig({
  main: {
    build: { rollupOptions: { input: {
      index: resolve(__dirname, 'src/main/index.ts'),
      wakeWorker: resolve(__dirname, 'src/main/agents/wakeWorker.ts'),
    } } },
    // electron-updater is a devDependency that is compiled into the main chunk,
    // exactly like zod is compiled into the sandboxed preload: production
    // `dependencies` must stay `zod` alone so app.asar ships one module tree.
    plugins: [
      externalizeDepsPlugin({ exclude: ['electron-updater'] }),
      externalDependencyInventory('main'),
      bundledDependencyInventory(),
    ],
  },
  preload: {
    // Sandboxed preload scripts cannot resolve arbitrary node_modules at runtime.
    plugins: [
      externalizeDepsPlugin({ exclude: ['zod'] }),
      externalDependencyInventory('preload'),
    ],
  },
  renderer: {
    plugins: [bundledDependencyInventory()],
    worker: {
      plugins: () => [bundledDependencyInventory('bundled-dependencies.worker.json')],
    },
    define: {
      'import.meta.env.SOTTO_VISUAL_PREVIEW': JSON.stringify(visualPreviewEnvironment),
    },
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'src/renderer/index.html'),
          widget: resolve(__dirname, 'src/renderer/widget.html'),
        },
      },
    },
  },
})
