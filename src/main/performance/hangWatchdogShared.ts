/** The slots main and the hang watch's worker share: when main last answered, and when Quit was received (0 for not). */
export const HEARTBEAT_SLOT = 0
export const QUIT_SLOT = 1
export const SHARED_SLOTS = 2
/** How often main writes its heartbeat, and how often the worker looks at it. */
export const HEARTBEAT_MS = 250
export const WATCH_TICK_MS = 250

export interface HangWatchdogWorkerData {
  readonly shared: SharedArrayBuffer
  /** Sotto's data folder's `performance-recordings`. */
  readonly directory: string
  readonly appRoots: readonly string[]
  readonly devOrigins: readonly string[]
  readonly sottoVersion: string
  readonly platform: string
  /** Development e2e runs only: shorter waits. */
  readonly hangMs?: number
  readonly quitForceMs?: number
}

/**
 * Milliseconds on the process's monotonic clock, the same on every thread: a change of the computer's clock never moves
 * it. Main writes its heartbeat and the Quit stamp on it, and the worker reads them on it.
 */
export function monotonicMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n)
}
