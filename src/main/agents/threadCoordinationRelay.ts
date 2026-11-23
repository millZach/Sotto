import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { AgentRuntimeMode, AgentState } from '../../shared/agents'
import { RUNTIME_MODE_ORDER } from '../../shared/newThreadDefaults'
import { COORDINATION_LIST_LIMIT_MAX, isEligibleParentThread, type CoordinationExchangeView, type CoordinationNews } from '../../shared/threadCoordination'
import { COORDINATION_RELAY_READ_TIMEOUT_MS, COORDINATION_RELAY_SEND_TIMEOUT_MS, coordinationRelayAskSchema, coordinationRemoteAskSchema,
  type CoordinationRelayAsk, type CoordinationRelayedReply, type CoordinationRemoteAsk, type CoordinationRemoteCaller } from '../../shared/threadCoordinationRelay'
import type { CoordinationRelayAdapter, CoordinationRemoteOutcomePush, ThreadCoordinationService } from './threadCoordination'

const HOST_UNAVAILABLE_NO_DESKTOP = 'No desktop with parent-thread coordination enabled is connected right now, so Sotto cannot reach other machines. Nothing was sent.'
const HOST_UNAVAILABLE_TARGET = 'That paired machine is not connected or does not have parent-thread coordination enabled. Nothing was sent.'
const HOST_UNAVAILABLE_TIMEOUT = 'Sotto did not hear back from the other machine in time. Call read_exchange before trying again.'
const FORGOTTEN_DESKTOP = 'This machine no longer takes parent-thread coordination requests from that desktop. Nothing was sent.'
const NOT_ADMITTED_REMOTE = 'That remote thread is not an eligible parent thread for coordination. Nothing was sent.'

/** Narrower of two runtime modes under `RUNTIME_MODE_ORDER`; undefined if either cannot be compared. */
function narrowerMode(a: AgentRuntimeMode | undefined, b: AgentRuntimeMode | undefined): AgentRuntimeMode | undefined {
  if (a === undefined || b === undefined) return undefined
  const rankA = RUNTIME_MODE_ORDER.indexOf(a)
  const rankB = RUNTIME_MODE_ORDER.indexOf(b)
  if (rankA < 0 || rankB < 0) return undefined
  return rankA <= rankB ? a : b
}

/** A recorded desktop connected to a headless host whose hello accepted `thread-coordination-relay`. */
export interface CoordinationRelayDesktop {
  readonly clientId: string
  /** Pushes an outgoing relay ask to the desktop; returns false if the socket is closed or unauthenticated. */
  pushAsk(askId: string, ask: CoordinationRelayAsk): boolean
  /** Pushes remote outcome news back to the desktop that originated an exchange; returns false if closed. */
  pushRemoteNews(payload: {
    readonly callerThreadId: string
    readonly callerHostId: string
    readonly news: CoordinationNews
    readonly replies?: readonly CoordinationRelayedReply[] | undefined
    readonly exchange?: CoordinationExchangeView | undefined
  }): boolean
}

export interface HostCoordinationRelayOptions {
  /** Whether a client is still recorded as a desktop (checked on every ask and every dispatch). */
  readonly recorded?: (clientId: string) => boolean
  /** Whether a desktop has a `remote-answer` grant (desktops without one are clamped to `approval-required`). */
  readonly mayAnswer?: (clientId: string) => boolean
  readonly localMachineName?: () => string
}

/**
 * Headless host side of `thread-coordination-relay` (ADR-0216, Slice 3).
 * Runs under plain Node with zero Electron imports: forwards outgoing cross-machine asks to a connected desktop,
 * enforces recorded-desktop and `mayAnswer` authority on incoming asks from a desktop, and routes outcome news both ways.
 */
export class HostCoordinationRelay implements CoordinationRelayAdapter {
  private readonly desktops: CoordinationRelayDesktop[] = []
  private readonly pending = new Map<string, {
    readonly desktop: CoordinationRelayDesktop
    readonly resolve: (result: Record<string, unknown>) => void
    readonly timer: NodeJS.Timeout
  }>()
  private service: ThreadCoordinationService | undefined
  private closed = false

  constructor(private readonly options: HostCoordinationRelayOptions = {}) {}

  useService(service: ThreadCoordinationService): void {
    this.service = service
    service.useRelay(this)
  }

  localMachineName(): string {
    return this.options.localMachineName?.() ?? (hostname().trim().slice(0, 64) || 'this machine')
  }

