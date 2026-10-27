import { join } from 'node:path'
import { z } from 'zod'
import { agentRuntimeModeSchema } from '../../shared/agents'
import { hostEntityKey, parseHostEntityKey } from '../../shared/clientIdentity'
import { DELEGATION_LEVELS_MAX, type DelegationNews } from '../../shared/delegation'
import { delegationRelayAskSchema, type DelegationRelayAsk, type RelayedReply } from '../../shared/delegationRelay'
import type { WatcherRefusal } from '../../shared/watcher'
import type { WorkerMachineSetting } from '../../shared/workerMachine'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import type { DelegationService, RelayedCaller } from './delegation'
import type { PlacementAsk, WorkerPlacement } from './workerPlacement'

/** A host connection as the relay uses it: the asks it pushes, the answers and news it takes. */
export interface RelayHostConnection {
  readonly hostId: string
  readonly kind: 'local' | 'remote'
  readonly service: {
    /** The host's threads as this computer last read them, with each one's `delegatedBy`: what proves a relayed caller's depth. */
    shell?(): { readonly host: { readonly threads: readonly { readonly id: string; readonly delegatedBy?: string | undefined }[] } }
    readonly supportsDelegationRelay?: boolean | undefined
    subscribeDelegationRelay?(listener: (askId: string, ask: DelegationRelayAsk) => void): () => void
    answerDelegationRelay?(askId: string, answer: unknown): Promise<void>
    delegationRelayNews?(threadId: string, news: DelegationNews, replies?: readonly RelayedReply[]): Promise<void>
  }
}
/** The host router as the relay follows it: each connection it takes, and the remote ones connected now. */
export interface RelayHostSource {
  subscribeConnected(listener: (connection: RelayHostConnection) => void): () => void
  remoteConnections(): Iterable<RelayHostConnection>
}
/** Where a relayed start may go: Watcher's machine list and placement, which the desktop's own delegations use too (#1032). */
export interface RelayPlacement {
  machines(): Promise<unknown>
  placement(ask: PlacementAsk, project: { readonly hostId: string; readonly projectId: string }, setting: WorkerMachineSetting): Promise<WorkerPlacement | WatcherRefusal>
  machineName(hostId: string): string | undefined
}

/**
 * The words for a relayed start that would go to a third machine, which this part of the relay does not carry (#1316
 * part 1): This computer only. Not settled with Zach; named here so it changes in one place.
 */
export const RELAY_THIS_COMPUTER_ONLY = (asked: string, from: string): string =>
  `A thread on ${from} can start threads on ${from} or on This computer for now, so it cannot start on ${asked}. Name This computer, or leave out the machine and system to start it on ${from}. Nothing was started.`
const RELAY_BACK_HOME = (from: string): string => `That is ${from}, where this thread runs. Leave out the machine and system to start it there. Nothing was started.`
const NOT_HELD = 'This computer holds no delegation for that ask, so Sotto cannot prove whether it started. Nothing was sent again.'

const id = z.string().min(1).max(512)
const callerSchema = z.object({ id, projectId: id, runtimeMode: agentRuntimeModeSchema, levels: z.number().int().min(0).max(8), rootUserMessageId: id,
  callerMessageId: id.optional() }).strict()
const fileSchema = z.object({ version: z.literal(1), callers: z.array(callerSchema).max(100_000),
  /** Each host's ask, by its `relayId` under the host's thread key, to the delegation it made here. */
  asks: z.array(z.object({ key: id, relayId: z.uuid(), retryKey: z.uuid(), delegation: z.uuid().optional() }).strict()).max(100_000) }).strict()
type RelayFile = z.infer<typeof fileSchema>
const CALLERS_MAX = 1_000, ASKS_MAX = 2_000
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * The desktop's side of the relay (#1316, ADR-0105 decisions 1 and 6, Owl `cross-machine-work`): a thread on a connected
 * host asks, over the connection this desktop keeps to that host, for a delegated thread on another machine. Its machine is
 * placed as this computer's own delegations place theirs, and its start is admitted by this computer's own delegation,
 * as if the asking thread were one of this computer's, under the same rules: the narrower of that thread's own permission
 * and this computer's new-thread default, this computer's worker roles, and two levels of delegation in all. The asking
 * thread is named by the host's own connection, so a host can ask only for its own threads.
 *
 * The delegation's record is this computer's. Its outcome changes go back to the asking host as news, and the host's
 * exact reads, after a dropped connection too, are answered from that record; an ask this computer never recorded reads
 * as one it cannot prove. Nothing is resent (ADR-0058). For now a relayed start goes to This computer only.
 */
