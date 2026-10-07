/**
 * Counts every Git process started through `node:child_process`, by `spawn`, `execFile` (and its promisified form),
 * `spawnSync` or `execFileSync`. A test installs it in its own `vi.mock`, which vitest hoists above the imports:
 *
 *   vi.mock('node:child_process', async importOriginal =>
 *     (await import('../fixtures/gitSpawnCounter')).countingGit(await importOriginal()))
 *
 * and reads `gitSpawns.count` from a static import of this module, which is the same instance. It imports nothing
 * at run time, so the mock's factory can load it while `node:child_process` is still being mocked.
 */
import type * as ChildProcess from 'node:child_process'

export const gitSpawns = { count: 0 }

const isGit = (command: unknown): boolean => typeof command === 'string' && /(^|[\\/])git(\.exe)?$/iu.test(command)

export async function countingGit(actual: typeof ChildProcess): Promise<typeof ChildProcess> {
  const { promisify } = await import('node:util')
  const counted = <F extends (...args: never[]) => unknown>(original: F): F =>
    ((...args: Parameters<F>) => { if (isGit(args[0])) gitSpawns.count += 1; return original(...args) }) as F
  const execFile = counted(actual.execFile)
  const custom = (actual.execFile as unknown as Record<symbol, (...args: never[]) => unknown>)[promisify.custom]
  if (custom) Object.assign(execFile, { [promisify.custom]: counted(custom) })
  const replaced = { spawn: counted(actual.spawn), execFile, spawnSync: counted(actual.spawnSync), execFileSync: counted(actual.execFileSync) }
  return { ...actual, ...replaced, default: { ...actual, ...replaced } } as typeof ChildProcess
}
