import { isDeepStrictEqual } from 'node:util'
import { clientCatalogKey, hostCatalogKey } from '../../shared/agents'
import { threadsReplacedSince } from '../../shared/threadListPatches'
import { ThreadChangesDrift, verifyingThreadChanges } from './threadChanges'
import type { KeptPartsBase, KeptPartsShell, WatcherConversationDelta, WatcherConversationMessage, WatcherPhoneWireParts } from '../../shared/keptParts'
import type { AgentClientHost, AgentCommandReceipt, AgentCommandChangedThreadRecordsReceipt, AgentModel, AgentModelCatalogBroadcast, AgentModelCatalogRevision, AgentState, AgentStateBroadcast, CompleteAgentStateBroadcast, AgentThread, AgentThreadsBroadcast, KeptHostPart, KeptPart } from '../../shared/agents'

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

  /** The revision `key`'s catalog has now, without comparing anything or moving it: undefined before it has one. */
  current(key: string): number | undefined { return this.catalogs.get(key)?.revision }

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

/** The `host` fields a main-window broadcast always sends, being sent by change already: the threads. */
const BROADCAST_HOST_SENT = new Set(['threads'])

/**
 * `whole` with its kept parts left out and named in `kept` (ADR-0028, October 30 kept parts): each part, at its top and in
 * its `host` but the threads, that holds the same data as in `parts`. The parts around the threads are the drafts,
 * receipts, deliveries, projects, providers, paired hosts and settings. Most of them do not change from one broadcast to
 * the next, and they were resent whole on every one, up to seventeen a second while a reply streamed. A part is compared
 * with `samePlainData`, identity first, so a part handed over unchanged costs one comparison.
 *
 * A host's shell push to a socket client that accepted `kept-parts` is made the same way (ADR-0028, November 10 amendment),
 * with `hostSent` naming the catalog's fields as well as the threads: they have forms of their own and always go as made.
 */
export function withKeptParts(whole: CompleteAgentStateBroadcast, parts: KeptPartsBase, hostSent?: ReadonlySet<string>): AgentStateBroadcast
export function withKeptParts<Whole extends { readonly host: object }>(whole: Whole, parts: KeptPartsBase, hostSent: ReadonlySet<string>): KeptPartsShell<Whole>
export function withKeptParts(whole: { readonly host: object }, parts: KeptPartsBase, hostSent: ReadonlySet<string> = BROADCAST_HOST_SENT): object {
  const top: Record<string, unknown> = {}
  const host: Record<string, unknown> = {}
  const kept: KeptPart[] = [], hostKept: KeptHostPart[] = []
  for (const [key, value] of Object.entries(whole)) {
    if (key === 'host') continue
    // A part that is undefined is never named: a push read off the wire never carried it, so a client holds nothing to put back.
    if (value !== undefined && Object.hasOwn(parts.top, key) && samePlainData(parts.top[key], value)) kept.push(key as KeptPart)
    else top[key] = value
  }
  for (const [key, value] of Object.entries(whole.host)) {
    if (value !== undefined && !hostSent.has(key) && Object.hasOwn(parts.host, key) && samePlainData(parts.host[key], value)) hostKept.push(key as KeptHostPart)
    else host[key] = value
  }
  if (hostKept.length) host.kept = hostKept
  // The parts left out are absent: the page puts them back from the broadcast it holds before anything reads the state.
  return { ...top, ...kept.length ? { kept } : {}, host }
}

function sameMessageExceptText(before: WatcherConversationMessage, after: WatcherConversationMessage): boolean {
  const left = before as unknown as Readonly<Record<string, unknown>>
  const right = after as unknown as Readonly<Record<string, unknown>>
  let keys = 0
  for (const key in right) {
    if (key === 'text') continue
    keys++
    const a = left[key], b = right[key]
    if (a === b ? a === undefined && !Object.hasOwn(left, key) : !samePlainData(a, b)) return false
  }
  for (const key in left) if (key !== 'text') keys--
  return keys === 0
}

