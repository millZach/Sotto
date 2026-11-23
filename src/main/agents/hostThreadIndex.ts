import { isWatcherKind, type AgentHostSnapshot, type AgentThread } from '../../shared/agents'

/**
 * The coordinator's host snapshot's threads, read without a walk of its list (ADR-0016, #925 step 5): Watcher's,
 * delegation's and coordination's passes look threads up here rather than search the list for each. Only ever for the
 * host snapshot it was asked of (`AgentControl.hostThreadsOf`), and only while the coordinator holds that snapshot.
 */
export interface HostThreadsView {
  /** The thread with this ID, the first a search of the list finds. */
  thread(id: string): AgentThread | undefined
  /** Where the thread with this ID is in the list, the first place a search finds it. */
  position(id: string): number | undefined
  /** The threads that name this one as the thread that delegated them (ADR-0081), in no order. */
  delegatedFrom(parentId: string): ReadonlySet<string> | undefined
  /** Watcher's conversations, current and earlier. */
  readonly watcherKinds: ReadonlySet<string>
  /** Whether a thread names a host other than this one, which a look-up by this host's ID would not find as a search does. */
  readonly foreign: boolean
}

/**
 * What an accept of thread changes changed in the host snapshot (#925 step 5), handed to Watcher with the snapshot it
 * made. Each thread it does not name is the very record `from` listed, in the same place.
 */
export interface HostThreadsChange {
  /** The host snapshot the change was made from. A reader that last read another reads this one whole. */
  readonly from: AgentHostSnapshot
  /** The threads shown again, in display order: the records the host snapshot now lists. */
  readonly threads: readonly AgentThread[]
  /** Each named thread's record as `from` listed it; a thread `from` did not list has none. */
  readonly previous: ReadonlyMap<string, AgentThread>
}

/**
 * The host snapshot's threads by ID and by position, for the very list they were read from (#925). An accept of thread
 * changes keeps it up to date as it patches the list; any other list is indexed afresh the first time it is read. It is
 * also how Watcher, delegation and coordination read the host's threads without a walk of the list (`HostThreadsView`, #925 step 5).
 */
export class HostThreadIndex implements HostThreadsView {
  readonly byId = new Map<string, AgentThread>()
  readonly at = new Map<string, number>()
  /** Threads that carry hidden wake-ups, which the detail broadcast keeps projections for. */
  readonly hidden = new Set<string>()
  /** Watcher's conversations, shown again whenever Watcher's requests move. */
  readonly watcherKinds = new Set<string>()
  /** The threads each thread delegated to, by its ID. */
  private readonly children = new Map<string, Set<string>>()
  /** Threads that name a host other than the host snapshot's own. */
  private readonly elsewhere = new Set<string>()
  /**
   * `list` is the list the host snapshot carries; `raw` the same threads in a list of the index's own, which a change
   * copies and replaces threads in. `hostId` is the host snapshot's own.
   */
  constructor(public list: readonly AgentThread[], public raw: AgentThread[], readonly hostId: string | undefined) {}
  get foreign(): boolean { return this.elsewhere.size > 0 }
  thread(id: string): AgentThread | undefined { return this.byId.get(id) }
  position(id: string): number | undefined { return this.at.get(id) }
  delegatedFrom(parentId: string): ReadonlySet<string> | undefined { return this.children.get(parentId) }
  /** Notes what a thread newly read into the index says, `previous` being the record it replaced, if any. */
  note(thread: AgentThread, previous?: AgentThread): void {
    if (thread.hiddenWakeUpMessageIds?.length) this.hidden.add(thread.id); else this.hidden.delete(thread.id)
    if (isWatcherKind(thread)) this.watcherKinds.add(thread.id); else this.watcherKinds.delete(thread.id)
    if (thread.hostId !== undefined && thread.hostId !== this.hostId) this.elsewhere.add(thread.id); else this.elsewhere.delete(thread.id)
    if (previous?.delegatedBy === thread.delegatedBy) return
    if (previous?.delegatedBy !== undefined) {
      const siblings = this.children.get(previous.delegatedBy)
      siblings?.delete(thread.id)
      if (siblings?.size === 0) this.children.delete(previous.delegatedBy)
    }
    if (thread.delegatedBy === undefined) return
    const siblings = this.children.get(thread.delegatedBy)
    if (siblings) siblings.add(thread.id); else this.children.set(thread.delegatedBy, new Set([thread.id]))
  }
}

/**
 * Thread IDs taken out in the order of their place, smallest first: a binary heap, so each push and pop costs the log of
 * what it holds. An ID already held is not held twice.
 */
export class PositionQueue {
  private readonly heap: string[] = []
  private readonly held = new Set<string>()
  constructor(private readonly position: (id: string) => number) {}
  push(id: string): void {
    if (this.held.has(id)) return
    this.held.add(id)
    const heap = this.heap
    heap.push(id)
    for (let at = heap.length - 1; at > 0;) {
      const parent = (at - 1) >> 1
      if (this.position(heap[parent]!) <= this.position(heap[at]!)) break
      ;[heap[parent], heap[at]] = [heap[at]!, heap[parent]!]
      at = parent
    }
  }
  pop(): string | undefined {
    const heap = this.heap
    if (!heap.length) return undefined
    const top = heap[0]!
    const last = heap.pop()!
    if (heap.length) {
      heap[0] = last
      for (let at = 0; ;) {
        const left = at * 2 + 1, right = left + 1
        let least = at
        if (left < heap.length && this.position(heap[left]!) < this.position(heap[least]!)) least = left
        if (right < heap.length && this.position(heap[right]!) < this.position(heap[least]!)) least = right
        if (least === at) break
        ;[heap[least], heap[at]] = [heap[at]!, heap[least]!]
        at = least
      }
    }
    this.held.delete(top)
    return top
  }
}
