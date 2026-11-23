import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { CoordinationBridge, CoordinationExchangeView, CoordinationReply } from '../../../shared/threadCoordination'
import { useOwlFeature } from '../state/owlFeature'

/** What the window holds of one thread's parent-to-parent coordination exchanges, oldest first. */
export interface ThreadCoordinationViews {
  readonly sent: readonly CoordinationExchangeView[]
  readonly received: readonly CoordinationExchangeView[]
}

const NONE: ThreadCoordinationViews = { sent: [], received: [] }
const CACHE_ENTRIES_MAX = 200

interface Entry {
  views: ThreadCoordinationViews
  readonly listeners: Set<() => void>
  reading: boolean
  again: boolean
  asked: boolean
}

function sameExchangeList(left: readonly CoordinationExchangeView[], right: readonly CoordinationExchangeView[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    const a = left[index]!, b = right[index]!
    if (
      a.id !== b.id
      || a.direction !== b.direction
      || a.peerThreadId !== b.peerThreadId
      || a.peerHostId !== b.peerHostId
      || a.peerMachine !== b.peerMachine
      || a.peerTitle !== b.peerTitle
      || a.peerProvider !== b.peerProvider
      || a.messageId !== b.messageId
      || a.anchorMessageId !== b.anchorMessageId
      || a.delivery !== b.delivery
      || a.deliveryState !== b.deliveryState
      || a.outcome !== b.outcome
      || a.hopCount !== b.hopCount
      || a.hopMax !== b.hopMax
      || a.expectReply !== b.expectReply
      || a.hasReply !== b.hasReply
      || a.note !== b.note
      || a.createdAt !== b.createdAt
      || a.updatedAt !== b.updatedAt
      || a.outcomeAt !== b.outcomeAt
    ) return false
  }
  return true
}

/**
 * Renderer store for parent-to-parent coordination exchanges (ADR-0216, Slice 2).
 * Reads once when a thread pane or Tools › Agents mounts, re-reads when main announces a change, retains a bounded
 * cache across thread switches so returning does not flash raw framing (N2), and retries after a failed first read (N3).
 */
export class CoordinationStore {
  private readonly entries = new Map<string, Entry>()
  private stopChanges: (() => void) | undefined
  private activeSubscriptions = 0

  constructor(private readonly bridge: () => CoordinationBridge | undefined) {}

  readonly subscribe = (threadId: string, listener: () => void): (() => void) => {
    let entry = this.entries.get(threadId)
    if (!entry) {
      entry = { views: NONE, listeners: new Set<() => void>(), reading: false, again: false, asked: false }
      this.entries.set(threadId, entry)
      this.trimCache()
    } else {
      // Refresh LRU order.
      this.entries.delete(threadId)
      this.entries.set(threadId, entry)
    }
    entry.listeners.add(listener)
    this.activeSubscriptions += 1
    this.listen()
    return () => {
      entry.listeners.delete(listener)
      this.activeSubscriptions = Math.max(0, this.activeSubscriptions - 1)
      if (this.activeSubscriptions === 0) {
        this.stopChanges?.()
        this.stopChanges = undefined
        // Mark cached entries stale when we stop listening so returning refreshes in the background without flashing.
        for (const cached of this.entries.values()) cached.asked = false
      }
    }
  }

  views(threadId: string): ThreadCoordinationViews {
    return this.entries.get(threadId)?.views ?? NONE
  }

  want(threadId: string): void {
    const entry = this.entries.get(threadId)
    if (!entry || entry.asked) return
    entry.asked = true
    this.read(threadId, entry)
  }

  readReply(threadId: string, exchangeId: string): Promise<CoordinationReply> {
    const bridge = this.bridge()
    if (!bridge) return Promise.resolve(null)
    return bridge.reply({ threadId, exchangeId })
  }

  private trimCache(): void {
    if (this.entries.size <= CACHE_ENTRIES_MAX) return
    for (const [key, candidate] of this.entries) {
      if (this.entries.size <= CACHE_ENTRIES_MAX) break
      if (candidate.listeners.size === 0 && !candidate.reading) this.entries.delete(key)
    }
  }

  private listen(): void {
    const bridge = this.bridge()
    if (this.stopChanges || !bridge) return
    this.stopChanges = bridge.onChanged(change => {
      for (const threadId of change.threadIds) {
        const entry = this.entries.get(threadId)
        if (!entry) continue
        if (!entry.listeners.size) {
          // Cached thread changed while off-screen: refresh on next visit.
          entry.asked = false
          continue
        }
        entry.asked = true
        this.read(threadId, entry)
      }
    })
  }

  private read(threadId: string, entry: Entry): void {
    const bridge = this.bridge()
    if (!bridge) { entry.asked = false; return }
    if (entry.reading) { entry.again = true; return }
    entry.reading = true
    void bridge.read({ threadId }).then(answer => {
      if (this.entries.get(threadId) !== entry) return
      const sameSent = sameExchangeList(entry.views.sent, answer.sent)
      const sameReceived = sameExchangeList(entry.views.received, answer.received)
      if (sameSent && sameReceived) return
      entry.views = {
        sent: sameSent ? entry.views.sent : answer.sent,
        received: sameReceived ? entry.views.received : answer.received,
      }
      for (const listener of [...entry.listeners]) listener()
    }, () => {
      // Allow subsequent visits or pushes to retry after a transient failure (N3).
      if (this.entries.get(threadId) === entry) entry.asked = false
    }).finally(() => {
      entry.reading = false
      if (entry.again && this.entries.get(threadId) === entry) { entry.again = false; this.read(threadId, entry) }
    })
  }
}

export const coordinationStore = new CoordinationStore(() => typeof window === 'undefined' ? undefined : window.sotto?.coordination)

/** Whether the window shows parent-to-parent thread coordination: Owl feature on AND preload bridge offered. */
export function useCoordinationEnabled(): boolean {
  return useOwlFeature('parent-thread-coordination') && typeof window !== 'undefined' && window.sotto?.coordination !== undefined
}

/** Whether an exchange is actively running or queued (drives the quiet header badge). */
export function isActiveExchange(view: Pick<CoordinationExchangeView, 'deliveryState' | 'outcome'>): boolean {
  if (view.deliveryState === 'failed') return false
  if (view.deliveryState === 'queued' || view.deliveryState === 'dispatching') return true
  return view.outcome === 'working' || view.outcome === 'background'
}

/** What `threadId` sent to and received from peer parent threads, read once and updated on main's change push. */
export function useThreadCoordination(threadId: string | undefined, store: CoordinationStore = coordinationStore): ThreadCoordinationViews {
  const enabled = useCoordinationEnabled()
  const id = enabled ? threadId : undefined
  const subscribe = useCallback((listener: () => void) => id === undefined ? () => undefined : store.subscribe(id, listener), [id, store])
  const views = useSyncExternalStore(subscribe, () => id === undefined ? NONE : store.views(id), () => NONE)
  useEffect(() => { if (id !== undefined) store.want(id) }, [id, store])
  return views
}