  remoteCallerAuthority(clientId: string): { readonly recorded: boolean; readonly mayAnswer: boolean } {
    const recorded = this.options.recorded ? this.options.recorded(clientId) : true
    const mayAnswer = this.options.mayAnswer ? this.options.mayAnswer(clientId) : true
    return { recorded, mayAnswer }
  }

  desktopConnected(desktop: CoordinationRelayDesktop): void {
    const at = this.desktops.indexOf(desktop)
    if (at !== -1) this.desktops.splice(at, 1)
    this.desktops.push(desktop)
    // Defer replay until after the hello response is written on the socket (L8).
    setImmediate(() => {
      if (this.closed || !this.desktops.includes(desktop)) return
      this.service?.replayUntoldRemoteNews({ clientId: desktop.clientId })
    })
  }

  desktopGone(desktop: CoordinationRelayDesktop): void {
    const at = this.desktops.indexOf(desktop)
    if (at !== -1) this.desktops.splice(at, 1)
    for (const [askId, entry] of [...this.pending]) {
      if (entry.desktop !== desktop) continue
      clearTimeout(entry.timer)
      this.pending.delete(askId)
      // The ask was already pushed to the desktop before it dropped, so delivery is unconfirmed (L1).
      entry.resolve({ status: 'refused', code: 'HOST_UNAVAILABLE', uncertain: true, message: HOST_UNAVAILABLE_TIMEOUT })
    }
  }

  /** Called when the desktop answers a pushed `coordination-relay-ask`. */
  answered(desktop: Pick<CoordinationRelayDesktop, 'clientId'>, askId: string, result: unknown): boolean {
    const entry = this.pending.get(askId)
    if (!entry || entry.desktop.clientId !== desktop.clientId) return false
    this.pending.delete(askId)
    clearTimeout(entry.timer)
    const answer = result !== null && typeof result === 'object' && !Array.isArray(result)
      ? result as Record<string, unknown>
      : { status: 'refused', code: 'HOST_UNAVAILABLE', uncertain: true, message: HOST_UNAVAILABLE_TIMEOUT }
    entry.resolve(answer)
    return true
  }

