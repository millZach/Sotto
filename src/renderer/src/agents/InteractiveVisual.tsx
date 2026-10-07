import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  VISUAL_IPC_ESCAPE, VISUAL_IPC_HEIGHT, VISUAL_IPC_STEP, VISUAL_IPC_THEME, VISUAL_PAGE_HEIGHT_MIN, VISUAL_STEP_MESSAGE,
  clampVisualPageHeight, type VisualStepPlace, type VisualTheme,
} from '../../../shared/visualGuest'
import { VISUAL_PARTITION } from '../../../shared/visualPages'
import { useReducedMotion } from '../state/reducedMotion'
import { useDiagramPalette, type DiagramPalette } from './diagrams/diagramPalette'
import { useVisualPageSlot } from './visualPageSlots'
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

type PageState = { readonly phase: 'waiting' } | { readonly phase: 'open'; readonly url: string } | { readonly phase: 'refused'; readonly reason: string }

export function InteractiveVisualPage({ threadId, visualId, title, step, expanded = false, otherwise, onEscape }: {
  readonly threadId: string | undefined
  readonly visualId: string
  readonly title: string
  /** The walkthrough's place, sent to the page whenever it changes. */
  readonly step: VisualStepPlace
  /** Shown expanded over the window: the page fills the room it is given and runs for as long as it is open. */
  readonly expanded?: boolean
  /** What the reader can turn to when the page is not shown, after the reason: "Its steps are below." */
  readonly otherwise: string
  /** Escape pressed inside the page: focus goes back to the card. */
  readonly onEscape: () => void
}): ReactNode {
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
  const running = useVisualPageSlot(frame, expanded)
  const latest = useRef({ theme, step, onEscape })
  latest.current = { theme, step, onEscape }

  // A fresh one-time address each time the page starts; the page starts again from the top when it comes back.
  useEffect(() => {
    if (!running) { setPage({ phase: 'waiting' }); setReady(false); return }
    const bridge = window.sotto?.visuals
    if (!bridge || threadId === undefined) { setPage({ phase: 'refused', reason: 'This window cannot show the page.' }); return }
    let current = true
    bridge.open({ threadId, visualId, theme: latest.current.theme }).then(result => {
      if (current) setPage(result.ok ? { phase: 'open', url: result.url } : { phase: 'refused', reason: result.reason })
    }, () => { if (current) setPage({ phase: 'refused', reason: 'Sotto could not open the page.' }) })
    return () => { current = false }
  }, [running, threadId, visualId])

  // The guest's own events: its first paint and its finished load, the height Sotto's preload measured, and Escape.
  useEffect(() => {
    const element = guest.current
    if (page.phase !== 'open' || !element) return
    // Ready once the page's own script has run, so a listener it attached at the top is there; the step and theme go
    // again once the whole load has finished, for a page that attaches its listener later.
    const onReady = (): void => setReady(true)
    const onLoaded = (): void => {
      void element.send(VISUAL_IPC_THEME, latest.current.theme).catch(() => undefined)
      void element.send(VISUAL_IPC_STEP, { type: VISUAL_STEP_MESSAGE, ...latest.current.step }).catch(() => undefined)
    }
    const onMessage = (event: Event): void => {
      const { channel, args } = event as GuestIpcEvent
      if (channel === VISUAL_IPC_HEIGHT) setHeight(clampVisualPageHeight(args[0]))
      else if (channel === VISUAL_IPC_ESCAPE) latest.current.onEscape()
    }
    const onGone = (): void => { setReady(false); setPage({ phase: 'refused', reason: 'The page stopped.' }) }
    element.addEventListener('dom-ready', onReady)
    element.addEventListener('did-finish-load', onLoaded)
    element.addEventListener('ipc-message', onMessage)
    element.addEventListener('render-process-gone', onGone)
    return () => {
      element.removeEventListener('dom-ready', onReady)
      element.removeEventListener('did-finish-load', onLoaded)
      element.removeEventListener('ipc-message', onMessage)
      element.removeEventListener('render-process-gone', onGone)
    }
  }, [page])

  useEffect(() => {
    if (ready) void guest.current?.send(VISUAL_IPC_THEME, latest.current.theme).catch(() => undefined)
  }, [ready, themeKey])
  useEffect(() => {
    if (ready) void guest.current?.send(VISUAL_IPC_STEP, { type: VISUAL_STEP_MESSAGE, ...latest.current.step }).catch(() => undefined)
  }, [ready, stepKey])

  return <div ref={frame} className="interactive-visual" data-state={page.phase === 'open' ? (ready ? 'running' : 'loading') : page.phase}
    data-fill={expanded || undefined} style={expanded || page.phase === 'refused' ? undefined : { height }}>
    {page.phase === 'open'
      ? React.createElement('webview', {
        key: page.url, ref: (element: VisualGuestElement | null) => { guest.current = element },
        src: page.url, partition: VISUAL_PARTITION, className: 'interactive-visual__page', tabIndex: 0,
        'aria-label': `${title}, interactive page`,
      })
      : <p className="interactive-visual__placeholder">{page.phase === 'refused' ? `${page.reason} ${otherwise}` : 'The page starts when it is in view.'}</p>}
  </div>
}
