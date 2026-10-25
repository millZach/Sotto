import { isThreadProviderConnected, type AgentHostSnapshot, type AgentThread } from '../../shared/agents'
import type { WatcherThreadTarget } from '../../shared/watcher'
import type { WatcherRemoteHosts } from '../../shared/watcherHost'
import type { HostThreadsChange, HostThreadsView } from './control'
import { targetKey } from './watcherEvidence'

/**
 * Every host's threads as Watcher reads them, without a walk of every thread on every update (ADR-0016, #925 step 5).
 *
 * Watcher's passes read one snapshot of every host: this computer's host snapshot, then each paired host's in the order
 * the hosts are listed, each thread marked with whether its host and provider are connected. Building that list made a
 * new record of every thread of every host on every update. Here the list is built only when something reads it whole,
 * and a pass that reads only some threads looks them up instead: this computer's by the coordinator's index of its host
 * snapshot, a paired host's by an index of the list it pushed, made once for each push. Each thread's marked record is
 * made once for its record and its connection, so a look-up and the list hand out the same record.
 *
 * It also keeps which threads the list held at Watcher's last wake-up pass (`takeChanges`): this computer's from each
 * change the coordinator takes in, a paired host's from each push, so a pass can tell a thread that has just appeared
 * without reading every thread.
 */

/** A thread list's threads by ID, the first a search finds, with where each is and what Watcher looks up among them. */
interface ListIndex {
  readonly byId: ReadonlyMap<string, { readonly thread: AgentThread; readonly at: number }>
  /** Watcher's current conversations (kind `watcher`), in list order. */
  readonly watchers: readonly string[]
  /** Each thread that names the thread that delegated it, with that thread's ID. */
  readonly delegated: ReadonlyMap<string, string>
  /** The host IDs the threads name, `undefined` for a thread that names none. */
  readonly hostIds: ReadonlySet<string | undefined>
}
/**
 * Indexes of frozen thread lists only: a frozen list can never change, so its index stays true. A paired host's list as
 * the router hands it to Watcher is frozen for each push; any other list is searched as it always was.
 */
const listIndexes = new WeakMap<readonly AgentThread[], ListIndex>()
function listIndex(threads: readonly AgentThread[]): ListIndex | undefined {
  if (!Object.isFrozen(threads)) return undefined
  let index = listIndexes.get(threads)
  if (index) return index
  const byId = new Map<string, { thread: AgentThread; at: number }>(), watchers: string[] = [], delegated = new Map<string, string>(), hostIds = new Set<string | undefined>()
  threads.forEach((thread, at) => {
    hostIds.add(thread.hostId)
    if (byId.has(thread.id)) return
    byId.set(thread.id, { thread, at })
    if (thread.kind === 'watcher') watchers.push(thread.id)
    if (thread.delegatedBy !== undefined) delegated.set(thread.id, thread.delegatedBy)
  })
  index = { byId, watchers, delegated, hostIds }
  listIndexes.set(threads, index)
  return index
}

/**
 * A host snapshot's threads by ID, the first a search finds for each: by the index of its list when the list is frozen,
 * otherwise by a map made once here, for a reader that looks up several threads of one snapshot.
 */
export function threadsById(snapshot: AgentHostSnapshot): Pick<ReadonlyMap<string, AgentThread>, 'get'> {
  const list = listIndex(snapshot.threads)
  if (list) return { get: id => list.byId.get(id)?.thread }
  const threads = new Map<string, AgentThread>()
  for (const thread of snapshot.threads) if (!threads.has(thread.id)) threads.set(thread.id, thread)
  return threads
}
/** Whether Watcher's passes count a thread among the threads they look at: every thread but Watcher's own conversations. */
const listed = (thread: AgentThread | undefined): boolean => thread !== undefined && thread.kind !== 'watcher' && thread.kind !== 'watcher-history'

/** Each thread's record as the merged list carries it, made once for its record and its connection. */
const marked = new WeakMap<AgentThread, { readonly connected: boolean; readonly thread: AgentThread }>()
function markedThread(host: AgentHostSnapshot, thread: AgentThread): AgentThread {
  const connected = host.connected && isThreadProviderConnected(host, thread)
  const known = marked.get(thread)
  if (known?.connected === connected) return known.thread
  const made = { ...thread, clientConnected: connected }
  marked.set(thread, { connected, thread: made })
  return made
}

