import { useSyncExternalStore } from 'react'

/**
 * What the user's last Settle offers back, for the toast at the Threads sidebar's foot (ADR-0165, Zach's pick B of #1826):
 * Undo, while the settle can be taken back whole, or the plain words of one that removed the thread's worktree folder too.
 * Only a Settle the user pressed makes one: the row's, its menu's, the pane's ··· menu's or the Settle shortcut, which
 * all go through `useSettleThread`. Watcher's settles and Auto-settle merged threads make none. One at a time, for as long
 * as the window lasts, so a Settle pressed beside another page is still offered when the sidebar shows.
 */
export interface SettleOffer {
  readonly id: number
  readonly threadId: string
  readonly title: string
  /**
   * `undo` while Restore would put everything back; `removed` once the settle also took the thread's worktree folder,
   * which Restore cannot bring back with what was in it; `refused` when Undo was pressed and the thread stayed settled.
   */
  readonly kind: 'undo' | 'removed' | 'refused'
  /** The worktree question is open: the toast waits for its answer before it shows or its time starts. */
  readonly asking: boolean
  /** Main's words for a refused Undo. */
  readonly refusal?: string | undefined
}

/** How long the toast stands once shown: long enough to reach Undo, and no longer than the gap needs (ADR-0165). */
export const SETTLE_UNDO_MS = 6_000
/** A refused Undo stays longer, to be read. */
export const SETTLE_REFUSAL_MS = 15_000

let current: SettleOffer | null = null
let next = 1
let timer: ReturnType<typeof setTimeout> | undefined
/** The pointer or the focus is on the toast: its time stands still until both leave. */
let held = false
const listeners = new Set<() => void>()
const publish = (): void => { for (const listener of [...listeners]) listener() }

/** Starts the offer's time again from the top, unless it waits on its worktree question or is held. */
function startClock(): void {
  if (timer !== undefined) { clearTimeout(timer); timer = undefined }
  const offer = current
  if (offer === null || offer.asking || held) return
  timer = setTimeout(() => settleOffers.dismiss(offer.id), offer.kind === 'refused' ? SETTLE_REFUSAL_MS : SETTLE_UNDO_MS)
}

function replace(offer: SettleOffer | null): void {
  current = offer
  held = false
  startClock()
  publish()
}

/** Changes the offer for this thread, if it is still the one standing. */
function update(threadId: string, change: (offer: SettleOffer) => SettleOffer): void {
  if (current === null || current.threadId !== threadId) return
  current = change(current)
  startClock()
  publish()
}

export const settleOffers = {
  get: (): SettleOffer | null => current,
  /**
   * A Settle the user pressed took. `asking` while its worktree question opens; `removed` when the on-settle rule takes
   * its clean folder at once.
   */
  settled(threadId: string, title: string, { asking = false, removed = false }: { readonly asking?: boolean; readonly removed?: boolean } = {}): void {
    replace({ id: next++, threadId, title, kind: removed ? 'removed' : 'undo', asking })
  },
  /** The worktree question was answered: the folder went with the thread, or stayed. */
  answered(threadId: string, removed: boolean): void {
    update(threadId, offer => ({ ...offer, asking: false, kind: removed ? 'removed' : offer.kind }))
  },
  /** The on-settle rule's removal was refused, so the folder stayed and Undo can put everything back after all. */
  kept(threadId: string): void {
    update(threadId, offer => offer.kind === 'removed' ? { ...offer, kind: 'undo' } : offer)
  },
  /** Undo was pressed and main kept the thread settled, in its own words. */
  refused(threadId: string, title: string, refusal: string): void {
    replace({ id: next++, threadId, title, kind: 'refused', asking: false, refusal })
  },
  /** Holds the toast's time while the pointer or the focus is on it, and starts it again once both have left. */
  hold(id: number, on: boolean): void {
    if (current?.id !== id || held === on) return
    held = on
    startClock()
  },
  /** Takes the toast away, if it is still the one named. */
  dismiss(id: number): void {
    if (current?.id !== id) return
    replace(null)
  },
  subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } },
}

export function useSettleOffer(): SettleOffer | null {
  return useSyncExternalStore(settleOffers.subscribe, settleOffers.get, settleOffers.get)
}
