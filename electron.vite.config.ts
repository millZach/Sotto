import { resolve } from 'node:path'
import { isBuiltin } from 'node:module'

import { lingui } from '@lingui/vite-plugin'
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
          // The host launches Git off its own thread too, from the worker file beside its index.js (`gitLauncher.ts`), and
          // checkpoints its thread store on another (`walCheckpointer.ts`).
          ssr: true, target: 'node24',
          outDir: resolve(__dirname, 'out/host'), emptyOutDir: true, minify: false,
          rollupOptions: {
            input: { index: resolve(__dirname, 'src/host/index.ts'), gitLauncherWorker: resolve(__dirname, 'src/main/agents/gitLauncherWorker.ts'),
              walCheckpointWorker: resolve(__dirname, 'src/main/storage/walCheckpointWorker.ts') },
            external: id => isBuiltin(id) || id === 'zod' || id === 'node-pty',
            output: { format: 'cjs', entryFileNames: '[name].js' },
          },
        },
      })
    },
  }
}

export default defineConfig({
  main: {
    // No public folder: nothing is copied into out/ wholesale; the Linux tray icon is emitted there with ?asset.
    publicDir: false,
    // Lingui reads NODE_ENV to decide whether to carry its message compiler. Main's catalogs are compiled at build time
    // (ADR-0123), so the compiler and the warnings beside it stay out of the bundle; nothing else in main reads it.
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: { rollupOptions: { external: ['node-pty', 'sherpa-onnx-node'], input: {
      index: resolve(__dirname, 'src/main/index.ts'),
      dictationClient: resolve(__dirname, 'src/main/hotkeys/dictationClient.ts'),
      // Git and gh launch on this worker thread, not on main's, which in Electron is the window's (`gitLauncher.ts`).
      gitLauncherWorker: resolve(__dirname, 'src/main/agents/gitLauncherWorker.ts'),
      // The thread store's log is checkpointed on this worker thread, so no save on main runs a checkpoint (`walCheckpointer.ts`).
      walCheckpointWorker: resolve(__dirname, 'src/main/storage/walCheckpointWorker.ts'),
      // Main's hang watch runs on this worker thread, which can see main stop when main cannot (`hangWatchdog.ts`).
      hangWatchdogWorker: resolve(__dirname, 'src/main/performance/hangWatchdogWorker.ts'),
    } } },
    // electron-updater is a devDependency that is compiled into the main chunk,
    // exactly like zod is compiled into the sandboxed preload: production
    // Native node-pty and sherpa-onnx-node stay external explicitly; each finds its
    // prebuilt binaries relative to its package layout (ADR-0018, ADR-0071). Claude SDK history ships as a reviewed
    // self-contained resource, so SDK peers are not production dependencies.
    plugins: [
      // Lingui's macros become message lookups and each `.po` catalog a compiled module, at build time (ADR-0123).
      lingui({ macroTransform: true, failOnCompileError: true }),
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
    plugins: [lingui({ macroTransform: true, failOnCompileError: true }), bundledDependencyInventory()],
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
