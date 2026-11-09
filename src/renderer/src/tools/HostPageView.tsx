import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Server } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'
import type { AgentState } from '../../../shared/agents'
import type { BrowserBridge, BrowserPage } from '../../../shared/browser'
import { parseHostEntityKey } from '../../../shared/clientIdentity'
import type { HostBrowserFrame, HostPageInputRequest } from '../../../shared/hostBrowser'
import { pageLabel } from './browserStore'

/** The host a paired host's thread runs on, as this window last heard: its name, whether it is connected, and whether it offers the browser. */
/** `link` numbers the connection, so a page watched over one that was replaced is watched again over the new one. */
export interface ThreadHost { readonly hostId: string; readonly name: string; readonly connected: boolean; readonly browser: boolean; readonly link: number }

/** The paired host `threadId` runs on, or undefined for a thread on this computer (ADR-0198). */
export function threadHost(state: AgentState | null | undefined, threadId: string): ThreadHost | undefined {
  const hostId = parseHostEntityKey(threadId)?.hostId
  const connection = hostId ? state?.connections?.find(item => item.hostId === hostId && item.kind === 'remote') : undefined
  return connection ? { hostId: connection.hostId, name: connection.name, connected: connection.connected, browser: connection.browser !== undefined, link: connection.browser ?? 0 } : undefined
}

/** Says on the pane's row which machine a page runs on (ADR-0198, decision 6), as a paired host's terminal does. */
export function BrowserMachine({ machine }: { readonly machine: string }): ReactNode {
  const { t } = useLingui()
  return <span className="terminal-machine" title={t({ message: `This page runs on ${machine}`, comment: '{machine} is the name of a paired host, as in forge.' })}>
    <Server size={13} aria-hidden="true" /><bdi>{t({ message: `on ${machine}`, comment: '{machine} is the name of a paired host, as in forge. Says which machine a browser page runs on.' })}</bdi>
  </span>
}

/**
 * The newest picture of each page shown lately, in memory only, so a pane or player that opens again, or a host that is
 * away, still shows where the page was. It holds a few pages' last pictures and nothing else.
 */
const LAST_FRAMES = new Map<string, HostBrowserFrame>()
const LAST_FRAMES_KEPT = 8
function keepFrame(frame: HostBrowserFrame): void {
  LAST_FRAMES.delete(frame.pageId)
  LAST_FRAMES.set(frame.pageId, frame)
  for (const pageId of LAST_FRAMES.keys()) { if (LAST_FRAMES.size <= LAST_FRAMES_KEPT) break; LAST_FRAMES.delete(pageId) }
}

/** Chromium's modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export function inputModifiers(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)
}
const BUTTONS = ['left', 'middle', 'right'] as const
/**
 * A key press as Chromium takes it. Tab and Shift+Tab, and F6 for the window's regions, are left to the window, so the
 * keyboard can always leave the page (Zach, November 9). Escape goes to the page, as it does on this computer's pages.
 */
export function keyInput(event: { key: string; code: string; keyCode: number; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }, action: 'down' | 'up'): HostPageInputRequest | null {
  // Paste is the window's: its paste event sends this computer's clipboard as text, which a key press would not carry.
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return null
  if (event.key === 'Tab' || event.key === 'F6' || event.key === 'Unidentified' || event.key === 'Process' || event.key.length > 32 || event.code.length > 32) return null
  const typed = event.key === 'Enter' ? '\r' : event.key.length === 1 && !event.ctrlKey && !event.metaKey ? event.key : undefined
  return { type: 'key', action, key: event.key, code: event.code, keyCode: Math.min(255, Math.max(0, event.keyCode)), ...typed ? { text: typed } : {}, modifiers: inputModifiers(event) }
}
/** The pane's size, as the page lays out at, within what a host takes. */
function pageSize(element: HTMLElement): { width: number; height: number } | null {
  const width = Math.round(element.clientWidth), height = Math.round(element.clientHeight)
  return width >= 100 && height >= 100 ? { width: Math.min(width, 4096), height: Math.min(height, 4096) } : null
}

/**
 * A page in a paired host's browser, drawn from the pictures the host sends while it is shown here, newest first, and
 * driven by the user's own clicks, keys, typed text and scrolls, which go to the page on the host (ADR-0198, decision 5).
 * The page lays out at this element's size. While the host is away the last picture stays, greyed, and nothing is sent.
 * Pictures are kept only as the one on screen.
 */
