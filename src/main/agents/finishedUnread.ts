import { isThreadProviderConnected, type AgentHostSnapshot, type AgentThread } from '../../shared/agents'
import { isThreadClosed, isWorkspaceThreadSettled } from '../../shared/threadActivity'

/** How many marks are kept, newest last; a thread forgotten while marked is dropped once the list is full. */
export const FINISHED_UNREAD_MAX = 200

/**
 * Which of the snapshot's threads are settled, as every client files them: settled in Sotto's workspace by itself, by its
 * project or with the thread that delegated to it (ADR-0081), or closed by its provider. Settled is quiet (#1279): a
 * settled thread neither keeps nor earns Just finished, and its failed turn is seen. Read once per snapshot; the projects
 * are few, and a set is made only when one is settled.
 */
export function settledIn(snapshot: Pick<AgentHostSnapshot, 'projects'>): (thread: AgentThread) => boolean {
  let projects: Set<string> | undefined
  for (const project of snapshot.projects) if (isWorkspaceThreadSettled({ workspaceSettledAt: null }, project)) (projects ??= new Set()).add(project.id)
  return thread => isWorkspaceThreadSettled(thread) || projects?.has(thread.projectId) === true || isThreadClosed(thread)
}

/** What reading one thread found: it is working now, and a mark was earned or lost. */
const WORKING = 1, MOVED = 2

/** A thread is still at it while its turn runs or work the turn started runs on in the background. */
const busy = (thread: AgentThread): boolean => thread.status === 'running' || (thread.backgroundWork?.length ?? 0) > 0

/**
 * The threads that finished while no client showed them, and that no client has shown since (ADR-0046). The coordinator
 * owns the record so every client reads one answer: the desktop's sidebar and a paired phone mark the same threads, a
 * thread opened on either stops being marked on both, and a restart keeps the marks.
 *
 * What a client shows is what it observes: the desktop window its panes, a phone the thread it has open. A thread shown
 * when it finishes never earns the mark, and showing a marked thread clears it. A provider that disconnects ends a
 * thread's work without finishing it, so a thread whose provider is gone earns nothing; it is not working any more either.
 * Settling a thread reads its finish too, and a settled thread earns nothing for work it finishes afterwards (#1279).
 */
export class FinishedUnread {
  /** Threads busy in the last snapshot, with their provider connected. Ephemeral: a restart starts from what it sees. */
  private working: ReadonlySet<string> = new Set()
  private shown: ReadonlySet<string> = new Set()
  /** Marked thread IDs, oldest first: a set keeps the order things were added in. */
  private readonly marks = new Set<string>()

  /**
   * `turns` hears each thread start and finish as this reads it, from the same pass over the threads (the next prompt,
   * ADR-0132), so nothing else walks every thread on every update for it.
   */
  constructor(saved: readonly string[] = [], private readonly dormant?: (threadId: string) => boolean,
    private readonly turns?: { started(threadId: string): void; finished(thread: AgentThread): void }) { this.restore(saved) }

  /** Takes the saved marks back at start, keeping what clients have said they show since. */
  restore(saved: readonly string[]): void {
    for (const id of this.marks) this.onMoved?.(id)
    this.marks.clear()
    for (const id of saved) if (this.dormant?.(id) || !this.shown.has(id)) { this.marks.add(id); this.onMoved?.(id) }
    this.trim()
  }

  /**
   * Told of each thread whose mark is earned or lost, from any path, so a caller that lists threads by what changed knows
   * which to list again (#925). Unset, nothing is told.
   */
  onMoved: ((threadId: string) => void) | undefined

  /** Reads one snapshot of the threads; true when a mark was earned or lost. */
  track(snapshot: AgentHostSnapshot): boolean {
    const live = new Set<string>()
    const settled = settledIn(snapshot)
    let changed = false
    for (const thread of snapshot.threads) {
      const read = this.read(snapshot, thread, settled, this.working.has(thread.id))
      if (read & WORKING) live.add(thread.id)
      if (read & MOVED) changed = true
    }
    this.working = live
    this.trim()
    return changed
  }

