import { isDeepStrictEqual } from 'node:util'
import { clientCatalogKey, hostCatalogKey } from '../../shared/agents'
import { threadsReplacedSince } from '../../shared/threadListPatches'
import { ThreadChangesDrift, verifyingThreadChanges } from './threadChanges'
import type { AgentClientHost, AgentCommandReceipt, AgentCommandChangedThreadRecordsReceipt, AgentModel, AgentModelCatalogBroadcast, AgentModelCatalogRevision, AgentState, AgentStateBroadcast, AgentThread, AgentThreadsBroadcast } from '../../shared/agents'

type EncodedClientHost<Catalog> = Omit<AgentClientHost, 'models'> & { models: Catalog }
type EncodedState<Catalog> = Omit<AgentState, 'host'> & {
  host: Omit<AgentState['host'], 'models' | 'clientHosts'> & { models: Catalog; clientHosts?: EncodedClientHost<Catalog>[] }
}

interface CatalogSnapshot {
  readonly revision: number
  models: readonly AgentModel[]
  /** `models.length` when it was stored, so an array that gained or lost a model in place is not taken as unchanged. */
  length: number
}

/**
 * A revision for each model catalog, keyed by the caller, that advances only when that catalog's content
 * actually changes. Content is compared with `isDeepStrictEqual`, because a shell rebuilds `models` into new
 * arrays and objects on every publish even when nothing in it changed, so identity cannot tell a repeat from
 * a change. The counter starts at 1 and only advances, so a revision names one content for as long as this
 * object lives. `AgentStateBroadcaster` uses one for the desktop's main window (ADR-0028); the socket listener
 * uses one of its own for its peers that accept `model-catalog-revision` (ADR-0028, October 3 amendment).
 */
export class ModelCatalogRevisions {
  private readonly catalogs = new Map<string, CatalogSnapshot>()
  private lastComparison: { stored: readonly AgentModel[]; incoming: readonly AgentModel[]; lengths: [number, number]; equal: boolean } | null = null

  /** The revision `models` has under `key`: the one it last had when its content is unchanged, otherwise the next. */
  revisionFor(key: string, models: readonly AgentModel[]): number {
    const existing = this.catalogs.get(key)
    // A shell from a peer that sent no catalog, such as an unreadable push from a host of another version, has none at
    // all; that is one content like any other.
    const length = models?.length ?? 0
    const same = existing !== undefined && (existing.models === models ? existing.length === length : this.sameContent(existing.models, models))
    if (same) {
      // The array just compared stands for this content from now on. A shell that keeps handing over one array, as a
      // certified catalog does, then meets its own identity on the next publish instead of being compared again with
      // whichever equal array came first (#1330).
      existing.models = models
      return existing.revision
    }
    const revision = (existing?.revision ?? 0) + 1
    this.catalogs.set(key, { revision, models, length })
    return revision
  }

  /**
   * One content comparison serves every key that holds the same array and is handed the same array:
   * `host.models` and the selected host's `clientHosts[]` entry are one array in a shell, and one shell is
   * encoded for the window. Without this, a publish compared the 608-model catalog twice, as did a
   * receipt. The last pair compared is remembered by identity and by the length each had then. A
   * shell is rebuilt, never edited, so identity is enough today; the lengths make a model added to or
   * removed from either array in place compare afresh rather than reuse a stale answer for good.
   */
  private sameContent(stored: readonly AgentModel[], incoming: readonly AgentModel[]): boolean {
    const last = this.lastComparison
    if (last !== null && last.stored === stored && last.incoming === incoming
      && last.lengths[0] === (stored?.length ?? 0) && last.lengths[1] === (incoming?.length ?? 0)) return last.equal
    const equal = stored === incoming || isDeepStrictEqual(stored, incoming)
    this.lastComparison = { stored, incoming, lengths: [stored?.length ?? 0, incoming?.length ?? 0], equal }
    return equal
  }
}

/** How deep `samePlainData` walks before it hands a value to `isDeepStrictEqual`, which also handles cycles. */
const PLAIN_DEPTH = 64

