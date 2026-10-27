/**
 * The checkpoint worker (`src/main/storage/walCheckpointWorker.ts`) compiled the way the build compiles it, for a test
 * that checkpoints on it. The test runner has no built file beside the thread store, so a store leaves checkpoints to
 * SQLite unless a test hands it this path. Transpiled with the bundler's own esbuild into a `.cjs` file, since the worker
 * imports only Node builtins.
 */
import { closeSync, openSync, readSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { transformWithEsbuild } from 'vite'

export async function builtCheckpointWorker(): Promise<{ readonly path: string; dispose(): Promise<void> }> {
  const source = resolve('src/main/storage/walCheckpointWorker.ts')
  const { code } = await transformWithEsbuild(await readFile(source, 'utf8'), source, { loader: 'ts', format: 'cjs', target: 'node24' })
  const root = await mkdtemp(join(tmpdir(), 'sotto-checkpoint-worker-'))
  const path = join(root, 'walCheckpointWorker.cjs')
  await writeFile(path, code)
  return {
    path,
    dispose: async () => {
      if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-checkpoint-worker-')) throw new Error('Unexpected fixture directory')
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