  /** Outgoing ask from a thread on this host -> pushed to newest connected recorded desktop. */
  async ask(ask: CoordinationRelayAsk, timeoutMs: number): Promise<Record<string, unknown>> {
    if (this.closed) return { status: 'refused', code: 'STOPPING', message: 'Sotto is closing. Nothing was sent.' }
    const desktop = [...this.desktops].reverse().find(item => !this.options.recorded || this.options.recorded(item.clientId))
    if (!desktop) return { status: 'refused', code: 'HOST_UNAVAILABLE', message: HOST_UNAVAILABLE_NO_DESKTOP }
    return await new Promise<Record<string, unknown>>(resolve => {
      const askId = randomUUID()
      const timer = setTimeout(() => {
        this.pending.delete(askId)
        resolve({ status: 'refused', code: 'HOST_UNAVAILABLE', uncertain: true, message: HOST_UNAVAILABLE_TIMEOUT })
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(askId, { desktop, resolve, timer })
      if (!desktop.pushAsk(askId, ask)) {
        clearTimeout(timer)
        this.pending.delete(askId)
        resolve({ status: 'refused', code: 'HOST_UNAVAILABLE', message: HOST_UNAVAILABLE_NO_DESKTOP })
      }
    })
  }

  /** Incoming ask from a connected recorded desktop (`coordination-remote-ask`), served by this host's local service. */
  async handleRemoteAsk(clientId: string, raw: CoordinationRemoteAsk): Promise<Record<string, unknown>> {
    const service = this.service
    if (!service || this.closed) {
      return { status: 'refused', code: 'HOST_UNAVAILABLE', message: 'Parent-thread coordination is unavailable on this machine. Nothing was sent.' }
    }
    const authority = this.remoteCallerAuthority(clientId)
    if (!authority.recorded) {
      return { status: 'refused', code: 'NOT_ADMITTED', message: FORGOTTEN_DESKTOP }
    }
    const parsed = coordinationRemoteAskSchema.safeParse(raw)
    if (!parsed.success) {
      return { status: 'refused', code: 'INVALID_INPUT', message: parsed.error.issues[0]?.message ?? 'Invalid remote coordination ask.' }
    }
    const ask = parsed.data
    // For read-only `list_threads(hostId:"all")` asking about this host's own threads from a thread on this same host,
    // evaluate `canMessage` against this host's own local thread runtimeMode rather than clamping by the desktop's remote-answer grant (N6).
    const localHostId = service.localHostId()
    if (ask.type === 'list' && localHostId !== undefined && ask.caller.hostId === localHostId) {
      const localMode = service.localThreadRuntimeMode(ask.caller.threadId)
      const { runtimeMode: _ignored, ...rest } = ask.caller
      void _ignored
      const localCaller: CoordinationRemoteCaller = { ...rest, ...(localMode ? { runtimeMode: localMode } : {}) }
      return await service.listThreadsForRemote(localCaller, ask.input)
    }
    // Clamp remote caller's permission mode when this desktop does not hold a `remote-answer` grant (ADR-0004).
    const caller: CoordinationRemoteCaller = authority.mayAnswer
      ? ask.caller
      : { ...ask.caller, runtimeMode: 'approval-required' }
    if (ask.type === 'list') {
      return await service.listThreadsForRemote(caller, ask.input)
    }
    if (ask.type === 'read') {
      return await service.readThreadForRemote(caller, ask.input)
    }
    if (ask.type === 'send') {
      return await service.sendToThreadForRemote(clientId, caller, ask.exchangeId, ask.input)
    }
    return await service.readExchangeForRemote(clientId, caller.hostId, caller.threadId, ask.exchangeId)
  }

  /** Incoming outcome news pushed by the desktop for an exchange sent from a thread on this host (`coordination-relay-news`). */
  async receiveRelayNews(
    threadId: string,
    news: CoordinationNews,
    replies?: readonly CoordinationRelayedReply[],
    exchange?: CoordinationExchangeView,
  ): Promise<void> {
    if (!this.service || this.closed) return
    await this.service.applyRelayedNews(threadId, news, replies, exchange)
  }

  /** Outgoing outcome news for an exchange that targeted a thread on this host -> pushed back to the asking desktop. */
  async notifyRemoteOutcome(payload: CoordinationRemoteOutcomePush): Promise<void> {
    const desktop = this.desktops.findLast(item => item.clientId === payload.clientId)
    if (!desktop) throw new Error('The desktop that asked for this coordination exchange is not connected.')
    let pushed: boolean
    try {
      pushed = desktop.pushRemoteNews({
        callerThreadId: payload.callerThreadId,
        callerHostId: payload.callerHostId,
        news: payload.news,
        ...(payload.replies?.length ? { replies: payload.replies } : {}),
        ...(payload.exchange ? { exchange: payload.exchange } : {}),
      })
    } catch {
      pushed = false
    }
    if (!pushed) throw new Error('Sotto could not push coordination news back to the desktop.')
  }

  close(): void {
    this.closed = true
    for (const [askId, entry] of [...this.pending]) {
      clearTimeout(entry.timer)
      this.pending.delete(askId)
      entry.resolve({ status: 'refused', code: 'STOPPING', message: 'Sotto is closing. Nothing was sent.' })
    }
    this.desktops.length = 0
  }
}

/** Remote host connection surface consumed by `DesktopCoordinationRelay`. */
export interface CoordinationRelayConnection {
  readonly kind: string
  readonly hostId: string | undefined
  readonly name: string
  readonly available?: () => boolean
  readonly service: {
    readonly supportsCoordinationRelay?: boolean
    view?(): AgentState
    subscribe?(listener: (state: AgentState) => void): () => void
    coordinationRemoteAsk?(ask: CoordinationRemoteAsk, timeoutMs: number): Promise<unknown>
    subscribeCoordinationRelay?(listener: (askId: string, ask: CoordinationRelayAsk) => void): () => void
    answerCoordinationRelay?(askId: string, answer: unknown): Promise<void>
    coordinationRelayNews?(threadId: string, news: CoordinationNews, replies?: readonly CoordinationRelayedReply[], exchange?: CoordinationExchangeView): Promise<void>
    subscribeCoordinationRemoteNews?(listener: (payload: {
      readonly callerThreadId: string
      readonly callerHostId: string
      readonly news: CoordinationNews
      readonly replies?: readonly CoordinationRelayedReply[] | undefined
      readonly exchange?: CoordinationExchangeView | undefined
    }) => void): () => void
  }
}

export interface CoordinationRelayHostSource {
  subscribeConnected(listener: (connection: CoordinationRelayConnection) => void): () => void
  subscribeRemoved?(listener: (hostId: string) => void): () => void
  remoteConnections(): Iterable<CoordinationRelayConnection>
}

interface PendingHostNewsEntry {
  readonly callerThreadId: string
  readonly callerHostId: string
  readonly news: CoordinationNews
  readonly replies?: readonly CoordinationRelayedReply[] | undefined
  readonly exchange?: CoordinationExchangeView | undefined
}

const LOCAL_DESKTOP_CLIENT_ID = 'local-desktop'
const PENDING_HOST_NEWS_MAX = 200
const LIST_ALL_PAGES_MAX = 50
const PENDING_HOST_NEWS_RETRY_MS = 1_000
const PENDING_HOST_NEWS_RETRY_MAX_MS = 30_000

/**
 * Desktop-side relay for cross-machine parent-to-parent coordination (ADR-0216, Slice 3).
 * Connects the local desktop `ThreadCoordinationService` to all paired hosts accepting `thread-coordination-relay`:
 * routes desktop <-> host and host <-> host calls, verifies host callers from authenticated socket connections and snapshots,
 * aggregates `list_threads(hostId:"all")` across machines, and forwards outcome news back to the originating host.
 */
export class DesktopCoordinationRelay implements CoordinationRelayAdapter {
  private readonly followed = new WeakSet<object>()
  private readonly hostStops = new Map<string, () => void>()
  /** Outcome news from target hosts waiting for an offline origin host to reconnect (L8; bounded per host, deduped by exchangeId). */
  private readonly pendingHostNews = new Map<string, Map<string, PendingHostNewsEntry>>()
  private readonly pendingHostNewsTimers = new Map<string, NodeJS.Timeout>()
  private readonly pendingHostNewsAttempts = new Map<string, number>()
  private readonly flushingHosts = new Set<string>()
  private hosts: CoordinationRelayHostSource | undefined
  private unfollowHosts: (() => void) | undefined
  private unfollowRemoved: (() => void) | undefined
  private closed = false

  constructor(private readonly options: {
    readonly service: ThreadCoordinationService
    readonly localHostId: () => string | undefined
    readonly localMachineName?: () => string
  }) {
    options.service.useRelay(this)
  }

  localMachineName(): string {
    return this.options.localMachineName?.() ?? (hostname().trim().slice(0, 64) || 'Desktop')
  }

  remoteCallerAuthority(): { readonly recorded: boolean; readonly mayAnswer: boolean } {
    return { recorded: true, mayAnswer: true }
  }

  useHosts(source: CoordinationRelayHostSource): void {
    this.unfollowHosts?.()
    this.unfollowRemoved?.()
    this.hosts = source
    this.unfollowHosts = source.subscribeConnected(connection => this.follow(connection))
    this.unfollowRemoved = source.subscribeRemoved?.(hostId => {
      this.hostStops.get(hostId)?.()
      this.hostStops.delete(hostId)
      this.clearPendingHostNews(hostId)
    })
    for (const connection of source.remoteConnections()) this.follow(connection)
  }

  close(): void {
    this.closed = true
    this.unfollowHosts?.()
    this.unfollowHosts = undefined
    this.unfollowRemoved?.()
    this.unfollowRemoved = undefined
    for (const stop of this.hostStops.values()) stop()
    this.hostStops.clear()
    for (const timer of this.pendingHostNewsTimers.values()) clearTimeout(timer)
    this.pendingHostNewsTimers.clear()
    this.pendingHostNews.clear()
    this.pendingHostNewsAttempts.clear()
  }

  private remoteConnection(hostId: string): CoordinationRelayConnection | undefined {
    if (!this.hosts) return undefined
    for (const connection of this.hosts.remoteConnections()) {
      if (connection.kind === 'remote' && connection.hostId === hostId) return connection
    }
    return undefined
  }

  private machineNameOf(hostId: string, fallback: string): string {
    return this.remoteConnection(hostId)?.name ?? fallback
  }

  private connectedRemoteMachines(): CoordinationRelayConnection[] {
    if (!this.hosts) return []
    const list: CoordinationRelayConnection[] = []
    for (const connection of this.hosts.remoteConnections()) {
      if (connection.kind === 'remote' && connection.hostId) list.push(connection)
    }
    return list
  }

  /** Outgoing ask from the local desktop's own `ThreadCoordinationService`, or forwarded from a paired host. */
  async ask(ask: CoordinationRelayAsk, timeoutMs: number): Promise<Record<string, unknown>> {
    if (this.closed) return { status: 'refused', code: 'STOPPING', message: 'Sotto is closing. Nothing was sent.' }
    const localId = this.options.localHostId()
    if (ask.type === 'list' && ask.targetHostId === 'all') {
      return await this.aggregateListAcrossHosts(ask.caller, ask.input)
    }
    if (localId && ask.targetHostId === localId) {
      return await this.dispatchLocal(ask)
    }
    const target = this.remoteConnection(ask.targetHostId)
    if (!target || target.available?.() === false || target.service.supportsCoordinationRelay !== true || !target.service.coordinationRemoteAsk) {
      return { status: 'refused', code: 'HOST_UNAVAILABLE', message: HOST_UNAVAILABLE_TARGET }
    }
    const remoteAsk = toRemoteAsk(ask)
    try {
      const answer = await target.service.coordinationRemoteAsk(remoteAsk, timeoutMs)
      if (answer !== null && typeof answer === 'object' && !Array.isArray(answer)) {
        return decorateRemoteAnswer(answer as Record<string, unknown>, target.hostId!, target.name)
      }
      // Request was already sent to target before receiving an unreadable response, so delivery is unconfirmed (L1).
      return { status: 'refused', code: 'HOST_UNAVAILABLE', uncertain: true, message: HOST_UNAVAILABLE_TIMEOUT }
    } catch {
      // Transport failed or timed out AFTER forwarding to target, so delivery is unconfirmed (L1).
      return { status: 'refused', code: 'HOST_UNAVAILABLE', uncertain: true, message: HOST_UNAVAILABLE_TIMEOUT }
    }
  }

  /** Outgoing outcome news from the desktop's local service when a paired host sent to a desktop parent thread. */
  async notifyRemoteOutcome(payload: CoordinationRemoteOutcomePush): Promise<void> {
    const target = this.remoteConnection(payload.callerHostId)
    if (!target || target.available?.() === false || target.service.supportsCoordinationRelay !== true || !target.service.coordinationRelayNews) {
      throw new Error('The paired host that sent this coordination message is not connected.')
    }
    const localId = this.options.localHostId()
    const decoratedExchange: CoordinationExchangeView | undefined = payload.exchange
      ? { ...payload.exchange, ...(localId ? { peerHostId: localId } : {}), peerMachine: this.localMachineName() }
      : undefined
    await target.service.coordinationRelayNews(payload.callerThreadId, payload.news, payload.replies, decoratedExchange)
  }

  private async dispatchLocal(ask: CoordinationRelayAsk): Promise<Record<string, unknown>> {
    const localId = this.options.localHostId()
    const machine = this.localMachineName()
    let answer: Record<string, unknown>
    if (ask.type === 'list') {
      answer = await this.options.service.listThreadsForRemote(ask.caller, ask.input)
    } else if (ask.type === 'read') {
      answer = await this.options.service.readThreadForRemote(ask.caller, ask.input)
    } else if (ask.type === 'send') {
      answer = await this.options.service.sendToThreadForRemote(LOCAL_DESKTOP_CLIENT_ID, ask.caller, ask.exchangeId, ask.input)
    } else {
      answer = await this.options.service.readExchangeForRemote(LOCAL_DESKTOP_CLIENT_ID, ask.caller.hostId, ask.caller.threadId, ask.exchangeId)
    }
    return localId ? decorateRemoteAnswer(answer, localId, machine) : answer
  }

  private async fetchHostPages(
    need: number,
    fetchPage: (cursor: number, limit: number) => Promise<unknown>,
  ): Promise<{ readonly ok: true; readonly threads: Record<string, unknown>[]; readonly total: number } | { readonly ok: false }> {
    const rows: Record<string, unknown>[] = []
    let pageCursor = 0
    let reportedTotal: number | undefined
    for (let pageIndex = 0; pageIndex < LIST_ALL_PAGES_MAX && rows.length < need; pageIndex++) {
      const pageLimit = Math.min(COORDINATION_LIST_LIMIT_MAX, Math.max(1, need - rows.length))
      let res: unknown
      try {
        res = await fetchPage(pageCursor, pageLimit)
      } catch {
        return pageIndex === 0 ? { ok: false } : { ok: true, threads: rows, total: reportedTotal ?? rows.length }
      }
      if (!res || typeof res !== 'object' || (res as Record<string, unknown>).status !== 'ok' || !Array.isArray((res as Record<string, unknown>).threads)) {
        return pageIndex === 0 ? { ok: false } : { ok: true, threads: rows, total: reportedTotal ?? rows.length }
      }
      const record = res as { threads: unknown[]; total?: unknown; nextCursor?: unknown }
      if (reportedTotal === undefined && typeof record.total === 'number' && Number.isFinite(record.total)) {
        reportedTotal = record.total
      }
      let added = 0
      for (const item of record.threads) {
        if (item && typeof item === 'object') {
          rows.push(item as Record<string, unknown>)
          added++
        }
      }
      const next = typeof record.nextCursor === 'number' ? record.nextCursor : null
      if (next === null || next <= pageCursor || added === 0) break
      pageCursor = next
    }
    return { ok: true, threads: rows, total: reportedTotal ?? rows.length }
  }

  private async aggregateListAcrossHosts(
    caller: CoordinationRemoteCaller,
    input: Extract<CoordinationRelayAsk, { type: 'list' }>['input'],
  ): Promise<Record<string, unknown>> {
    const localId = this.options.localHostId()
    const cursor = input.cursor ?? 0
    const limit = input.limit ?? 20
    const need = cursor + limit
    const collected: Record<string, unknown>[] = []
    const unavailableHosts: { readonly hostId: string; readonly machine: string; readonly reason: string }[] = []
    let totalCount = 0

    const tasks: Promise<void>[] = []

    if (localId) {
      tasks.push((async () => {
        const remoteProject = caller.hostId === localId ? input.project : (!input.project || input.project === 'same' ? 'all' : input.project)
        const baseInput = { ...input, ...(remoteProject ? { project: remoteProject } : {}) }
        const fetched = await this.fetchHostPages(need, (pageCursor, pageLimit) =>
          this.options.service.listThreadsForRemote(caller, { ...baseInput, cursor: pageCursor, limit: pageLimit }),
        )
        if (fetched.ok) {
          totalCount += fetched.total
          const machine = this.localMachineName()
          for (const item of fetched.threads) collected.push({ ...item, hostId: localId, machine })
        }
      })())
    }

    for (const connection of this.connectedRemoteMachines()) {
      const hostId = connection.hostId!
      if (connection.available?.() === false) {
        unavailableHosts.push({ hostId, machine: connection.name, reason: 'disconnected' })
        continue
      }
      if (connection.service.supportsCoordinationRelay !== true || !connection.service.coordinationRemoteAsk) {
        unavailableHosts.push({ hostId, machine: connection.name, reason: 'unsupported' })
        continue
      }
      const remoteProject = caller.hostId === hostId ? input.project : (!input.project || input.project === 'same' ? 'all' : input.project)
      const baseInput = { ...input, ...(remoteProject ? { project: remoteProject } : {}) }
      tasks.push((async () => {
        const fetched = await this.fetchHostPages(need, (pageCursor, pageLimit) =>
          connection.service.coordinationRemoteAsk!({
            type: 'list',
            caller,
            input: { ...baseInput, cursor: pageCursor, limit: pageLimit },
          }, COORDINATION_RELAY_READ_TIMEOUT_MS),
        )
        if (fetched.ok) {
          totalCount += fetched.total
          const machine = this.machineNameOf(hostId, connection.name)
          for (const item of fetched.threads) collected.push({ ...item, hostId, machine })
        } else {
          unavailableHosts.push({ hostId, machine: this.machineNameOf(hostId, connection.name), reason: 'unavailable' })
        }
      })())
    }

    await Promise.all(tasks)
    collected.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')) || String(a.threadId ?? '').localeCompare(String(b.threadId ?? '')))
    const page = collected.slice(cursor, cursor + limit)
    const nextCursor = cursor + page.length < totalCount && page.length > 0 ? cursor + page.length : null
    return {
      status: 'ok',
      hostId: 'all',
      scope: input.project ?? 'same',
      total: totalCount,
      nextCursor,
      threads: page,
      ...(unavailableHosts.length > 0 ? { unavailableHosts } : {}),
    }
  }

  private follow(connection: CoordinationRelayConnection): void {
    const { service, hostId } = connection
    if (connection.kind !== 'remote' || !hostId) return
    if (!this.followed.has(service)) {
      this.followed.add(service)
      // Release any previous connection's listeners for this hostId on reconnect so closed sockets can be GC'd.
      this.hostStops.get(hostId)?.()
      const stops: (() => void)[] = []

      if (service.subscribeCoordinationRelay) {
        stops.push(service.subscribeCoordinationRelay((askId, raw) => {
          void this.handleHostRelayAsk(connection, hostId, askId, raw)
        }))
      }

      if (service.subscribeCoordinationRemoteNews) {
        stops.push(service.subscribeCoordinationRemoteNews(payload => {
          void this.handleRemoteOutcomeNews(hostId, this.machineNameOf(hostId, connection.name), payload)
        }))
      }

      if (service.subscribe) {
        let wasAvailable = connection.available?.() !== false
        stops.push(service.subscribe(() => {
          const nowAvailable = connection.available?.() !== false
          const recovered = !wasAvailable && nowAvailable
          wasAvailable = nowAvailable
          if (recovered) this.onHostAvailable(hostId)
        }))
      }

      this.hostStops.set(hostId, () => { for (const stop of stops) stop() })
    }
    if (connection.available?.() !== false) this.onHostAvailable(hostId)
  }

  private onHostAvailable(hostId: string): void {
    if (this.closed) return
    void this.flushPendingHostNews(hostId)
    this.options.service.replayUntoldRemoteNews({ callerHostId: hostId })
  }

  private clearPendingHostNews(hostId: string): void {
    const timer = this.pendingHostNewsTimers.get(hostId)
    if (timer) { clearTimeout(timer); this.pendingHostNewsTimers.delete(hostId) }
    this.pendingHostNews.delete(hostId)
    this.pendingHostNewsAttempts.delete(hostId)
  }

  private enqueuePendingHostNews(entry: PendingHostNewsEntry): void {
    if (this.closed) return
    let bucket = this.pendingHostNews.get(entry.callerHostId)
    if (!bucket) {
      bucket = new Map()
      this.pendingHostNews.set(entry.callerHostId, bucket)
    }
    const key = entry.news.items.map(item => item.exchangeId).join(',')
    bucket.delete(key)
    bucket.set(key, entry)
    if (bucket.size > PENDING_HOST_NEWS_MAX) {
      const oldest = bucket.keys().next().value
      if (oldest !== undefined) bucket.delete(oldest)
    }
    this.schedulePendingHostNewsFlush(entry.callerHostId)
  }

  private schedulePendingHostNewsFlush(hostId: string): void {
    if (this.closed || this.pendingHostNewsTimers.has(hostId)) return
    const attempt = (this.pendingHostNewsAttempts.get(hostId) ?? 0) + 1
    this.pendingHostNewsAttempts.set(hostId, attempt)
    const delay = Math.min(PENDING_HOST_NEWS_RETRY_MAX_MS, PENDING_HOST_NEWS_RETRY_MS * Math.min(attempt, 30))
    const timer = setTimeout(() => {
      this.pendingHostNewsTimers.delete(hostId)
      void this.flushPendingHostNews(hostId)
    }, delay)
    timer.unref?.()
    this.pendingHostNewsTimers.set(hostId, timer)
  }

  private async flushPendingHostNews(hostId: string): Promise<void> {
    if (this.closed || this.flushingHosts.has(hostId)) return
    const bucket = this.pendingHostNews.get(hostId)
    if (!bucket || bucket.size === 0) return
    const callerHost = this.remoteConnection(hostId)
    if (!callerHost || callerHost.available?.() === false || callerHost.service.supportsCoordinationRelay !== true || !callerHost.service.coordinationRelayNews) {
      this.schedulePendingHostNewsFlush(hostId)
      return
    }
    this.flushingHosts.add(hostId)
    const timer = this.pendingHostNewsTimers.get(hostId)
    if (timer) { clearTimeout(timer); this.pendingHostNewsTimers.delete(hostId) }
    try {
      for (const [key, entry] of [...bucket]) {
        if (this.closed) return
        try {
          await callerHost.service.coordinationRelayNews(entry.callerThreadId, entry.news, entry.replies, entry.exchange)
          bucket.delete(key)
        } catch {
          this.schedulePendingHostNewsFlush(hostId)
          return
        }
      }
      if (bucket.size === 0) {
        this.pendingHostNews.delete(hostId)
        this.pendingHostNewsAttempts.delete(hostId)
      }
    } finally {
      this.flushingHosts.delete(hostId)
    }
  }

  /** Handles an incoming `coordination-relay-ask` from a paired host, strictly verifying caller identity from its authenticated socket & snapshot. */
  private async handleHostRelayAsk(connection: CoordinationRelayConnection, callerHostId: string, askId: string, raw: unknown): Promise<void> {
    let answer: Record<string, unknown>
    try {
      const parsed = coordinationRelayAskSchema.safeParse(raw)
      if (!parsed.success) {
        answer = { status: 'refused', code: 'INVALID_INPUT', message: parsed.error.issues[0]?.message ?? 'Invalid relay coordination ask.' }
      } else {
        const ask = parsed.data
        // Verify caller thread strictly against this authenticated host's own zero-copy snapshot (never trust spoofed hostId, provider, or runtimeMode; L4).
        const snapshot = connection.service.view?.().host
        const callerThread = snapshot?.threads.find(item => item.id === ask.caller.threadId)
        if (!callerThread || !isEligibleParentThread(callerThread)) {
          answer = { status: 'refused', code: 'NOT_ADMITTED', message: NOT_ADMITTED_REMOTE }
        } else {
          const {
            runtimeMode: claimedMode,
            provider: _claimedProvider,
            hostId: _claimedHostId,
            machineName: _claimedMachine,
            title: _claimedTitle,
            projectId: _claimedProject,
            ...chainFields
          } = ask.caller
          void _claimedProvider; void _claimedHostId; void _claimedMachine; void _claimedTitle; void _claimedProject
          const verifiedMode = narrowerMode(callerThread.runtimeMode, claimedMode)
          const verifiedCaller: CoordinationRemoteCaller = {
            ...chainFields,
            hostId: callerHostId,
            machineName: this.machineNameOf(callerHostId, connection.name),
            title: callerThread.title,
            projectId: callerThread.projectId,
            ...(callerThread.providerId ? { provider: callerThread.providerId } : {}),
            ...(verifiedMode ? { runtimeMode: verifiedMode } : {}),
          }
          const verifiedAsk: CoordinationRelayAsk = { ...ask, caller: verifiedCaller }
          const timeoutMs = verifiedAsk.type === 'send'
            ? Math.min(COORDINATION_RELAY_SEND_TIMEOUT_MS, ((verifiedAsk.input.wait_seconds ?? 0) + 30) * 1000)
            : COORDINATION_RELAY_READ_TIMEOUT_MS
          answer = await this.ask(verifiedAsk, timeoutMs)
        }
      }
    } catch {
      answer = { status: 'refused', code: 'HOST_UNAVAILABLE', uncertain: true, message: HOST_UNAVAILABLE_TIMEOUT }
    }
    await connection.service.answerCoordinationRelay?.(askId, answer).catch(() => undefined)
  }

  /** Routes outcome news from a target paired host back to the originating desktop thread or originating paired host. */
  private async handleRemoteOutcomeNews(
    targetHostId: string,
    targetMachineName: string,
    payload: {
      readonly callerThreadId: string
      readonly callerHostId: string
      readonly news: CoordinationNews
      readonly replies?: readonly CoordinationRelayedReply[] | undefined
      readonly exchange?: CoordinationExchangeView | undefined
    },
  ): Promise<void> {
    const decoratedExchange: CoordinationExchangeView | undefined = payload.exchange
      ? { ...payload.exchange, peerHostId: targetHostId, peerMachine: targetMachineName }
      : undefined
    const localId = this.options.localHostId()
    if (localId && payload.callerHostId === localId) {
      await this.options.service.applyRelayedNews(payload.callerThreadId, payload.news, payload.replies, decoratedExchange, targetHostId).catch(() => undefined)
      return
    }
    const entry: PendingHostNewsEntry = {
      callerThreadId: payload.callerThreadId,
      callerHostId: payload.callerHostId,
      news: payload.news,
      ...(payload.replies ? { replies: payload.replies } : {}),
      ...(decoratedExchange ? { exchange: decoratedExchange } : {}),
    }
    const callerHost = this.remoteConnection(payload.callerHostId)
    if (!callerHost || callerHost.available?.() === false || callerHost.service.supportsCoordinationRelay !== true || !callerHost.service.coordinationRelayNews) {
      this.enqueuePendingHostNews(entry)
      return
    }
    try {
      await callerHost.service.coordinationRelayNews(entry.callerThreadId, entry.news, entry.replies, entry.exchange)
    } catch {
      this.enqueuePendingHostNews(entry)
    }
  }
}

function toRemoteAsk(ask: CoordinationRelayAsk): CoordinationRemoteAsk {
  if (ask.type === 'list') return { type: 'list', caller: ask.caller, input: ask.input }
  if (ask.type === 'read') return { type: 'read', caller: ask.caller, input: ask.input }
  if (ask.type === 'send') return { type: 'send', exchangeId: ask.exchangeId, caller: ask.caller, input: ask.input }
  return { type: 'read-exchange', caller: ask.caller, exchangeId: ask.exchangeId }
}

/** Stamps verified `hostId` and `machine` on answers coming back from a target machine. */
function decorateRemoteAnswer(answer: Record<string, unknown>, hostId: string, machine: string): Record<string, unknown> {
  if (answer.status !== 'ok') return answer
  if (Array.isArray(answer.threads)) {
    return {
      ...answer,
      hostId,
      machine,
      threads: answer.threads.map(item => item && typeof item === 'object' ? { ...(item as Record<string, unknown>), hostId, machine } : item),
    }
  }
  if (answer.thread && typeof answer.thread === 'object' && !Array.isArray(answer.thread)) {
    return {
      ...answer,
      thread: { ...(answer.thread as Record<string, unknown>), hostId, machine },
    }
  }
  if (typeof answer.exchangeId === 'string') {
    return { ...answer, targetHostId: hostId, targetMachine: machine }
  }
  return answer
}