  /**
   * Reads only the threads a change named (#925): `threads`, each as the snapshot now shows it, and `gone`, the threads it
   * no longer shows. Every other thread is as the last read left it, and so are the connection, the providers and the
   * projects `snapshot` carries: reading such a thread again would change nothing, so this says what `track` would of
   * the whole list.
   */
  trackChanged(snapshot: AgentHostSnapshot, threads: readonly AgentThread[], gone: Iterable<string>): boolean {
    const working = new Set(this.working)
    for (const id of gone) working.delete(id)
    const settled = settledIn(snapshot)
    let changed = false
    for (const thread of threads) {
      const read = this.read(snapshot, thread, settled, this.working.has(thread.id))
      if (read & WORKING) working.add(thread.id); else working.delete(thread.id)
      if (read & MOVED) changed = true
    }
    this.working = working
    this.trim()
    return changed
  }

  /** One thread read against the last: `WORKING` when it is working now, `MOVED` when a mark was earned or lost. */
  private read(snapshot: AgentHostSnapshot, thread: AgentThread, settled: (thread: AgentThread) => boolean, wasWorking: boolean): number {
    if (this.dormant?.(thread.id)) return 0
    // Settled is quiet, whether or not its provider is connected: settling is the user's word that it is done with.
    if (settled(thread)) return this.unmark(thread.id) ? MOVED : 0
    // A disconnect neither finishes a thread nor clears what it finished; it only stops counting as work.
    if (!snapshot.connected || !isThreadProviderConnected(snapshot, thread)) return 0
    if (busy(thread)) {
      if (this.turns && thread.status === 'running' && !wasWorking) this.turns.started(thread.id)
      return WORKING | (this.unmark(thread.id) ? MOVED : 0)
    }
    // A turn that failed did not finish, and one that stopped to ask you something is waiting on you, not finished.
    // Either way a mark it had is not true any more.
    if (thread.status !== 'idle' || thread.requests.length > 0) return this.unmark(thread.id) ? MOVED : 0
    if (this.turns && wasWorking) this.turns.finished(thread)
    if (!wasWorking || this.shown.has(thread.id)) return 0
    this.marks.delete(thread.id); this.marks.add(thread.id); this.onMoved?.(thread.id)
    return MOVED
  }

  /** Takes a thread's mark away; true when it had one. */
  private unmark(threadId: string): boolean {
    if (!this.marks.delete(threadId)) return false
    this.onMoved?.(threadId)
    return true
  }

  /** The threads some client shows now: they lose the mark and cannot earn it. True when a mark was lost. */
  show(threadIds: readonly string[]): boolean {
    this.shown = new Set(threadIds)
    let changed = false
    for (const id of this.shown) if (!this.dormant?.(id)) changed = this.unmark(id) || changed
    return changed
  }

  has(threadId: string): boolean { return this.marks.has(threadId) }

  /** The marks as the coordinator saves them. */
  saved(): string[] { return [...this.marks] }

  /** Drops the oldest ordinary marks past the limit; dormant Watcher marks stay whole. */
  private trim(): void {
    let ordinary = this.dormant ? [...this.marks].filter(id => !this.dormant?.(id)).length : this.marks.size
    for (const id of this.marks) {
      if (ordinary <= FINISHED_UNREAD_MAX) return
      if (!this.dormant?.(id)) { this.unmark(id); ordinary -= 1 }
    }
  }

  /** The thread as clients read it: with `finishedUnread` while it is marked, without it otherwise. */
  publish<T extends Pick<AgentThread, 'id' | 'finishedUnread'>>(thread: T): T {
    if (this.has(thread.id)) return thread.finishedUnread === true ? thread : { ...thread, finishedUnread: true }
    if (thread.finishedUnread === undefined) return thread
    const { finishedUnread: _mark, ...rest } = thread
    void _mark
    return rest as T
  }
}
