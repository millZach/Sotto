import { useSyncExternalStore } from 'react'

/**
 * What the user's last Settle offers back, for the toast at the Threads sidebar's foot (ADR-0167, Zach's pick B of #1826):
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
   * `undo` while Restore would put everything back; `removing` while the on-settle cleanup rule takes the thread's clean
   * worktree folder, its time standing still until that answers; `removed` once the settle took the folder, which Restore
   * cannot bring back with what was in it; `refused` when Undo was pressed and main kept the thread settled; `unconfirmed`
   * when Undo was pressed and no answer came back, so whether it took is not known.
   */
  readonly kind: 'undo' | 'removing' | 'removed' | 'refused' | 'unconfirmed'
  /** The worktree question is open: the toast waits for its answer before it shows or its time starts. */
  readonly asking: boolean
  /** Main's words for a refused Undo. */
  readonly refusal?: string | undefined
}

/** How long the toast stands once shown: long enough to reach Undo, and no longer than the gap needs (ADR-0167). */
export const SETTLE_UNDO_MS = 6_000
/** A refused or unconfirmed Undo stays longer, to be read. */
export const SETTLE_REFUSAL_MS = 15_000

let current: SettleOffer | null = null
let next = 1
let timer: ReturnType<typeof setTimeout> | undefined
/**
 * The pointer or the focus is on the toast: its time stands still until both leave. It is the toast's, not one offer's, so
 * a later Settle that replaces the words under a still pointer is held as well.
 */
let held = false
const listeners = new Set<() => void>()
const publish = (): void => { for (const listener of [...listeners]) listener() }

/** Starts the offer's time again from the top, unless it waits on its worktree question or is held. */
function startClock(): void {
  if (timer !== undefined) { clearTimeout(timer); timer = undefined }
  const offer = current
  if (offer === null || offer.asking || offer.kind === 'removing' || held) return
  timer = setTimeout(() => settleOffers.dismiss(offer.id), offer.kind === 'undo' || offer.kind === 'removed' ? SETTLE_UNDO_MS : SETTLE_REFUSAL_MS)
}

function replace(offer: SettleOffer | null): void {
  current = offer
  // Nothing left to hold once the toast is gone; a toast that replaces another keeps its hold.
  if (offer === null) held = false
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
   * A Settle the user pressed took. `asking` while its worktree question opens; `removing` while the on-settle rule takes
   * its clean folder.
   */
  settled(threadId: string, title: string, { asking = false, removing = false }: { readonly asking?: boolean; readonly removing?: boolean } = {}): void {
    replace({ id: next++, threadId, title, kind: removing ? 'removing' : 'undo', asking })
  },
  /**
   * The worktree question was answered, or the rule's removal was: the folder went with the thread, or it stayed and Undo
   * can put everything back. The toast's time starts now.
   */
  answered(threadId: string, removed: boolean): void {
    update(threadId, offer => ({ ...offer, asking: false, kind: removed ? 'removed' : offer.kind === 'removing' ? 'undo' : offer.kind }))
  },
  /**
   * Undo was pressed and main kept the thread settled, in its own words, or (`refusal` undefined) no answer came back.
   * Said only while no later Settle has offered its own Undo, which would otherwise be taken away by older news.
   */
  refused(threadId: string, title: string, refusal: string | undefined): void {
    if (current !== null) return
    replace(refusal === undefined
      ? { id: next++, threadId, title, kind: 'unconfirmed', asking: false }
      : { id: next++, threadId, title, kind: 'refused', asking: false, refusal })
  },
  /** Holds the toast's time while the pointer or the focus is on it, and starts it again once both have left. */
  hold(on: boolean): void {
    if (held === on) return
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
