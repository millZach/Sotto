/**
 * Counts and times every process this thread launches through `node:child_process` (`spawn` or `execFile`), and how
 * long each launch call held the thread: on Windows that call is CreateProcess, and on Electron's main thread it holds
 * the window. A launch made on a worker thread does not pass through here, since a worker loads its own
 * `node:child_process`. A test installs it in its own `vi.mock`, which vitest hoists above the imports:
 *
 *   vi.mock('node:child_process', async importOriginal =>
 *     (await import('../fixtures/mainThreadLaunches')).timingLaunches(await importOriginal()))
 *
 * and reads `mainThreadLaunches` from a static import of this module, which is the same instance. Commands are not
 * recorded, only counted and timed.
 */
import type * as ChildProcess from 'node:child_process'

export const mainThreadLaunches = { count: 0, heldMs: 0, longestMs: 0 }
export function resetMainThreadLaunches(): void { Object.assign(mainThreadLaunches, { count: 0, heldMs: 0, longestMs: 0 }) }

export function timingLaunches(actual: typeof ChildProcess): typeof ChildProcess {
  const timed = <F extends (...args: never[]) => unknown>(original: F): F => ((...args: Parameters<F>) => {
    const started = performance.now()
    try { return original(...args) } finally {
      const held = performance.now() - started
      mainThreadLaunches.count += 1; mainThreadLaunches.heldMs += held
      mainThreadLaunches.longestMs = Math.max(mainThreadLaunches.longestMs, held)
    }
  }) as F
  const replaced = { spawn: timed(actual.spawn), execFile: timed(actual.execFile) }
  return { ...actual, ...replaced, default: { ...actual, ...replaced } } as typeof ChildProcess
}
