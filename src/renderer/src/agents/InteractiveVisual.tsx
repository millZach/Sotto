import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  VISUAL_IPC_ESCAPE, VISUAL_IPC_HEIGHT, VISUAL_IPC_STEP, VISUAL_IPC_THEME, VISUAL_PAGE_HEIGHT_MIN,
  clampVisualPageHeight, type VisualStepPlace, type VisualTheme,
} from '../../../shared/visualGuest'
import { VISUAL_PARTITION } from '../../../shared/visualPages'
import { useReducedMotion } from '../state/reducedMotion'
import { useDiagramPalette, type DiagramPalette } from './diagrams/diagramPalette'
import { useVisualPageSlot, type PageSlotState } from './visualPageSlots'
import './interactiveVisual.css'

/**
 * An interactive visual's page in its card (ADR-0060). The page is an agent's own HTML, so it never runs in this
 * window: main serves it once, from its own store, into a `<webview>` guest on a sealed in-memory session. This side
 * only asks for the page's address, sizes the guest to the height Sotto's guest preload measured, and sends the
 * walkthrough's step and the theme in. Which pages run is `visualPageSlots.ts`'s to say.
 */

/** The guest's side of the `<webview>` element this file uses; Electron's own type is not in the renderer's build. */
interface VisualGuestElement extends HTMLElement {
  send(channel: string, ...args: unknown[]): Promise<void>
}
interface GuestIpcEvent extends Event { readonly channel: string; readonly args: readonly unknown[] }

const HEX3 = /^#([\da-f])([\da-f])([\da-f])$/iu
const hex6 = (colour: string): string => colour.replace(HEX3, (_all, r: string, g: string, b: string) => `#${r}${r}${g}${g}${b}${b}`).toLowerCase()

/** The theme a page is given: the same colours a diagram is drawn in, by the names the tool's description gives agents. */
export function visualThemeFrom(palette: DiagramPalette, reducedMotion: boolean): VisualTheme {
  return {
    mode: palette.dark ? 'dark' : 'light', reducedMotion,
    tokens: {
      '--sotto-text': hex6(palette.text), '--sotto-muted': hex6(palette.muted), '--sotto-line': hex6(palette.line),
      '--sotto-background': hex6(palette.block), '--sotto-surface': hex6(palette.node), '--sotto-border': hex6(palette.nodeBorder),
      '--sotto-group': hex6(palette.group), '--sotto-note': hex6(palette.note), '--sotto-accent': hex6(palette.accent),
    },
  }
}

/**
 * What the frame holds: nothing yet; the page, at its one-time address; main's reason it is not shown; or, after it was
 * shown, why it is gone (it failed to load, or its renderer stopped), which the reader can try again.
 */
type PageState =
  | { readonly phase: 'waiting' }
  | { readonly phase: 'open'; readonly url: string }
  | { readonly phase: 'refused'; readonly reason: string }
  | { readonly phase: 'lost'; readonly reason: string }

interface LoadFailure extends Event { readonly isMainFrame: boolean; readonly errorCode: number }
interface LoadCommitted extends Event { readonly httpResponseCode: number }
/** Chromium's code for a load that was aborted, as when the page is replaced; not a failure to report. */
const LOAD_ABORTED = -3

