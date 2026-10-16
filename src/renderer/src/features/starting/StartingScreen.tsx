import React, { useCallback, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react'

import type { HostsBridge, HostsState } from '../../../../shared/hosts'
import { useOptionalAgents } from '../../agents/AgentContext'
import { Button } from '../../components/Button'
import { SottoMark } from '../../components/SottoMark'
import { prefersReducedMotion } from '../../state/reducedMotion'
import { LATE_AFTER_MS, LEAVE_MS, REVEAL_AFTER_MS, startingView, type DotState } from './startingView'
import './startingScreen.css'

/** Set once this window has opened the app, so a reload of the same window goes straight to it. */
export const STARTING_SCREEN_DONE_KEY = 'sotto:starting-screen:done'
/**
 * When this window first showed the starting screen. A reload before the app opens shows the screen again, since Sotto is
 * still not ready, and counts the ten seconds from here rather than from the reload.
 */
export const STARTING_SCREEN_SINCE_KEY = 'sotto:starting-screen:since'

function openedBefore(): boolean {
  try { return sessionStorage.getItem(STARTING_SCREEN_DONE_KEY) === '1' } catch { return false }
}

function rememberOpened(): void {
  // A window that cannot remember shows the screen again on a reload, where everything has already settled.
  try {
    sessionStorage.setItem(STARTING_SCREEN_DONE_KEY, '1')
    sessionStorage.removeItem(STARTING_SCREEN_SINCE_KEY)
  } catch { /* nothing to keep */ }
}

/** When this window first showed the screen: kept from before a reload, or now, remembered for the next one. */
function firstShownAt(): number {
  const now = Date.now()
  try {
    const kept = Number(sessionStorage.getItem(STARTING_SCREEN_SINCE_KEY) ?? Number.NaN)
    // A time after now means the clock moved back; the ten seconds start again rather than stretching.
    if (Number.isFinite(kept) && kept > 0 && kept <= now) return kept
    sessionStorage.setItem(STARTING_SCREEN_SINCE_KEY, String(now))
  } catch { /* a window that cannot remember starts the ten seconds again on a reload */ }
  return now
}

/**
 * Whether this window can show the starting screen at all: it needs main's agent state to know what is connecting. An
 * end-to-end run shows it only when its spec asks, so the journeys and design captures that open straight onto a page
 * keep doing so.
 */
function startingScreenAvailable(): boolean {
  if (window.sotto?.agents === undefined) return false
  const e2e = window.sottoE2E
  return e2e === undefined || e2e.startingScreen === true
}

/** What a screen reader hears after each name in the row of dots. */
const DOT_WORDS: Record<DotState, string> = {
  ready: 'ready', connecting: 'connecting', late: 'not answering', 'not-connected': 'not connected',
}

interface HostsReading { readonly state: HostsState | null; readonly known: boolean }

/** The saved hosts as main last published them, and whether main has answered at all. */
function useHostsReading(bridge: HostsBridge | undefined): HostsReading {
  const [reading, setReading] = useState<HostsReading>({ state: null, known: bridge === undefined })
  useEffect(() => {
    if (bridge === undefined) return
    let live = true
    void bridge.get().then(state => { if (live) setReading({ state, known: true }) }, () => { if (live) setReading(current => ({ ...current, known: true })) })
    const off = bridge.onChanged(state => { if (live) setReading({ state, known: true }) })
    return () => { live = false; off() }
  }, [bridge])
  return reading
}

/** One call per milestone: `delay` after `since` (by default, when the caller mounted), `fired` turns true and stays so. */
function useElapsed(delay: number, since?: number): boolean {
  const [start] = useState(() => since ?? Date.now())
  const [fired, setFired] = useState(() => Date.now() - start >= delay)
  useEffect(() => {
    if (fired) return
    const timer = setTimeout(() => setFired(true), Math.min(delay, Math.max(0, delay - (Date.now() - start))))
    return () => clearTimeout(timer)
  }, [delay, start, fired])
  return fired
}

/** A modal dialog over the window, such as a saved host's SSH question: what the Dictate room checks for too. */
const MODAL_DIALOG = '[role="dialog"]:not([aria-modal="false"]), [role="alertdialog"], dialog[open]'

/**
 * Gives `target` focus now, unless a modal dialog is open. Then focus stays where the dialog has it, so a key meant for
 * the dialog never presses `target`, and once no dialog is left `target` takes focus only if the dialog left it
 * nowhere. Returns what stops the wait.
 */
function focusUnlessDialog(target: RefObject<HTMLElement | null>): () => void {
  if (document.querySelector(MODAL_DIALOG) === null) {
    target.current?.focus()
    return () => undefined
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const observer = new MutationObserver(() => {
    // After the dialog's own focus return, which runs once its removal has been committed.
    timer ??= setTimeout(() => {
      timer = undefined
      if (document.querySelector(MODAL_DIALOG) !== null) return
      const active = document.activeElement
      if (active === null || active === document.body) target.current?.focus()
      stop()
    }, 0)
  })
  const stop = (): void => { observer.disconnect(); clearTimeout(timer) }
  observer.observe(document.body, { childList: true, subtree: true })
  return stop
}

interface StartingScreenProps {
  readonly leaving: boolean
  readonly hosts: HostsBridge | undefined
  /** Everything settled, or the user chose to open without what is left: `revealed` says whether any words showed. */
  readonly onOpen: (revealed: boolean) => void
}

/**
 * The starting screen itself (ADR-0086): the Sotto mark, one line saying what Sotto is doing now, a dot and name for
 * each provider and host it waits for, and after ten seconds the late line, naming what has not answered or saying
 * Sotto has not loaded your threads, with the button that opens Sotto anyway.
 */
function StartingScreen({ leaving, hosts, onOpen }: StartingScreenProps): ReactNode {
  const agents = useOptionalAgents()
  const hostsReading = useHostsReading(hosts)
  // The ten seconds run from when this window first showed the screen; the words are kept back afresh after a reload.
  const [since] = useState(firstShownAt)
  const late = useElapsed(LATE_AFTER_MS, since)
  const waited = useElapsed(REVEAL_AFTER_MS)
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set())
  const agentState = agents?.state ?? null
  const live = agentState !== null && agentState.stale !== true
  const view = startingView({
    agent: live ? agentState : null,
    agentKnown: live || agents?.error != null,
    hosts: hostsReading.state,
    hostsKnown: hostsReading.known,
    late,
    seen,
  })
  // Once the words show they stay, so a provider connecting right after them still fades rather than vanishing.
  const [shown, setShown] = useState(false)
  const revealed = shown || waited || view.pending.length > 0 || leaving
  const buttonRef = useRef<HTMLButtonElement>(null)
  const noteId = useId()
  // Only a late line that shows can give its button focus: a hidden one cannot take it.
  const hasLateNote = view.late !== null && revealed

  useEffect(() => { if (revealed && !shown) setShown(true) }, [revealed, shown])

  useEffect(() => {
    if (view.pending.every(key => seen.has(key))) return
    setSeen(current => new Set([...current, ...view.pending]))
  }, [view.pending, seen])

  useEffect(() => {
    if (!leaving && view.settled) onOpen(revealed)
  }, [leaving, view.settled, revealed, onOpen])

  // The button takes focus once, when it appears: nothing on the screen is focusable before it. An SSH question asked
  // over the screen keeps focus; when it closes and leaves focus nowhere, the button takes it.
  useEffect(() => hasLateNote ? focusUnlessDialog(buttonRef) : undefined, [hasLateNote])

  return (
    <div className={leaving ? 'starting-screen starting-screen--leaving' : 'starting-screen'}>
      <div className="starting-screen__block" data-revealed={revealed ? 'true' : 'false'}>
        <SottoMark className="starting-screen__mark" />
        <p className="starting-screen__line" role="status">{revealed ? view.line : ''}</p>
        {revealed && view.dots.length > 0 ? (
          <ul className="starting-screen__items" aria-label="Providers and hosts">
            {view.dots.map(dot => (
              <li key={dot.key} className="starting-screen__item">
                <span className="starting-screen__dot" data-state={dot.state} aria-hidden="true" />
                <span className="starting-screen__name">{dot.name}</span>
                <span className="tt-visually-hidden">, {DOT_WORDS[dot.state]}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {view.late !== null ? (
          <div className="starting-screen__late">
            <p id={noteId}>{view.late.text}</p>
            <Button ref={buttonRef} variant="secondary" aria-describedby={noteId} disabled={leaving} onClick={() => onOpen(true)}>
              {view.late.button}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export interface StartingScreenGateProps {
  /** Settings have loaded, or failed to: the gate can decide whether this launch shows the screen. */
  readonly settingsSettled: boolean
  /** First-run setup is finished and not showing, so the app would open on a page of its own. */
  readonly eligible: boolean
  /** Seats the screen under the window's strip, as the loading and setup views are. */
  readonly frame: (screen: ReactNode) => ReactNode
  readonly hosts?: HostsBridge | undefined
  /** The app. */
  readonly children: ReactNode
}

type GatePhase = 'deciding' | 'starting' | 'leaving' | 'open'

/**
 * Shows the starting screen in place of the app at launch, until every provider on this computer and every saved host
 * Sotto is connecting has settled, or the user opens Sotto without what is left. It decides once, when settings load:
 * first-run setup, a window that already opened the app (a reload after it opened), and a window that cannot know what
 * is connecting all go straight to the app. A reload before the app opened shows the screen again on the same ten
 * seconds. Once open it never comes back, whatever disconnects later.
 */
export function StartingScreenGate({ settingsSettled, eligible, frame, hosts = window.sotto?.hosts, children }: StartingScreenGateProps): ReactNode {
  const [phase, setPhase] = useState<GatePhase>(() => startingScreenAvailable() && !openedBefore() ? 'deciding' : 'open')
  // Decided in the render that has the settings, so the app never paints a frame before the screen.
  if (phase === 'deciding' && settingsSettled) setPhase(eligible ? 'starting' : 'open')

  useEffect(() => { if (phase === 'open') rememberOpened() }, [phase])
  useEffect(() => {
    if (phase !== 'leaving') return
    const timer = setTimeout(() => setPhase('open'), LEAVE_MS)
    return () => clearTimeout(timer)
  }, [phase])

  const open = useCallback((revealed: boolean): void => {
    // Words that showed fade before the app replaces them; with reduced motion, or with nothing shown, it is one step.
    setPhase(current => current !== 'starting' ? current : revealed && !prefersReducedMotion() ? 'leaving' : 'open')
  }, [])

  if (phase === 'deciding' || phase === 'open') return children
  return frame(<StartingScreen leaving={phase === 'leaving'} hosts={hosts} onOpen={open} />)
}
