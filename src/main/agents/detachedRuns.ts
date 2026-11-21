/**
 * Detached runs (#2476, ADR-0204): the agent clients a thread started and cut loose from its own process, found by the
 * marks they inherited, so the thread is not called at rest while they work and the user can see and stop them.
 *
 * The watch looks when there is a reason to: a while after Sotto starts, a few seconds after any turn ends, and, while it
 * knows of a run, every little while until that run ends. It never looks on a thread's update path. It stops a run only
 * when the user presses Stop, and only once a fresh look shows the same process still running. Plain Node: the headless
 * host runs it too.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { MAX_BACKGROUND_WORK, MAX_DETACHED_RUNS, MAX_DETACHED_RUNS_ELSEWHERE, type AgentBackgroundWork, type DetachedRunElsewhere } from '../../shared/agentMonitoring'
import { descendsFrom, runWords, shownCommand, type AgentProcess, type ProcessTable, type RunMark, type ScanProcesses } from './detachedRunScan'

/** How long after Sotto starts it first looks: long enough for the threads to load. */
export const DETACHED_RUN_FIRST_LOOK_MS = 5_000
/** How long after a turn ends it looks: long enough for a launching shell to have exited. */
export const DETACHED_RUN_AFTER_TURN_MS = 3_000
/** How often it looks while it knows of a run, to see it end. Windows' look starts PowerShell, so it looks less often. */
export const DETACHED_RUN_FOLLOW_MS = process.platform === 'win32' ? 30_000 : 15_000
/** How long a stopped run has to end before it is made to. */
const STOP_GRACE_MS = 5_000

export const DETACHED_RUN_ENDED = 'That detached run has already ended. Nothing was stopped.'
export const DETACHED_RUN_NOT_STOPPED = 'Sotto could not stop that detached run. It may still be running. Stop it from a terminal on that computer.'
export const DETACHED_RUN_UNCHECKED = 'Sotto could not check that the detached run is still the same process, so nothing was stopped. Try again in a moment.'
/** How many looks in a row may fail before the watch waits for the next turn to end. */
const FAILED_LOOKS_RETRIED = 3
/**
 * How many looks in a row may find marked clients that no thread owns before the watch waits for the next turn to end. Just
 * after Sotto starts, its adapters may not have loaded the sessions a run names yet, so a run that outlived a restart is
 * looked for again for about two minutes (four on Windows); a client started from somewhere else stays unowned for good.
 */
const UNOWNED_LOOKS_RETRIED = 8

export interface DetachedRunWatchOptions {
  readonly scan: ScanProcesses
  /** The Sotto thread a mark names, asked of the adapter that owns that session; undefined when no thread here does. */
  readonly owner: (mark: RunMark) => string | undefined
  /** Sotto's own process. Anything under it is a provider's, or work a provider reports itself. */
  readonly rootPid: number
  readonly followMs?: number
  /** Ends a process and what it started; the real one signals, and on Windows runs taskkill. */
  readonly end?: (pid: number) => Promise<boolean>
  /**
   * The desktop's reach into its paired hosts for runs its threads started there (#2749): `look` asks each to look again,
   * as a turn ending here may have started one, and `stop` ends one there, through that host's own look-again rule.
   */
  readonly elsewhere?: {
    readonly look: () => void
    readonly stop: (hostId: string, runId: string) => Promise<void>
  }
}

interface RunRecord { readonly threadId: string; readonly pid: number; readonly work: AgentBackgroundWork }
/** A run found here that carries a mark no thread here owns (#2749): what a desktop may know it by, and what was read. */
interface ForeignRecord { readonly pid: number; readonly run: DetachedRunElsewhere }
/** A run a paired host reported, as this desktop's own thread's (#2749). */
interface RemoteRecord { readonly threadId: string; readonly hostId: string }

