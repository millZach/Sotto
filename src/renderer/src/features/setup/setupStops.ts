import type { SottoPlatform } from '../../../../shared/platform'

/**
 * First-run setup's stops, in order (ADR-0200): each lights one control on a real page and puts a note beside it.
 * This module is the walk's plain rules, with no words and no React: which stops there are, where each one is, when
 * its task is done, and which stops a walk passes over.
 */
export type SetupStopId = 'welcome' | 'agents' | 'project' | 'thread' | 'omarchy' | 'microphone' | 'speech-model' | 'shortcut' | 'tailscale' | 'computers' | 'iphone' | 'end'

/** The page a stop is on, in the words `actions.navigate` takes. */
export type SetupPage =
  | { readonly navigation: 'threads' | 'home' }
  | { readonly navigation: 'settings'; readonly section: 'settings-providers' | 'settings-capture' | 'settings-hosts' }

export interface SetupStop {
  readonly id: SetupStopId
  readonly page: SetupPage
  /**
   * The control the stop lights, as selectors tried in order: the control itself, then what its page shows in its
   * place when the control is not there (a page that says why, say). None for the first and last notes.
   */
  readonly target: readonly string[]
  /** A project and a thread need a connected agent: with none ready the walk passes over these. */
  readonly needsAgent?: true
  /** The dictation stops, passed over while dictation is turned off. */
  readonly dictation?: true
}

/** What the walk knows about this computer, read from the app's own state and the pages it lights. */
export interface SetupFacts {
  readonly agentReady: boolean
  readonly projectAdded: boolean
  /** A thread is open with its composer on the page: the point where setup's first part is done. */
  readonly threadOpen: boolean
  readonly omarchyDone: boolean
  /** Settings' microphone test has heard a voice during this walk. */
  readonly microphoneHeard: boolean
  readonly speechModelChosen: boolean
  /** A dictation finished with text during the shortcut stop. */
  readonly shortcutTried: boolean
  readonly tailscaleOn: boolean
  readonly hostAdded: boolean
  readonly phoneAccess: boolean
  readonly dictationOn: boolean
}

/** The collapsed sidebar's Expand sidebar, which a stop lights when the control it wants is in the sidebar. */
export const SIDEBAR_RAIL = '[data-setup="expand-sidebar"]'

const STOPS: readonly SetupStop[] = [
  { id: 'welcome', page: { navigation: 'threads' }, target: [] },
  { id: 'agents', page: { navigation: 'settings', section: 'settings-providers' }, target: ['#settings-providers .providers-list', '#settings-providers'] },
  // In a narrow window the sidebar is a rail, and Add project and New thread are behind its Expand sidebar.
  { id: 'project', page: { navigation: 'threads' }, target: ['[data-setup="add-project"]', SIDEBAR_RAIL], needsAgent: true },
  { id: 'thread', page: { navigation: 'threads' }, target: ['form.thread-prompt', '[data-setup="new-thread"]', SIDEBAR_RAIL], needsAgent: true },
  { id: 'omarchy', page: { navigation: 'settings', section: 'settings-capture' }, target: ['[data-setting="omarchy-setup"]'], dictation: true },
  { id: 'microphone', page: { navigation: 'settings', section: 'settings-capture' }, target: ['.settings-microphone-test'], dictation: true },
  { id: 'speech-model', page: { navigation: 'settings', section: 'settings-capture' }, target: ['#settings-transcription'], dictation: true },
  { id: 'shortcut', page: { navigation: 'home' }, target: ['.dictate__bar', 'section.dictate'], dictation: true },
  { id: 'tailscale', page: { navigation: 'settings', section: 'settings-hosts' }, target: ['section.hosts-tailscale'] },
  { id: 'computers', page: { navigation: 'settings', section: 'settings-hosts' }, target: ['[data-setting="remote-hosts"]'] },
  { id: 'iphone', page: { navigation: 'settings', section: 'settings-hosts' }, target: ['.phones-card'] },
  { id: 'end', page: { navigation: 'threads' }, target: [] },
]

/** The stops this platform's walk has: Omarchy's only on Linux (ADR-0062). */
export function setupStops(platform: SottoPlatform): readonly SetupStop[] {
  return platform === 'linux' ? STOPS : STOPS.filter(stop => stop.id !== 'omarchy')
}

