import { isBuiltin } from 'node:module'
import { resolve } from 'node:path'

/** The store workers, each built on its own: the thread store's (#1457) and Usage's (ADR-0083, October 27 amendment). */
export const STORE_WORKERS = ['threadStoreWorker', 'usageStoreWorker']

/**
 * How a store worker (`src/main/agents/threadStoreWorker.ts`, `src/main/agents/usageStoreWorker.ts`) is built, wherever it
 * is built: beside main's bundle (`electron.vite.config.ts`), beside the headless host's (`scripts/build-host.mjs`) and for
 * the tests (`tests/fixtures/storeWorker.ts`). Each is one file with everything it imports inside it, built alone, so a
 * store's code stays in the bundle that starts it rather than moving to a chunk two bundles would share (#1457).
 */
export function storeWorkerBuild({ root, outDir, extension = 'js', logLevel = 'warn', worker = 'threadStoreWorker' }) {
  return {
    root, configFile: false, logLevel,
    ssr: { noExternal: true },
    build: {
      ssr: true, target: 'node24', outDir, emptyOutDir: false, minify: false, copyPublicDir: false,
      rollupOptions: {
        input: { [worker]: resolve(root, `src/main/agents/${worker}.ts`) },
        external: id => isBuiltin(id),
        output: { format: 'cjs', entryFileNames: `[name].${extension}` },
      },
    },
  }
}
