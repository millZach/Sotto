import { isDeepStrictEqual } from 'node:util'
import type { AgentHostSnapshot, AgentThread } from '../../shared/agents'
import { immutableUpdates, isImmutableRecord } from './activitySnapshots'
import { cloneHostSnapshot } from './cloneHostSnapshot'
import type { ActivitySubscriptionOptions } from './host'

/**
 * Thread changes (ADR-0016, proposed October 24 amendment, #925): what one layer of main hands the next instead of a
 * whole snapshot on every update. Internal to main; nothing here crosses IPC or the socket.
 *
 * The rules:
 * - Each publication carries a `sequence`, one more than the last that subscriber was sent.
 * - A first publication is whole, as is one answering a resync and one in which most of the threads moved. A whole
 *   publication lists every thread in the publisher's display order and carries `rest`.
 * - Any other publication lists the threads that changed (`upserts`, whole records) and the Sotto thread IDs that went
 *   (`removals`), and carries `rest` only when a part of the snapshot that is not its threads changed. They apply in
 *   that order: removals, then upserts, an upserted thread keeping its place or going last when it is new, then
 *   `placements`, in the order given, each putting a thread just before another or last.
 * - Every record and every `rest` is copied and frozen all the way down by `activitySnapshots.ts`, and only ever
 *   replaced, never written into.
 */

/** Every part of a host snapshot but its threads: providers, the catalog, projects, the connection and the rest. */
export type AgentHostRest = Omit<AgentHostSnapshot, 'threads'>

/** Where a thread goes: just before `beforeId`, or last when that is null. */
export interface ThreadPlacement {
  readonly id: string
  readonly beforeId: string | null
}

/** A publication before its publisher numbers it. */
export interface ThreadChangeSet {
  /** Set on a first publication, one answering a resync, and one in which most of the threads moved. */
  readonly whole?: true
  /** Whole records: every thread, in order, on a whole publication; otherwise those that changed. */
  readonly upserts: readonly AgentThread[]
  /** The Sotto thread IDs that went. Empty on a whole publication. */
  readonly removals: readonly string[]
  /**
   * Threads that came somewhere other than last, or moved, applied after the upserts in the order given. A thread that
   * only moved is placed without being upserted. Never on a whole publication.
   */
  readonly placements?: readonly ThreadPlacement[]
  /** The parts that are not threads: always on a whole publication, otherwise only when they changed. */
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

/** Whether `SOTTO_VERIFY_THREAD_CHANGES=1` asks every thread map given a whole snapshot to check itself against it. */
export function verifyingThreadChanges(): boolean { return process.env.SOTTO_VERIFY_THREAD_CHANGES === '1' }

/** A change left a map unlike the whole snapshot it should equal. Names thread IDs only, never what a thread says. */
export class ThreadChangesDrift extends Error {
  constructor(readonly differences: readonly string[]) {
    super(`The thread map no longer equals its whole snapshot: ${differences.join('; ')}.`)
    this.name = 'ThreadChangesDrift'
  }
}

/**
 * What `apply` answers. 'resync': not applied, because the map holds no whole publication yet or one was missed, so the
 * subscriber asks its publisher for a whole one. 'stale': not applied, because the map already holds as new a
 * publication, so there is nothing to do.
 */
export type ThreadMapApplied = 'applied' | 'resync' | 'stale'

interface Node { record: AgentThread; previous: Node | undefined; next: Node | undefined }

function ownedOrRefused(changes: ThreadChangeSet): void {
  for (const record of changes.upserts) {
    if (!isImmutableRecord(record)) throw new TypeError(`Thread changes carry records frozen all the way down; thread "${record.id}" was not.`)
  }
  if (changes.rest && !isImmutableRecord(changes.rest)) throw new TypeError('Thread changes carry the rest of the snapshot frozen all the way down.')
}

/**
 * Frozen thread records by Sotto thread ID, in a publisher's display order, as one subscriber holds them. They are a list
 * linked both ways with each thread's place found by its ID, so applying a change costs what the change carries: an
 * upsert of a thread it holds keeps its place, a new one goes last, a removal drops one and a placement moves one, each
 * without touching the rest. A whole publication replaces the list, which is what most of the threads moving costs.
 * Reading every record walks the list, for a read or a command.
 */
export class ThreadMap {
  private nodes = new Map<string, Node>()
  private first: Node | undefined
  private last: Node | undefined
  private held: AgentHostRest | undefined
  private at: number | undefined
  private readonly verifying: boolean