export function InteractiveVisualPage({ threadId, visualId, title, step, expanded = false, fallbackHint, onEscape }: {
  readonly threadId: string | undefined
  readonly visualId: string
  readonly title: string
  /** The walkthrough's place, sent to the page whenever it changes. */
  readonly step: VisualStepPlace
  /** Shown expanded over the window: the page fills the room it is given and runs for as long as it is open. */
  readonly expanded?: boolean
  /** Where the reader can turn when the page is not shown, after the reason: "Its steps are below." */
  readonly fallbackHint: string
  /** Escape pressed inside the page: focus goes back to the card. */
  readonly onEscape: () => void
}): ReactNode {
  const frame = useRef<HTMLDivElement>(null)
  const guest = useRef<VisualGuestElement | null>(null)
  const [height, setHeight] = useState(VISUAL_PAGE_HEIGHT_MIN)
  const [ready, setReady] = useState(false)
  const [page, setPage] = useState<PageState>({ phase: 'waiting' })
  // Each try asks main for a new address: Try again bumps it.
  const [attempt, setAttempt] = useState(0)
  const palette = useDiagramPalette()
  const reducedMotion = useReducedMotion()
  const theme = visualThemeFrom(palette, reducedMotion)
  const themeKey = JSON.stringify(theme)
  const stepKey = JSON.stringify(step)
  const slot = useVisualPageSlot(frame, expanded)
  const running = slot.state === 'running'
  const latest = useRef({ theme, step, onEscape })
  latest.current = { theme, step, onEscape }

  // A fresh one-time address each time the page starts; the page starts again from the top when it comes back.
  useEffect(() => {
    if (!running) { setPage({ phase: 'waiting' }); setReady(false); return }
    const bridge = window.sotto?.visuals
    if (!bridge || threadId === undefined) { setPage({ phase: 'refused', reason: 'This window cannot show the page.' }); return }
    let current = true
    setPage({ phase: 'waiting' })
    bridge.open({ threadId, visualId, theme: latest.current.theme }).then(result => {
      if (current) setPage(result.ok ? { phase: 'open', url: result.url } : { phase: 'refused', reason: result.reason })
    }, () => { if (current) setPage({ phase: 'lost', reason: 'Sotto could not open the page.' }) })
    return () => { current = false }
  }, [running, threadId, visualId, attempt])

  // The guest's own events: its first paint and finished load, a load that failed, the height Sotto's preload measured,
  // Escape, and its renderer stopping.
  useEffect(() => {
    const element = guest.current
    if (page.phase !== 'open' || !element) return
    const send = sendTo(element)
    // Ready once the page's own script has run, so a listener it attached at the top is there; the step and theme go
    // again once the whole load has finished, for a page that attaches its listener later.
    const onReady = (): void => setReady(true)
    const onLoaded = (): void => { send.theme(latest.current.theme); send.step(latest.current.step) }
    const onFailed = (event: Event): void => {
      const failure = event as LoadFailure
      if (!failure.isMainFrame || failure.errorCode === LOAD_ABORTED) return
      setReady(false)
      setPage({ phase: 'lost', reason: 'The page could not be loaded.' })
    }
    // An address that is spent or unknown is answered with Not found, which commits as a page rather than failing.
    const onCommitted = (event: Event): void => {
      if ((event as LoadCommitted).httpResponseCode < 400) return
      setReady(false)
      setPage({ phase: 'lost', reason: 'The page could not be loaded.' })
    }
    const onMessage = (event: Event): void => {
      const { channel, args } = event as GuestIpcEvent
      if (channel === VISUAL_IPC_HEIGHT) setHeight(clampVisualPageHeight(args[0]))
      else if (channel === VISUAL_IPC_ESCAPE) latest.current.onEscape()
    }
    const onGone = (): void => { setReady(false); setPage({ phase: 'lost', reason: 'The page stopped.' }) }
    const events: [string, (event: Event) => void][] = [['dom-ready', onReady], ['did-finish-load', onLoaded], ['did-fail-load', onFailed], ['did-navigate', onCommitted],
      ['ipc-message', onMessage], ['render-process-gone', onGone]]
    for (const [name, listener] of events) element.addEventListener(name, listener)
    return () => { for (const [name, listener] of events) element.removeEventListener(name, listener) }
  }, [page])

  useEffect(() => {
    if (ready && guest.current) sendTo(guest.current).theme(latest.current.theme)
  }, [ready, themeKey])
  useEffect(() => {
    if (ready && guest.current) sendTo(guest.current).step(latest.current.step)
  }, [ready, stepKey])

  const state = page.phase === 'open' ? (ready ? 'running' : 'loading') : page.phase === 'waiting' && slot.state === 'crowded' ? 'crowded' : page.phase
  return <div ref={frame} className="interactive-visual" data-state={state}
    data-fill={expanded || undefined} style={expanded || page.phase === 'refused' || page.phase === 'lost' ? undefined : { height }}>
    {page.phase === 'open'
      ? React.createElement('webview', {
        key: page.url, ref: (element: VisualGuestElement | null) => { guest.current = element },
        src: page.url, partition: VISUAL_PARTITION, className: 'interactive-visual__page', tabIndex: 0,
        'aria-label': `${title}, interactive page`,
      })
      : <div className="interactive-visual__placeholder">
        <p>{placeholderText(page, slot.state, fallbackHint)}</p>
        {page.phase === 'lost' && <button type="button" className="tt-button tt-focusable" onClick={() => setAttempt(value => value + 1)}>Try again</button>}
        {page.phase === 'waiting' && slot.state === 'crowded' && <button type="button" className="tt-button tt-focusable" onClick={slot.runNow}>Run this page</button>}
      </div>}
  </div>
}

/** The words in the frame while the page is not showing: what is true now, and where to turn. */
function placeholderText(page: Exclude<PageState, { phase: 'open' }>, slot: PageSlotState, fallbackHint: string): string {
  if (page.phase === 'refused') return `${page.reason} ${fallbackHint}`
  if (page.phase === 'lost') return `${page.reason} Try again to start it from the top. ${fallbackHint}`
  if (slot === 'crowded') return `Three other pages are running, the most Sotto runs at once. ${fallbackHint}`
  if (slot === 'running') return 'Starting the page.'
  return 'The page starts when it is in view.'
}

/** Sends the guest the theme or the walkthrough's place; a guest that has gone takes nothing. */
function sendTo(element: VisualGuestElement): { theme(theme: VisualTheme): void; step(step: VisualStepPlace): void } {
  return {
    theme: theme => { void element.send(VISUAL_IPC_THEME, theme).catch(() => undefined) },
    step: step => { void element.send(VISUAL_IPC_STEP, step).catch(() => undefined) },
  }
}