/** One host's part of the merged list. */
interface Part {
  readonly snapshot: AgentHostSnapshot
  /** The host's ID as its threads are keyed: this computer's host snapshot's own, or the paired host's. */
  readonly hostId: string | undefined
  /** This computer's threads by the coordinator's index, when the snapshot is the coordinator's. */
  readonly view?: HostThreadsView | undefined
  /** A paired host's threads by an index of its frozen list. */
  readonly list?: ListIndex | undefined
}

/** Look-ups into the merged snapshot, which find what a search of its list finds (`WatcherHosts.index`). */
export interface WatcherHostsIndex {
  /** A target's thread as the merged list carries it: the first whose ID and host, its own or the list's, are the target's. */
  thread(target: WatcherThreadTarget): AgentThread | undefined
  /** Where a target's thread is in the merged list, as a pair to compare: the host's place, then the thread's. */
  place(target: WatcherThreadTarget): readonly [number, number] | undefined
  /** Whether the merged list holds this target's thread and counts it among the threads it looks at. */
  holds(target: WatcherThreadTarget): boolean
  /** Watcher's current conversations on every host, as the merged list carries them, in its order. */
  watchers(): AgentThread[]
  /** Each thread that names the thread that delegated it, keyed by target, with that thread's key, on every host. */
  delegated(): Map<string, string>
}

export interface WatcherHostsReader {
  /** Look-ups into `snapshot`, the merged snapshot last handed out, or undefined when a look-up might not find what a search does. */
  index(snapshot: AgentHostSnapshot): WatcherHostsIndex | undefined
  /**
   * Each thread key whose place among the threads the merged list holds moved since the last call, with whether the list
   * held it then; undefined on the first call, when there is nothing to compare with.
   */
  takeChanges(snapshot: AgentHostSnapshot): ReadonlyMap<string, boolean> | undefined
}

/** Compares two places in the merged list (`WatcherHostsIndex.place`). */
export const byPlace = (left: readonly [number, number], right: readonly [number, number]): number => left[0] - right[0] || left[1] - right[1]

export interface WatcherHostsSource {
  /** This computer's host snapshot, never copied. */
  local(): AgentHostSnapshot
  /** The coordinator's index of its host snapshot, or undefined for another snapshot. */
  localThreads(snapshot: AgentHostSnapshot): HostThreadsView | undefined
  remote(): WatcherRemoteHosts | undefined
}

export class WatcherHosts implements WatcherHostsReader {
  private built: { readonly key: readonly unknown[]; readonly parts: readonly Part[]; readonly snapshot: AgentHostSnapshot; readonly index: WatcherHostsIndex | undefined } | undefined
  /** The keys whose place in the merged list moved since the last `takeChanges`, with whether it held them then. */
  private readonly journal = new Map<string, boolean>()
  /** Whether `takeChanges` has been called, so there is a list to compare with. */
  private baseline = false
  /** This computer's host snapshot as the journal last followed it. */
  private local: AgentHostSnapshot | undefined
  /**
   * The earliest of this computer's host snapshots since the last `takeChanges` that a new one replaced without saying
   * what changed, compared with the one then held when `takeChanges` comes: once a pass, however many came between.
   */
  private unfollowed: AgentHostSnapshot | undefined
  /** Each paired host's snapshot as the journal last followed it. */
  private remotes = new Map<string, AgentHostSnapshot | undefined>()

  constructor(private readonly source: WatcherHostsSource) {}

  /**
   * Every host's threads as one snapshot, as Watcher always read them. The same snapshot while nothing it is made from
   * changed. Its threads and projects are put together only when something reads them.
   */
  snapshot(): AgentHostSnapshot { return this.build().snapshot }

  index(snapshot: AgentHostSnapshot): WatcherHostsIndex | undefined {
    return this.built?.snapshot === snapshot ? this.built.index : undefined
  }