function diffWatcherConversation(
  prev: { readonly messages: readonly WatcherConversationMessage[]; readonly earlierAvailable: boolean; readonly revision: number },
  next: { readonly messages: readonly WatcherConversationMessage[]; readonly earlierAvailable: boolean; readonly revision: number },
): WatcherConversationDelta | undefined {
  const prevMsgs = prev.messages, nextMsgs = next.messages
  if (!prevMsgs.length || !nextMsgs.length) return undefined
  const firstId = nextMsgs[0]!.id
  const dropHead = prevMsgs[0]!.id === firstId ? 0 : prevMsgs.findIndex(message => message.id === firstId)
  if (dropHead < 0) return undefined
  let keep = 0
  while (dropHead + keep < prevMsgs.length && keep < nextMsgs.length && samePlainData(prevMsgs[dropHead + keep], nextMsgs[keep])) keep++
  let appendLastText: string | undefined
  if (dropHead + keep < prevMsgs.length && keep < nextMsgs.length) {
    const before = prevMsgs[dropHead + keep]!, after = nextMsgs[keep]!
    if (sameMessageExceptText(before, after) && after.text.length > before.text.length && after.text.startsWith(before.text)) {
      appendLastText = after.text.slice(before.text.length)
      keep++
    }
  }
  if (keep === 0) return undefined
  return { dropHead, keep, ...(appendLastText !== undefined ? { appendLastText } : {}), tail: nextMsgs.slice(keep),
    earlierAvailable: next.earlierAvailable, revision: next.revision }
}

/**
 * Encodes a changed Watcher phone page against the last pushed page `prev` (`watcher-phone-parts`): unchanged sub-parts
 * are named in `kept` and omitted, and a changed `conversation` that shares messages with `prev` goes as
 * `conversationDelta` instead of resending all 200 messages.
 */
export function withWatcherPhoneParts<
  Page extends { readonly conversation: { readonly messages: readonly WatcherConversationMessage[]; readonly earlierAvailable: boolean; readonly revision: number } },
