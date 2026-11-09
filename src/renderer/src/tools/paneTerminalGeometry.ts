import type { PaneDrawerView } from './paneTerminalStore'

/** Shorter than this, a terminal has nowhere useful to put a cursor. */
const MIN_DRAWER_HEIGHT = 120
/** Shorter than this, the Council's figures and its Ask form have no room beside each other (ADR-0177). */
const MIN_COUNCIL_HEIGHT = 240
/**
 * What the header, transcript and composer keep between them, whatever the drawer's height: roughly the
 * header's own 44px, the composer's own room, and about 160px of conversation, so the thread stays readable.
 */
const MIN_CONVERSATION_AREA = 320
/** A little wider and taller than a 13px monospace cell, so the estimate errs towards a shell narrower than its view. */
const CELL_WIDTH = 8
const CELL_HEIGHT = 17
/** The bar, the hint line and the view's padding: the room in the drawer that is not the terminal's grid. */
const CHROME_HEIGHT = 80
const CHROME_WIDTH = 40

/** The cell grid a new drawer shell should start at, estimated from the drawer's width and height in pixels. */
export function drawerShellSize(width: number, height: number): { cols: number; rows: number } | undefined {
  if (width <= 0) return undefined
  return {
    cols: Math.max(20, Math.min(500, Math.floor((width - CHROME_WIDTH) / CELL_WIDTH))),
    rows: Math.max(5, Math.min(300, Math.floor((height - CHROME_HEIGHT) / CELL_HEIGHT))),
  }
}

/**
 * How tall a pane's drawer is, and the bounds it is held to: the saved height, else a third of the pane (half while it
 * shows the Council), kept between the view's minimum (more while the terminal's search is open) and what leaves the
 * conversation its room. `paneHeight` is the `.thread-pane`'s client height, 0 while unmeasured.
 */
export function drawerHeight(paneHeight: number, saved: number | null, searchOpen = false, view: PaneDrawerView = 'terminal'): { readonly height: number; readonly min: number; readonly max: number } {
  const council = view === 'council'
  // The search row takes 48px; another 16px keeps one output row readable even at the largest text size.
  const min = council ? MIN_COUNCIL_HEIGHT : MIN_DRAWER_HEIGHT + (searchOpen ? 64 : 0)
  const max = paneHeight > 0 ? Math.max(min, paneHeight - MIN_CONVERSATION_AREA) : Math.max(min, saved ?? min)
  const clamp = (value: number): number => Math.min(max, Math.max(min, value))
  return { height: clamp(saved ?? (paneHeight > 0 ? Math.round(paneHeight / (council ? 2 : 3)) : council ? 320 : 200)), min, max }
}
