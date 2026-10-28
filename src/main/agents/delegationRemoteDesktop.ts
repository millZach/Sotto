import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { AgentRuntimeMode } from '../../shared/agents'
import { hostEntityKey, parseHostEntityKey } from '../../shared/clientIdentity'
import { delegationWorkSchema, type DelegationNews, type DelegationWork } from '../../shared/delegation'
import { DELEGATION_RELAY_ANSWER_GRACE_MS, DELEGATION_RELAY_READ_MS, DELEGATION_RELAY_RECORDS_MAX, type DelegationRemoteAsk, type RelayedReply } from '../../shared/delegationRelay'
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
}

const id = z.string().min(1).max(512)
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
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict()
type RemoteRecord = z.infer<typeof recordSchema>
const fileSchema = z.object({ version: z.literal(1), delegations: z.array(recordSchema).max(100_000) }).strict()
type RemoteFile = z.infer<typeof fileSchema>

const SETTLED: ReadonlySet<WatcherOutcome> = new Set(['answered', 'failed', 'stopped', 'unknown'])
const now = (): string => new Date().toISOString()
const capital = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1)
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
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
  private records: RemoteRecord[] = []
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

  constructor(directory: string, private readonly options: {
    /** The name this computer saved for a host, which every sentence about it says. */
    readonly machineName: (hostId: string) => string | undefined
    /** Stable event names only, never a brief, a reply or a thread. */
    readonly log?: (event: 'delegation-remote-answer-lost' | 'delegation-remote-reconciled') => void
  }) {
    this.store = new AtomicJsonStore(join(directory, 'delegation-remote.json'), input => fileSchema.parse(input), (): RemoteFile => ({ version: 1, delegations: [] }))
  }
  async load(): Promise<void> {
    const file = await this.store.read().catch((): RemoteFile => ({ version: 1, delegations: [] }))
    this.records = file.delegations
    for (const record of this.records) if (record.action === 'start' && record.delegation === undefined && record.unread === true) this.reserve(record)
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
  }

  /** Whether `delegationId` is one of `callerId`'s delegations on a paired host. */
  holds(callerId: string, delegationId: string): boolean { return this.find(callerId, delegationId) !== undefined }
  /** Whether `threadKey` (`host:<hostId>:<threadId>`) is a thread on a paired host that `callerId` delegated to. */
  holdsThread(callerId: string, threadKey: string): boolean {
    const key = parseHostEntityKey(threadKey)
    return key !== null && this.records.some(record => record.callerId === callerId && record.hostId === key.hostId && record.thread === key.id)
  }
  /** The delegation `callerId` made under its own `retryKey`, if any. */
  retried(callerId: string, retryKey: string): string | undefined {
    return this.records.findLast(record => record.callerId === callerId && record.callerRetryKey === retryKey)?.id
  }
  isOpen(delegationId: string): boolean { const record = this.records.find(item => item.id === delegationId); return record !== undefined && this.open(record) }
  hasOpen(callerId: string): boolean { return this.records.some(record => record.callerId === callerId && this.open(record)) }
  /** An answered delegation's reply for the wake-up that tells it, as the host sent it; none once worded or never sent. */
  detail(delegationId: string): DelegationNewsDetail | undefined {
    const reply = this.replies.get(delegationId)
    return reply ? { reply } : undefined
  }
  /** `callerId`'s delegations on paired hosts as `read_delegation` lists them, newest twenty, oldest first. */
  list(callerId: string): { id: string; thread?: string; work: DelegationWork; action: 'start' | 'send'; outcome: WatcherOutcome; machine: string; createdAt: string }[] {
    return this.records.filter(record => record.callerId === callerId).slice(-20).map(record => ({ id: record.id,
      ...(record.thread ? { thread: hostEntityKey(record.hostId, record.thread) } : {}), work: record.work, action: record.action, outcome: record.outcome,
      machine: record.machine, createdAt: record.createdAt }))
  }

  /**
   * Starts a delegated thread on the paired host `placement` names, for `callerId`. The record is saved before the host is
   * asked, so a lost answer still names what was asked; a refusal leaves nothing behind. Throws `RelayUnanswered('away')`
   * when the host is not connected, since then nothing was asked.
   */
  async start(callerId: string, work: DelegationWork, placement: { readonly hostId: string; readonly projectId: string; readonly receipt: WorkerPlacementReceipt }, ask: RemoteAsk): Promise<Record<string, unknown>> {
    const retried = ask.retryKey ? this.records.findLast(record => record.callerId === callerId && record.callerRetryKey === ask.retryKey) : undefined
    if (retried) return await this.read(callerId, retried.id)
    return await this.ask({ callerId, hostId: placement.hostId, projectId: placement.projectId, machine: placement.receipt.name, action: 'start', work }, ask,
      answer => ({ ...answer, placement: { ...placement.receipt, awayFromDefault: placement.receipt.awayFromDefault } }))
  }
  /** Sends another brief to `threadKey`, a thread `callerId` delegated to on a paired host, charged there as any brief is. */
  async send(callerId: string, work: DelegationWork, threadKey: string, ask: RemoteAsk): Promise<Record<string, unknown>> {
    const key = parseHostEntityKey(threadKey)!
    const first = this.records.find(record => record.callerId === callerId && record.hostId === key.hostId && record.thread === key.id)!
    const retried = ask.retryKey ? this.records.findLast(record => record.callerId === callerId && record.callerRetryKey === ask.retryKey) : undefined
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
    const record: RemoteRecord = { id: randomUUID(), ...base, ...ask.retryKey ? { callerRetryKey: ask.retryKey } : {}, outcome: 'working', createdAt: time, updatedAt: time }
    this.records.push(record)
    if (record.action === 'start') this.reserve(record)
    await this.save()
    let answer: unknown
    try {
      // The host answers at once: a call that waits for its outcome waits here, on the news, so nothing stays open there.
      answer = await connection.service.delegationRemoteAsk!({ type: 'delegate', caller: base.callerId, levels: ask.levels, rootUserMessageId: ask.rootUserMessageId,
        ...ask.callerMessageId ? { callerMessageId: ask.callerMessageId } : {}, runtimeMode: ask.runtimeMode, projectId: base.projectId,
        input: { ...ask.input, retry_key: record.id, wait_seconds: 0 }, waitMs: 0 }, DELEGATION_RELAY_ANSWER_GRACE_MS + DELEGATION_RELAY_READ_MS)
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
      this.records = this.records.filter(item => item !== record); this.release(record); await this.persist()
      return isObject(answer) ? this.asKnown(record, answer) : { status: 'refused', code: 'PROVIDER_UNAVAILABLE', message: `${capital(this.name(record))} could not start this delegation. Nothing was started.` }
    }
    this.adopt(record, delegation)
    await this.persist()
    // A call that waits for the outcome hears it from the host's news, then reads it exactly, the reply included.
    if (!SETTLED.has(record.outcome) && ask.waitMs > 0) {
      await this.wait(record.id, ask.waitMs)
      if (record.outcome !== 'working') return { ...shape(await this.read(base.callerId, record.id)), ...this.carried(answer) }
    }
    return shape(this.asKnown(record, answer))
  }
  /** What a start's own answer carries besides the delegation, which a read after its wait would not: the role and the warning. */
  private carried(answer: Record<string, unknown>): Record<string, unknown> {
    return { ...answer.role !== undefined ? { role: answer.role } : {}, ...answer.warning !== undefined ? { warning: answer.warning } : {} }
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
    try {
      const answer = await connection.service.delegationRemoteAsk!({ type: 'cancel', caller: callerId, delegation: record.delegation }, DELEGATION_RELAY_READ_MS)
      if (!isObject(answer)) throw new RelayUnanswered('lost')
      this.fromRead(record, answer)
      await this.persist()
      return this.asKnown(record, answer)
    } catch { return { status: 'refused', code: 'PROVIDER_UNAVAILABLE', message: REMOTE_LOST_CANCEL(this.name(record)) } }
  }

  /**
   * A host's news of delegations it holds for `caller`: each moved outcome is kept, and told to the thread that delegated,
   * and counts as told only once delivered. News naming one this computer has not matched yet, as when a start's answer
   * was lost, reads that host's open delegations again.
   */
  async news(hostId: string, caller: string, news: DelegationNews, replies: readonly RelayedReply[]): Promise<void> {
    const recordOf = (delegationId: string) => this.records.find(saved => saved.hostId === hostId && saved.callerId === caller && saved.delegation === delegationId)
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
      const open = this.records.filter(record => record.hostId === hostId && (record.unread === true || !SETTLED.has(record.outcome) || record.told !== record.outcome
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
    if (service.supportsDelegationRemote && this.records.some(record => record.hostId === connection.hostId)) void this.reconcile(connection.hostId)
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
    for (const { record, item } of items) record.told = item.outcome
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
    } else if (answer.status === 'refused' || answer.status === 'ok' && !outcome.success) {
      this.update(record, saved => { saved.outcome = 'unknown'; if (tells) saved.told = 'unknown'; delete saved.unread })
      this.release(record)
    }
  }
  private adopt(record: RemoteRecord, delegation: Record<string, unknown>, tells = true): void {
    const outcome = watcherOutcomeSchema.safeParse(delegation.outcome)
    this.update(record, saved => {
      if (typeof delegation.id === 'string' && z.uuid().safeParse(delegation.id).success) { saved.delegation = delegation.id; this.release(saved) }
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
    return this.records.find(record => record.callerId === callerId && record.id === delegationId)
  }
  private update(record: RemoteRecord, change: (record: RemoteRecord) => void): void { change(record); record.updatedAt = now() }
  /** Keeps the newest, dropping only settled ones, oldest first: one still open, or whose read was lost, is never forgotten. */
  private trim(): void {
    let excess = this.records.length - DELEGATION_RELAY_RECORDS_MAX * 4
    if (excess <= 0) return
    this.records = this.records.filter(record => excess <= 0 || this.open(record) || excess-- <= 0)
  }
  private save(): Promise<void> {
    this.trim()
    return this.store.writeLatest(() => ({ version: 1, delegations: this.records }))
  }
  private persist(): Promise<void> { return this.save().catch(() => undefined) }
}
