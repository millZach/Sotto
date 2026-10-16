import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { DelegationsBridge, DelegationView } from '../../../shared/delegation'
import { useOwlFeature } from '../state/owlFeature'

const NONE: readonly DelegationView[] = []

interface Entry {
  views: readonly DelegationView[]
  readonly listeners: Set<() => void>
  /** A read is on its way; `again` asks for one more once it lands, because main named the thread since. */
  reading: boolean
  again: boolean
  /** The window has asked main for this thread: its pane shows a thread that delegated, or main named it. */
  asked: boolean
}

/**
 * The window's copy of the delegations each shown thread made (#1029). It asks main only for a thread a pane shows,
 * once when that pane opens on a thread that delegated, and again when main names the thread as changed; never on a
 * publish, and never for a thread nothing shows. What it holds goes when the last pane showing the thread closes.
 */
export class DelegationStore {
  private readonly entries = new Map<string, Entry>()
  private stopChanges: (() => void) | undefined

  constructor(private readonly bridge: () => DelegationsBridge | undefined) {}

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
  views(threadId: string): readonly DelegationView[] { return this.entries.get(threadId)?.views ?? NONE }
  /** Asks main once for a shown thread that delegated; later reads come only from main naming it as changed. */
  want(threadId: string): void {
    const entry = this.entries.get(threadId)
    if (!entry || entry.asked) return
    entry.asked = true
    this.read(threadId, entry)
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
      entry.views = answer.delegations
      for (const listener of [...entry.listeners]) listener()
    }, () => undefined).finally(() => {
      entry.reading = false
      if (entry.again && this.entries.get(threadId) === entry) { entry.again = false; this.read(threadId, entry) }
    })
  }
}

const windowStore = new DelegationStore(() => typeof window === 'undefined' ? undefined : window.sotto?.delegations)

/** Whether the window shows delegation: the Owl list turns it on and main offered the bridge. */
export function useDelegationsEnabled(): boolean {
  return useOwlFeature('thread-delegation') && typeof window !== 'undefined' && window.sotto?.delegations !== undefined
}

/**
 * The delegations `threadId` made, as main last answered, while the window shows delegation. `delegating` says the
 * snapshot links a thread to this one, so the first read waits until there is something to read; main naming the thread
 * reads it whatever `delegating` says. `store` is the window's, or a test's.
 */
export function useDelegations(threadId: string | undefined, delegating: boolean, store: DelegationStore = windowStore): readonly DelegationView[] {
  const enabled = useDelegationsEnabled()
  const id = enabled ? threadId : undefined
  const subscribe = useCallback((listener: () => void) => id === undefined ? () => undefined : store.subscribe(id, listener), [id, store])
  const views = useSyncExternalStore(subscribe, () => id === undefined ? NONE : store.views(id), () => NONE)
  useEffect(() => { if (id !== undefined && delegating) store.want(id) }, [id, delegating, store])
  return views
}