/** Whether a stop's own task is done, which decides whether its way forward reads Continue or Skip for now. */
export function stopDone(id: SetupStopId, facts: SetupFacts): boolean {
  switch (id) {
    case 'agents': return facts.agentReady
    case 'project': return facts.projectAdded
    case 'thread': return facts.threadOpen
    case 'omarchy': return facts.omarchyDone
    case 'microphone': return facts.microphoneHeard
    case 'speech-model': return facts.speechModelChosen
    case 'shortcut': return facts.shortcutTried
    case 'tailscale': return facts.tailscaleOn
    case 'computers': return facts.hostAdded
    case 'iphone': return facts.phoneAccess
    default: return true
  }
}

/** A stop the walk does not visit now: one that needs an agent while none is ready, or a dictation stop while dictation is off. */
export function passedOver(stop: SetupStop, facts: SetupFacts): boolean {
  return (stop.needsAgent === true && !facts.agentReady) || (stop.dictation === true && !facts.dictationOn)
}

/** The stop one step on from `at` (or back, with `step` -1), over the stops the walk passes over; `at` itself at either end. */
export function neighbouringStop(stops: readonly SetupStop[], at: number, step: 1 | -1, facts: SetupFacts): number {
  for (let next = at + step; next >= 0 && next < stops.length; next += step) if (!passedOver(stops[next]!, facts)) return next
  return at
}

/** The stops whose task is still to do, for the last note: every stop with a task that is not done, visited or not. */
export function stopsLeft(stops: readonly SetupStop[], facts: SetupFacts): readonly SetupStopId[] {
  return stops.filter(stop => stop.id !== 'welcome' && stop.id !== 'end' && !(stop.dictation === true && !facts.dictationOn) && !stopDone(stop.id, facts)).map(stop => stop.id)
}

export interface Box { readonly top: number; readonly left: number; readonly width: number; readonly height: number }

const GAP = 14
const EDGE = 12
/** A note is this wide where there is room, and no narrower than the least a sentence reads in. */
export const NOTE_WIDTH = 330
export const NOTE_MIN_WIDTH = 228

/**
 * Where a note goes: beside the control it lights, never over it (ADR-0200). It takes the first side with room for it,
 * to the right, then the left, then below, then above, narrowing to fit a side that is tight, as the sidebar is at the
 * smallest window. A control so large that no side has room keeps its note in the corner farthest from its middle.
 * With no control, the note is in the middle of the window.
 */
export function placeNote(target: Box | null, noteHeight: (width: number) => number, view: { readonly width: number; readonly height: number }): { top: number; left: number; width: number } {
  const widest = Math.min(NOTE_WIDTH, view.width - EDGE * 2)
  if (!target) {
    const height = noteHeight(widest)
    return { width: widest, left: Math.max(EDGE, (view.width - widest) / 2), top: Math.max(EDGE, (view.height - height) / 2) }
  }
  const clampTop = (top: number, height: number): number => Math.min(Math.max(EDGE, top), Math.max(EDGE, view.height - height - EDGE))
  const clampLeft = (left: number, width: number): number => Math.min(Math.max(EDGE, left), Math.max(EDGE, view.width - width - EDGE))
  const right = view.width - (target.left + target.width) - GAP - EDGE
  const left = target.left - GAP - EDGE
  for (const side of ['right', 'left'] as const) {
    const room = side === 'right' ? right : left
    if (room < NOTE_MIN_WIDTH) continue
    const width = Math.min(widest, room)
    const height = noteHeight(width)
    return { width, left: side === 'right' ? target.left + target.width + GAP : target.left - GAP - width, top: clampTop(target.top, height) }
  }
  const height = noteHeight(widest)
  const below = view.height - (target.top + target.height) - GAP - EDGE
  const above = target.top - GAP - EDGE
  if (below >= height) return { width: widest, left: clampLeft(target.left + target.width - widest, widest), top: target.top + target.height + GAP }
  if (above >= height) return { width: widest, left: clampLeft(target.left + target.width - widest, widest), top: target.top - GAP - height }
  // No side has room: the corner farthest from the control's middle covers the least of it.
  const middleX = target.left + target.width / 2, middleY = target.top + target.height / 2
  return { width: widest, left: middleX < view.width / 2 ? view.width - widest - EDGE : EDGE, top: middleY < view.height / 2 ? Math.max(EDGE, view.height - height - EDGE) : EDGE }
}
