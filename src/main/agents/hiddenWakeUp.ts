import type { WatcherEvent } from '../../shared/watcherNews'
import { isWatcherNews, type WakeUpNews } from './wakeUp'

/**
 * Watcher's hidden wake-up (ADR-0073): the one queued item per Watcher that holds only Watcher's news, which no window,
 * queue panel or phone shows, and so no one can resume, reorder or remove. Everything Sotto does with it by itself is
 * decided here, from what the item keeps, so the same rules hold before and after a restart:
 *
 * (a) A Watcher has at most one hidden wake-up. News folds into it, while it is being sent too, and a saved queue that
 *     holds more is consolidated as it loads.
 * (b) A blocked hidden wake-up (one holding nothing that needs Watcher, or whose tries are spent) is never sent, revived
 *     or moved again until news that needs Watcher folds into it. Its tries are bounded in total, and kept with the item.
 * (c) An event that did not need Watcher when it was observed never wakes Watcher by itself: the item keeps which of its
 *     events did (`attention`), through saves, restarts, pruning and folding.
 * (d) An event leaves the item when a send that carried it (`carried`) is acknowledged, or when it is no longer true.
 */
export interface HiddenWakeUpState {
  readonly status: 'queued' | 'dispatching' | 'uncertain' | 'failed' | 'paused'
  readonly news?: readonly WakeUpNews[] | undefined
  /** The events that needed Watcher's attention when they were observed. */
  readonly attention?: readonly string[] | undefined
  /** How many sends of it have been tried since news that needs Watcher last came. */
  readonly attempts?: number | undefined
  readonly resumeAfterTurnId?: string | undefined
}

/** How many times a hidden wake-up is sent, its first send and every try again, before it waits for news that needs Watcher. */
export const HIDDEN_WAKE_UP_ATTEMPTS = 4

export const hiddenEvents = (news: readonly WakeUpNews[] | undefined): WatcherEvent[] => (news ?? []).flatMap(item => isWatcherNews(item) ? item.events : [])

/** Whether what the item holds now includes news that needed Watcher when it was observed. */
export function needsWatcherNow(item: Pick<HiddenWakeUpState, 'news' | 'attention'>): boolean {
  const attention = new Set(item.attention ?? [])
  return hiddenEvents(item.news).some(event => attention.has(event.id))
}

export type HiddenWakeUpAction =
  /** Send it: queued, holding news that needs Watcher, with tries left. */
  | 'send'
  /** Set it going again: stopped, holding news that needs Watcher, with tries left, and Watcher able to take it. */
  | 'revive'
  /** Stop it here, behind the thread's other items: it may not go by itself. */
  | 'block'
  /** Its send is unknown and nothing reconciles it: let go of what it carried, keep the rest. */
  | 'let-go'
  /** Its send was acknowledged: what it carried leaves, the rest waits. */
  | 'acknowledge'
  | 'none'

export interface HiddenWakeUpContext {
  /** Watcher is resting: no turn running and no card waiting. */
  readonly resting: boolean
  /** Watcher's newest turn finished, and is not the one the item last followed. */
  readonly finished: boolean
  /** The send it carried is echoed in Watcher's history. */
  readonly echoed: boolean
  /** A delivery of it is still being reconciled. */
  readonly reconciling: boolean
  /** Items of the user's own wait behind it. */
  readonly holdingOthers: boolean
}

/** What Sotto does with a hidden wake-up at the head of Watcher's queue, by itself. */
export function hiddenWakeUpAction(item: HiddenWakeUpState, context: HiddenWakeUpContext): HiddenWakeUpAction {
  if (context.echoed && item.status !== 'queued') return 'acknowledge'
  if (item.status === 'dispatching' || context.reconciling) return 'none'
  if (item.status === 'uncertain') return 'let-go'
  const may = needsWatcherNow(item) && (item.attempts ?? 0) < HIDDEN_WAKE_UP_ATTEMPTS
  if (item.status === 'queued') return may ? 'send' : 'block'
  if (may && (context.finished || item.status === 'failed' && context.resting)) return 'revive'
  return context.holdingOthers ? 'block' : 'none'
}
