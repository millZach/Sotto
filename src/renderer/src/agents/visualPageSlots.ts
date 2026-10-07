import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react'

/**
 * Which interactive visuals' pages run (ADR-0060). A page runs while its card is near the view or while it is shown
 * expanded, and at most three run at once. An expanded page always runs and counts toward the three; the cards in view
 * share what is left, in the order they came into view. A card in view past the three can be run on request, which
 * stops the page that came into view first: the one the reader has most likely scrolled furthest from.
 */
export const LIVE_PAGES_MAX = 3
/** How far beyond the transcript's visible edge a card starts its page, so it is running as it scrolls in. */
const NEAR_MARGIN = '400px 0px'

let cardsInView: readonly symbol[] = []
let expandedPages: readonly symbol[] = []
const listeners = new Set<() => void>()
const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const changed = (): void => { for (const listener of listeners) listener() }

/** `list` with `slot` in it or out of it, added at the end; the same list when nothing changes. */
function withSlot(list: readonly symbol[], slot: symbol, present: boolean): readonly symbol[] {
  if (list.includes(slot) === present) return list
  return present ? [...list, slot] : list.filter(item => item !== slot)
}
function setInView(slot: symbol, inView: boolean): void {
  const next = withSlot(cardsInView, slot, inView)
  if (next !== cardsInView) { cardsInView = next; changed() }
}
function setExpanded(slot: symbol, expanded: boolean): void {
  const next = withSlot(expandedPages, slot, expanded)
  if (next !== expandedPages) { expandedPages = next; changed() }
}

const room = (): number => Math.max(0, LIVE_PAGES_MAX - expandedPages.length)

/**
 * Where a page stands: `running`; `crowded`, in view but past the pages that may run at once; or `away`, out of view.
 */
export type PageSlotState = 'running' | 'crowded' | 'away'
export function pageSlotState(slot: symbol): PageSlotState {
  if (expandedPages.includes(slot)) return 'running'
  const index = cardsInView.indexOf(slot)
  if (index < 0) return 'away'
  return index < room() ? 'running' : 'crowded'
}
export const mayRunPage = (slot: symbol): boolean => pageSlotState(slot) === 'running'

/** Runs a crowded page now, stopping the running page that came into view first. */
function runCrowded(slot: symbol): void {
  if (pageSlotState(slot) !== 'crowded' || room() === 0) return
  const others = cardsInView.filter(item => item !== slot)
  const running = others.slice(0, room())
  cardsInView = [...running.slice(1), slot, running[0]!, ...others.slice(room())]
  changed()
}

/**
 * Where the page in `frame` stands, and a way to run it when it is crowded. A card's page watches its frame against the
 * transcript's scroller (the nearest scrolling ancestor), which is what clips it; an expanded page runs for as long as
 * it is open.
 */
export function useVisualPageSlot(frame: RefObject<HTMLElement | null>, expanded: boolean): { readonly state: PageSlotState; readonly runNow: () => void } {
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
  const state = useSyncExternalStore(subscribe, () => pageSlotState(slot))
  return { state, runNow: () => runCrowded(slot) }
}

/** The nearest ancestor that scrolls vertically: the transcript, in a thread. Null (the window) when there is none. */
function scroller(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return parent
  }
  return null
}
