import type { ProviderId } from '../../shared/agents'

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
  /**
   * Names what `isBusy` holds the session for, for `held`. Asked only while `isBusy` says yes, so a name never holds a
   * session the sweep would stop; absent or empty, the read says `busy`.
   */
  whyBusy?(id: string): readonly SessionBusyHold[]
  /** Names what `isWatched` keeps the session for, for `held`, asked only while it says yes. Absent, `watched`. */
  whyWatched?(id: string): 'watched' | 'live-session'
  /** End this thread's provider session. Anything durable it holds is flushed first by the adapter. */
  stop(id: string): void | Promise<void>
}

/**
 * What keeps a session running past a sweep, by name (#2398). `busy` is a turn, a start or a command mid-dispatch, or
 * anything else the adapter's busy rule names no other way; `request` a request the user has not answered; `background`
 * a live watch or background work the provider runs (Claude Code); `compaction` a compaction still running or not yet
 * confirmed (Claude Code, Codex). `reading` is an owned maintenance read. `watched` is
 * the adapter's watched set and `live-session` Claude Code's live-session set. With none of those, `recent` says its
 * idle window has not run out, and `none` that the next sweep stops it.
 */
export type SessionHold = 'busy' | 'request' | 'background' | 'compaction' | 'reading' | 'watched' | 'live-session' | 'recent' | 'none'
/** The holds an adapter's busy rule is made of. */
export type SessionBusyHold = Extract<SessionHold, 'busy' | 'request' | 'background' | 'compaction'>
/** One session the reaper tracks, as its read gives it: names, ages and IDs, never anything the thread said. */
export interface HeldSession {
  /** The adapter's own key for the session. `SottoThreadHost` turns it into the Sotto thread ID before it goes further. */
  readonly id: string
  /** Since the last activity the session's own commands or provider events made; a sweep that spares it does not count. */
  readonly idleMs: number
  /** Every rule keeping it now, or `recent` or `none`. */
  readonly holds: readonly SessionHold[]
  /** The session's own process, where the adapter knows it. */
  readonly pid?: number
}
/** A held session as it leaves its adapter: under the Sotto thread that owns it (ADR-0002), without one where none does. */
export type HeldThreadSession = Omit<HeldSession, 'id'> & { readonly threadId?: string }
/** A held session on a host, with the provider whose adapter holds it: one row of `POST /v1/admin/held-sessions`. */
export type HostHeldSession = HeldThreadSession & { readonly provider: ProviderId }
/** The busy holds named by the parts of an adapter's busy rule, in `SessionHold` order. */
export function busyHolds(parts: { readonly busy?: boolean; readonly request?: boolean; readonly background?: boolean; readonly compaction?: boolean }): SessionBusyHold[] {
  const holds: SessionBusyHold[] = []
  if (parts.busy) holds.push('busy')
  if (parts.request) holds.push('request')
  if (parts.background) holds.push('background')
  if (parts.compaction) holds.push('compaction')
  return holds
}

export class SessionReaper {
  private readonly sweepEveryMs: number
  private readonly idleAfterMs: number
  private readonly now: () => number
  /** When each session's idle window began: its last activity, or the last sweep that found it watched or working. */
  private readonly activity = new Map<string, number>()
  /** When each session last had activity of its own, for `held`. A sweep that spares a session leaves this alone. */
  private readonly touched = new Map<string, number>()
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
  touch(id: string): void { const now = this.now(); this.activity.set(id, now); this.touched.set(id, now) }

  /** Stop tracking a session the adapter ended itself. */
  forget(id: string): void { this.activity.delete(id); this.touched.delete(id) }

  /** The sessions the reaper believes are running. */
  tracked(): readonly string[] { return [...this.activity.keys()] }

  /**
   * Each tracked session, how long since its own last activity, and every rule keeping it now, asked the way a sweep asks
   * (#2398). Read on request only, never on the update path. `pid` is asked of the adapter for each session.
   */
  held(pid?: (id: string) => number | undefined): HeldSession[] {
    const now = this.now()
    return [...this.activity].map(([id, window]) => {
      const holds: SessionHold[] = []
      if (this.options.isBusy(id)) {
        const why = this.options.whyBusy?.(id)
        holds.push(...(why?.length ? why : ['busy' as const]))
      }
      if (this.options.isReading?.(id)) holds.push('reading')
      if (this.options.isWatched(id)) holds.push(this.options.whyWatched?.(id) ?? 'watched')
      if (!holds.length) holds.push(now - window < this.idleAfterMs ? 'recent' : 'none')
      const own = pid?.(id)
      return { id, idleMs: now - (this.touched.get(id) ?? window), holds, ...(own === undefined ? {} : { pid: own }) }
    })
  }

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
      // A stop that did not take leaves the session tracked, so a later sweep can try again. One started again while it
      // stopped keeps the activity that started it.
      try {
        await this.options.stop(id)
        if (!this.activity.has(id)) this.touched.delete(id)
      } catch { this.activity.set(id, this.now()) }
    }
  }

  dispose(): void { clearInterval(this.timer); this.timer = undefined; this.activity.clear(); this.touched.clear() }
}
