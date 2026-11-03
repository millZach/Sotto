/**
 * Session reaper: stops a provider session that has sat idle past a threshold, so a run holds only the
 * sessions it is using. A session its adapter keeps running is never stopped (the watched set, or for Claude
 * Code the live-session set), and neither is one running a turn or holding a request the user has not
 * answered. Stopping is meant to be invisible: the thread keeps its place in the snapshot and its messages
 * are answered for by the event store, and the next action starts its session again.
 */
export interface SessionReaperOptions {
  /** How often to look for idle sessions. */
  readonly sweepEveryMs?: number
  /** How long a session may sit without activity before a sweep stops it. */
  readonly idleAfterMs?: number
  /** Injected for tests; the reaper never reads the clock another way. */
  readonly now?: () => number
  /** A turn is running, a request is outstanding, or a command is mid-dispatch. */
  isBusy(id: string): boolean
  /**
   * The adapter keeps this thread's session running whatever its idle age. For most adapters that is the watched set: on
   * screen now, or assigned, queued or awaiting a follow-up. Claude Code's is the live-session set, which leaves out a
   * thread that is only on screen (ADR-0038, November 1, 2026 amendment).
   */
  isWatched(id: string): boolean
  /** An owned maintenance read defers closing this session, but does not renew its idle age. */
  isReading?(id: string): boolean
  /** End this thread's provider session. Anything durable it holds is flushed first by the adapter. */
  stop(id: string): void | Promise<void>
}

export class SessionReaper {
  private readonly sweepEveryMs: number
  private readonly idleAfterMs: number
  private readonly now: () => number
  private readonly activity = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | undefined
  private sweeping: Promise<void> | undefined

  constructor(private readonly options: SessionReaperOptions) {
    this.sweepEveryMs = options.sweepEveryMs ?? 5 * 60_000
    this.idleAfterMs = options.idleAfterMs ?? 30 * 60_000
    this.now = options.now ?? Date.now
  }

  /** Begin sweeping. Calling this twice keeps the one timer. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.sweep() }, this.sweepEveryMs)
    this.timer.unref()
  }

  /** Record activity for a thread whose session is running: a command, or an event the provider sent. */
  touch(id: string): void { this.activity.set(id, this.now()) }

  /** Stop tracking a session the adapter ended itself. */
  forget(id: string): void { this.activity.delete(id) }

  /** The sessions the reaper believes are running. */
  tracked(): readonly string[] { return [...this.activity.keys()] }

  /** One pass. Sweeps do not overlap, so a slow stop delays the next pass rather than racing it. */
  sweep(): Promise<void> {
    this.sweeping ??= this.run().finally(() => { this.sweeping = undefined })
    return this.sweeping
  }

  private async run(): Promise<void> {
    for (const id of [...this.activity.keys()]) {
      // An earlier stop may have awaited a provider while this session changed or was forgotten.
      const last = this.activity.get(id)
      if (last === undefined) continue
      const now = this.now()
      // A watched or working session keeps its full idle window from the moment it stops being either.
      if (this.options.isWatched(id) || this.options.isBusy(id)) { this.activity.set(id, now); continue }
      if (now - last < this.idleAfterMs || this.options.isReading?.(id)) continue
      this.activity.delete(id)
      // A stop that did not take leaves the session tracked, so a later sweep can try again.
      try { await this.options.stop(id) } catch { this.activity.set(id, this.now()) }
    }
  }

  dispose(): void { clearInterval(this.timer); this.timer = undefined; this.activity.clear() }
}