>(next: Page, prev: Page): WatcherPhoneWireParts<Page> {
  const prevRecord = prev as unknown as Readonly<Record<string, unknown>>
  const out: Record<string, unknown> = {}
  const kept: string[] = []
  for (const [key, value] of Object.entries(next as unknown as Readonly<Record<string, unknown>>)) {
    if (key === 'conversation') continue
    if (value !== undefined && Object.hasOwn(prevRecord, key) && samePlainData(prevRecord[key], value)) kept.push(key)
    else out[key] = value
  }
  if (samePlainData(prev.conversation, next.conversation)) kept.push('conversation')
  else {
    const delta = diffWatcherConversation(prev.conversation, next.conversation)
    if (delta !== undefined) out.conversationDelta = delta
    else out.conversation = next.conversation
  }
  if (kept.length) out.kept = kept
  return out as WatcherPhoneWireParts<Page>
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

/** Records an answer lists whole, held under `revision` once `commit()` says the answer was delivered. */
export interface ThreadRecordsSeed { readonly revision: number; readonly commit: () => void }

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
  encode(threads: readonly AgentThread[], host?: object, taken?: number): { payload: AgentThreadsBroadcast; commit: () => void } {
    const revision = taken ?? ++this.revision
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
   * `threads`, which an answer lists whole, as the base the next broadcast is measured from once that answer is delivered
   * (ADR-0028, November 1 amendment): the client holds them under the revision returned, so the broadcast after the answer
   * carries only what changed since it rather than every record again. Committing voids any earlier send that has not
   * become the base yet, as `reset()` does: the client read past it. Undefined, leaving everything as it was, when two
   * records share an ID and cannot be told apart.
   */
  seed(threads: readonly AgentThread[]): ThreadRecordsSeed | undefined {
    const revision = ++this.revision
    const walked = walk(threads, revision, null)
    if (!walked.unique) return undefined
    return { revision, commit: () => { this.resets++; this.base = { revision, host: undefined, records: walked.records, overrides: NO_OVERRIDES, order: walked.order } } }
  }
  /**
   * The next revision, for a command's reply as main builds it (#306): the reply is measured and encoded later, but it
   * holds the state of this moment, so it is numbered against the broadcasts by when that state was taken.
   */
  take(): number { return ++this.revision }

  /** The revision of the broadcast the next is measured from, or null when the next lists every record. */
  get baseRevision(): number | null { return this.base?.revision ?? null }

  /**
   * `threads` measured from what the window was last sent, as a broadcast would be, for a command's reply: nothing is
   * made the base, so the next broadcast is measured from the same place and carries the same changes (#1330's shape).
   */
  peek(threads: readonly AgentThread[], host?: object, taken?: number): AgentThreadsBroadcast { return this.encode(threads, host, taken).payload }

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
  /**
   * The parts of the broadcast the next one's threads are measured from, as that broadcast was encoded, under its thread
   * revision: the kept parts' base. It moves with the threads' base, and only to a broadcast delivered.
   */
  private parts: { readonly revision: number; readonly top: Readonly<Record<string, unknown>>; readonly host: Readonly<Record<string, unknown>> } | null = null
  /**
   * The thread revision each command reply took as the router built it (#306), by the reply's `host`, which the router's
   * top-level additions to a reply leave in place. Held beside the state, so a reply is never copied to carry it.
   */
  private readonly taken = new WeakMap<object, number>()
  /**
   * The newest thread revision sent to a window: the last broadcast delivered, or a reply encoded after it that the router
   * built later. A reply built before it is older than the window's state, whichever of the two carried that state.
   */
  private newest = 0
  /**
   * The main window's last whole read (`readWhole`): the number its answer named and its records by ID, until a complete
   * list delivered after it has marked the records it repeats from it.
   */
  private read: { readonly revision: number; readonly records: ReadonlyMap<string, AgentThread> } | null = null

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
    const listed = this.withRepeats(threads.payload)
    const whole: CompleteAgentStateBroadcast = { ...encoded, host: { ...encoded.host, threads: listed } }
    // Measured from the broadcast the window last applied, which it holds the parts of: what did not change is left out.
    const parts = this.parts
    const payload = threads.payload.base !== null && parts?.revision === threads.payload.base ? withKeptParts(whole, parts) : whole
    const delivered = deliver(payload)
    if (delivered) {
      if (threads.payload.revision > this.newest) this.newest = threads.payload.revision
      for (const [key, revision] of confirmed) this.sent.set(key, revision)
      threads.commit()
      // A complete list delivered has marked what it repeats from the read; every broadcast after is measured from it.
      if (listed.base === null) this.read = null
      // The parts go with the threads' base: a read while this was delivered leaves neither.
      this.parts = this.threads.baseRevision === threads.payload.revision ? { revision: threads.payload.revision, top: whole, host: whole.host } : null
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
  readonly windowRead = (): void => { this.threads.reset(); this.parts = null }

  /**
   * The main window read the whole state (`AGENT_GET`): `windowRead`, and `state`, the state it is answered with, named by
   * a number of its own (`readRevision`). The next broadcast still lists every record, so it can be taken in whatever
   * order it and the answer reach the window, but it marks the records whose content is the same as the read's
   * (`AgentThreadsBroadcast.repeats`), and a page holding the read keeps its own copies of those rather than taking 1,070
   * records in anew, as the owner's window did after each of 26 whole reads in a minute on November 20, 2026 (#2733). An
   * arrow property, so `registerAgentIpc` can be handed it on its own.
   */
  readonly readWhole = (state: AgentState): AgentState => {
    this.windowRead()
    const records = new Map<string, AgentThread>()
    for (const thread of state.host.threads) records.set(thread.id, thread)
    const revision = this.threads.take()
    this.read = { revision, records }
    return { ...state, readRevision: revision }
  }

  /** A complete list after the main window's whole read, with the positions whose record has the read's content marked. */
  private withRepeats(threads: AgentThreadsBroadcast): AgentThreadsBroadcast {
    const read = this.read
    if (read === null || threads.base !== null) return threads
    const positions: number[] = []
    threads.changed.forEach((thread, position) => {
      const sent = read.records.get(thread.id)
      if (sent !== undefined && samePlainData(sent, thread)) positions.push(position)
    })
    return positions.length ? { ...threads, repeats: { read: read.revision, positions } } : threads
  }

  /**
   * The router built `state` to answer a command (#306): it takes the next thread revision now, which its reply carries
   * however much later it is encoded, so the window orders it against the broadcasts by when its state was taken. One
   * counter step and one weak entry, with nothing read from the state. An arrow property, so the router can be handed it.
   */
  readonly replyBuilt = (state: AgentState): void => { this.taken.set(state.host, this.threads.take()) }

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
   * differs from what the counter last held. A reply the router built before a broadcast the window was delivered, or
   * before a reply already encoded (`replyBuilt`), does not: it is older than the window's state, so its catalogs are named by the revisions they hold
   * now, and the window resolves the newer catalog it holds (ADR-0028, November 5 amendment). A reply nobody numbered
   * as it was built, such as one a test encodes directly, is encoded as before.
   *
   * An arrow property rather than a method, so `registerAgentIpc` can be handed it on its own.
   */
  readonly encodeReceipt = (state: AgentState): AgentCommandReceipt => {
    // A reply built before a broadcast the window was delivered, or before another command's reply already encoded, is
    // older than the window's state (#306), and the window drops it. Its catalogs are named by the revisions they hold now
    // without moving the counter: the window resolves the newer one it holds, and neither it nor the next broadcast pays
    // for a catalog only this reply held. Concurrent commands can finish out of the order the router built their replies.
    const taken = this.taken.get(state.host)
    const older = taken !== undefined && taken < this.newest
    if (taken !== undefined && !older) this.newest = taken
    return this.encode(state, (key, models): AgentModelCatalogRevision => ({ revision: (older ? this.revisions.current(key) : undefined) ?? this.revisionFor(key, models), omitted: true }))
  }

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
    return { ...receipt, host: { ...receipt.host, threads: this.withRepeats(this.threads.peek(state.host.threads, state.host, this.taken.get(state.host))) } }
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