/** A run's ID: the same for one process for as long as it runs, and never the same for another that takes its number. */
function runId(process: AgentProcess): string {
  const hex = createHash('sha256').update(`${process.pid}\0${process.startedAt ?? ''}\0${process.commandLine}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${(8 | (parseInt(hex[16]!, 16) & 3)).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** One run as a piece of its thread's background work. */
export function detachedRunWork(process: AgentProcess): AgentBackgroundWork {
  const words = runWords(process)
  return {
    id: runId(process),
    label: words.name ?? `${process.client} run`,
    type: 'detached-run',
    ...(process.startedAt !== undefined ? { startedAt: new Date(process.startedAt).toISOString() } : {}),
    run: {
      client: process.client,
      ...(words.model ? { model: words.model } : {}),
      ...(words.effort ? { effort: words.effort } : {}),
      ...(process.folder && !/\p{Cc}/u.test(process.folder) ? { folder: process.folder.slice(0, 4_096) } : {}),
      command: shownCommand(process.argv.length ? process.argv : [process.commandLine]) || process.client,
    },
  }
}

/**
 * A thread's background work with `runs` as its detached runs, after the provider's own work, within the list's limit:
 * the provider's work keeps its place and the runs go where they fit. A list with no detached run in it and none to add
 * is handed back as it is, uncopied, since a provider's update merges every thread through here.
 */
export function withDetachedRuns(work: readonly AgentBackgroundWork[] | undefined, runs: readonly AgentBackgroundWork[] | undefined): AgentBackgroundWork[] | undefined {
  const stale = work?.some(item => item.type === 'detached-run') === true
  if (!runs?.length && !stale) return work as AgentBackgroundWork[] | undefined
  const own = stale ? work!.filter(item => item.type !== 'detached-run') : work ?? []
  const next = [...own, ...runs ?? []].slice(0, Math.max(own.length, MAX_BACKGROUND_WORK))
  return next.length ? next : undefined
}

const signal = (pid: number, name: NodeJS.Signals | 0): boolean => {
  try { process.kill(pid, name); return true } catch { return false }
}

/** Ends a run: its process group where it leads one, as a run cut loose with setsid does, else the process; taskkill /T on Windows. */
export async function endRun(pid: number): Promise<boolean> {
  if (process.platform === 'win32') {
    return new Promise(done => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, error => done(!error)))
  }
  const group = signal(-pid, 'SIGTERM')
  if (!group && !signal(pid, 'SIGTERM')) return !signal(pid, 0)
  // A group is gone when nothing in it is left, not when its leader is: a helper that ignores SIGTERM outlives it.
  const alive = (): boolean => group ? signal(-pid, 0) : signal(pid, 0)
  const deadline = Date.now() + STOP_GRACE_MS
  while (Date.now() < deadline) {
    await new Promise(done => setTimeout(done, 200))
    if (!alive()) return true
  }
  if (group) signal(-pid, 'SIGKILL'); else signal(pid, 'SIGKILL')
  await new Promise(done => setTimeout(done, 200))
  return !alive()
}

export class DetachedRunWatch {
  private readonly byThread = new Map<string, AgentBackgroundWork[]>()
  private readonly records = new Map<string, RunRecord>()
  private readonly listeners = new Set<(threadIds: readonly string[]) => void>()
  /** Runs found here that no thread here owns, by run ID, for the desktops that may (#2749). */
  private foreign = new Map<string, ForeignRecord>()
  private readonly foreignListeners = new Set<() => void>()
  /** What each paired host reported, as it reported it (#2749). */
  private readonly reported = new Map<string, { readonly machine: string; readonly runs: readonly DetachedRunElsewhere[] }>()
  /** Where each reported run this desktop's threads own belongs. */
  private remoteRecords = new Map<string, RemoteRecord>()
  /** Each thread's runs as `runsFor` gives them: its own, then those its paired hosts found, within the list's limit. */
  private shown = new Map<string, AgentBackgroundWork[]>()
  private elsewhere: DetachedRunWatchOptions['elsewhere']
  private timer: ReturnType<typeof setTimeout> | undefined
  private dueAt = Number.POSITIVE_INFINITY
  private looking: Promise<boolean> | undefined
  private failedLooks = 0
  private unownedLooks = 0
  private closed = false

  constructor(private readonly options: DetachedRunWatchOptions) { this.elsewhere = options.elsewhere }

  /** Gives a desktop's watch its reach into the paired hosts once they are known, after it was built (#2749). */
  useElsewhere(elsewhere: NonNullable<DetachedRunWatchOptions['elsewhere']>): void { this.elsewhere = elsewhere }

  /** Starts looking, once, a while after Sotto starts. */
  start(): void { this.schedule(DETACHED_RUN_FIRST_LOOK_MS) }
  /**
   * A turn ended somewhere: a run it cut loose would be running by now. A desktop asks its paired hosts to look too, since
   * the turn may have started one there (#2749).
   */
  turnEnded(): void { this.schedule(DETACHED_RUN_AFTER_TURN_MS); this.elsewhere?.look() }
  /** This thread's detached runs as background work, its own and any its paired hosts found, or undefined when it has none. */
  runsFor(threadId: string): readonly AgentBackgroundWork[] | undefined { return this.shown.get(threadId) }

  /**
   * The runs found here that carry a mark no thread here owns (#2749), for a host to send its desktops. A desktop whose own
   * adapter knows a mark shows the run as that thread's; the rest ignore it.
   */
  foreignRuns(): readonly DetachedRunElsewhere[] { return [...this.foreign.values()].map(record => record.run) }
  /**
   * Told after a look that changed the foreign runs. While anything listens the watch follows them until they end, as it
   * follows its own threads' runs; with nothing listening, as on a desktop, it looks for them only a few times.
   */
  subscribeForeign(listener: () => void): () => void {
    this.foreignListeners.add(listener)
    if (this.foreign.size) this.schedule(this.options.followMs ?? DETACHED_RUN_FOLLOW_MS)
    return () => { this.foreignListeners.delete(listener) }
  }
  /**
   * Stops a run found here that no thread here owns, because a desktop's user pressed its Stop (#2749): the same look-again
   * rule as `stop`, so a process that ended, or another that took its number, is never signalled.
   */
  async stopForeign(id: string): Promise<void> {
    if (!this.foreign.has(id)) throw new Error(DETACHED_RUN_ENDED)
    if (!await this.lookNow()) throw new Error(DETACHED_RUN_UNCHECKED)
    const record = this.foreign.get(id)
    if (!record) throw new Error(DETACHED_RUN_ENDED)
    const ended = await (this.options.end ?? endRun)(record.pid)
    await this.lookNow()
    if (!ended && this.foreign.has(id)) throw new Error(DETACHED_RUN_NOT_STOPPED)
  }

  /**
   * What a paired host reported of the runs it found with marks it does not own (#2749), named by the machine this desktop
   * calls it. Each one a mark of this desktop's own threads names is shown as that thread's run; an empty list clears the
   * host, as when it goes away.
   */
  setElsewhere(hostId: string, machine: string, runs: readonly DetachedRunElsewhere[]): void {
    if (runs.length) this.reported.set(hostId, { machine, runs: runs.slice(0, MAX_DETACHED_RUNS_ELSEWHERE) })
    else if (!this.reported.delete(hostId)) return
    this.refreshShown()
  }
  /** Told the threads whose runs changed, after each look that changed any. */
  subscribe(listener: (threadIds: readonly string[]) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Stops one of a thread's runs, because the user pressed Stop. It looks again first, so a process that ended, or another
   * that took its number, is never signalled. Throws with words to show when the run is gone or would not stop.
   */
  async stop(threadId: string, id: string): Promise<void> {
    // A run a paired host reported is stopped there, by that host's own look-again rule (#2749).
    const remote = this.remoteRecords.get(id)
    if (remote) {
      if (remote.threadId !== threadId || !this.elsewhere) throw new Error(DETACHED_RUN_ENDED)
      await this.elsewhere.stop(remote.hostId, id)
      return
    }
    if (this.records.get(id)?.threadId !== threadId) throw new Error(DETACHED_RUN_ENDED)
    // Only a look that read the table now may vouch for the process: one that failed leaves the old records standing.
    if (!await this.lookNow()) throw new Error(DETACHED_RUN_UNCHECKED)
    const record = this.records.get(id)
    if (record?.threadId !== threadId) throw new Error(DETACHED_RUN_ENDED)
    const ended = await (this.options.end ?? endRun)(record.pid)
    await this.lookNow()
    if (!ended && this.records.has(id)) throw new Error(DETACHED_RUN_NOT_STOPPED)
  }

  close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.listeners.clear()
    this.foreignListeners.clear()
  }

  /** Looks now, after any look already under way; true when it read the process table. */
  async lookNow(): Promise<boolean> {
    while (this.looking) await this.looking
    this.looking = this.look().finally(() => { this.looking = undefined })
    return this.looking
  }

  private schedule(delay: number): void {
    if (this.closed) return
    const due = Date.now() + delay
    if (this.timer && this.dueAt <= due) return
    if (this.timer) clearTimeout(this.timer)
    this.dueAt = due
    this.timer = setTimeout(() => {
      this.timer = undefined; this.dueAt = Number.POSITIVE_INFINITY
      void this.lookNow().catch(() => undefined)
    }, delay)
    this.timer.unref?.()
  }

  private async look(): Promise<boolean> {
    if (this.closed) return false
    let table: ProcessTable
    try {
      table = await this.options.scan((process, all) => process.pid !== this.options.rootPid && !descendsFrom(all, process.pid, this.options.rootPid))
    } catch {
      // A look that failed says nothing about the runs: the ones known stay, and it tries again a few times, whether or not
      // it knows of any, so a run already going when the first look failed is still found.
      if (++this.failedLooks <= FAILED_LOOKS_RETRIED || this.records.size) this.schedule(this.options.followMs ?? DETACHED_RUN_FOLLOW_MS)
      return false
    }
    this.failedLooks = 0
    if (this.closed) return false
    const found = new Map<string, AgentBackgroundWork[]>()
    const records = new Map<string, RunRecord>()
    const owned = new Map<number, string>()
    for (const agent of table.agents) {
      const threadId = agent.marks.map(mark => this.options.owner(mark)).find(id => id !== undefined)
      if (threadId) owned.set(agent.pid, threadId)
    }
    const all = new Map<string, RunRecord[]>()
    for (const agent of table.agents) {
      const threadId = owned.get(agent.pid)
      // A client that starts its own client, as Codex's npm launcher starts Codex, is one run, counted at the top.
      if (!threadId || this.underAnotherRun(table, agent.pid, threadId, owned)) continue
      all.set(threadId, [...all.get(threadId) ?? [], { threadId, pid: agent.pid, work: detachedRunWork(agent) }])
    }
    // The oldest runs are listed, the same ones at every look, however the system orders its processes.
    for (const [threadId, list] of all) {
      const kept = list.sort((a, b) => (a.work.startedAt ?? '').localeCompare(b.work.startedAt ?? '') || a.work.id.localeCompare(b.work.id)).slice(0, MAX_DETACHED_RUNS)
      found.set(threadId, kept.map(record => record.work))
      for (const record of kept) records.set(record.work.id, record)
    }
    this.byThread.clear(); for (const [threadId, list] of found) this.byThread.set(threadId, list)
    this.records.clear(); for (const [id, record] of records) this.records.set(id, record)
    // Marked clients no thread here owns, each counted once at the top, as a thread's own are (#2749).
    const unownedPids = new Set(table.agents.filter(agent => agent.marks.length > 0 && !owned.has(agent.pid)).map(agent => agent.pid))
    const foreign: ForeignRecord[] = []
    for (const agent of table.agents) {
      if (!unownedPids.has(agent.pid) || this.underAny(table, agent.pid, unownedPids)) continue
      foreign.push({ pid: agent.pid, run: { marks: agent.marks.map(mark => ({ name: mark.name, value: mark.value })), work: detachedRunWork(agent) } })
    }
    // The oldest are reported, the same ones at every look.
    const kept = foreign.sort((a, b) => (a.run.work.startedAt ?? '').localeCompare(b.run.work.startedAt ?? '') || a.run.work.id.localeCompare(b.run.work.id))
      .slice(0, MAX_DETACHED_RUNS_ELSEWHERE)
    const foreignChanged = JSON.stringify(this.foreignRuns()) !== JSON.stringify(kept.map(record => record.run))
    this.foreign = new Map(kept.map(record => [record.run.work.id, record]))
    const unowned = unownedPids.size > 0
    this.unownedLooks = unowned ? this.unownedLooks + 1 : 0
    const following = this.foreign.size > 0 && this.foreignListeners.size > 0
    if (this.records.size || following || (unowned && this.unownedLooks <= UNOWNED_LOOKS_RETRIED)) this.schedule(this.options.followMs ?? DETACHED_RUN_FOLLOW_MS)
    this.refreshShown()
    if (foreignChanged) for (const listener of [...this.foreignListeners]) listener()
    return true
  }

  /**
   * Rebuilds each thread's runs from its own and those its paired hosts reported, asking the adapters again which thread
   * each reported mark names, since a session a run names may load after the report came. Tells the listeners which
   * threads' runs changed. Runs on a look or a report, never on a thread's update.
   */
  private refreshShown(): void {
    const remoteRecords = new Map<string, RemoteRecord>()
    const remote = new Map<string, AgentBackgroundWork[]>()
    for (const [hostId, { machine, runs }] of this.reported) {
      for (const { marks, work } of runs) {
        const threadId = marks.map(mark => this.options.owner(mark)).find(id => id !== undefined)
        if (!threadId || !work.run || this.records.has(work.id) || remoteRecords.has(work.id)) continue
        remoteRecords.set(work.id, { threadId, hostId })
        remote.set(threadId, [...remote.get(threadId) ?? [], { ...work, run: { ...work.run, machine } }])
      }
    }
    const shown = new Map<string, AgentBackgroundWork[]>()
    for (const threadId of new Set([...this.byThread.keys(), ...remote.keys()])) {
      shown.set(threadId, [...this.byThread.get(threadId) ?? [], ...remote.get(threadId) ?? []].slice(0, MAX_DETACHED_RUNS))
    }
    const changed = new Set<string>()
    for (const [threadId, list] of shown) if (JSON.stringify(this.shown.get(threadId)) !== JSON.stringify(list)) changed.add(threadId)
    for (const threadId of this.shown.keys()) if (!shown.has(threadId)) changed.add(threadId)
    this.shown = shown
    this.remoteRecords = remoteRecords
    if (changed.size) for (const listener of [...this.listeners]) listener([...changed])
  }

  /** Whether one of `pids` started this process, up its parents: a client a marked client started counts once, at the top. */
  private underAny(table: ProcessTable, pid: number, pids: ReadonlySet<number>): boolean {
    let parentPid = table.processes.get(pid)?.parentPid
    for (let steps = 0; parentPid !== undefined && steps < 16; steps++) {
      if (pids.has(parentPid)) return true
      parentPid = table.processes.get(parentPid)?.parentPid
    }
    return false
  }

  private underAnotherRun(table: ProcessTable, pid: number, threadId: string, owned: ReadonlyMap<number, string>): boolean {
    let parentPid = table.processes.get(pid)?.parentPid
    for (let steps = 0; parentPid !== undefined && steps < 16; steps++) {
      if (owned.get(parentPid) === threadId) return true
      parentPid = table.processes.get(parentPid)?.parentPid
    }
    return false
  }
}
