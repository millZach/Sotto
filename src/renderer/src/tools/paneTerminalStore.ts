import { useSyncExternalStore } from 'react'
import { TerminalStore } from './terminalStore'

/** The pane terminal drawer's own shells: separate sessions from Tools' Terminal surface, which never see each other. */
export const paneTerminalStore = new TerminalStore('drawer')

export const PANE_TERMINAL_STORAGE_KEY = 'sotto.paneTerminal'
const MAX_ENTRIES = 64

/** What a pane's drawer shows: its shells, or the Council (ADR-0177; Owl only), each a tab on the drawer's bar. */
export type PaneDrawerView = 'terminal' | 'council'

export interface PaneTerminalState {
  readonly open: boolean
  /** A drawer height in pixels, or null for the default: one third of the pane, recomputed as it resizes. */
  readonly height: number | null
  readonly view: PaneDrawerView
  /** The drawer's height while it shows the Council, or null for the default: half the pane. */
  readonly councilHeight: number | null
}

const DEFAULT_STATE: PaneTerminalState = { open: false, height: null, view: 'terminal', councilHeight: null }

/** The view a drawer shows: the one it holds, but its shells while the Council is off. */
export function shownView(state: PaneTerminalState, council: boolean): PaneDrawerView {
  return council ? state.view : 'terminal'
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function browserStorage(): StorageLike | null {
  try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null }
}

function parseStoredStates(raw: string | null): Map<string, PaneTerminalState> {
  const states = new Map<string, PaneTerminalState>()
  if (!raw) return states
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return states
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof id !== 'string' || !id) continue
      const record = value as { open?: unknown; height?: unknown; view?: unknown; councilHeight?: unknown } | null
      const open = typeof record?.open === 'boolean' ? record.open : false
      const pixels = (held: unknown): number | null => typeof held === 'number' && Number.isFinite(held) ? held : null
      states.set(id, { open, height: pixels(record?.height), view: record?.view === 'council' ? 'council' : 'terminal', councilHeight: pixels(record?.councilHeight) })
    }
  } catch { /* A bad record falls back to the default; nothing here is worth losing the window over. */ }
  return states
}

/**
 * Each pane's own terminal drawer: open or closed, and its height, remembered per thread the way the split
 * layout remembers its own sizes (`sotto.threadWorkspace.layout`). The shells themselves live in
 * `paneTerminalStore`; this store only remembers whether a thread's drawer is open and how tall it is.
 */
export class PaneTerminalChromeStore {
  private states: Map<string, PaneTerminalState> | null = null
  private readonly listeners = new Set<() => void>()
  /** Threads whose drawer should take keyboard focus once its terminal is ready, set by the Ctrl+J shortcut. */
  private readonly focusRequests = new Set<string>()
  constructor(private readonly storage: StorageLike | null = null, private readonly key = PANE_TERMINAL_STORAGE_KEY) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private load(): Map<string, PaneTerminalState> {
    if (this.states === null) this.states = parseStoredStates(this.read())
    return this.states
  }
  private read(): string | null {
    try { return this.storage?.getItem(this.key) ?? null } catch { return null }
  }

  get(threadId: string): PaneTerminalState { return this.load().get(threadId) ?? DEFAULT_STATE }

  setOpen(threadId: string, open: boolean): void { this.update(threadId, { open }) }
  /** Opens the drawer on one of its views. */
  show(threadId: string, view: PaneDrawerView): void { this.update(threadId, { open: true, view }) }
  /**
   * A header button's press, or Ctrl+J's for the terminal: hides the drawer while it shows this view, and otherwise
   * shows this view. `council` says whether the Council is on, since without it the drawer shows only its shells.
   */
  toggle(threadId: string, view: PaneDrawerView, council: boolean): void {
    const state = this.get(threadId)
    if (state.open && shownView(state, council) === view) this.setOpen(threadId, false)
    else this.show(threadId, view)
  }
  /** Each view keeps its own height. */
  setHeight(threadId: string, height: number, view: PaneDrawerView = 'terminal'): void { this.update(threadId, view === 'council' ? { councilHeight: height } : { height }) }
  /** Resets a view to its default height (a third of the pane, half for the Council), which then tracks the pane's size until dragged again. */
  resetHeight(threadId: string, view: PaneDrawerView = 'terminal'): void { this.update(threadId, view === 'council' ? { councilHeight: null } : { height: null }) }

  /** Asks the next mount of this thread's drawer to focus its terminal once ready; consumed at most once. */
  requestFocus(threadId: string): void { this.focusRequests.add(threadId) }
  consumeFocusRequest(threadId: string): boolean {
    const had = this.focusRequests.has(threadId)
    this.focusRequests.delete(threadId)
    return had
  }

  private update(threadId: string, patch: Partial<PaneTerminalState>): void {
    const states = this.load()
    const current = states.get(threadId) ?? DEFAULT_STATE
    const next = { ...current, ...patch }
    if (next.open === current.open && next.height === current.height && next.view === current.view && next.councilHeight === current.councilHeight) return
    // Re-inserting moves this thread to the end, so trimming drops the longest-untouched entries first.
    states.delete(threadId)
    states.set(threadId, next)
    while (states.size > MAX_ENTRIES) {
      const oldest = states.keys().next().value
      if (oldest === undefined) break
      states.delete(oldest)
    }
    this.persist()
    this.emit()
  }
  private persist(): void {
    try {
      const object: Record<string, PaneTerminalState> = {}
      for (const [id, value] of this.load()) object[id] = value
      this.storage?.setItem(this.key, JSON.stringify(object))
    } catch { /* Storage can be unavailable; the drawer still holds for this session. */ }
  }
  private emit(): void { for (const listener of [...this.listeners]) listener() }
}

export const paneTerminalChromeStore = new PaneTerminalChromeStore(browserStorage())

export function usePaneTerminalChrome(threadId: string, store: PaneTerminalChromeStore = paneTerminalChromeStore): PaneTerminalState {
  return useSyncExternalStore(store.subscribe, () => store.get(threadId))
}