  /**
   * A thread of the host that owns it, by its ID, as a search of that host's own snapshot finds it: the first with that
   * ID, whatever host it names. Undefined when the host is not known here.
   */
  owning(hostId: string, threadId: string, localId: string): AgentThread | undefined {
    if (hostId === localId) {
      const local = this.source.local(), view = this.source.localThreads(local)
      return view ? view.thread(threadId) : local.threads.find(thread => thread.id === threadId)
    }
    const snapshot = this.source.remote()?.snapshot(hostId)
    if (!snapshot) return undefined
    const list = listIndex(snapshot.threads)
    return list ? list.byId.get(threadId)?.thread : snapshot.threads.find(thread => thread.id === threadId)
  }

  /**
   * This computer's host snapshot after the coordinator took something in: `changed` names what an accept of thread changes
   * changed, so the journal follows it without a walk; any other new snapshot is compared with the last thread by thread.
   */
  localChanged(snapshot: AgentHostSnapshot, changed: HostThreadsChange | undefined): void {
    if (!this.baseline || snapshot === this.local) { this.local = snapshot; return }
    const from = this.local
    this.local = snapshot
    const view = this.source.localThreads(snapshot)
    if (!changed || changed.from !== from || !view || from.hostId !== snapshot.hostId) { this.unfollowed ??= from; return }
    const hostId = snapshot.hostId
    const follow = (id: string) => {
      const before = changed.previous.get(id), after = view.thread(id)
      if (listed(before) === listed(after)) return
      const keyed = (before && listed(before) ? before : after)!
      this.note(targetKey({ hostId: keyed.hostId ?? hostId ?? '', threadId: id }), listed(before))
    }
    for (const id of changed.previous.keys()) follow(id)
    for (const thread of changed.threads) if (!changed.previous.has(thread.id)) follow(thread.id)
  }

  takeChanges(snapshot: AgentHostSnapshot): ReadonlyMap<string, boolean> | undefined {
    const built = this.built
    if (built?.snapshot !== snapshot) return undefined
    const local = built.parts[0]!.snapshot
    if (!this.baseline) {
      this.baseline = true
      this.local = local; this.unfollowed = undefined
      this.remotes = new Map(built.parts.slice(1).map(part => [part.hostId!, part.snapshot]))
      this.journal.clear()
      return undefined
    }
    if (local !== this.local) { this.unfollowed ??= this.local; this.local = local }
    if (this.unfollowed) { this.compare(this.unfollowed, local); this.unfollowed = undefined }
    const seen = new Set<string>()
    for (const part of built.parts.slice(1)) {
      seen.add(part.hostId!)
      const before = this.remotes.get(part.hostId!)
      if (before === part.snapshot) continue
      this.compare(before, part.snapshot, local.hostId)
      this.remotes.set(part.hostId!, part.snapshot)
    }
    for (const [hostId, before] of [...this.remotes]) if (!seen.has(hostId)) { this.compare(before, undefined, local.hostId); this.remotes.delete(hostId) }
    const changes = new Map(this.journal)
    this.journal.clear()
    return changes
  }

  /** Notes a key's place moving, keeping whether the list held it at the last pass if it already moved since. */
  private note(key: string, before: boolean): void { if (!this.journal.has(key)) this.journal.set(key, before) }

  /**
   * Notes every key whose place differs between two snapshots of one host, read thread by thread. `localId` keys a thread
   * that names no host by this computer's host snapshot's own, as the merged list does; this computer's own snapshots use
   * their own host ID.
   */
  private compare(before: AgentHostSnapshot | undefined, after: AgentHostSnapshot | undefined, localId?: string): void {
    const keys = (snapshot: AgentHostSnapshot | undefined): Set<string> => {
      const held = new Set<string>()
      const hostId = localId ?? snapshot?.hostId
      for (const thread of snapshot?.threads ?? []) if (listed(thread)) held.add(targetKey({ hostId: thread.hostId ?? hostId ?? '', threadId: thread.id }))
      return held
    }
    const was = keys(before), is = keys(after)
    for (const key of was) if (!is.has(key)) this.note(key, true)
    for (const key of is) if (!was.has(key)) this.note(key, false)
  }

