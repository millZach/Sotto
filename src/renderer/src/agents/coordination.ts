import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { CoordinationBridge, CoordinationExchangeView, CoordinationReply } from '../../../shared/threadCoordination'
import { useOwlFeature } from '../state/owlFeature'

/** What the window holds of one thread's parent-to-parent coordination exchanges, oldest first. */
export interface ThreadCoordinationViews {
  readonly sent: readonly CoordinationExchangeView[]
  readonly received: readonly CoordinationExchangeView[]
}

const NONE: ThreadCoordinationViews = { sent: [], received: [] }

interface Entry {
  views: ThreadCoordinationViews
  readonly listeners: Set<() => void>
  reading: boolean
  again: boolean
  asked: boolean
}

/**
 * Renderer store for parent-to-parent coordination exchanges (ADR-0216, Slice 2).
 * Reads once when a thread pane or Tools › Agents mounts, and re-reads only when main announces that thread changed.
 */
export class CoordinationStore {
  private readonly entries = new Map<string, Entry>()
  private stopChanges: (() => void) | undefined

  constructor(private readonly bridge: () => CoordinationBridge | undefined) {}

  readonly subscribe = (threadId: string, listener: () => void): (() => void) => {
    const entry = this.entries.get(threadId) ?? { views: NONE, listeners: new Set<() => void>(), reading: false, again: false, asked: false }
    this.entries.set(threadId, entry)
    entry.listeners.add(listener)
    this.listen()
    return () => {
      entry.listeners.delete(listener)
      if (entry.listeners.size || this.entries.get(threadId) !== entry) return
      this.entries.delete(threadId)
      if (!this.entries.size) { this.stopChanges?.(); this.stopChanges = undefined }
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

  private listen(): void {
    const bridge = this.bridge()
    if (this.stopChanges || !bridge) return
    this.stopChanges = bridge.onChanged(change => {
      for (const threadId of change.threadIds) {
        const entry = this.entries.get(threadId)
        if (!entry?.listeners.size) continue
        entry.asked = true
        this.read(threadId, entry)
      }
    })
  }

  private read(threadId: string, entry: Entry): void {
    const bridge = this.bridge()
    if (!bridge) return
    if (entry.reading) { entry.again = true; return }
    entry.reading = true
    void bridge.read({ threadId }).then(answer => {
      if (this.entries.get(threadId) !== entry) return
      entry.views = { sent: answer.sent, received: answer.received }
      for (const listener of [...entry.listeners]) listener()
    }, () => undefined).finally(() => {
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