export class DesktopDelegationRelay {
  private readonly store: AtomicJsonStore<RelayFile>
  private readonly callers = new Map<string, RelayedCaller>()
  private asks: RelayFile['asks'] = []
  private readonly followed = new WeakSet<object>()
  private source: RelayHostSource | undefined
  private unfollow: (() => void) | undefined
  private delegation: Pick<DelegationService, 'delegate' | 'read' | 'cancel' | 'retriedDelegation' | 'isOpen' | 'hasOpen'> | undefined

  constructor(directory: string, private readonly options: {
    readonly placement: RelayPlacement
    readonly localHostId: () => string | undefined
    readonly log?: (event: 'delegation-relay-answer-failed' | 'delegation-relay-news-failed') => void
  }) {
    this.store = new AtomicJsonStore(join(directory, 'delegation-relay-callers.json'), input => fileSchema.parse(input), (): RelayFile => ({ version: 1, callers: [], asks: [] }))
  }
  async load(): Promise<void> {
    const file = await this.store.read().catch((): RelayFile => ({ version: 1, callers: [], asks: [] }))
    for (const caller of file.callers) this.callers.set(caller.id, caller)
    this.asks = file.asks
  }
  /** The delegation that admits relayed starts: this computer's own. */
  useDelegation(delegation: Pick<DelegationService, 'delegate' | 'read' | 'cancel' | 'retriedDelegation' | 'isOpen' | 'hasOpen'>): void { this.delegation = delegation }
  /** Follows the router: every connection it takes whose host relays through this desktop is heard from then on. */
  useHosts(source: RelayHostSource): void {
    this.source = source
    this.unfollow?.()
    this.unfollow = source.subscribeConnected(connection => this.follow(connection))
    for (const connection of source.remoteConnections()) this.follow(connection)
  }
  close(): void { this.unfollow?.(); this.unfollow = undefined }

  /** What `DelegationService` asks of a relayed caller: the thread as its machine last said it, or none. */
  caller(threadId: string): RelayedCaller | undefined { return this.callers.get(threadId) }
  /** A relayed delegation's news goes back to its host, which tells the asking thread; rejects when it could not go. */
  async tell(threadId: string, news: DelegationNews, replies: readonly RelayedReply[] = []): Promise<void> {
    const key = parseHostEntityKey(threadId)
    const connection = key ? [...this.source?.remoteConnections() ?? []].find(item => item.hostId === key.hostId) : undefined
    if (!key || !connection?.service.supportsDelegationRelay || !connection.service.delegationRelayNews) throw new Error('That machine is not connected.')
    try { await connection.service.delegationRelayNews(key.id, news, replies) } catch (error) { this.options.log?.('delegation-relay-news-failed'); throw error }
  }

  private follow(connection: RelayHostConnection): void {
    const service = connection.service
    if (connection.kind !== 'remote' || this.followed.has(service) || !service.subscribeDelegationRelay) return
    this.followed.add(service)
    const hostId = connection.hostId
    service.subscribeDelegationRelay((askId, ask) => {
      void (async () => {
        let answer: unknown
        try { answer = await this.answer(hostId, ask) }
        catch { answer = { status: 'refused', code: 'PROVIDER_UNAVAILABLE', message: 'This computer could not carry out this delegation call. Call read_delegation to see where it stands.' } }
        try { await service.answerDelegationRelay?.(askId, answer) } catch { this.options.log?.('delegation-relay-answer-failed') }
      })()
    })
  }

