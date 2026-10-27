/**
 * The store worker (`src/main/agents/threadStoreWorker.ts`) compiled the way the build compiles it, for a test that writes
 * on it (#1457). The test runner has no built file beside the thread store, so a store writes on main unless a test hands
 * it this path. Built with the bundler into one `.cjs` file with what it imports inside it, by the config the builds use
 * (`scripts/store-worker-build.mjs`).
 */
import { closeSync, openSync, readSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { build } from 'vite'
import { storeWorkerBuild } from '../../scripts/store-worker-build.mjs'

export async function builtStoreWorker(): Promise<{ readonly path: string; dispose(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-store-worker-'))
  await build(storeWorkerBuild({ root: resolve('.'), outDir: root, extension: 'cjs', logLevel: 'silent' }))
  return {
    path: join(root, 'threadStoreWorker.cjs'),
    dispose: async () => {
      if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-store-worker-')) throw new Error('Unexpected fixture directory')
      await rm(root, { recursive: true, force: true })
    },
  }
}

/** SQLite's write-ahead log index header, read from the side: how many frames the log holds and how many are in the file. */
export function walIndex(databasePath: string): { frames: number; backfilled: number } {
  const header = Buffer.alloc(100)
  const handle = openSync(`${databasePath}-shm`, 'r')
  try { readSync(handle, header, 0, 100, 0) } finally { closeSync(handle) }
  // mxFrame in the header's first copy, and nBackfill in the checkpoint information after the two copies.
  return { frames: header.readUInt32LE(16), backfilled: header.readUInt32LE(96) }
}
