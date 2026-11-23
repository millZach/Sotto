import { hostEntityKey, parseHostEntityKey } from '../../shared/clientIdentity'
import type { CoordinationExchangeView, CoordinationRead, CoordinationReply } from '../../shared/threadCoordination'
import type { CoordinationViewsChange, HostService } from '../agents/hostService'

/** What a remote host's connection offers these reads: its coordination views & on-demand reply reads, when supported. */
export interface RemoteCoordinationHost {
  readonly hostId: string
  readonly service: Pick<HostService, 'supportsCoordinationViews' | 'coordinationViews' | 'coordinationReply'>
}

/** How many threads' last coordination reads are kept, newest read first, so views stay visible while a host reconnects. */
export const KEPT_COORDINATION_READS = 256

/**
 * Window reads of a paired host's parent-to-parent coordination views (ADR-0216, Slice 3).
 * Mirrors `RemoteDelegationReads`: reads on demand only (never on the update path), qualifies every peer thread ID
 * using `view.peerHostId ?? hostId` so cross-machine peer links open the exact target thread on its own machine,
 * returns empty views / null reply cleanly when a host is disconnected or lacks `thread-coordination-views`,
 * and re-notifies asked threads when a host reconnects.
 */
export class RemoteCoordinationReads {
  private readonly kept = new Map<string, CoordinationRead>()
  private readonly asked = new Set<string>()
  private readonly listeners = new Set<(threadIds: readonly string[]) => void>()

  constructor(private readonly hosts: {
    connection(hostId: string): RemoteCoordinationHost | undefined
    connected(hostId: string): boolean
  }) {}

  async views(threadKey: string): Promise<CoordinationRead> {
    const key = parseHostEntityKey(threadKey)
    if (!key) return empty(threadKey)
    this.asked.delete(threadKey)
    this.asked.add(threadKey)
    if (this.asked.size > KEPT_COORDINATION_READS) this.asked.delete(this.asked.values().next().value!)
    const connection = this.hosts.connection(key.hostId)
    if (!connection || !this.hosts.connected(key.hostId)) return this.kept.get(threadKey) ?? empty(threadKey)
    if (connection.service.supportsCoordinationViews !== true || !connection.service.coordinationViews) return empty(threadKey)
    let answer: CoordinationRead
    try {
      answer = await connection.service.coordinationViews(key.id)
    } catch {
      return this.kept.get(threadKey) ?? empty(threadKey)
    }
    if (this.hosts.connection(key.hostId) !== connection) return this.kept.get(threadKey) ?? empty(threadKey)
    const read = windowRead(threadKey, key.hostId, answer)
    this.kept.delete(threadKey)
    this.kept.set(threadKey, read)
    if (this.kept.size > KEPT_COORDINATION_READS) this.kept.delete(this.kept.keys().next().value!)
    return read
  }

  async reply(threadKey: string, exchangeId: string): Promise<CoordinationReply> {
    const key = parseHostEntityKey(threadKey)
    const connection = key ? this.hosts.connection(key.hostId) : undefined
    if (!key || !connection || !this.hosts.connected(key.hostId)
      || connection.service.supportsCoordinationViews !== true || !connection.service.coordinationReply) return null
    try {
      return await connection.service.coordinationReply(key.id, exchangeId)
    } catch {
      return null
    }
  }

  subscribe(listener: (threadIds: readonly string[]) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  heard(hostId: string, change: CoordinationViewsChange): void {
    if ('threadIds' in change) this.tell(change.threadIds.map(id => hostEntityKey(hostId, id)))
    else if (!change.connected) this.lostHost(hostId)
  }

  lostHost(hostId: string): void {
    this.tell(this.keysOf(hostId))
  }

  taken(hostId: string): void {
    this.tell(this.keysOf(hostId))
  }

  removed(hostId: string): void {
    const keys = this.keysOf(hostId)
    for (const key of keys) { this.kept.delete(key); this.asked.delete(key) }
    this.tell(keys)
  }

  private keysOf(hostId: string): string[] {
    return [...new Set([...this.asked, ...this.kept.keys()])].filter(key => parseHostEntityKey(key)?.hostId === hostId)
  }

  private tell(threadIds: readonly string[]): void {
    if (!threadIds.length) return
    for (const listener of [...this.listeners]) { try { listener(threadIds) } catch { /* A listener's failure is its own. */ } }
  }
}

function empty(threadId: string): CoordinationRead {
  return { threadId, sent: [], received: [] }
}

/** Qualifies every peer thread ID using `view.peerHostId ?? hostId` so both same-host and cross-machine peer links open the exact target thread. */
function windowRead(threadKey: string, hostId: string, answer: CoordinationRead): CoordinationRead {
  const qualify = (view: CoordinationExchangeView): CoordinationExchangeView => ({
    ...view,
    peerThreadId: hostEntityKey(view.peerHostId ?? hostId, view.peerThreadId),
  })
  return {
    threadId: threadKey,
    sent: answer.sent.map(qualify),
    received: answer.received.map(qualify),
  }
}