  constructor(private readonly options: ThreadMapOptions = {}) {
    this.verifying = options.verify ?? verifyingThreadChanges()
  }

  /** The sequence of the last publication applied, undefined until a whole one is. */
  get sequence(): number | undefined { return this.at }
  get size(): number { return this.nodes.size }
  /** The parts of the snapshot that are not threads, as last published. */
  get rest(): AgentHostRest | undefined { return this.held }
  get(id: string): AgentThread | undefined { return this.nodes.get(id)?.record }
  has(id: string): boolean { return this.nodes.has(id) }
  *ids(): IterableIterator<string> { for (let node = this.first; node; node = node.next) yield node.record.id }
  /** Every record in order, in a list of the caller's own. */
  threads(): AgentThread[] {
    const threads: AgentThread[] = []
    for (let node = this.first; node; node = node.next) threads.push(node.record)
    return threads
  }

  /**
   * Applies one publication (see `ThreadMapApplied`). A record or a `rest` that is not frozen all the way down, or a
   * placement naming a thread the map will not hold, is refused before anything is applied.
   */
  apply(changes: AgentHostChanges): ThreadMapApplied {
    if (changes.whole) {
      if (!changes.rest) throw new TypeError('A whole publication of thread changes carries the rest of the snapshot.')
      if (changes.placements?.length) throw new TypeError('A whole publication of thread changes gives its order by its records, not by placements.')
      // An older whole publication, delivered after a newer one, would take the map back.
      if (this.at !== undefined && changes.sequence < this.at) return 'stale'
      ownedOrRefused(changes)
      this.nodes = new Map(); this.first = undefined; this.last = undefined
      for (const record of changes.upserts) this.upsert(record)
      this.held = changes.rest
    } else {
      if (this.at === undefined || changes.sequence > this.at + 1) return 'resync'
      if (changes.sequence <= this.at) return 'stale'
      ownedOrRefused(changes)
      this.placeableOrRefused(changes)
      for (const id of changes.removals) {
        const node = this.nodes.get(id)
        if (node) { this.unlink(node); this.nodes.delete(id) }
      }
      for (const record of changes.upserts) this.upsert(record)
      for (const placement of changes.placements ?? []) {
        const node = this.nodes.get(placement.id)!
        this.unlink(node)
        this.linkBefore(node, placement.beforeId === null ? undefined : this.nodes.get(placement.beforeId))
      }
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

  /** Placements only move threads, so which threads the map holds once they apply is known before any is. */
  private placeableOrRefused(changes: ThreadChangeSet): void {
    if (!changes.placements?.length) return
    const removed = new Set(changes.removals), upserted = new Set(changes.upserts.map(record => record.id))
    const held = (id: string): boolean => upserted.has(id) || this.nodes.has(id) && !removed.has(id)
    for (const { id, beforeId } of changes.placements) {
      if (!held(id)) throw new TypeError(`A placement names thread "${id}", which the map will not hold.`)
      if (beforeId !== null && (beforeId === id || !held(beforeId))) throw new TypeError(`A placement puts thread "${id}" before "${beforeId}", which it cannot.`)
    }
  }

  private upsert(record: AgentThread): void {
    const node = this.nodes.get(record.id)
    if (node) { node.record = record; return }
    const added: Node = { record, previous: undefined, next: undefined }
    this.nodes.set(record.id, added)
    this.linkBefore(added, undefined)
  }

  private unlink(node: Node): void {
    if (node.previous) node.previous.next = node.next; else this.first = node.next
    if (node.next) node.next.previous = node.previous; else this.last = node.previous
    node.previous = undefined; node.next = undefined
  }

  /** Links `node` just before `before`, or last when that is undefined. */
  private linkBefore(node: Node, before: Node | undefined): void {
    node.next = before
    node.previous = before ? before.previous : this.last
    if (node.previous) node.previous.next = node; else this.first = node
    if (before) before.previous = node; else this.last = node
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

/** The positions in `values` of one longest strictly increasing run of them, not necessarily next to each other. */
function longestIncreasing(values: readonly number[]): Set<number> {
  const ends: number[] = [], before = new Array<number>(values.length)
  for (let index = 0; index < values.length; index++) {
    let low = 0, high = ends.length
    while (low < high) { const middle = (low + high) >> 1; if (values[ends[middle]!]! < values[index]!) low = middle + 1; else high = middle }
    before[index] = low > 0 ? ends[low - 1]! : -1
    ends[low] = index
  }
  const kept = new Set<number>()
  for (let at = ends.length ? ends[ends.length - 1]! : -1; at >= 0; at = before[at]!) kept.add(at)
  return kept
}

/**
 * The boundary shim: what changed between the records last published (`published`, undefined before the first) and a
 * whole snapshot `next`, worked out the way the workspace's publication shares what did not change (#1326). A thread
 * that is the record published last is left out after one identity check, which is sound because every published record
 * is owned and frozen all the way down. Any other is read against that record with `immutableUpdates`, which hands back
 * the record itself when the thread equals it, and otherwise a new owned record that keeps every part that did not
 * change, so nothing the caller still holds is kept. The parts that are not threads are read the same way. This costs a
 * check per thread, so it is for a publisher that does not yet mark its own changes.
 *
 * The order: the threads that stayed in the same order as before (one longest run of them) stay where they are, and
 * every other thread that moved or came is placed just before the thread that follows it, working from the end, except
 * new threads at the very end, which an upsert puts there. The first publication is whole, and so is one where more than
 * half the threads would need a placement.
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
  const position = new Map<string, number>()
  for (const id of published.ids()) position.set(id, position.size)
  const present = new Set(threads.map(thread => thread.id))
  const removals = [...position.keys()].filter(id => !present.has(id))
  // The threads that were published before, in their new order, by where they were.
  const stayed: number[] = [], was: number[] = []
  for (let index = 0; index < threads.length; index++) {
    const at = position.get(threads[index]!.id)
    if (at !== undefined) { stayed.push(index); was.push(at) }
  }
  let increasing = true
  for (let index = 1; index < was.length && increasing; index++) increasing = was[index - 1]! < was[index]!
  const still = new Set<number>()
  if (increasing) for (const index of stayed) still.add(index)
  else for (const at of longestIncreasing(was)) still.add(stayed[at]!)
  let end = threads.length
  while (end > 0 && !position.has(threads[end - 1]!.id)) end--
  const placements: ThreadPlacement[] = []
  for (let index = end - 1; index >= 0; index--) {
    if (still.has(index)) continue
    placements.push({ id: threads[index]!.id, beforeId: index + 1 < threads.length ? threads[index + 1]!.id : null })
  }
  if (placements.length * 2 > threads.length) return { whole: true, upserts: records, removals: [], rest: rest! }
  return { upserts, removals, ...(placements.length ? { placements } : {}), ...(rest !== published.rest ? { rest: rest! } : {}) }
}

type Build = (historyFromEvents: boolean, published: ThreadMap | undefined) => ThreadChangeSet
interface Listening { readonly historyFromEvents: boolean; whole: boolean; subscribed: boolean }

/**
 * A layer's thread changes subscribers, and the records it last published to each form of its snapshot (with history
 * from events or without, as `ActivitySubscribers` builds them). A publication builds each form once, whichever
 * subscribers want it, and hands every subscriber of the form the same frozen change. A subscriber that has just come,
 * or asked for a resync, gets a whole publication instead, built from what was published, numbered as the change it
 * stands in for so the next change follows it. A form nobody subscribes to is not built, and its numbering goes on
 * where it stopped when someone subscribes again.
 *
 * A publication made while one is being delivered, by a subscriber that publishes again from inside its listener, waits
 * until every subscriber has the first, so none is ever sent an older publication after a newer one.
 */
export class ThreadChangesPublisher implements ActivityChangesSource {
  private readonly listeners = new Map<ActivityChangesListener, Listening>()
  private readonly forms = new Map<boolean, ThreadMap>()
  private readonly sequences = new Map<boolean, number>()
  private delivering = false
  private readonly waiting: Build[] = []

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
   * the change must be whole). Records and parts it does not own are copied and owned here, sharing what equals what
   * was published, so nothing the publisher still holds reaches a subscriber. A publication that changed nothing still
   * goes out, so a subscriber sees every publish.
   */
  publishChanges(build: Build): void {
    this.publish((historyFromEvents, published) => {
      const set = build(historyFromEvents, published)
      const upserts = immutableUpdates(set.upserts, set.upserts.map(record => published?.get(record.id)))
      const [rest] = set.rest ? immutableUpdates<AgentHostRest>([set.rest], [published?.rest]) : []
      return { ...set, upserts, ...(rest ? { rest } : {}) }
    })
  }

  /**
   * A listener that throws neither stops the others getting the publication nor drops one queued from inside a listener:
   * every subscriber still reaches the latest state, and the first failure is thrown once all of them have it.
   */
  private publish(build: Build): void {
    if (this.delivering) { this.waiting.push(build); return }
    this.delivering = true
    const failures: unknown[] = []
    try {
      for (let next: Build | undefined = build; next; next = this.waiting.shift()) {
        try { this.deliver(next, failures) } catch (error) { failures.push(error) }
      }
    } finally {
      this.delivering = false
      this.waiting.length = 0
    }
    if (failures.length) throw failures[0]
  }

  private deliver(build: Build, failures: unknown[]): void {
    const sent = new Map<boolean, { changes: AgentHostChanges; map: ThreadMap; whole?: AgentHostChanges }>()
    for (const [listener, listening] of [...this.listeners]) {
      if (!listening.subscribed) continue
      const historyFromEvents = listening.historyFromEvents
      let form = sent.get(historyFromEvents)
      if (!form) {
        const map = this.forms.get(historyFromEvents) ?? new ThreadMap({ verify: false })
        const set = build(historyFromEvents, map.sequence === undefined ? undefined : map)
        if (map.sequence === undefined && !set.whole) throw new Error('The first publication of thread changes must be whole.')
        const sequence = (this.sequences.get(historyFromEvents) ?? 0) + 1
        const changes: AgentHostChanges = Object.freeze({ ...set, upserts: Object.freeze(set.upserts.slice()), removals: Object.freeze(set.removals.slice()),
          ...(set.placements ? { placements: Object.freeze(set.placements.map(placement => Object.freeze({ ...placement }))) } : {}), sequence })
        // The publisher's own map holds what every subscriber of the form should, numbered the same.
        if (map.apply(changes) !== 'applied') throw new Error('A publisher could not apply its own thread changes.')
        this.forms.set(historyFromEvents, map)
        this.sequences.set(historyFromEvents, sequence)
        form = { changes, map }
        sent.set(historyFromEvents, form)
      }
      const needsWhole = listening.whole && !form.changes.whole
      listening.whole = false
      if (needsWhole) form.whole ??= wholeOf(form.map)
      try { listener(needsWhole ? form.whole! : form.changes) } catch (error) { failures.push(error) }
    }
  }
}

function wholeOf(map: ThreadMap): AgentHostChanges {
  return Object.freeze({ sequence: map.sequence!, whole: true as const, upserts: Object.freeze(map.threads()), removals: Object.freeze([] as string[]), rest: map.rest! })
}
