import { resolve } from 'node:path'

import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'

// Preview code is inert unless the renderer was built with this exact test-only gate.
const visualPreviewEnvironment = process.env.TALKTYPE_VISUAL_PREVIEW === '1' ? '1' : '0'

function bundledDependencyInventory(): Plugin {
  return {
    name: 'talktype-bundled-dependency-inventory',
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
        fileName: 'bundled-dependencies.json',
        source: `${JSON.stringify({ version: 1, packages: [...packages].sort() }, null, 2)}\n`,
      })
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    // Sandboxed preload scripts cannot resolve arbitrary node_modules at runtime.
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] })],
  },
  renderer: {
    plugins: [bundledDependencyInventory()],
    define: {
      'import.meta.env.TALKTYPE_VISUAL_PREVIEW': JSON.stringify(visualPreviewEnvironment),
    },
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'src/renderer/index.html'),
          widget: resolve(__dirname, 'src/renderer/widget.html'),
          transcriptionWorker: resolve(
            __dirname,
            'src/renderer/src/transcription/worker.ts',
          ),
        },
      },
    },
  },
})
