import { isDeepStrictEqual } from 'node:util'
import type { AgentHostSnapshot, AgentThread } from '../../shared/agents'
import { immutableUpdates } from './activitySnapshots'
import { cloneHostSnapshot } from './cloneHostSnapshot'
import type { ActivitySubscriptionOptions } from './host'

/**
 * Thread changes (ADR-0016, proposed October 24 amendment, #925): what one layer of main hands the next instead of a
 * whole snapshot on every update. Internal to main; nothing here crosses IPC or the socket.
 *
 * The rules:
 * - Each publication carries a `sequence`, one more than the last that subscriber was sent.
 * - A first publication is whole, as is one answering a resync and one whose threads changed order some way an upsert
 *   cannot say. A whole publication lists every thread in the publisher's display order and carries `rest`.
 * - Any other publication lists the threads that changed (`upserts`, whole frozen records) and the Sotto thread IDs that
 *   went (`removals`), and carries `rest` only when a part of the snapshot that is not its threads changed. Removals are
 *   applied before upserts. An upserted thread keeps its place, or goes last when it is new.
 * - Every record and every `rest` is frozen and only ever replaced, never written into.
 */

/** Every part of a host snapshot but its threads: providers, the catalog, projects, the connection and the rest. */
export type AgentHostRest = Omit<AgentHostSnapshot, 'threads'>

/** A publication before its publisher numbers it. */
export interface ThreadChangeSet {
  /** Set on a first publication, one answering a resync, and one that reorders the threads. */
  readonly whole?: true
  /** Whole frozen thread records: every thread, in order, on a whole publication; otherwise those that changed. */
  readonly upserts: readonly AgentThread[]
  /** The Sotto thread IDs that went. Empty on a whole publication. */
  readonly removals: readonly string[]
  /** The parts that are not threads, frozen: always on a whole publication, otherwise only when they changed. */
  readonly rest?: AgentHostRest
}

export interface AgentHostChanges extends ThreadChangeSet {
  /** One more than the publication this subscriber was sent before it. A gap means one was missed. */
  readonly sequence: number
}

export type ActivityChangesListener = (changes: AgentHostChanges) => void

/** Calling it stops the listener. `resync()` asks for a whole publication of what was last published. */
export interface ActivityChangesSubscription {
  (): void
  resync(): void
}

/** What a layer offers once it passes on thread changes, beside or instead of `subscribeActivitySnapshots`. */
export interface ActivityChangesSource {
  subscribeActivityChanges(listener: ActivityChangesListener, options?: ActivitySubscriptionOptions): ActivityChangesSubscription
}

export interface ThreadMapOptions {
  /** The whole snapshot this map should equal after every change it applies, from the path it replaces. */
  wholeOf?: () => AgentHostSnapshot
  /** Check the map against `wholeOf` after every change. Off unless `SOTTO_VERIFY_THREAD_CHANGES=1`. */
  verify?: boolean
}

/** A change left a map unlike the whole snapshot it should equal. Names thread IDs only, never what a thread says. */
export class ThreadChangesDrift extends Error {
  constructor(readonly differences: readonly string[]) {
    super(`The thread map no longer equals its whole snapshot: ${differences.join('; ')}.`)
    this.name = 'ThreadChangesDrift'
  }
}

function frozenOrRefused(changes: ThreadChangeSet): void {
  for (const record of changes.upserts) if (!Object.isFrozen(record)) throw new TypeError(`Thread changes carry frozen records; thread "${record.id}" was not frozen.`)
  if (changes.rest && !Object.isFrozen(changes.rest)) throw new TypeError('Thread changes carry the rest of the snapshot frozen.')
}

/**
 * Frozen thread records by Sotto thread ID, in a publisher's display order, as one subscriber holds them. Applying a
 * change costs what the change carries: a JavaScript Map keeps insertion order, so an upsert of a thread it holds keeps its
 * place, a new one goes last and a removal drops one, each without touching the rest. A whole publication replaces the
 * map, which is what a new order costs. A whole snapshot is built only when asked, for a read or a command.
 */
export class ThreadMap {
  private records = new Map<string, AgentThread>()
  private held: AgentHostRest | undefined
  private at: number | undefined
  private readonly verifying: boolean

  constructor(private readonly options: ThreadMapOptions = {}) {
    this.verifying = options.verify ?? process.env.SOTTO_VERIFY_THREAD_CHANGES === '1'
  }

  /** The sequence of the last publication applied, undefined until a whole one is. */
  get sequence(): number | undefined { return this.at }
  get size(): number { return this.records.size }
  /** The parts of the snapshot that are not threads, as last published. */
  get rest(): AgentHostRest | undefined { return this.held }
  get(id: string): AgentThread | undefined { return this.records.get(id) }
  has(id: string): boolean { return this.records.has(id) }
  ids(): IterableIterator<string> { return this.records.keys() }
  /** Every record in order, in a list of the caller's own. */
  threads(): AgentThread[] { return [...this.records.values()] }

