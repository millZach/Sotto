import { randomUUID } from 'node:crypto'
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { AgentRuntimeMode } from '../../shared/agents'
import { hostEntityKey, parseHostEntityKey } from '../../shared/clientIdentity'
import { delegationWorkSchema, type DelegationNews, type DelegationWork } from '../../shared/delegation'
import { DELEGATION_RELAY_ANSWER_GRACE_MS, DELEGATION_RELAY_READ_MS, DELEGATION_RELAY_RECORDS_MAX, type DelegationRemoteAsk, type RelayedReply, type RemoteLandedBranch } from '../../shared/delegationRelay'
import { watcherOutcomeSchema, type WatcherOutcome } from '../../shared/watcher'
import type { WorkerPlacementReceipt } from '../../shared/workerMachine'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { RelayUnanswered } from './delegationRelayHost'
import type { DelegationNewsDetail } from './delegationNews'

/** A host connection as remote delegation uses it: the asks it takes and the news it pushes (`delegation-remote`). */
export interface RemoteDelegationConnection {
  readonly hostId: string
  readonly kind: 'local' | 'remote'
  readonly service: {
    readonly supportsDelegationRemote?: boolean | undefined
    /** The host takes a start from a branch this computer landed there, and a check (`delegation-branch-starts`, #1316 part 2). */
    readonly supportsDelegationBranchStarts?: boolean | undefined
    delegationRemoteAsk?(ask: DelegationRemoteAsk, timeoutMs: number): Promise<unknown>
    subscribeDelegationRemoteNews?(listener: (caller: string, news: DelegationNews, replies: readonly RelayedReply[]) => void): () => void
  }
}
/** The host router as remote delegation follows it: each connection it takes, and the remote ones connected now. */
export interface RemoteDelegationHosts {
  subscribeConnected(listener: (connection: RemoteDelegationConnection) => void): () => void
  remoteConnections(): Iterable<RemoteDelegationConnection>
}
/** What a start or a second brief on a paired host asks for its caller, as this computer's delegation admitted it to ask. */
export interface RemoteAsk {
  readonly levels: number
  readonly rootUserMessageId: string
  readonly callerMessageId?: string | undefined
  readonly runtimeMode: AgentRuntimeMode
  /** The `delegate` arguments, without a machine, a system or a branch, and without a retry key: this computer gives its own. */
  readonly input: Record<string, unknown>
  /** The caller's own retry key, when it gave one: a second call with it reads the first call's delegation. */
  readonly retryKey?: string | undefined
  /** How long the call waits here for the outcome. */
  readonly waitMs: number
  /** The caller's branch, which this computer already landed in the host's project for this start (#1316 part 2). */
  readonly branch?: RemoteLandedBranch | undefined
  /** The place this computer reserved in the host's check queue for this start, before its branch moved (#1316 part 2). */
  readonly reservation?: string | undefined
}

