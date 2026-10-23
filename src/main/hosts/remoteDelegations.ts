import { hostEntityKey, parseHostEntityKey } from '../../shared/clientIdentity'
import type { DelegationBrief, DelegationsRead, DelegationView } from '../../shared/delegation'
import type { DelegationViewsChange, HostService } from '../agents/hostService'

/** What a remote host's connection offers these reads: its service's delegation reads, when it has them. */
export interface RemoteDelegationHost {
  readonly hostId: string
  readonly service: Pick<HostService, 'supportsDelegationViews' | 'delegationViews' | 'delegationBrief'>
}

/** How many threads' last reads are kept, newest read first, so a thread's roster still shows them while its host is away. */
export const KEPT_DELEGATION_READS = 256

/**
 * The window's reads of a remote host's own threads' delegations (#1310), and the word of which changed. A host that runs
 * delegation for its threads answers `delegation-views` from its own record; every thread ID it names is its own, and goes
 * to the window keyed by that host, as the router keys its threads. The last answer for each thread is kept, so while the
 * host is not connected the window still shows what Sotto last read there, as it stood when the connection was lost
 * (`lastRead`), never an outcome guessed from nothing. Once it connects again every kept thread of it is named as changed,
 * and read afresh: what the host's own record says then is what shows, `unknown` included. Nothing here runs on the
 * update path: it reads only when the window asks, and copies only the answer it was given.
 */
export class RemoteDelegationReads {
  /** By the window's key for each thread, oldest read first. */
  private readonly kept = new Map<string, DelegationsRead>()
  /**
   * Every thread the window has asked for, oldest ask first, whether or not Sotto could read it then, so a roster first
   * opened while its host was away is told when the host connects again, as one read earlier is.
   */
  private readonly asked = new Set<string>()
  /** When Sotto lost each host it no longer hears, until it connects again. */
  private readonly lost = new Map<string, string>()
  private readonly listeners = new Set<(threadIds: readonly string[]) => void>()

  constructor(private readonly hosts: {
    /** The host's connection the router holds now, if any. */
    connection(hostId: string): RemoteDelegationHost | undefined
    /** Whether that connection is up: not reconnecting, not dropped. */
    connected(hostId: string): boolean
  }, private readonly now: () => Date = () => new Date()) {}

  /** What the window shows of `threadKey`'s delegations: read from its host now, or as Sotto last read it there. */
  async views(threadKey: string): Promise<DelegationsRead> {
    const key = parseHostEntityKey(threadKey)
    if (!key) return none(threadKey, 'not-connected')
    this.asked.delete(threadKey)
    this.asked.add(threadKey)
    if (this.asked.size > KEPT_DELEGATION_READS) this.asked.delete(this.asked.values().next().value!)
    const connection = this.hosts.connection(key.hostId)
    if (!connection || !this.hosts.connected(key.hostId)) return this.lastRead(threadKey, key.hostId)
    if (connection.service.supportsDelegationViews !== true || !connection.service.delegationViews) return none(threadKey, 'older-host')
    let answer: DelegationsRead
    try { answer = await connection.service.delegationViews(key.id) } catch { return this.lastRead(threadKey, key.hostId) }
    // An answer from a connection a reconnect or a forget has since replaced is that connection's, not the new one's.
    if (this.hosts.connection(key.hostId) !== connection) return this.lastRead(threadKey, key.hostId)
    const read = windowRead(threadKey, key.hostId, answer)
    this.kept.delete(threadKey)
    this.kept.set(threadKey, read)
    if (this.kept.size > KEPT_DELEGATION_READS) this.kept.delete(this.kept.keys().next().value!)
    return read
  }
  /** The newest brief `threadKey` was sent, read from its host while it is connected; none while it is not. */
  async brief(threadKey: string): Promise<DelegationBrief> {
    const key = parseHostEntityKey(threadKey)
    const connection = key ? this.hosts.connection(key.hostId) : undefined
    if (!key || !connection || !this.hosts.connected(key.hostId) || connection.service.supportsDelegationViews !== true || !connection.service.delegationBrief) return null
    try {
      const brief = await connection.service.delegationBrief(key.id)
      return brief === null ? null : { threadId: threadKey, text: brief.text }
    } catch { return null }
  }
  /** Hears the window keys of threads whose delegations changed, or whose host was lost or taken again. */
  subscribe(listener: (threadIds: readonly string[]) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** What a host's connection hears: threads it names as changed, or the connection closing. */
  heard(hostId: string, change: DelegationViewsChange): void {
    if ('threadIds' in change) this.tell(change.threadIds.map(id => hostEntityKey(hostId, id)))
    else if (!change.connected) this.lostHost(hostId)
  }
  /** The host's connection is lost or reconnecting: its kept reads stand as they were then. */
  lostHost(hostId: string): void {
    if (this.lost.has(hostId)) return
    this.lost.set(hostId, this.now().toISOString())
    this.tell(this.keysOf(hostId))
  }
  /** The router took a connection for the host, new or in place of one: everything kept of it is read afresh. */
  taken(hostId: string): void {
    this.lost.delete(hostId)
    this.tell(this.keysOf(hostId))
  }
  /** The host is gone from the router: nothing of it is kept. */
  removed(hostId: string): void {
    this.lost.delete(hostId)
    const keys = this.keysOf(hostId)
    for (const key of keys) { this.kept.delete(key); this.asked.delete(key) }
    this.tell(keys)
  }

  private lastRead(threadKey: string, hostId: string): DelegationsRead {
    const kept = this.kept.get(threadKey)
    if (!kept) return none(threadKey, 'not-connected')
    return { ...kept, lastRead: this.lost.get(hostId) ?? this.now().toISOString() }
  }
  /** The threads of `hostId` the window has asked for or Sotto has kept a read of. */
  private keysOf(hostId: string): string[] {
    return [...new Set([...this.asked, ...this.kept.keys()])].filter(key => parseHostEntityKey(key)?.hostId === hostId)
  }
  private tell(threadIds: readonly string[]): void {
    if (!threadIds.length) return
    for (const listener of [...this.listeners]) { try { listener(threadIds) } catch { /* A listener's failure is its own. */ } }
  }
}

function none(threadId: string, unread: NonNullable<DelegationsRead['unread']>): DelegationsRead {
  return { threadId, delegations: [], received: [], unread }
}

/** A host's answer with every thread it names keyed by that host, as the window names them. */
function windowRead(threadKey: string, hostId: string, answer: DelegationsRead): DelegationsRead {
  const keyed = <View extends DelegationView>(view: View): View => view.thread === undefined ? view : { ...view, thread: hostEntityKey(hostId, view.thread) }
  return { threadId: threadKey, delegations: answer.delegations.map(keyed), received: answer.received.map(keyed) }
}
