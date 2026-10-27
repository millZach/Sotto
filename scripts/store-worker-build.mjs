import { isBuiltin } from 'node:module'
import { resolve } from 'node:path'

/**
 * How the store worker (`src/main/agents/threadStoreWorker.ts`) is built, wherever it is built: beside main's bundle
 * (`electron.vite.config.ts`), beside the headless host's (`scripts/build-host.mjs`) and for the tests
 * (`tests/fixtures/storeWorker.ts`). It is one file with everything it imports inside it, so the thread store's code stays
 * in the bundle that starts it rather than moving to a chunk the two would share (#1457).
 */
export function storeWorkerBuild({ root, outDir, extension = 'js', logLevel = 'warn' }) {
  return {
    root, configFile: false, logLevel,
    ssr: { noExternal: true },
    build: {
      ssr: true, target: 'node24', outDir, emptyOutDir: false, minify: false, copyPublicDir: false,
      rollupOptions: {
        input: { threadStoreWorker: resolve(root, 'src/main/agents/threadStoreWorker.ts') },
        external: id => isBuiltin(id),
        output: { format: 'cjs', entryFileNames: `[name].${extension}` },
      },
    },
  }
}