/**
 * Whether two values hold the same data, for the plain objects, arrays and primitives a shell is made of. Identity
 * answers first at every level, so a part handed over unchanged costs one comparison; only parts whose identity changed
 * are walked. An object that is neither plain nor an array (a `Map`, a `Date`), and anything deeper than `PLAIN_DEPTH`,
 * goes to `isDeepStrictEqual`. Object keys are compared as sets, so a key present with `undefined` differs from a key
 * that is absent, as structured clone keeps them apart too. An array's hole reads as `undefined`; a shell has none.
 *
 * Written for speed over the 300 records a broadcast compares, most of them with a few rebuilt parts: `for...in` rather
 * than `Object.keys`, which allocates an array per object. At the owner's scale it walks a broadcast's threads in under
 * half the time serializing them takes, and in under half the time `isDeepStrictEqual` takes.
 */
export function samePlainData(previous: unknown, next: unknown, depth = 0): boolean {
  if (Object.is(previous, next)) return true
  if (typeof previous !== 'object' || typeof next !== 'object' || previous === null || next === null) return false
  if (depth > PLAIN_DEPTH) return isDeepStrictEqual(previous, next)
  if (Array.isArray(previous)) {
    if (!Array.isArray(next) || previous.length !== next.length) return false
    for (let index = 0; index < previous.length; index++) {
      const left: unknown = previous[index], right: unknown = next[index]
      if (left !== right && !samePlainData(left, right, depth + 1)) return false
    }
    return true
  }
  if (Array.isArray(next)) return false
  const prototype = Object.getPrototypeOf(previous) as unknown
  if (prototype !== Object.getPrototypeOf(next)) return false
  if (prototype !== Object.prototype && prototype !== null) return isDeepStrictEqual(previous, next)
  const left = previous as Record<string, unknown>, right = next as Record<string, unknown>
  let keys = 0
  for (const key in right) {
    keys++
    const before = left[key], after = right[key]
    if (before === after ? before === undefined && !Object.hasOwn(left, key) : !samePlainData(before, after, depth + 1)) return false
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- only counted
  for (const key in left) keys--
  return keys === 0
}

interface ThreadBase {
  readonly revision: number
  /**
   * The host the threads were listed from, when the caller named it: a later host whose list notes it was made from this
   * one's in place (`threadListPatches.ts`) is read only where it was. Held while it is the base, as the records are.
   */
  readonly host: object | undefined
  /** The records sent, by ID: those of the last whole walk, with the ones later broadcasts read in part sent over them. */
  readonly records: ReadonlyMap<string, AgentThread>
  readonly overrides: ReadonlyMap<string, AgentThread>
  readonly order: readonly string[]
}

/** The most records sent over a whole walk's before they are folded into a map of their own, which reads no thread. */
const MAX_OVERRIDES = 64
const NO_OVERRIDES: ReadonlyMap<string, AgentThread> = new Map()

/** The record the window was last sent for a thread, by its ID. */
function sentRecord(base: ThreadBase, id: string): AgentThread | undefined { return base.overrides.get(id) ?? base.records.get(id) }

/**
 * The thread records of the main window's broadcasts (issue #1330, ADR-0028's October 22 amendment): each broadcast
 * carries the records that changed since the last one the window was sent, the IDs of those that went and, when it
 * moved, the order. A whole thread array on every broadcast, up to one each 16 ms while a thread streams, was most of
 * what main spent serializing for the window, and the window then spent longer than that working out which records
 * had not changed.
 *
 * A record is unchanged when it is the record last sent or holds the same data (`samePlainData`). The router builds a
 * new record for every thread on every publish, but what each holds is the coordinator's or a remote host's, handed
 * over by identity until it changes, so the comparison is mostly identities. The records held are the ones last sent,
 * read and never written into, as everything a publish carries is. Only a broadcast `deliver()` reports as sent
 * becomes the base the next is measured from, so after a failed send the next is measured from the one before.
 *
 * A list whose host notes it was made in place from the base's host (`threadListPatches.ts`, #925 step 6) is read only
 * at the positions replaced since: every other record is the very record the base listed, and the threads, their order
 * and what went are the base's. A replaced record can hold the same data, so each is still compared. Any other list,
 * and one of another length or with another thread at a replaced position, is walked whole. The router notes each
 * publication so against the one before, and a note carries the steps before it, so a base sent several publications
 * back is found though the ones between were skipped by a coalesced send and have gone.
 *
 * `reset()` drops the base, and the next broadcast lists every record: main calls it when the window reads the whole
 * state, which it does whenever it loads or reloads and whenever it cannot apply a broadcast. A read while a send is
 * being delivered voids that send as a base too: the window may have read past it. Two records with one
 * Sotto thread ID cannot be told apart by ID, so a list that holds them goes complete and leaves no base, as the whole
 * array always did.
 *
 * Verifying mode (`SOTTO_VERIFY_THREAD_CHANGES=1`): each broadcast read in part is checked against the whole walk from
 * the same base, which must give the very same payload. The check reads, and keeps and changes nothing.
 */
export class ThreadRecordsBroadcast {
  private revision = 0
  private base: ThreadBase | null = null
  /** Advanced by every `reset()`, so a send the window read the whole state during cannot become a base after it. */
  private resets = 0
  private readonly verifying = verifyingThreadChanges()
  /** Broadcasts read only where their host's notes say the list was replaced. */
  patchedEncodes = 0
  /** Of those, the ones checked against the whole walk in verifying mode. */
  verifiedEncodes = 0

  /**
   * `threads` encoded against what the window was last sent, and the commit that makes it the base once delivered.
   * `host`, when given, is the object `threads` was listed from, whose notes say how its list was made.
   */
  encode(threads: readonly AgentThread[], host?: object): { payload: AgentThreadsBroadcast; commit: () => void } {
    const revision = ++this.revision
    const base = this.base
    const resets = this.resets
    const replaced = base?.host !== undefined && host !== undefined ? threadsReplacedSince(host, base.host) : undefined
    const changed = replaced && base ? changedAt(threads, base, replaced) : undefined
    if (changed && base) {
      this.patchedEncodes++
      const payload: AgentThreadsBroadcast = { revision, base: base.revision, changed }
      if (this.verifying) this.verifyPatched(threads, base, payload)
      let records = base.records, overrides = base.overrides
      if (changed.length) {
        const sent = new Map(overrides)
        for (const thread of changed) sent.set(thread.id, thread)
        if (sent.size > MAX_OVERRIDES) {
          const folded = new Map(records)
          for (const [id, thread] of sent) folded.set(id, thread)
          records = folded; overrides = NO_OVERRIDES
        } else overrides = sent
      }
      const commit = (): void => { if (resets === this.resets) this.base = { revision, host, records, overrides, order: base.order } }
      return { payload, commit }
    }
    const walked = walk(threads, revision, base)
    const commit = (): void => {
      if (resets === this.resets) this.base = walked.unique ? { revision, host, records: walked.records, overrides: NO_OVERRIDES, order: walked.order } : null
    }
    return { payload: walked.payload, commit }
  }

  /** The next broadcast lists every record: the window holds none it can measure from. */
  reset(): void { this.base = null; this.resets++ }

  /**
   * `threads` measured from what the window was last sent, as a broadcast would be, for a command's reply: nothing is
   * made the base, so the next broadcast is measured from the same place and carries the same changes (#1330's shape).
   */
  peek(threads: readonly AgentThread[], host?: object): AgentThreadsBroadcast { return this.encode(threads, host).payload }

  /** Verifying mode: a broadcast read in part, against the whole walk from the same base. */
  private verifyPatched(threads: readonly AgentThread[], base: ThreadBase, payload: AgentThreadsBroadcast): void {
    this.verifiedEncodes++
    const whole = walk(threads, payload.revision, base).payload
    const differences: string[] = []
    if (whole.base !== payload.base) differences.push(`the whole walk measures from ${String(whole.base)} where the broadcast measures from ${String(payload.base)}`)
    if (whole.removed) differences.push(`the whole walk names ${whole.removed.length} threads gone, which a list made in place cannot have`)
    if (whole.order) differences.push('the whole walk moves the order, which a list made in place cannot')
    const sent = new Set(payload.changed), walked = new Set(whole.changed)
    for (const thread of whole.changed) if (!sent.has(thread)) differences.push(`thread "${thread.id}" changed and was not sent, a missed change`)
    for (const thread of payload.changed) if (!walked.has(thread)) differences.push(`thread "${thread.id}" was sent though it did not change`)
    if (!differences.length && whole.changed.some((thread, index) => payload.changed[index] !== thread)) differences.push('the changed records are not in the order the whole walk lists them')
    if (differences.length) throw new ThreadChangesDrift(differences)
  }
}

/**
 * The records at `replaced` that changed since `base`, in list order; undefined when the list cannot have been made from
 * the base's in place (another length, or another thread at a replaced position) and must be walked whole.
 */
function changedAt(threads: readonly AgentThread[], base: ThreadBase, replaced: ReadonlySet<number>): AgentThread[] | undefined {
  if (threads.length !== base.order.length) return undefined
  const changed: AgentThread[] = []
  for (const position of [...replaced].sort((left, right) => left - right)) {
    if (!(position >= 0 && position < threads.length)) return undefined
    const thread = threads[position]!
    if (thread.id !== base.order[position]) return undefined
    const sent = sentRecord(base, thread.id)
    if (sent === undefined || !samePlainData(sent, thread)) changed.push(thread)
  }
  return changed
}

/** One walk of every thread, against `base` when there is one: the payload, and the records and order it leaves as a base. */
function walk(threads: readonly AgentThread[], revision: number, base: ThreadBase | null): { payload: AgentThreadsBroadcast; records: Map<string, AgentThread>; order: string[]; unique: boolean } {
  // One walk of the threads builds the records, the order and what changed.
  const records = new Map<string, AgentThread>()
  const order: string[] = []
  const changed: AgentThread[] = []
  for (const thread of threads) {
    records.set(thread.id, thread)
    order.push(thread.id)
    const sent = base ? sentRecord(base, thread.id) : undefined
    if (sent === undefined || !samePlainData(sent, thread)) changed.push(thread)
  }
  const unique = records.size === threads.length
  if (base === null || !unique) return { payload: { revision, base: null, changed: [...threads] }, records, order, unique }
  const removed = base.order.filter(id => !records.has(id))
  const moved = order.length !== base.order.length || order.some((id, index) => base.order[index] !== id)
  return { payload: { revision, base: base.revision, changed, ...(removed.length ? { removed } : {}), ...(moved ? { order } : {}) }, records, order, unique }
}

/**
 * Turns a shell into what actually crosses `sotto:agents:state` for the main window, omitting a
 * model catalog that window was already sent and nothing has changed since (issue #286): `models` is
 * a new array of new objects on every publish when no adapter certified it (the coordinator's shell is a structured
 * clone), so identity cannot always tell a repeat from a change — content, compared with `isDeepStrictEqual`, can. A
 * certified catalog keeps its identity until it changes, which the comparison checks first (#917). A catalog's revision is a counter bumped only when its content actually
 * changes. What the window has already been sent is tracked only once delivery of it is confirmed,
 * so a window that never actually received a revision is not skipped
 * on the next attempt.
 *
 * `host.models` and the selected host's own `clientHosts[]` entry are today always the same array
 * (`DesktopHostRouter.shell()`), but they are still keyed apart, with a `host:`/`client:` prefix, rather
 * than sharing the selected host's ID: if the two ever held different content, sharing a key would flip
 * one's revision out from under the other's own comparison on every publish, so neither could ever settle
 * on `omitted` again.
 *
 * A command's reply to a window is encoded here too (`encodeReceipt`, issue #323), with the same revisions,
 * so one counter orders what the broadcast and the replies say about a catalog. The keys are
 * `hostCatalogKey` and `clientCatalogKey` from `src/shared/agents.ts`, which the page's cache uses too.
 */
export class AgentStateBroadcaster {
  private readonly revisions = new ModelCatalogRevisions()
  private readonly sent = new Map<string, number>()
  private readonly threads = new ThreadRecordsBroadcast()

  /** Encodes `state` for the main window and hands it to `deliver`; only a delivery `deliver` reports as
   * successful (its return value) is remembered, so a window that was not actually listening is sent the
   * catalog in full again next time rather than being assumed caught up, and its threads are measured again
   * from the last broadcast it was sent. */
  send(state: AgentState, deliver: (payload: AgentStateBroadcast) => boolean): boolean {
    const confirmed: Array<[string, number]> = []
    const encoded = this.encode(state, (key, models): AgentModelCatalogBroadcast => {
      const revision = this.revisionFor(key, models)
      if (this.sent.get(key) === revision) return { revision, omitted: true }
      confirmed.push([key, revision])
      return { revision, models: models as AgentModel[] }
    })
    const threads = this.threads.encode(state.host.threads, state.host)
    const payload: AgentStateBroadcast = { ...encoded, host: { ...encoded.host, threads: threads.payload } }
    const delivered = deliver(payload)
    if (delivered) {
      for (const [key, revision] of confirmed) this.sent.set(key, revision)
      threads.commit()
    }
    return delivered
  }

  /**
   * The window read the whole state (`AGENT_GET`), as it does on every load and reload and whenever it cannot apply a
   * broadcast's threads. Whatever it held before, the next broadcast lists every thread record. Catalogs need no
   * reset: a window names a catalog it lacks by its revision and reads it back the same way (ADR-0028).
   *
   * An arrow property, so `registerAgentIpc` can be handed it on its own.
   */
  readonly windowRead = (): void => { this.threads.reset() }

  /** The broadcasts whose threads were read only where their host's notes say they were replaced, and those verified (#925 step 6). */
  get threadEncodes(): { readonly patched: number; readonly verified: number } { return { patched: this.threads.patchedEncodes, verified: this.threads.verifiedEncodes } }

  /**
   * A command's reply to a window (issue #323): `state` whole except that every catalog is named by its
   * catalog revision rather than listed, whatever the window was sent. The revision comes from the same
   * counter the broadcast uses, so a window resolves it from what the broadcast already gave it and
   * recovers through `AGENT_GET` when it holds another. A receipt records nothing as sent to any window.
   *
   * It is not a pure encoder. Naming a catalog's revision goes through `revisionFor`, which advances the
   * counter the window uses and stores `state`'s catalog as the current content when that content
   * differs from what the counter last held. A reply shell built before a catalog change and encoded after
   * its broadcast therefore takes a revision of its own for the old content, and the next broadcast takes
   * another for the new content and sends it in full to the window (ADR-0028's
   * September 26 amendment).
   *
   * An arrow property rather than a method, so `registerAgentIpc` can be handed it on its own.
   */
  readonly encodeReceipt = (state: AgentState): AgentCommandReceipt =>
    this.encode(state, (key, models): AgentModelCatalogRevision => ({ revision: this.revisionFor(key, models), omitted: true }))

  /**
   * A command's reply to a window that asked for its threads as changed thread records (ADR-0028, October 30 amendment): `encodeReceipt`'s,
   * with the thread records that changed since the last broadcast the window was sent in place of every one. The window
   * puts the whole array back from that broadcast's records; one that holds another broadcast reads the whole state.
   * Nothing is recorded as sent, so the next broadcast is measured from the same broadcast and carries the same changes.
   *
   * An arrow property, so `registerAgentIpc` can be handed it on its own.
   */
  readonly encodeChangedThreadRecordsReceipt = (state: AgentState): AgentCommandChangedThreadRecordsReceipt => {
    const receipt = this.encodeReceipt(state)
    return { ...receipt, host: { ...receipt.host, threads: this.threads.peek(state.host.threads, state.host) } }
  }

  /** `state` with `host.models` and every `host.clientHosts[].models` replaced by what `catalog` makes of it. */
  private encode<Catalog>(state: AgentState, catalog: (key: string, models: readonly AgentModel[]) => Catalog): EncodedState<Catalog> {
    const encodeClientHost = (client: AgentClientHost): EncodedClientHost<Catalog> => ({ ...client, models: catalog(clientCatalogKey(client.hostId), client.models) })
    const { clientHosts, ...hostRest } = state.host
    return {
      ...state,
      host: {
        ...hostRest,
        models: catalog(hostCatalogKey(state.host.hostId), state.host.models),
        ...(clientHosts ? { clientHosts: clientHosts.map(encodeClientHost) } : {}),
      },
    }
  }

  private revisionFor(key: string, models: readonly AgentModel[]): number { return this.revisions.revisionFor(key, models) }
}