  /** One ask from `hostId`, answered as this computer's own delegation would answer the asking thread. */
  async answer(hostId: string, raw: DelegationRelayAsk): Promise<unknown> {
    const ask = delegationRelayAskSchema.parse(raw)
    const delegation = this.delegation
    if (!delegation) return { status: 'refused', code: 'PROVIDER_UNAVAILABLE', message: 'This computer cannot delegate right now. Nothing was started.' }
    if (ask.type === 'machines') return await this.options.placement.machines()
    const key = hostEntityKey(hostId, ask.threadId)
    if (ask.type === 'read') {
      // An ask's delegation is found by the retry key it was admitted under, saved before the start waited, so a lost answer
      // or a restart in the middle of that wait still finds what it made (#1316 review).
      const saved = ask.delegation === undefined ? this.asks.find(item => item.key === key && item.relayId === ask.relayId) : undefined
      const delegationId = ask.delegation ?? saved?.delegation ?? (saved ? delegation.retriedDelegation(key, saved.retryKey) : undefined)
      if (!delegationId || !this.callers.has(key)) return { status: 'refused', code: 'UNKNOWN_DELEGATION', message: NOT_HELD }
      return await delegation.read(key, { delegation: delegationId })
    }
    if (ask.type === 'cancel') {
      if (!this.callers.has(key)) return { status: 'refused', code: 'UNKNOWN_DELEGATION', message: NOT_HELD }
      return await delegation.cancel(key, { delegation: ask.delegation })
    }
    const from = this.options.placement.machineName(hostId) ?? 'that machine'
    let placed: WorkerPlacement | WatcherRefusal
    try { placed = await this.options.placement.placement({ machine: ask.machine, os: ask.os }, { hostId, projectId: ask.projectId }, 'this-computer') }
    catch { return { status: 'refused', code: 'PROVIDER_UNAVAILABLE', message: 'This computer could not read the machines just now. Nothing was started. Try again.' } }
    if ('status' in placed) return { status: 'refused', code: 'MACHINE_UNAVAILABLE', message: placed.message }
    if (placed.hostId === hostId) return { status: 'refused', code: 'MACHINE_UNAVAILABLE', message: RELAY_BACK_HOME(from) }
    if (placed.hostId !== this.options.localHostId()) return { status: 'refused', code: 'MACHINE_UNAVAILABLE', message: RELAY_THIS_COMPUTER_ONLY(placed.receipt.name, from) }
    this.callers.delete(key)
    this.callers.set(key, { id: key, projectId: placed.projectId, runtimeMode: ask.runtimeMode, levels: this.provedLevels(hostId, ask.threadId, ask.levels), rootUserMessageId: ask.rootUserMessageId,
      ...(ask.callerMessageId ? { callerMessageId: ask.callerMessageId } : {}) })
    const retryKey = typeof ask.input.retry_key === 'string' && z.uuid().safeParse(ask.input.retry_key).success ? ask.input.retry_key : ask.relayId
    this.asks.push({ key, relayId: ask.relayId, retryKey })
    // Saved before the start, so a read after a lost answer finds the ask by its retry key, and an ask never recorded reads as unproved.
    await this.save()
    const input = { ...ask.input, retry_key: retryKey }
    const result = await delegation.delegate(key, input, { waitMs: ask.waitMs + 2_000 })
    const made = isObject(result) && isObject(result.delegation) && typeof result.delegation.id === 'string' ? result.delegation.id : undefined
    if (made) { const saved = this.asks.findLast(item => item.key === key && item.relayId === ask.relayId); if (saved) saved.delegation = made; await this.save().catch(() => undefined) }
    return isObject(result) && result.status === 'ok' ? { ...result, placement: { ...placed.receipt, awayFromDefault: false } } : result
  }
  /**
   * How many threads delegated above the asking one, as far as this computer can prove from its own read of that host's
   * threads, and never fewer than the host says. A chain this computer cannot follow to its top counts as the deepest a
   * thread that may still delegate can be, so a host that understates its depth gains no generation (#1316 review).
   */
  private provedLevels(hostId: string, threadId: string, claimed: number): number {
    const deepest = DELEGATION_LEVELS_MAX - 1
    const connection = [...this.source?.remoteConnections() ?? []].find(item => item.hostId === hostId)
    let threads: readonly { readonly id: string; readonly delegatedBy?: string | undefined }[] | undefined
    try { threads = connection?.service.shell?.().host.threads } catch { threads = undefined }
    if (!threads) return deepest
    let at = threads.find(thread => thread.id === threadId), level = 0
    if (!at) return deepest
    while (at.delegatedBy !== undefined) {
      if (++level >= DELEGATION_LEVELS_MAX) return level
      const above: string = at.delegatedBy
      at = threads.find(thread => thread.id === above)
      if (!at) return deepest
    }
    return Math.max(level, claimed)
  }
  /**
   * Keeps the newest callers and asks, dropping only those with nothing open: a caller with an open delegation, and an ask
   * whose delegation is open or not yet known, stay whatever the count, so an open one can always be read and told (#1316 review).
   */
  private trim(): void {
    const delegation = this.delegation
    let excess = this.callers.size - CALLERS_MAX
    if (excess > 0) for (const key of [...this.callers.keys()]) {
      if (excess <= 0) break
      if (delegation?.hasOpen(key) !== false) continue
      this.callers.delete(key); excess--
    }
    excess = this.asks.length - ASKS_MAX
    if (excess > 0) this.asks = this.asks.filter(item => {
      if (excess <= 0) return true
      const made = item.delegation ?? delegation?.retriedDelegation(item.key, item.retryKey)
      const open = !delegation || (made === undefined ? this.callers.has(item.key) && delegation.hasOpen(item.key) : delegation.isOpen(made))
      if (open) return true
      excess--; return false
    })
  }
  private save(): Promise<void> {
    this.trim()
    return this.store.writeLatest(() => ({ version: 1, callers: [...this.callers.values()].map(caller => ({ ...caller })), asks: this.asks }))
  }
}
