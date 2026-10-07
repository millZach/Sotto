import React, { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  VISUAL_GUEST_ESCAPE, VISUAL_GUEST_HEIGHT, VISUAL_GUEST_STEP, VISUAL_GUEST_THEME, VISUAL_PAGE_HEIGHT_MIN, VISUAL_STEP_MESSAGE,
  clampVisualPageHeight, type VisualStepMessage, type VisualTheme,
} from '../../../shared/visualGuest'
import { VISUAL_PARTITION } from '../../../shared/visualPages'
import { useDiagramPalette, type DiagramPalette } from './diagrams/diagramPalette'
import './interactiveVisual.css'

/**
 * An interactive visual's page in its card (ADR-0056). The page is an agent's own HTML, so it never runs in this
 * window: main serves it once, from its own store, into a `<webview>` guest on a sealed in-memory session. This side
 * only asks for the page's address, sizes the guest to the height Sotto's guest preload measured, and sends the
 * walkthrough's step and the theme in. At most three pages run at once, each only while its card is near the view.
 */

/** The guest's side of the `<webview>` element this file uses; Electron's own type is not in the renderer's build. */
interface VisualGuestElement extends HTMLElement {
  send(channel: string, ...args: unknown[]): Promise<void>
}
interface GuestIpcEvent extends Event { readonly channel: string; readonly args: readonly unknown[] }

/** How many pages may run at once, and how far outside the view a card starts its page. */
export const LIVE_PAGES_MAX = 3
const NEAR_MARGIN = '400px 0px'

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

// The cards near the view, in the order they came near. The first three run their pages.
let near: readonly symbol[] = []
const listeners = new Set<() => void>()
const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
function setNear(card: symbol, isNear: boolean): void {
  const has = near.includes(card)
  if (has === isNear) return
  near = isNear ? [...near, card] : near.filter(item => item !== card)
  for (const listener of listeners) listener()
}
/** Whether this card may run its page now: near the view, and among the first three that are. */
export function mayRunPage(card: symbol): boolean { return near.indexOf(card) > -1 && near.indexOf(card) < LIVE_PAGES_MAX }

function readReducedMotion(): boolean {
  return document.documentElement.dataset.reducedMotion === 'on' || (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
}
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(readReducedMotion)
  useEffect(() => {
    const update = (): void => setReduced(readReducedMotion())
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    media?.addEventListener('change', update)
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-reduced-motion'] })
    return () => { media?.removeEventListener('change', update); observer.disconnect() }
  }, [])
  return reduced
}

type PageState = { readonly phase: 'waiting' } | { readonly phase: 'open'; readonly url: string } | { readonly phase: 'refused'; readonly reason: string }

export function InteractiveVisualPage({ threadId, visualId, title, step, fill = false, onEscape }: {
  readonly threadId: string | undefined
  readonly visualId: string
  readonly title: string
  /** The walkthrough's place, sent to the page whenever it changes. */
  readonly step: Omit<VisualStepMessage, 'type'>
  /** Fill the space it is given (Expand) rather than take the page's own height. */
  readonly fill?: boolean
  /** Escape pressed inside the page: focus goes back to the card. */
  readonly onEscape: () => void
}): ReactNode {
  const [card] = useState(() => Symbol('visual-page'))
  const frame = useRef<HTMLDivElement>(null)
  const guest = useRef<VisualGuestElement | null>(null)
  const [height, setHeight] = useState(VISUAL_PAGE_HEIGHT_MIN)
  const [ready, setReady] = useState(false)
  const [page, setPage] = useState<PageState>({ phase: 'waiting' })
  const palette = useDiagramPalette()
  const reducedMotion = useReducedMotion()
  const theme = visualThemeFrom(palette, reducedMotion)
  const themeKey = JSON.stringify(theme)
  const stepKey = JSON.stringify(step)
  const running = useSyncExternalStore(subscribe, () => mayRunPage(card))
  const latest = useRef({ theme, step, onEscape })
  latest.current = { theme, step, onEscape }

  // Near the view or not, measured against the window: the transcript's scrolling clips the card as the window sees it.
  useEffect(() => {
    const element = frame.current
    if (!element || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(entries => { for (const entry of entries) setNear(card, entry.isIntersecting) }, { rootMargin: NEAR_MARGIN })
    observer.observe(element)
    return () => { observer.disconnect(); setNear(card, false) }
  }, [card])

  // A fresh one-time address each time the page starts; the page starts again from the top when it comes back.
  useEffect(() => {
    if (!running) { setPage({ phase: 'waiting' }); setReady(false); return }
    const bridge = window.sotto?.visuals
    if (!bridge || threadId === undefined) { setPage({ phase: 'refused', reason: 'This window cannot show the page. Its steps are below.' }); return }
    let current = true
    bridge.open({ threadId, visualId, theme: latest.current.theme }).then(result => {
      if (current) setPage(result.ok ? { phase: 'open', url: result.url } : { phase: 'refused', reason: result.reason })
    }, () => { if (current) setPage({ phase: 'refused', reason: 'Sotto could not open the page. Its steps are below.' }) })
    return () => { current = false }
  }, [running, threadId, visualId])

  // The guest's own events: its first paint, the height Sotto's preload measured, and Escape.
  useEffect(() => {
    const element = guest.current
    if (page.phase !== 'open' || !element) return
    // Once the page has loaded it is sent the theme and the step (below), and again whenever either changes.
    const onReady = (): void => setReady(true)
    const onMessage = (event: Event): void => {
      const { channel, args } = event as GuestIpcEvent
      if (channel === VISUAL_GUEST_HEIGHT) setHeight(clampVisualPageHeight(args[0]))
      else if (channel === VISUAL_GUEST_ESCAPE) latest.current.onEscape()
    }
    const onGone = (): void => { setReady(false); setPage({ phase: 'refused', reason: 'The page stopped. Its steps are below.' }) }
    element.addEventListener('dom-ready', onReady)
    element.addEventListener('ipc-message', onMessage)
    element.addEventListener('render-process-gone', onGone)
    return () => {
      element.removeEventListener('dom-ready', onReady)
      element.removeEventListener('ipc-message', onMessage)
      element.removeEventListener('render-process-gone', onGone)
    }
  }, [page])

  useEffect(() => {
    if (ready) void guest.current?.send(VISUAL_GUEST_THEME, latest.current.theme).catch(() => undefined)
  }, [ready, themeKey])
  useEffect(() => {
    if (ready) void guest.current?.send(VISUAL_GUEST_STEP, { type: VISUAL_STEP_MESSAGE, ...latest.current.step }).catch(() => undefined)
  }, [ready, stepKey])

  return <div ref={frame} className="interactive-visual" data-state={page.phase === 'open' ? (ready ? 'running' : 'loading') : page.phase}
    data-fill={fill || undefined} style={fill || page.phase === 'refused' ? undefined : { height }}>
    {page.phase === 'open'
      ? React.createElement('webview', {
        key: page.url, ref: (element: VisualGuestElement | null) => { guest.current = element },
        src: page.url, partition: VISUAL_PARTITION, className: 'interactive-visual__page', tabIndex: 0,
        'aria-label': `${title}, interactive page`,
      })
      : <p className="interactive-visual__placeholder">{page.phase === 'refused' ? page.reason : 'The page starts when it is in view.'}</p>}
  </div>
}
