import { resolve } from 'node:path'
import { isBuiltin } from 'node:module'

import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { build as buildVite, type Plugin } from 'vite'

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

/** A separate Node bundle prevents desktop-only modules entering the host's dependency graph. */
function headlessHostBuild(): Plugin {
  return {
    name: 'sotto-headless-host',
    async closeBundle() {
      await buildVite({
        configFile: false,
        build: {
          ssr: resolve(__dirname, 'src/host/index.ts'), target: 'node24',
          outDir: resolve(__dirname, 'out/host'), emptyOutDir: true, minify: false,
          rollupOptions: {
            external: id => isBuiltin(id) || id === 'zod' || id === 'node-pty',
            output: { format: 'cjs', entryFileNames: 'index.js' },
          },
        },
      })
    },
  }
}

export default defineConfig({
  main: {
    // Runtime assets keep their verified resource path; emit the tray PNG under out/ with ?asset.
    publicDir: 'resources/runtime',
    build: { rollupOptions: { external: ['node-pty'], input: {
      index: resolve(__dirname, 'src/main/index.ts'),
      dictationClient: resolve(__dirname, 'src/main/hotkeys/dictationClient.ts'),
    } } },
    // electron-updater is a devDependency that is compiled into the main chunk,
    // exactly like zod is compiled into the sandboxed preload: production
    // Native node-pty stays external explicitly; its relative prebuild/helper
    // lookup requires its package layout. Claude SDK history ships as a reviewed
    // self-contained resource, so SDK peers are not production dependencies.
    plugins: [
      externalizeDepsPlugin({ exclude: ['electron-updater'] }),
      headlessHostBuild(),
      externalDependencyInventory('main'),
      bundledDependencyInventory(),
    ],
  },
  preload: {
    // Sandboxed preload scripts cannot resolve arbitrary node_modules at runtime, nor a chunk two of them share: the
    // window's preload and an interactive visual's (ADR-0060) import no module in common.
    build: { rollupOptions: { input: {
      index: resolve(__dirname, 'src/preload/index.ts'),
      visual: resolve(__dirname, 'src/preload/visual.ts'),
    } } },
    plugins: [
      externalizeDepsPlugin({ exclude: ['zod'] }),
      externalDependencyInventory('preload'),
    ],
  },
  renderer: {
    plugins: [bundledDependencyInventory()],
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
