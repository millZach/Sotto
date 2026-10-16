import type { WatcherEvent } from '../../shared/watcherNews'
import { isWatcherNews, type WakeUpNews } from './wakeUp'

/**
 * Watcher's hidden wake-up (ADR-0073): the one queued item per Watcher that holds only Watcher's news, which no window,
 * queue panel or phone shows, and so no one can resume, reorder or remove. It never changes once made. News that comes
 * while it exists waits in Watcher's own news (WatcherWakeUp) and becomes the next one. Sotto sends it, waits, or takes
 * it out whole with one of these outcomes, which WatcherWakeUp is told:
 *
 * - told: Watcher acknowledged its send.
 * - failed: its send surely did not go, or it may not go by itself; its news waits again.
 * - unknown: its send may have gone; its news is forgotten and observed afresh, as after a restart.
 * - withdrawn: some of its news was no longer true before it went; what still is waits again.
 */
export type HiddenWakeUpOutcome = 'told' | 'failed' | 'unknown' | 'withdrawn'

export const hiddenEvents = (news: readonly WakeUpNews[] | undefined): WatcherEvent[] => (news ?? []).flatMap(item => isWatcherNews(item) ? item.events : [])

/**
 * Settles each hidden wake-up once. A settle of one already settling joins the first rather than running beside it: the
 * first saves the wake-up's news as untold before the wake-up leaves the queue, and a second running beside it would
 * find that news untold in memory, skip the save, and take the wake-up out while the save is still on its way. A crash
 * then would leave the news saved as told with nothing queued. The first's outcome stands; a failed one leaves the
 * wake-up for the next settle to try afresh, which saves again before the wake-up leaves.
 */
export class HiddenWakeUpSettlements {
  private readonly settling = new Map<string, Promise<void>>()
  settle<T extends { readonly id: string }>(items: readonly T[], run: (fresh: readonly T[]) => Promise<void>): Promise<void> {
    const waits = new Set(items.flatMap(item => this.settling.get(item.id) ?? []))
    const fresh = items.filter(item => !this.settling.has(item.id))
    if (fresh.length) {
      const settling = run(fresh)
      for (const item of fresh) this.settling.set(item.id, settling)
      const done = () => { for (const item of fresh) if (this.settling.get(item.id) === settling) this.settling.delete(item.id) }
      settling.then(done, done)
      waits.add(settling)
    }
    return Promise.all(waits).then(() => undefined)
  }
}

export interface HiddenWakeUpContext {
  /** The send it made is echoed in Watcher's history. */
  readonly echoed: boolean
  /** A delivery of it is still being reconciled. */
  readonly reconciling: boolean
  /** Some of its news is no longer true. */
  readonly outdated: boolean
}

/** What Sotto does by itself with a hidden wake-up at the head of Watcher's queue: send it, wait, or take it out. */
export function hiddenWakeUpStep(item: { readonly status: 'queued' | 'dispatching' | 'uncertain' | 'failed' | 'paused' }, context: HiddenWakeUpContext): HiddenWakeUpOutcome | 'send' | 'wait' {
  if (context.echoed && item.status !== 'queued') return 'told'
  if (item.status === 'uncertain') return context.reconciling ? 'wait' : 'unknown'
  if (item.status === 'dispatching') return 'wait'
  // Nothing stops one, but one an earlier step left stopped cannot wait for a Resume no one can press.
  if (item.status !== 'queued') return 'failed'
  return context.outdated ? 'withdrawn' : 'send'
}