  /**
   * Applies one publication. 'resync' means it was not applied: the map holds no whole publication yet, or the sequence
   * is not the next one, so a publication was missed and the subscriber asks its publisher for a whole one. A record or a
   * `rest` that is not frozen is refused before anything is applied.
   */
  apply(changes: AgentHostChanges): 'applied' | 'resync' {
    if (changes.whole) {
      if (!changes.rest) throw new TypeError('A whole publication of thread changes carries the rest of the snapshot.')
      frozenOrRefused(changes)
      const records = new Map<string, AgentThread>()
      for (const record of changes.upserts) records.set(record.id, record)
      this.records = records
      this.held = changes.rest
    } else {
      if (this.at === undefined || changes.sequence !== this.at + 1) return 'resync'
      frozenOrRefused(changes)
      for (const id of changes.removals) this.records.delete(id)
      for (const record of changes.upserts) this.records.set(record.id, record)
      if (changes.rest) this.held = changes.rest
    }
    this.at = changes.sequence
    if (this.verifying && this.options.wholeOf) {
      const differences = threadMapDifferences(this, this.options.wholeOf())
      if (differences.length) throw new ThreadChangesDrift(differences)
    }
    return 'applied'
  }

  /** A whole snapshot any caller may change, undefined until a whole publication arrived. O(threads): for reads and commands. */
  snapshot(): AgentHostSnapshot | undefined {
    if (!this.held) return undefined
    return cloneHostSnapshot({ ...this.held, threads: this.threads() })
  }
}

/**
 * How `map` differs from what a map rebuilt from `whole` would hold: a thread it kept that went (a missed removal), one
 * it lacks (a missed upsert), a record unlike the snapshot's (a stale one), the order, and the parts that are not threads.
 * Empty when they are the same. This is the verifying mode's check.
 */
export function threadMapDifferences(map: ThreadMap, whole: AgentHostSnapshot): string[] {
  const differences: string[] = []
  const wanted = new Map(whole.threads.map(thread => [thread.id, thread]))
  let membership = true
  for (const id of map.ids()) if (!wanted.has(id)) { membership = false; differences.push(`thread "${id}" is in the map but not the snapshot, a missed removal`) }
  for (const thread of whole.threads) {
    const held = map.get(thread.id)
    if (!held) { membership = false; differences.push(`thread "${thread.id}" is in the snapshot but not the map, a missed upsert`) }
    else if (held !== thread && !isDeepStrictEqual(held, thread)) differences.push(`thread "${thread.id}" is unlike the snapshot's, a stale record`)
  }
  if (membership) {
    let position = 0
    for (const id of map.ids()) {
      const expected = whole.threads[position]!.id
      if (id !== expected) { differences.push(`the threads are in another order from position ${position}: the map has "${id}" where the snapshot has "${expected}"`); break }
      position++
    }
  }
  const rest = whole as unknown as Record<string, unknown>
  const held = map.rest as Record<string, unknown> | undefined
  if (!held) differences.push('the map holds no rest of the snapshot')
  else {
    const fields = [...new Set([...Object.keys(held), ...Object.keys(rest)])].filter(key => key !== 'threads' && !isDeepStrictEqual(held[key], rest[key]))
    if (fields.length) differences.push(`the rest of the snapshot differs in ${fields.join(', ')}`)
  }
  return differences
}

/**
 * The boundary shim: what changed between the records last published (`published`, undefined before the first) and a
 * whole snapshot `next`, worked out the way the workspace's publication shares what did not change (#1326). A thread
 * that is the record published last is left out after one identity check; any other is read against that record with
 * `immutableUpdates`, which hands back the record itself when the thread equals it, and otherwise a new frozen record
 * that keeps every part that did not change. The parts that are not threads are read the same way. This costs a check
 * per thread, so it is for a publisher that does not yet mark its own changes.
 *
 * The first publication is whole. So is one whose threads are in another order than the last one's, less those that
 * went, with new ones after them: an upsert keeps a thread's place and appends a new one, so nothing else can say that.
 */
export function threadChangesBetween(published: ThreadMap | undefined, next: AgentHostSnapshot): ThreadChangeSet {
  const { threads, ...parts } = next
  const [rest] = immutableUpdates<AgentHostRest>([parts], [published?.rest])
  const records = threads.slice()
  const changed: number[] = []
  for (let index = 0; index < threads.length; index++) if (threads[index] !== published?.get(threads[index]!.id)) changed.push(index)
  const sources = changed.map(index => threads[index]!), previous = sources.map(thread => published?.get(thread.id))
  const updated = immutableUpdates(sources, previous)
  const upserts: AgentThread[] = []
  for (let at = 0; at < changed.length; at++) {
    records[changed[at]!] = updated[at]!
    if (updated[at] !== previous[at]) upserts.push(updated[at]!)
  }
  if (!published) return { whole: true, upserts: records, removals: [], rest: rest! }
  const present = new Set(threads.map(thread => thread.id))
  const survivors: string[] = [], removals: string[] = []
  for (const id of published.ids()) (present.has(id) ? survivors : removals).push(id)
  let kept = 0, appending = false, reordered = false
  for (const thread of threads) {
    if (!published.has(thread.id)) { appending = true; continue }
    if (appending || survivors[kept] !== thread.id) { reordered = true; break }
    kept++
  }
  if (reordered) return { whole: true, upserts: records, removals: [], rest: rest! }
  return { upserts, removals, ...(rest !== published.rest ? { rest: rest! } : {}) }
}

