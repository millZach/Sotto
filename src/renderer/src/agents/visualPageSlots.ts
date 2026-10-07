import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react'

/**
 * Which interactive visuals' pages run (ADR-0060). A page runs while its card is near the view or while it is shown
 * expanded, and at most three run at once. An expanded page always runs and counts toward the three; the cards in view
 * share what is left, in the order they came into view.
 */
export const LIVE_PAGES_MAX = 3
/** How far beyond the transcript's visible edge a card starts its page, so it is running as it scrolls in. */
const NEAR_MARGIN = '400px 0px'

let cardsInView: readonly symbol[] = []
let expandedPages: readonly symbol[] = []
const listeners = new Set<() => void>()
const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const changed = (): void => { for (const listener of listeners) listener() }

function place(list: readonly symbol[], slot: symbol, present: boolean): readonly symbol[] {
  if (list.includes(slot) === present) return list
  return present ? [...list, slot] : list.filter(item => item !== slot)
}
function setInView(slot: symbol, inView: boolean): void {
  const next = place(cardsInView, slot, inView)
  if (next !== cardsInView) { cardsInView = next; changed() }
}
function setExpanded(slot: symbol, expanded: boolean): void {
  const next = place(expandedPages, slot, expanded)
  if (next !== expandedPages) { expandedPages = next; changed() }
}

/** Whether a page may run now: shown expanded, or in view among the first that fit beside the expanded ones. */
export function mayRunPage(slot: symbol): boolean {
  if (expandedPages.includes(slot)) return true
  const index = cardsInView.indexOf(slot)
  return index > -1 && index < Math.max(0, LIVE_PAGES_MAX - expandedPages.length)
}

/**
 * Whether the page in `frame` may run. A card's page watches its frame against the transcript's scroller (the nearest
 * scrolling ancestor), which is what clips it; an expanded page runs for as long as it is open.
 */
export function useVisualPageSlot(frame: RefObject<HTMLElement | null>, expanded: boolean): boolean {
  const [slot] = useState(() => Symbol('visual-page-slot'))
  useEffect(() => {
    if (expanded) { setExpanded(slot, true); return () => setExpanded(slot, false) }
    const element = frame.current
    if (!element || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(entries => { for (const entry of entries) setInView(slot, entry.isIntersecting) },
      { root: scroller(element), rootMargin: NEAR_MARGIN })
    observer.observe(element)
    return () => { observer.disconnect(); setInView(slot, false) }
  }, [frame, expanded, slot])
  return useSyncExternalStore(subscribe, () => mayRunPage(slot))
}

/** The nearest ancestor that scrolls vertically: the transcript, in a thread. Null (the window) when there is none. */
function scroller(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return parent
  }
  return null
}