const id = z.string().min(1).max(512)
/** Built once: a delegation ID a host's answer names is checked on every answer (zodSchemaSites). */
const uuidSchema = z.uuid()
const recordSchema = z.object({
  /** The ID the delegating thread knows it by: this computer's own, given before the host was asked. */
  id: z.uuid(), hostId: z.uuid(), callerId: id, action: z.enum(['start', 'send']), work: delegationWorkSchema,
  /** The host's own copy of the project, where it started. */
  projectId: id,
  /** The caller's own retry key, when it gave one. The host is asked under `id`. */
  callerRetryKey: z.uuid().optional(),
  /** The host's delegation ID, once its answer named one. */
  delegation: z.uuid().optional(),
  /** The delegated thread, by the host's own thread ID, once the host named it. */
  thread: id.optional(),
  /** The machine it went to, by the name this computer saved for it. */
  machine: z.string().min(1).max(200),
  outcome: watcherOutcomeSchema, told: watcherOutcomeSchema.optional(),
  /** The answer was lost, or a read could not reach the host: read it exactly once the host is back. */
  unread: z.literal(true).optional(),
  /** The host said it holds none for its retry key and is admitting none: it was never made, and is history (#1316 review). */
  absent: z.literal(true).optional(),
  /**
   * The move that landed the caller's branch in the host's project for this start (#1316 part 2), kept while the host has
   * not yet named the delegation that owns it: let go of there once an exact read proves none does, kept while it may.
   */
  moveId: z.uuid().optional(),
  /** The place reserved in the host's check queue for this start (#1316 part 2), kept and let go of as `moveId` is. */
  reservation: z.uuid().optional(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict()
type RemoteRecord = z.infer<typeof recordSchema>
const fileSchema = z.object({ version: z.literal(1), delegations: z.array(recordSchema).max(100_000) }).strict()
type RemoteFile = z.infer<typeof fileSchema>

const SETTLED: ReadonlySet<WatcherOutcome> = new Set(['answered', 'failed', 'stopped', 'unknown'])
const now = (): string => new Date().toISOString()
const capital = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1)
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
/** The settled delegations kept as history, newest first; an open one is never dropped to stay under it. */
const SETTLED_KEPT = DELEGATION_RELAY_RECORDS_MAX * 4
const targetIndex = (hostId: string, delegation: string): string => `${hostId}\n${delegation}`
const threadIndex = (callerId: string, hostId: string, thread: string): string => `${callerId}\n${hostId}\n${thread}`
const retryIndex = (callerId: string, retryKey: string): string => `${callerId}\n${retryKey}`
/** How soon a host still admitting a start whose answer was lost is read again. */
const REREAD_MS = 5_000
/** How many replies wait in memory for their wake-up to be worded. */
const REPLIES_KEPT = 200

/** Model-facing words, said of the machine by the name this computer saved for it (#1316 part 2). Not settled with Zach. */
export const REMOTE_LOST_START = (machine: string): string =>
  `Sotto asked ${machine} to start this delegation, but its answer was lost, so Sotto cannot tell whether it started. Nothing will be sent again. Call read_delegation with this delegation once ${machine} is connected again to see what happened.`
export const REMOTE_LOST_SEND = (machine: string): string =>
  `Sotto asked ${machine} to send this brief, but its answer was lost, so Sotto cannot tell whether it was sent. Nothing will be sent again. Call read_delegation with this delegation once ${machine} is connected again to see what happened.`
const REMOTE_LAST_READ = (machine: string): string =>
  `${capital(machine)} is not connected now, so this is the outcome Sotto last read there. Sotto reads it again when ${machine} is back, and sends this thread a wake-up if it changed. Nothing was sent again.`
/** A thread on a paired host that is not connected now: a second brief to it is refused, and nothing is queued. */
export const REMOTE_SEND_AWAY = (machine: string): string =>
  `${capital(machine)} isn't connected to This computer, so Sotto could not send this brief there. Nothing was sent. Try again when ${machine} is connected.`
/**
 * A start on a paired host that is not connected to This computer now: nothing was started there, and nothing is queued.
 * Not settled with Zach.
 */
export const REMOTE_AWAY = (machine: string): string =>
  `${capital(machine)} isn't connected to This computer, so nothing was started there. Name another machine, or try again when ${machine} is connected.`
const REMOTE_CANCEL_AWAY = (machine: string): string => `${capital(machine)} isn't connected to This computer, so Sotto could not stop this delegation there. Nothing was stopped.`
const REMOTE_LOST_CANCEL = (machine: string): string => `${capital(machine)} did not answer, so Sotto cannot tell whether it was stopped. Call read_delegation with this delegation to see where it stands.`

/**
 * This computer's side of a delegation on a paired host (#1316 part 2, ADR-0105 decisions 1 and 6, Owl `cross-machine-work`):
 * a thread here, or a thread on another host that asked through the desktop relay, delegates to a thread on a host this
 * computer is connected to. The host admits it with its own delegation, under its own rules and the desktop defaults it was
 * sent (#1310), and keeps the delegated thread's record; this computer keeps only identities and outcomes in
 * `delegation-remote.json`, never a brief or a reply, and is the only one the host tells.
 *
 * The host answers a call at once and tells each outcome change after as news; a call that waits for its outcome waits
 * here, so no request stays open on the host's socket. A call whose answer is lost is never sent again (ADR-0058): its
 * delegation reads `unknown` until the host is back. Each time a host connects, every open delegation there, and every one
 * whose answer was lost, is read exactly; what the host's record says then stands, and one it cannot prove stays `unknown`.
 */
export class DesktopRemoteDelegations {
  private readonly store: AtomicJsonStore<RemoteFile>
  /**
   * The record, by this computer's ID in the order made, with an index for each way it is looked up, so a news update,
   * a read or a send touches only the records it names, however long the history (AGENTS.md, #1316 review).
   */
  private readonly byId = new Map<string, RemoteRecord>()
  private readonly byCaller = new Map<string, RemoteRecord[]>()
  /** By host and the host's own delegation ID: what its news names. */
  private readonly byTarget = new Map<string, RemoteRecord>()
  /** The first delegation to each thread, by caller, host and the host's thread ID: where a second brief goes. */
  private readonly byThread = new Map<string, RemoteRecord>()
  private readonly byRetry = new Map<string, RemoteRecord>()
  /**
   * Each host's live records: open, untold, or never matched to the host's own ID. Only these are in
   * `delegation-remote.json`, written whole on a change; the rest are history, appended once to
   * `delegation-remote-settled.jsonl` as each settles, so an outcome update never writes the history out again.
   */
  private readonly live = new Map<string, Set<RemoteRecord>>()
  private readonly dirty = new Set<RemoteRecord>()
  private readonly settledPath: string
  private settledLines = 0
  private settledTail: Promise<void> = Promise.resolve()
  private readonly followed = new WeakSet<object>()
  private source: RemoteDelegationHosts | undefined
  private unfollow: (() => void) | undefined
  private deliver: ((callerId: string, news: DelegationNews, replies: readonly RelayedReply[]) => Promise<void>) | undefined
  /** Answered delegations' replies, by this computer's ID, held in memory only until the wake-up that carries them is worded. */
  private readonly replies = new Map<string, NonNullable<DelegationNewsDetail['reply']>>()
  private readonly waiters = new Map<string, Set<() => void>>()
  private readonly reconciling = new Map<string, Promise<void>>()
  /**
   * Each host's starts this computer asked for that the host has not yet said became a thread or never did, by this
   * computer's delegation ID: from before the host is asked, through a lost answer, until an exact read settles it. The
   * machine's count adds them, so a start it may be making is never missed (the counting rule, Zach, October 23).
   */
  private readonly pending = new Map<string, Set<string>>()
  private closed = false
  /** A host's pending read again, while it is still admitting a start whose answer was lost. */
  private readonly rereads = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(directory: string, private readonly options: {
    /** The name this computer saved for a host, which every sentence about it says. */
    readonly machineName: (hostId: string) => string | undefined
    /** Stable event names only, never a brief, a reply or a thread. */
    readonly log?: (event: 'delegation-remote-answer-lost' | 'delegation-remote-reconciled') => void
    /** Lets go of a move landed in a host's project for a start no thread there owns. Best effort. */
    readonly letGo?: (landed: { readonly hostId: string; readonly projectId: string; readonly moveId: string }) => Promise<void>
  }) {
    this.store = new AtomicJsonStore(join(directory, 'delegation-remote.json'), input => fileSchema.parse(input), (): RemoteFile => ({ version: 1, delegations: [] }))
    this.settledPath = join(directory, 'delegation-remote-settled.jsonl')
  }
  async load(): Promise<void> {
    // History first, newest line of each winning, then the live records, which are newer still.
    const lines = (await readFile(this.settledPath, 'utf8').catch(() => '')).split('\n')
    const settled = new Map<string, RemoteRecord>()
    for (const line of lines) {
      if (!line.trim()) continue
      let parsed: unknown
      try { parsed = JSON.parse(line) } catch { continue }
      const record = recordSchema.safeParse(parsed)
      if (record.success) { settled.delete(record.data.id); settled.set(record.data.id, record.data); this.settledLines++ }
    }
    const file = await this.store.read().catch((): RemoteFile => ({ version: 1, delegations: [] }))
    for (const record of file.delegations) settled.delete(record.id)
    for (const record of [...settled.values(), ...file.delegations].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) this.add(record)
    for (const record of file.delegations) {
      if (record.action === 'start' && record.delegation === undefined && record.unread === true) this.reserve(record)
      // A settled record in the live file, as one from before the history was split off, goes to the history at the next save.
      if (!this.isLive(record)) this.dirty.add(record)
    }
    if (this.settledLines > SETTLED_KEPT * 2) await this.compact().catch(() => undefined)
  }
  /** The starts on `hostId` not yet settled there, which its machine count adds (`placedNotStartedWith`). */
  pendingStarts(hostId: string): readonly string[] { return [...this.pending.get(hostId) ?? []] }
  private reserve(record: RemoteRecord): void {
    const held = this.pending.get(record.hostId) ?? new Set<string>()
    held.add(record.id); this.pending.set(record.hostId, held)
  }
  private release(record: RemoteRecord): void {
    const held = this.pending.get(record.hostId)
    if (held?.delete(record.id) && !held.size) this.pending.delete(record.hostId)
  }
  /** How news reaches the thread that delegated: its hidden wake-up here, or its own machine's through the relay. */
  useDelivery(deliver: (callerId: string, news: DelegationNews, replies: readonly RelayedReply[]) => Promise<void>): void { this.deliver = deliver }
  /** Follows the router: every host connection it takes is heard from, and read again, from then on. */
  useHosts(source: RemoteDelegationHosts): void {
    this.source = source
    this.unfollow?.()
    this.unfollow = source.subscribeConnected(connection => this.follow(connection))
    for (const connection of source.remoteConnections()) this.follow(connection)
  }
  close(): void {
    this.closed = true
    this.unfollow?.(); this.unfollow = undefined
    for (const waiting of this.waiters.values()) for (const wake of waiting) wake()
    this.waiters.clear()
    for (const timer of this.rereads.values()) clearTimeout(timer)
    this.rereads.clear()
  }

  /**
   * Whether `hostId` is connected now and takes a start from a branch this computer lands there, or a check
   * (`delegation-branch-starts`, #1316 part 2). A host from before it, or one not connected, does not.
   */
  takesBranches(hostId: string): boolean { return this.connection(hostId)?.service.supportsDelegationBranchStarts === true }
  /** Whether `delegationId` is one of `callerId`'s delegations on a paired host. */
  holds(callerId: string, delegationId: string): boolean { return this.find(callerId, delegationId) !== undefined }
  /** Whether `threadKey` (`host:<hostId>:<threadId>`) is a thread on a paired host that `callerId` delegated to. */
  holdsThread(callerId: string, threadKey: string): boolean {
    const key = parseHostEntityKey(threadKey)
    return key !== null && this.byThread.has(threadIndex(callerId, key.hostId, key.id))
  }
  /** The delegation `callerId` made under its own `retryKey`, if any. */
  retried(callerId: string, retryKey: string): string | undefined {
    return this.byRetry.get(retryIndex(callerId, retryKey))?.id
  }
  isOpen(delegationId: string): boolean { const record = this.byId.get(delegationId); return record !== undefined && this.open(record) }
  hasOpen(callerId: string): boolean { return (this.byCaller.get(callerId) ?? []).some(record => this.open(record)) }
  /** An answered delegation's reply for the wake-up that tells it, as the host sent it; none once worded or never sent. */
  detail(delegationId: string): DelegationNewsDetail | undefined {
    const reply = this.replies.get(delegationId)
    return reply ? { reply } : undefined
  }
  /** `callerId`'s delegations on paired hosts as `read_delegation` lists them, newest twenty, oldest first. */
  list(callerId: string): { id: string; thread?: string; work: DelegationWork; action: 'start' | 'send'; outcome: WatcherOutcome; machine: string; createdAt: string }[] {
    return (this.byCaller.get(callerId) ?? []).slice(-20).map(record => ({ id: record.id,
      ...(record.thread ? { thread: hostEntityKey(record.hostId, record.thread) } : {}), work: record.work, action: record.action, outcome: record.outcome,
      machine: record.machine, createdAt: record.createdAt }))
  }

  /**
   * Starts a delegated thread on the paired host `placement` names, for `callerId`. The record is saved before the host is
   * asked, so a lost answer still names what was asked; a refusal leaves nothing behind. Throws `RelayUnanswered('away')`
   * when the host is not connected, since then nothing was asked.
   */
  async start(callerId: string, work: DelegationWork, placement: { readonly hostId: string; readonly projectId: string; readonly receipt: WorkerPlacementReceipt }, ask: RemoteAsk): Promise<Record<string, unknown>> {
    const retried = ask.retryKey ? this.byRetry.get(retryIndex(callerId, ask.retryKey)) : undefined
    if (retried) {
      // A call that raced the first one with the same retry key landed a branch of its own, and held a place, which no thread will use.
      if (ask.branch) await this.options.letGo?.({ hostId: placement.hostId, projectId: placement.projectId, moveId: ask.branch.moveId }).catch(() => undefined)
      if (ask.reservation) await this.releasePlace(callerId, placement.hostId, ask.reservation)
      return await this.read(callerId, retried.id)
    }
    return await this.ask({ callerId, hostId: placement.hostId, projectId: placement.projectId, machine: placement.receipt.name, action: 'start', work }, ask,
      answer => ({ ...answer, placement: { ...placement.receipt, awayFromDefault: placement.receipt.awayFromDefault } }))
  }
  /**
   * Holds a place at the end of `hostId`'s check queue for a check `callerId` is about to start there, before its branch
   * or snapshot moves (#1316 part 2), so that queue keeps the order checks were asked in. Answers the reservation, which
   * the start names. Throws `RelayUnanswered('away')` when the host is not connected, and otherwise when it did not hold one.
   */
  async reservePlace(callerId: string, hostId: string, work: DelegationWork): Promise<string> {
    const connection = this.connection(hostId)
    if (!connection || this.closed) throw new RelayUnanswered('away')
    const reservation = randomUUID()
    let answer: unknown
    try { answer = await connection.service.delegationRemoteAsk!({ type: 'reserve', caller: callerId, reservation, work }, DELEGATION_RELAY_READ_MS) }
    catch { await this.releasePlace(callerId, hostId, reservation); throw new RelayUnanswered('lost') }
    if (!isObject(answer) || answer.status !== 'ok') throw new RelayUnanswered('lost')
    return reservation
  }
  /** Lets go of a place reserved on `hostId` that no start there took. Best effort: the host also lets it go when this computer's socket closes. */
  async releasePlace(callerId: string, hostId: string, reservation: string): Promise<void> {
    await this.connection(hostId)?.service.delegationRemoteAsk!({ type: 'release', caller: callerId, reservation }, DELEGATION_RELAY_READ_MS).catch(() => undefined)
  }
  /** Sends another brief to `threadKey`, a thread `callerId` delegated to on a paired host, charged there as any brief is. */
  async send(callerId: string, work: DelegationWork, threadKey: string, ask: RemoteAsk): Promise<Record<string, unknown>> {
    const key = parseHostEntityKey(threadKey)!
    const first = this.byThread.get(threadIndex(callerId, key.hostId, key.id))!
    const retried = ask.retryKey ? this.byRetry.get(retryIndex(callerId, ask.retryKey)) : undefined
    if (retried) return await this.read(callerId, retried.id)
    if (!this.connection(first.hostId)) return { status: 'refused', code: 'PROVIDER_UNAVAILABLE', message: REMOTE_SEND_AWAY(this.name(first)) }
    return await this.ask({ callerId, hostId: first.hostId, projectId: first.projectId, machine: first.machine, action: 'send', work, thread: key.id },
      { ...ask, input: { ...ask.input, thread: key.id } }, answer => answer)
  }

  private async ask(base: Pick<RemoteRecord, 'callerId' | 'hostId' | 'projectId' | 'machine' | 'action' | 'work'> & { readonly thread?: string }, ask: RemoteAsk,
    shape: (answer: Record<string, unknown>) => Record<string, unknown>): Promise<Record<string, unknown>> {
    const connection = this.connection(base.hostId)
    if (!connection || this.closed) throw new RelayUnanswered('away')
    const time = now()
    const record: RemoteRecord = { id: randomUUID(), ...base, ...ask.retryKey ? { callerRetryKey: ask.retryKey } : {}, ...ask.branch ? { moveId: ask.branch.moveId } : {},
      ...ask.reservation ? { reservation: ask.reservation } : {},
      outcome: 'working', createdAt: time, updatedAt: time }
    this.add(record); this.dirty.add(record)
    if (record.action === 'start') this.reserve(record)
    await this.save()
    let answer: unknown
    try {
      // The host answers at once: a call that waits for its outcome waits here, on the news, so nothing stays open there.
      answer = await connection.service.delegationRemoteAsk!({ type: 'delegate', caller: base.callerId, levels: ask.levels, rootUserMessageId: ask.rootUserMessageId,
        ...ask.callerMessageId ? { callerMessageId: ask.callerMessageId } : {}, runtimeMode: ask.runtimeMode, projectId: base.projectId,
        input: { ...ask.input, retry_key: record.id, wait_seconds: 0 }, waitMs: 0, ...ask.branch ? { branch: ask.branch } : {},
        ...ask.reservation ? { reservation: ask.reservation } : {} }, DELEGATION_RELAY_ANSWER_GRACE_MS + DELEGATION_RELAY_READ_MS)
    } catch {
      // The counting rule (Zach, October 23): what cannot be told apart from a start counts as one, and is read once the host is back.
      this.options.log?.('delegation-remote-answer-lost')
      this.update(record, saved => { saved.outcome = 'unknown'; saved.told = 'unknown'; saved.unread = true })
      await this.persist()
      return { status: 'ok', delegation: { id: record.id, work: base.work, action: base.action, outcome: 'unknown',
        note: (base.action === 'start' ? REMOTE_LOST_START : REMOTE_LOST_SEND)(this.name(record)), createdAt: record.createdAt } }
    }
    const delegation = isObject(answer) && isObject(answer.delegation) ? answer.delegation : undefined
    if (!isObject(answer) || answer.status !== 'ok' || !delegation || typeof delegation.id !== 'string') {
      this.forget(record); this.release(record); await this.persist()
      return isObject(answer) ? this.asKnown(record, answer) : { status: 'refused', code: 'PROVIDER_UNAVAILABLE', message: `${capital(this.name(record))} could not start this delegation. Nothing was started.` }
    }
    this.adopt(record, delegation)
    await this.persist()
    // A call that waits for the outcome hears it from the host's news, then reads it exactly, the reply included.
    // News may have moved it already, while the start was being saved: then it is read at once, without waiting.
    if (ask.waitMs > 0) {
      if (!SETTLED.has(record.outcome)) await this.wait(record.id, ask.waitMs)
      if (record.outcome !== 'working') return { ...shape(await this.read(base.callerId, record.id)), ...this.carried(answer) }
    }
    return shape(this.asKnown(record, answer))
  }
  /**
   * What a start's own answer carries besides the delegation, which a read after its wait would not: the role, the warning,
   * and where it started from, the branch and a check's snapshot (#1316 part 2).
   */
  private carried(answer: Record<string, unknown>): Record<string, unknown> {
    return { ...answer.role !== undefined ? { role: answer.role } : {}, ...answer.warning !== undefined ? { warning: answer.warning } : {},
      ...answer.startedFrom !== undefined ? { startedFrom: answer.startedFrom } : {} }
  }

  /** Reads one exactly from its host, or, while the host is away, as Sotto last read it, said as such. */
  async read(callerId: string, delegationId: string): Promise<Record<string, unknown>> {
    const record = this.find(callerId, delegationId)!
    const connection = this.connection(record.hostId)
    try {
      if (!connection) throw new RelayUnanswered('away')
      const answer = await connection.service.delegationRemoteAsk!({ type: 'read', caller: callerId,
        ...record.delegation ? { delegation: record.delegation } : { retryKey: record.id } }, DELEGATION_RELAY_READ_MS)
      if (!isObject(answer)) throw new RelayUnanswered('lost')
      this.fromRead(record, answer)
      await this.persist()
      return this.asKnown(record, answer)
    } catch {
      this.update(record, saved => { saved.unread = true; saved.told = saved.outcome })
      await this.persist()
      return { status: 'ok', delegation: { id: record.id, ...record.thread ? { thread: hostEntityKey(record.hostId, record.thread) } : {}, work: record.work, action: record.action,
        outcome: record.outcome, note: REMOTE_LAST_READ(this.name(record)), createdAt: record.createdAt } }
    }
  }
  /** Cancels one on its host, as `cancel_delegation` there does. While the host is away, nothing is stopped and the call says so. */
  async cancel(callerId: string, delegationId: string): Promise<Record<string, unknown>> {
    const record = this.find(callerId, delegationId)!
    const connection = this.connection(record.hostId)
    if (!connection) return { status: 'refused', code: 'PROVIDER_UNAVAILABLE', message: REMOTE_CANCEL_AWAY(this.name(record)) }
    if (!record.delegation) return { status: 'refused', code: 'PROVIDER_UNAVAILABLE', message: `${REMOTE_LOST_CANCEL(this.name(record))} Nothing was stopped.` }
    const answer = await this.cancelling(record, record.delegation, connection)
    if (!answer) return { status: 'refused', code: 'PROVIDER_UNAVAILABLE', message: REMOTE_LOST_CANCEL(this.name(record)) }
    await this.persist()
    return this.asKnown(record, answer)
  }
  /** Asks its host to cancel one and keeps what it answered, saving nothing; undefined when its answer was lost. Never asked twice. */
  private async cancelling(record: RemoteRecord, delegation: string, connection: RemoteDelegationConnection): Promise<Record<string, unknown> | undefined> {
    try {
      const answer = await connection.service.delegationRemoteAsk!({ type: 'cancel', caller: record.callerId, delegation }, DELEGATION_RELAY_READ_MS)
      if (!isObject(answer)) return undefined
      this.fromRead(record, answer)
      return answer
    } catch { return undefined }
  }

  /**
   * Stops what these threads delegated on paired hosts that is still open, as the user's Stop on them stops what they
   * delegated on this computer (#1316 part 3): each delegated thread once per thread that delegated to it, by its newest open
   * delegation, cancelled on its host as `cancel_delegation` is, which stops it and what it delegated in turn. A stop they
   * asked for is not news to them. Reads only the live records, once for the whole Stop, so it does no more work for a
   * longer history, and saves once. Answers the machines it could not reach, by the names this computer saved for them;
   * nothing is queued for them.
   */
  async stopFor(callerIds: Iterable<string>): Promise<string[]> {
    const callers = new Set(callerIds), open: RemoteRecord[] = []
    if (callers.size) for (const records of this.live.values()) for (const record of records) if (callers.has(record.callerId) && this.open(record)) open.push(record)
    if (!open.length) return []
    open.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const left = new Set<string>(), seen = new Set<string>()
    await Promise.all(open.map(async record => {
      const thread = `${record.callerId}\n${record.hostId}\n${record.thread ?? record.id}`
      if (seen.has(thread)) return
      seen.add(thread)
      const connection = this.connection(record.hostId)
      const answer = record.delegation && connection ? await this.cancelling(record, record.delegation, connection) : undefined
      if (answer?.status !== 'ok') left.add(this.name(record))
    }))
    for (const record of open) if (this.open(record)) this.update(record, saved => { saved.told = 'stopped' })
    await this.persist()
    return [...left]
  }
  /**
   * A host's news of delegations it holds for `caller`: each moved outcome is kept, and told to the thread that delegated,
   * and counts as told only once delivered. News naming one this computer has not matched yet, as when a start's answer
   * was lost, reads that host's open delegations again.
   */
  async news(hostId: string, caller: string, news: DelegationNews, replies: readonly RelayedReply[]): Promise<void> {
    const recordOf = (delegationId: string) => { const record = this.byTarget.get(targetIndex(hostId, delegationId)); return record?.callerId === caller ? record : undefined }
    let unmatched = false
    const items = news.items.flatMap(item => {
      const record = recordOf(item.delegationId)
      if (!record) { unmatched = true; return [] }
      this.update(record, saved => { saved.outcome = item.outcome; delete saved.unread })
      this.waiters.get(record.id)?.forEach(wake => wake())
      const reply = replies.find(saved => saved.delegationId === item.delegationId)
      if (reply && item.outcome === 'answered') this.keepReply(record.id, { messageId: reply.messageId, text: reply.text, truncated: reply.truncated })
      return record.told === item.outcome && item.heldMinutes === undefined ? [] : [{ record, item: { delegationId: record.id, threadId: hostEntityKey(hostId, record.thread ?? record.id),
        outcome: item.outcome, ...item.heldMinutes !== undefined ? { heldMinutes: item.heldMinutes } : {} } }]
    })
    await this.persist()
    await this.tell(caller, items).catch(() => undefined)
    // A start whose answer was lost may have been admitted after an early read found nothing: its news names an ID this
    // computer never learned, so that caller's unresolved delegations are read again by retry key. Nothing is resent.
    if (unmatched) void this.reconcile(hostId, caller)
  }
  /**
   * Reads every open delegation on `hostId` exactly, and every one whose answer was lost (ADR-0058): what the host's record
   * says then is what stands, `unknown` included, and each thread is told what moved. Nothing is sent again. With
   * `unresolvedOf`, that caller's delegations whose ID there was never learned are read again too, `unknown` or not.
   */
  reconcile(hostId: string, unresolvedOf?: string): Promise<void> {
    const running = this.reconciling.get(hostId)
    if (running) return unresolvedOf === undefined ? running : running.then(() => this.reconcile(hostId, unresolvedOf))
    const run = (async () => {
      const open = [...this.live.get(hostId) ?? []].filter(record => (record.unread === true || !SETTLED.has(record.outcome) || record.told !== record.outcome
        || record.callerId === unresolvedOf && record.delegation === undefined))
      const moved = new Map<string, { record: RemoteRecord; item: DelegationNews['items'][number] }[]>()
      for (const record of open) {
        const connection = this.connection(hostId)
        if (!connection || this.closed) break
        try {
          const answer = await connection.service.delegationRemoteAsk!({ type: 'read', caller: record.callerId,
            ...record.delegation ? { delegation: record.delegation } : { retryKey: record.id } }, DELEGATION_RELAY_READ_MS)
          if (!isObject(answer)) continue
          this.fromRead(record, answer, false)
        } catch { continue }
        this.waiters.get(record.id)?.forEach(wake => wake())
        if (record.outcome !== 'working' && record.outcome !== record.told) {
          const items = moved.get(record.callerId) ?? []
          items.push({ record, item: { delegationId: record.id, threadId: hostEntityKey(hostId, record.thread ?? record.id), outcome: record.outcome } })
          moved.set(record.callerId, items)
        }
      }
      await this.persist()
      for (const [callerId, items] of moved) await this.tell(callerId, items).catch(() => undefined)
      if (open.length) this.options.log?.('delegation-remote-reconciled')
    })().finally(() => { this.reconciling.delete(hostId) })
    this.reconciling.set(hostId, run)
    return run
  }

  private follow(connection: RemoteDelegationConnection): void {
    const service = connection.service
    if (connection.kind !== 'remote' || !service.subscribeDelegationRemoteNews) return
    // Every new connection, a reconnect included, reads that host's open delegations again.
    if (service.supportsDelegationRemote && this.live.has(connection.hostId)) void this.reconcile(connection.hostId)
    if (this.followed.has(service)) return
    this.followed.add(service)
    const hostId = connection.hostId
    service.subscribeDelegationRemoteNews((caller, news, replies) => { void this.news(hostId, caller, news, replies).catch(() => undefined) })
  }
  private connection(hostId: string): RemoteDelegationConnection | undefined {
    for (const connection of this.source?.remoteConnections() ?? []) {
      if (connection.hostId === hostId && connection.service.supportsDelegationRemote && connection.service.delegationRemoteAsk) return connection
    }
    return undefined
  }
  private async tell(callerId: string, items: readonly { record: RemoteRecord; item: DelegationNews['items'][number] }[]): Promise<void> {
    if (!items.length || !this.deliver) return
    const replies = items.flatMap(({ record, item }) => {
      const reply = item.outcome === 'answered' ? this.replies.get(record.id) : undefined
      return reply ? [{ delegationId: record.id, ...reply }] : []
    })
    await this.deliver(callerId, { source: 'delegation', items: items.map(({ item }) => item) }, replies)
    for (const { record, item } of items) this.update(record, saved => { saved.told = item.outcome })
    await this.persist()
  }
  /** What a read or cancel answered: the host's outcome, or `unknown` when it holds nothing it can prove. */
  private fromRead(record: RemoteRecord, answer: Record<string, unknown>, tells = true): void {
    const delegation = isObject(answer.delegation) ? answer.delegation : undefined
    const outcome = watcherOutcomeSchema.safeParse(delegation?.outcome)
    if (answer.status === 'ok' && delegation && outcome.success) {
      this.adopt(record, delegation, tells)
      const reply = isObject(delegation.reply) ? delegation.reply : undefined
      if (outcome.data === 'answered' && reply && typeof reply.messageId === 'string' && typeof reply.text === 'string')
        this.keepReply(record.id, { messageId: reply.messageId, text: reply.text, truncated: reply.truncated === true })
    } else if (answer.status === 'refused' && record.delegation === undefined && answer.absent !== true) {
      // Read by retry key, the host holds none yet: its admission may still be running, or it cannot say. Nothing is proved,
      // so the start still counts, stays unread and is read again, never sent again (Sol re-review of #1316 part 2).
      this.update(record, saved => { saved.outcome = 'unknown'; if (tells) saved.told = 'unknown'; saved.unread = true })
      if (answer.admitting === true) this.readAgain(record.hostId, record.callerId)
    } else if (answer.status === 'refused' || answer.status === 'ok' && !outcome.success) {
      // Proved: the host holds nothing under that ID, or none under the retry key and is admitting none. A branch landed
      // there for a start never made is owned by no thread, so it is let go of.
      const landed = record.delegation === undefined && record.moveId !== undefined ? { hostId: record.hostId, projectId: record.projectId, moveId: record.moveId } : undefined
      // So is the place held for it in that host's check queue.
      const place = record.delegation === undefined ? record.reservation : undefined
      this.update(record, saved => { saved.outcome = 'unknown'; if (tells) saved.told = 'unknown'; delete saved.unread; if (saved.delegation === undefined) saved.absent = true; delete saved.moveId; delete saved.reservation })
      this.release(record)
      if (landed) void this.options.letGo?.(landed).catch(() => undefined)
      if (place) void this.releasePlace(record.callerId, record.hostId, place)
    }
  }
  /** Reads a host's unresolved delegations for `callerId` again shortly, while the host is still admitting one. */
  private readAgain(hostId: string, callerId: string): void {
    if (this.rereads.has(hostId) || this.closed) return
    const timer = setTimeout(() => { this.rereads.delete(hostId); void this.reconcile(hostId, callerId) }, REREAD_MS)
    timer.unref?.()
    this.rereads.set(hostId, timer)
  }
  private adopt(record: RemoteRecord, delegation: Record<string, unknown>, tells = true): void {
    const outcome = watcherOutcomeSchema.safeParse(delegation.outcome)
    this.update(record, saved => {
      // Named by the host, the delegation owns the branch landed for it there, and the host lets go of it if its start fails.
      if (typeof delegation.id === 'string' && uuidSchema.safeParse(delegation.id).success) { saved.delegation = delegation.id; delete saved.moveId; delete saved.reservation; this.release(saved) }
      if (typeof delegation.thread === 'string' && id.safeParse(delegation.thread).success) saved.thread = delegation.thread
      saved.outcome = outcome.success ? outcome.data : 'unknown'
      // A call's own result tells the thread; a read after a reconnect does not, so what moved is sent as news.
      if (tells) saved.told = saved.outcome
      delete saved.unread
    })
  }
  /** The host's answer, with the delegation and its thread named as the thread that delegated knows them here. */
  private asKnown(record: RemoteRecord, answer: Record<string, unknown>): Record<string, unknown> {
    if (!isObject(answer.delegation)) return answer
    const delegation = answer.delegation, thread = record.thread ? hostEntityKey(record.hostId, record.thread) : undefined
    const reply = isObject(delegation.reply) && thread ? { ...delegation.reply, thread } : delegation.reply
    return { ...answer, delegation: { ...delegation, id: record.id, ...thread ? { thread } : {}, ...reply !== undefined ? { reply } : {} } }
  }
  private keepReply(delegationId: string, reply: NonNullable<DelegationNewsDetail['reply']>): void {
    this.replies.delete(delegationId); this.replies.set(delegationId, reply)
    if (this.replies.size > REPLIES_KEPT) this.replies.delete(this.replies.keys().next().value!)
  }
  private wait(recordId: string, ms: number): Promise<void> {
    return new Promise(resolveWait => {
      const waiting = this.waiters.get(recordId) ?? new Set<() => void>()
      this.waiters.set(recordId, waiting)
      const wake = () => { clearTimeout(timer); waiting.delete(wake); if (!waiting.size) this.waiters.delete(recordId); resolveWait() }
      const timer = setTimeout(wake, ms)
      timer.unref?.()
      waiting.add(wake)
      if (this.closed) wake()
    })
  }
  private name(record: RemoteRecord): string { return this.options.machineName(record.hostId) ?? record.machine }
  private open(record: RemoteRecord): boolean { return record.unread === true || !SETTLED.has(record.outcome) }
  private find(callerId: string, delegationId: string): RemoteRecord | undefined {
    const record = this.byId.get(delegationId)
    return record?.callerId === callerId ? record : undefined
  }
  private update(record: RemoteRecord, change: (record: RemoteRecord) => void): void {
    change(record); record.updatedAt = now()
    this.indexed(record); this.dirty.add(record)
  }
  /** Whether a record is kept in the live file: open, its outcome untold, or never matched to the host's own ID. */
  private isLive(record: RemoteRecord): boolean { return this.open(record) || record.told !== record.outcome || record.delegation === undefined && record.absent !== true }
  private add(record: RemoteRecord): void {
    this.byId.set(record.id, record)
    const own = this.byCaller.get(record.callerId) ?? []
    own.push(record); this.byCaller.set(record.callerId, own)
    if (record.callerRetryKey) this.byRetry.set(retryIndex(record.callerId, record.callerRetryKey), record)
    this.indexed(record)
  }
  /** Files a record under what it has learned since it was made: the host's ID, its thread, and whether it is live. */
  private indexed(record: RemoteRecord): void {
    if (record.delegation) this.byTarget.set(targetIndex(record.hostId, record.delegation), record)
    if (record.thread) { const key = threadIndex(record.callerId, record.hostId, record.thread); if (!this.byThread.has(key)) this.byThread.set(key, record) }
    const live = this.live.get(record.hostId)
    if (this.isLive(record)) { if (live) live.add(record); else this.live.set(record.hostId, new Set([record])) }
    else if (live?.delete(record) && !live.size) this.live.delete(record.hostId)
  }
  private forget(record: RemoteRecord): void {
    this.byId.delete(record.id); this.dirty.delete(record)
    const own = this.byCaller.get(record.callerId)
    if (own) { const at = own.indexOf(record); if (at !== -1) own.splice(at, 1); if (!own.length) this.byCaller.delete(record.callerId) }
    const drop = (index: Map<string, RemoteRecord>, key: string) => { if (index.get(key) === record) index.delete(key) }
    if (record.delegation) drop(this.byTarget, targetIndex(record.hostId, record.delegation))
    if (record.thread) {
      // A later brief to the same thread that is still kept takes its place, so its caller still holds the thread (#1316 review).
      const key = threadIndex(record.callerId, record.hostId, record.thread)
      if (this.byThread.get(key) === record) {
        const next = own?.find(item => item.hostId === record.hostId && item.thread === record.thread)
        if (next) this.byThread.set(key, next); else this.byThread.delete(key)
      }
    }
    if (record.callerRetryKey) drop(this.byRetry, retryIndex(record.callerId, record.callerRetryKey))
    const live = this.live.get(record.hostId)
    if (live?.delete(record) && !live.size) this.live.delete(record.hostId)
  }
  /**
   * Writes what changed: each record that left the live file, or changed outside it, is appended to the history once, and
   * the live records are written whole. An outcome update so writes the live records and that one line, never the history.
   */
  private async save(): Promise<void> {
    const settled = [...this.dirty].filter(record => this.byId.has(record.id) && !this.isLive(record))
    this.dirty.clear()
    if (settled.length) {
      const appended = this.settledTail.catch(() => undefined).then(async () => {
        await appendFile(this.settledPath, settled.map(record => `${JSON.stringify(record)}\n`).join(''), { encoding: 'utf8', mode: 0o600 })
        this.settledLines += settled.length
        if (this.settledLines > SETTLED_KEPT * 2) await this.compact()
      })
      this.settledTail = appended
      await appended
    }
    await this.store.writeLatest(() => ({ version: 1, delegations: [...this.live.values()].flatMap(records => [...records]) }))
  }
  /**
   * Keeps the newest `SETTLED_KEPT` settled records and forgets older ones, rewriting the history once it has grown to twice
   * that, so each line is written a bounded number of times. A live record is never forgotten.
   */
  private async compact(): Promise<void> {
    const settled = [...this.byId.values()].filter(record => !this.isLive(record))
    for (const record of settled.slice(0, Math.max(0, settled.length - SETTLED_KEPT))) this.forget(record)
    const kept = settled.slice(-SETTLED_KEPT), temporary = `${this.settledPath}.${process.pid}.tmp`
    await writeFile(temporary, kept.map(record => `${JSON.stringify(record)}\n`).join(''), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.settledPath)
    this.settledLines = kept.length
  }
  private persist(): Promise<void> { return this.save().catch(() => undefined) }
}