interface Listening { readonly historyFromEvents: boolean; whole: boolean; subscribed: boolean }

/**
 * A layer's thread changes subscribers, and the records it last published to each form of its snapshot (with history
 * from events or without, as `ActivitySubscribers` builds them). A publication builds each form once, whichever
 * subscribers want it, and hands every subscriber of the form the same frozen change. A subscriber that has just come,
 * or asked for a resync, gets a whole publication instead, built from what was published, numbered as the change it
 * stands in for so the next change follows it. A form nobody subscribes to is not built.
 */
export class ThreadChangesPublisher implements ActivityChangesSource {
  private readonly listeners = new Map<ActivityChangesListener, Listening>()
  private readonly forms = new Map<boolean, ThreadMap>()

  get size(): number { return this.listeners.size }

  subscribe(listener: ActivityChangesListener, options?: ActivitySubscriptionOptions): ActivityChangesSubscription {
    const listening: Listening = { historyFromEvents: options?.historyFromEvents === true, whole: true, subscribed: true }
    this.listeners.set(listener, listening)
    const off = (() => {
      if (this.listeners.get(listener) !== listening) return
      listening.subscribed = false
      this.listeners.delete(listener)
      if (![...this.listeners.values()].some(other => other.historyFromEvents === listening.historyFromEvents)) this.forms.delete(listening.historyFromEvents)
    }) as ActivityChangesSubscription
    off.resync = () => {
      if (!listening.subscribed) return
      listening.whole = true
      // Not inside the call: a subscriber asks from within its own listener, on the change it could not apply.
      queueMicrotask(() => {
        const map = this.forms.get(listening.historyFromEvents)
        if (!listening.subscribed || !listening.whole || map?.sequence === undefined) return
        listening.whole = false
        listener(wholeOf(map))
      })
    }
    return off
  }
  subscribeActivityChanges(listener: ActivityChangesListener, options?: ActivitySubscriptionOptions): ActivityChangesSubscription {
    return this.subscribe(listener, options)
  }

  /** The shim: each form's whole snapshot, compared with what was last published to it (`threadChangesBetween`). */
  publishSnapshots(view: (historyFromEvents: boolean) => AgentHostSnapshot): void {
    this.publish((historyFromEvents, published) => threadChangesBetween(published, view(historyFromEvents)))
  }

  /**
   * Changes a publisher worked out itself, given what it last published to the form (undefined before the first, when
   * the change must be whole). A publication that changed nothing still goes out, so a subscriber sees every publish.
   */
  publishChanges(build: (historyFromEvents: boolean, published: ThreadMap | undefined) => ThreadChangeSet): void {
    this.publish(build)
  }

  private publish(build: (historyFromEvents: boolean, published: ThreadMap | undefined) => ThreadChangeSet): void {
    const sent = new Map<boolean, { changes: AgentHostChanges; map: ThreadMap; whole?: AgentHostChanges }>()
    for (const [listener, listening] of [...this.listeners]) {
      if (!listening.subscribed) continue
      let form = sent.get(listening.historyFromEvents)
      if (!form) {
        const map = this.forms.get(listening.historyFromEvents) ?? new ThreadMap({ verify: false })
        const set = build(listening.historyFromEvents, map.sequence === undefined ? undefined : map)
        if (map.sequence === undefined && !set.whole) throw new Error('The first publication of thread changes must be whole.')
        const changes = Object.freeze({ ...set, upserts: Object.freeze(set.upserts.slice()), removals: Object.freeze(set.removals.slice()), sequence: (map.sequence ?? 0) + 1 })
        map.apply(changes)
        this.forms.set(listening.historyFromEvents, map)
        form = { changes, map }
        sent.set(listening.historyFromEvents, form)
      }
      const needsWhole = listening.whole && !form.changes.whole
      listening.whole = false
      if (needsWhole) form.whole ??= wholeOf(form.map)
      listener(needsWhole ? form.whole! : form.changes)
    }
  }
}

function wholeOf(map: ThreadMap): AgentHostChanges {
  return Object.freeze({ sequence: map.sequence!, whole: true as const, upserts: Object.freeze(map.threads()), removals: Object.freeze([] as string[]), rest: map.rest! })
}