export function HostPageView({ page, threadId, bridge, shown, connected, link = 0 }: {
  readonly page: BrowserPage; readonly threadId: string; readonly bridge: BrowserBridge | undefined
  readonly shown: boolean; readonly connected: boolean
  /** The host connection's number: a new one means the last one's watch ended with it, so the page is watched again. */
  readonly link?: number
}): ReactNode {
  const { t } = useLingui()
  const element = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [frame, setFrame] = useState<HostBrowserFrame | null>(() => LAST_FRAMES.get(page.id) ?? null)
  // What did not reach the host, said over the picture until the next picture comes.
  const [problem, setProblem] = useState<string | null>(null)
  const target = { threadId, workspaceId: page.workspace.workspaceId, pageId: page.id }
  const targetKey = `${target.workspaceId}:${target.pageId}`
  const sending = useRef<Promise<unknown>>(Promise.resolve())
  // A hidden or minimised window shows no page, so it is sent no pictures (ADR-0198, decision 5).
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  useEffect(() => {
    const changed = (): void => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }, [])
  const live = shown && connected && visible && bridge !== undefined

  useEffect(() => {
    const host = element.current
    if (!host) return
    const measure = (): void => setSize(current => { const next = pageSize(host); return next?.width === current?.width && next?.height === current?.height ? current : next })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!bridge) return
    return bridge.onFrame(next => { if (next.pageId !== page.id) return; keepFrame(next); setFrame(next); setProblem(null) })
  }, [bridge, page.id])
  // Watching follows the pane's size: a pause after a resize sends one watch, which takes the place of the last.
  useEffect(() => {
    if (!live || !size) return
    const timer = setTimeout(() => {
      void bridge.watch({ ...target, size }).then(result => { if (!result.ok) setProblem(result.error.message) },
        () => setProblem(t`The host didn't answer, so this picture may be old. Nothing was changed. Try again.`))
    }, 120)
    return () => clearTimeout(timer)
    // The target is read through its key, so a new object for the same page does not watch again.
  }, [live, bridge, targetKey, size?.width, size?.height, link])
  useEffect(() => {
    if (!live) return
    return () => { void bridge.unwatch(target).catch(() => undefined) }
  }, [live, bridge, targetKey, link])

  /** Sends the user's input in the order it was made; one that fails is dropped, as a lost click is. */
  const send = useCallback((input: HostPageInputRequest): void => {
    if (!live) return
    const lost = t`Your click or key didn't reach the page. Nothing was changed there. Try again.`
    sending.current = sending.current.then(() => bridge.input({ ...target, input })).then(result => { if (!result.ok) setProblem(lost) }, () => setProblem(lost))
  }, [live, bridge, targetKey])
  const shownFrame = useRef(frame)
  shownFrame.current = frame
  /**
   * Where a point in the picture is on the page. A picture is drawn at its own size or shrunk to fit, never enlarged, so
   * a page another pane laid out larger is drawn smaller here, and the point is scaled back up by as much.
   */
  const at = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = element.current!.getBoundingClientRect()
    const drawn = shownFrame.current
    const scale = drawn && rect.width > 0 && rect.height > 0 ? Math.min(1, rect.width / drawn.width, rect.height / drawn.height) : 1
    return { x: Math.max(0, Math.round((event.clientX - rect.left) / scale)), y: Math.max(0, Math.round((event.clientY - rect.top) / scale)) }
  }
  const moving = useRef<number | null>(null)
  const lastMove = useRef<{ x: number; y: number; buttons: number; modifiers: number } | null>(null)
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    lastMove.current = { ...at(event), buttons: event.buttons, modifiers: inputModifiers(event) }
    if (moving.current !== null) return
    moving.current = requestAnimationFrame(() => {
      moving.current = null
      const move = lastMove.current
      if (move) send({ type: 'mouse', action: 'move', x: move.x, y: move.y, button: move.buttons & 1 ? 'left' : 'none', clickCount: 0, modifiers: move.modifiers })
    })
  }
  const onPointerButton = (event: React.PointerEvent<HTMLDivElement>, action: 'down' | 'up'): void => {
    const button = BUTTONS[event.button]
    if (!button) return
    if (action === 'down') { element.current?.focus(); event.currentTarget.setPointerCapture?.(event.pointerId) }
    event.preventDefault()
    send({ type: 'mouse', action, ...at(event), button, clickCount: Math.min(3, Math.max(1, event.detail || 1)), modifiers: inputModifiers(event) })
  }
  // Wheel events are taken here rather than scrolling the window behind the page, so the listener is not passive.
  useEffect(() => {
    const host = element.current
    if (!host) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? host.clientHeight : 1
      const clamp = (value: number): number => Math.max(-4096, Math.min(4096, Math.round(value * scale)))
      send({ type: 'wheel', ...at(event), deltaX: clamp(event.deltaX), deltaY: clamp(event.deltaY), modifiers: inputModifiers(event) })
    }
    host.addEventListener('wheel', onWheel, { passive: false })
    return () => host.removeEventListener('wheel', onWheel)
  }, [send])
  const onKey = (event: React.KeyboardEvent<HTMLDivElement>, action: 'down' | 'up'): void => {
    if (event.target !== event.currentTarget || event.nativeEvent.isComposing) return
    const input = keyInput(event, action)
    if (!input) return
    event.preventDefault(); event.stopPropagation()
    send(input)
  }

  const label = pageLabel(page)
  return <div className="browser-viewport host-page" data-off={!connected || undefined}>
    <div ref={element} className="host-page__picture tt-focusable" tabIndex={0} role="application"
      aria-label={t({ message: `Page: ${label}`, comment: '{label} is a browser page\'s title or host. The page runs on a paired host and is drawn here from its pictures.' })}
      onPointerDown={event => onPointerButton(event, 'down')} onPointerUp={event => onPointerButton(event, 'up')} onPointerMove={onPointerMove}
      onContextMenu={event => event.preventDefault()} onKeyDown={event => onKey(event, 'down')} onKeyUp={event => onKey(event, 'up')}
      onPaste={event => { const text = event.clipboardData.getData('text/plain').slice(0, 4000); if (text) { event.preventDefault(); send({ type: 'text', text }) } }}
      onCompositionEnd={event => { if (event.data) send({ type: 'text', text: event.data.slice(0, 4000) }) }}>
      {frame ? <img className="host-page__frame" src={`data:image/jpeg;base64,${frame.data}`} alt="" draggable={false} data-size={`${frame.width}x${frame.height}`} /> : null}
    </div>
    {problem ? <p className="browser-problem host-page__problem" role="alert">{problem}</p> : null}
  </div>
}
