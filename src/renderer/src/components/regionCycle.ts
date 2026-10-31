import { useEffect } from 'react'
import type { SottoPlatform } from '../../../shared/platform'
import { fixedKeyFree, type ThreadShortcutSettings } from '../agents/threadShortcuts'
import { chordBelongsElsewhere } from '../tools/changesShortcut'

/**
 * F6 and Shift+F6 move between a page's regions (ADR-0164, Zach's pick A of #1827), as they move between the panes of
 * other Windows apps. A region is an element marked `data-region`: the sidebar, a thread pane and its composer, Tools
 * while it is open, or a page's room where it holds no region of its own (the Threads page's workspace with no pane). F6 visits them in the order they are drawn, except that in a split
 * the trip from the sidebar starts at the focused pane and goes round the others before it comes back; Shift+F6 goes
 * the other way, so from the sidebar it reaches the focused pane's composer first.
 *
 * Each region is entered at its entry: the control marked `data-region-entry="1"` (the thread list's stop, the rail's),
 * then `"2"` (the search field), then a pane's transcript or a composer's field, then its first control.
 */
export const REGION = 'data-region'

const TABBABLE = 'button:not(:disabled), a[href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [contenteditable="true"], [tabindex]'
const KIND_ENTRY: Partial<Record<string, string>> = {
  pane: '[role="log"]',
  composer: '.prompt-editor[contenteditable="true"], textarea:not(:disabled)',
}

const shown = (element: Element): boolean => element.closest('[hidden], [inert]') === null
const kindOf = (region: Element): string => region.getAttribute(REGION) ?? ''

/** The regions on screen in the order they are drawn. A room that holds regions (the Threads page's) is not one itself. */
export function pageRegions(root: ParentNode = document): HTMLElement[] {
  const all = [...root.querySelectorAll<HTMLElement>(`[${REGION}]`)].filter(shown)
  return all.filter(region => kindOf(region) !== 'room' || !all.some(other => other !== region && region.contains(other)))
}

/** The innermost region holding an element. */
function regionOf(element: Element | null, regions: readonly HTMLElement[]): HTMLElement | undefined {
  return element === null ? undefined : regions.filter(region => region.contains(element)).at(-1)
}

/** Where focus lands in a region: its marked entry, its kind's own, or its first control, never one in a region inside it. */
export function regionEntry(region: HTMLElement, regions: readonly HTMLElement[] = pageRegions()): HTMLElement | null {
  const own = (element: Element): boolean => shown(element) && regionOf(element, regions) === region
  const focusable = (element: HTMLElement): boolean => element.matches(TABBABLE) && own(element)
    && !(element.getAttribute('tabindex') === '-1' && !element.matches('[role="log"]'))
  for (const marked of ['1', '2']) {
    for (const entry of region.querySelectorAll<HTMLElement>(`[data-region-entry="${marked}"]`)) {
      if (!own(entry)) continue
      if (focusable(entry)) return entry
      // A list marked as the entry is entered at its stop, the control holding tabindex 0.
      const stop = [...entry.querySelectorAll<HTMLElement>('[tabindex="0"]')].find(own)
      if (stop !== undefined) return stop
    }
  }
  const kind = KIND_ENTRY[kindOf(region)]
  const typical = kind === undefined ? undefined : [...region.querySelectorAll<HTMLElement>(kind)].find(own)
  if (typical !== undefined) return typical
  return [...region.querySelectorAll<HTMLElement>(TABBABLE)].find(focusable) ?? null
}

/** The pane a trip from outside the panes starts from, kept until the trip leaves them, so it goes round every pane once. */
let anchor: HTMLElement | null = null

/** The regions in the order F6 visits them now, from `current`. */
export function regionOrder(regions: readonly HTMLElement[], current: HTMLElement | undefined, backwards: boolean): HTMLElement[] {
  const panes = regions.filter(region => kindOf(region) === 'pane')
  if (panes.length === 0) return [...regions]
  const paneOf = (region: HTMLElement | undefined): HTMLElement | undefined => region === undefined ? undefined : panes.find(pane => pane.contains(region))
  const inside = paneOf(current)
  if (inside === undefined || anchor === null || !panes.includes(anchor)) {
    const focused = panes.findIndex(pane => pane.hasAttribute('data-focused'))
    const start = Math.max(0, focused)
    // From outside the panes F6 enters the focused one; Shift+F6 reaches it last, so its composer is the first stop.
    anchor = inside ?? panes[backwards && inside === undefined ? (start + 1) % panes.length : start]!
  }
  const first = regions.findIndex(region => paneOf(region) !== undefined)
  const last = regions.length - 1 - [...regions].reverse().findIndex(region => paneOf(region) !== undefined)
  const from = panes.indexOf(anchor)
  const rotated = [...panes.slice(from), ...panes.slice(0, from)].flatMap(pane => regions.filter(region => paneOf(region) === pane))
  return [...regions.slice(0, first), ...rotated, ...regions.slice(last + 1)]
}

/** Moves the focus to the next region, or the one before it; false when there is none to go to. */
export function cycleRegions(backwards: boolean, root: Document = document): boolean {
  const regions = pageRegions(root)
  if (regions.length === 0) return false
  const current = regionOf(root.activeElement, regions)
  const order = regionOrder(regions, current, backwards)
  const at = current === undefined ? -1 : order.indexOf(current)
  for (let step = 1; step <= order.length; step += 1) {
    const index = at === -1 ? (backwards ? order.length - step : step - 1) : (at + (backwards ? -step : step) + order.length * step) % order.length
    const next = order[index]!
    if (next === current) return false
    const entry = regionEntry(next, regions)
    if (entry === null) continue
    entry.focus()
    // A control the page has drawn out of sight takes no focus; the region after it is tried instead.
    if (root.activeElement !== entry) continue
    if (!order.some(region => kindOf(region) === 'pane' && region.contains(next))) anchor = null
    return true
  }
  return false
}

/** F6 or Shift+F6 alone. */
const regionKey = (event: KeyboardEvent): boolean => event.key === 'F6' && !event.ctrlKey && !event.altKey && !event.metaKey

/**
 * F6 and Shift+F6 from anywhere in the window, standing down for dictation's own keys and in a terminal, which keeps
 * them; while a dialog is open they do nothing, rather than letting the window drop the focus.
 */
export function useRegionCycle({ settings, platform }: { readonly settings: ThreadShortcutSettings | null | undefined; readonly platform: SottoPlatform }): void {
  const forward = fixedKeyFree(settings, 'f6', platform), back = fixedKeyFree(settings, 'shift+f6', platform)
  useEffect(() => {
    if (!forward && !back) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || !regionKey(event) || !(event.shiftKey ? back : forward) || chordBelongsElsewhere(event.target)) return
      event.preventDefault()
      if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]') !== null) return
      cycleRegions(event.shiftKey)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [forward, back])
}