  private build(): NonNullable<WatcherHosts['built']> {
    const local = this.source.local(), remote = this.source.remote(), localId = local.hostId
    const hosts = remote?.hosts() ?? []
    const others = hosts.map(host => ({ host, snapshot: localId !== undefined && host.hostId === localId ? local : remote!.snapshot(host.hostId) }))
    const key: unknown[] = [local, localId, this.source.localThreads(local)]
    for (const { host, snapshot } of others) key.push(host.hostId, snapshot)
    const built = this.built
    if (built && built.key.length === key.length && built.key.every((item, at) => item === key[at])) return built
    const parts: Part[] = [{ snapshot: local, hostId: localId, view: this.source.localThreads(local) }]
    let exact = parts[0]!.view !== undefined && !parts[0]!.view.foreign
    for (const { host, snapshot } of others) {
      if (!snapshot) continue
      const list = snapshot === local ? undefined : listIndex(snapshot.threads)
      // A paired host listed under this computer's ID, or whose threads name another host, is searched, never looked up.
      if (!list || [...list.hostIds].some(id => (id ?? localId) !== host.hostId)) exact = false
      parts.push({ snapshot, hostId: host.hostId, list })
    }
    const snapshot = this.merged(parts, local, localId)
    const index = exact ? this.indexOf(parts, localId) : undefined
    return this.built = { key, parts, snapshot, index }
  }

  /** The merged snapshot over `parts`, as Watcher always made it; its threads and projects are made when first read. */
  private merged(parts: readonly Part[], local: AgentHostSnapshot, localId: string | undefined): AgentHostSnapshot {
    const others = parts.slice(1).map(part => part.snapshot)
    const snapshot: AgentHostSnapshot = { ...local, connected: local.connected || others.some(host => host.connected),
      clientHosts: [local, ...others].flatMap(host => { const hostId = host.hostId ?? localId
        return hostId ? [{ hostId, connected: host.connected, models: host.models, capabilities: host.capabilities, providers: host.providers }] : [] }) }
    let threads: AgentThread[] | undefined, projects: AgentHostSnapshot['projects'] | undefined
    Object.defineProperty(snapshot, 'threads', { enumerable: true, configurable: true,
      get: () => threads ??= [local, ...others].flatMap(host => host.threads.map(thread => markedThread(host, thread))) })
    Object.defineProperty(snapshot, 'projects', { enumerable: true, configurable: true,
      get: () => projects ??= [...local.projects, ...others.flatMap(host => host.projects.map(project => ({ ...project, hostId: host.hostId })))] })
    return snapshot
  }

  private indexOf(parts: readonly Part[], localId: string | undefined): WatcherHostsIndex {
    const [local, ...others] = parts as [Part, ...Part[]]
    const view = local.view!
    const partOf = (hostId: string): [number, Part] | undefined => {
      if (hostId === localId) return [0, local]
      const at = others.findIndex(part => part.hostId === hostId)
      return at === -1 ? undefined : [at + 1, others[at]!]
    }
    const raw = (target: WatcherThreadTarget): AgentThread | undefined => {
      const found = partOf(target.hostId)
      if (!found) return undefined
      const [, part] = found
      const thread = part === local ? view.thread(target.threadId) : part.list!.byId.get(target.threadId)?.thread
      return thread && (thread.hostId ?? localId) === target.hostId ? thread : undefined
    }
    return {
      thread: target => { const thread = raw(target); return thread && markedThread(partOf(target.hostId)![1].snapshot, thread) },
      place: target => {
        const found = partOf(target.hostId)
        if (!found || !raw(target)) return undefined
        const [rank, part] = found
        return [rank, part === local ? view.position(target.threadId)! : part.list!.byId.get(target.threadId)!.at]
      },
      holds: target => listed(raw(target)),
      watchers: () => [local, ...others].flatMap(part => {
        const ids = part === local ? [...view.watcherKinds].filter(id => view.thread(id)?.kind === 'watcher').sort((a, b) => view.position(a)! - view.position(b)!) : part.list!.watchers
        return ids.map(id => markedThread(part.snapshot, part === local ? view.thread(id)! : part.list!.byId.get(id)!.thread))
      }),
      delegated: () => {
        const parents = new Map<string, string>()
        for (const part of [local, ...others]) {
          const entries = part === local ? view.delegated : part.list!.delegated
          for (const [child, parent] of entries) {
            const thread = part === local ? view.thread(child)! : part.list!.byId.get(child)!.thread, hostId = thread.hostId ?? localId ?? ''
            parents.set(targetKey({ hostId, threadId: child }), targetKey({ hostId, threadId: parent }))
          }
        }
        return parents
      },
    }
  }
}
