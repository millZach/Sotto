import { useCallback, useSyncExternalStore } from 'react'
import type { BrowserBounds } from '../../../shared/browser'
import type { CloudEvent, CloudIphoneBridge, CloudIphoneStatus, CloudSession } from '../../../shared/cloudIphone'

export type CloudIphoneBridgeLike = CloudIphoneBridge | undefined

/** `window.sotto.cloudIphone`: the main window's view of cloud iPhone sessions. */
export function bridgeCloudIphone(): CloudIphoneBridgeLike {
  return window.sotto?.cloudIphone
}

function sameBounds(a: BrowserBounds | null, b: BrowserBounds | null): boolean {
  return a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height)
}

interface Mounted { readonly threadId: string; readonly workspaceId: string; readonly sessionId: string; readonly bounds: BrowserBounds }

/**
 * Cloud iPhone sessions (ADR-0047) and this computer's run.cloud status: the one thing Settings, the thread's
 * request card, the phone player and Tools > iPhone all read. A remote host's threads have no sessions here,
 * since a cloud iPhone is this computer's own run.cloud adapter.
 */
export class CloudIphoneStore {
  private readonly sessions = new Map<string, readonly CloudSession[]>()
  private readonly watched = new Set<string>()
  private status: CloudIphoneStatus | null = null
  private subscribedBridge: CloudIphoneBridge | null = null
  private unsubscribe: (() => void) | null = null
  private mounted: Mounted | null = null
  private readonly listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private emit(): void { for (const listener of [...this.listeners]) listener() }

  sessionsFor = (threadId: string): readonly CloudSession[] => this.sessions.get(threadId) ?? []
  statusSnapshot = (): CloudIphoneStatus | null => this.status

  private listen(bridge: CloudIphoneBridge): void {
    if (this.subscribedBridge === bridge) return
    this.unsubscribe?.()
    this.subscribedBridge = bridge
    this.watched.clear()
    this.unsubscribe = bridge.onEvent(event => this.receive(event))
  }

  private receive(event: CloudEvent): void {
    if (event.type === 'status') { this.status = event.status; this.emit(); return }
    const list = this.sessions.get(event.session.threadId) ?? []
    // The updated session moves to the end, so the newest touched session is always the thread's last one.
    this.sessions.set(event.session.threadId, [...list.filter(item => item.id !== event.session.id), event.session])
    this.emit()
  }

  /** Subscribes to session events, once per bridge, and lists a thread's sessions the first time it is watched. */
  watch(bridge: CloudIphoneBridgeLike, threadId: string): void {
    if (!bridge) return
    this.listen(bridge)
    if (this.watched.has(threadId)) return
    this.watched.add(threadId)
    // This computer's bridge refuses a remote host's thread by throwing before it asks anything. That thread has no
    // sessions here, so a refusal, thrown or rejected, reads as none rather than taking the page down with it.
    const unwatch = (): void => { this.watched.delete(threadId) }
    let listing: ReturnType<CloudIphoneBridge['sessions']>
    try { listing = bridge.sessions({ threadId }) } catch { unwatch(); return }
    void listing.then(result => {
      if (!result.ok) { unwatch(); return }
      if (result.value.length === 0) return
      this.sessions.set(threadId, [...result.value].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)))
      this.emit()
    }, unwatch)
  }

  /** Settings' view of the key, the cap, this month's minutes and recent sessions. */
  async loadStatus(bridge: CloudIphoneBridgeLike): Promise<void> {
    if (!bridge) return
    this.listen(bridge)
    const result = await bridge.status()
    if (result.ok) { this.status = result.value; this.emit() }
  }

  /** Checks the key with run.cloud and saves it only if accepted; an empty value removes the saved key. */
  async setKey(bridge: CloudIphoneBridgeLike, value: string): Promise<{ saved: boolean; problem: string | null }> {
    if (!bridge) return { saved: false, problem: 'Cloud iPhone is not available in this window.' }
    const result = await bridge.setKey({ value })
    if (!result.ok) return { saved: false, problem: result.error.message }
    void this.loadStatus(bridge)
    return result.value
  }

  /** The user's Start cloud iPhone or Deny on the thread's request card. */
  async answer(bridge: CloudIphoneBridgeLike, session: CloudSession, allow: boolean): Promise<string | null> {
    if (!bridge) return 'Cloud iPhone is not available in this window.'
    const result = await bridge.answer({ threadId: session.threadId, workspaceId: session.workspaceId, sessionId: session.id, allow })
    if (!result.ok) return result.error.message
    this.receive({ type: 'session', session: result.value })
    return null
  }

  /** The user's End session. */
  async end(bridge: CloudIphoneBridgeLike, session: CloudSession): Promise<string | null> {
    if (!bridge) return 'Cloud iPhone is not available in this window.'
    const result = await bridge.end({ threadId: session.threadId, workspaceId: session.workspaceId, sessionId: session.id })
    if (!result.ok) return result.error.message
    this.receive({ type: 'session', session: result.value })
    return null
  }

  /**
   * Places the session's native viewer at `bounds`, or takes it off the window with null. Only one session is
   * ever mounted at once: mounting a different session un-mounts whichever one was showing, as the browser's
   * pages do for a slot.
   */
  mount(bridge: CloudIphoneBridgeLike, session: CloudSession, bounds: BrowserBounds | null): void {
    if (!bridge) return
    const target = { threadId: session.threadId, workspaceId: session.workspaceId, sessionId: session.id }
    if (bounds === null) {
      if (this.mounted?.sessionId !== session.id) return
      this.mounted = null
      void bridge.mount({ ...target, bounds: null })
      return
    }
    if (this.mounted?.sessionId === session.id && sameBounds(this.mounted.bounds, bounds)) return
    if (this.mounted && this.mounted.sessionId !== session.id) {
      void bridge.mount({ threadId: this.mounted.threadId, workspaceId: this.mounted.workspaceId, sessionId: this.mounted.sessionId, bounds: null })
    }
    this.mounted = { ...target, bounds }
    void bridge.mount({ ...target, bounds })
  }
}

/** In-session singleton, like the Browser store's and the Tools panel's. */
export const cloudIphoneStore = new CloudIphoneStore()

/** The thread's newest cloud iPhone session, or undefined when it has none. */
export function useCloudSession(threadId: string | null, store: CloudIphoneStore = cloudIphoneStore): CloudSession | undefined {
  const read = useCallback(() => threadId === null ? undefined : store.sessionsFor(threadId).at(-1), [store, threadId])
  return useSyncExternalStore(store.subscribe, read)
}

/** This computer's run.cloud status: the key, the cap, this month's minutes and recent sessions. */
export function useCloudStatus(store: CloudIphoneStore = cloudIphoneStore): CloudIphoneStatus | null {
  return useSyncExternalStore(store.subscribe, store.statusSnapshot)
}
