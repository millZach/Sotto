import React, { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { Globe, Minimize2, PanelRight, Pause, Play, X } from 'lucide-react'
import type { AgentState } from '../../../shared/agents'
import type { BrowserBounds, BrowserBridge, BrowserPage } from '../../../shared/browser'
import { pageLabel, useThreadBrowser, useBrowserTasks } from './browserStore'
import { useBrowserPageMount } from './useBrowserPageMount'
import { useOverlayOpen } from './browserOverlay'
import { toolsTarget, useToolsPanelChrome, type ToolsPanelStore } from './toolsPanelStore'
import {
  browserPlayerStore, clampBrowserPlayerRect, BROWSER_PLAYER_MOVE_STEP, BROWSER_PLAYER_MOVE_STEP_LARGE,
  useBrowserPlayerRect, useBrowserPlayerVisibility, type BrowserPlayerStore, type WindowSize,
} from './browserPlayerStore'
import './browserPlayer.css'

function windowSize(): WindowSize { return { width: window.innerWidth, height: window.innerHeight } }

function pageHost(page: BrowserPage | undefined): string {
  if (!page) return ''
  try { return new URL(page.url).host || page.url } catch { return page.url }
}

/**
 * The live page, mounted at this element's rectangle while it is the one thing the player shows. `boundary` is
 * the whole player (the outer `<aside>`, which itself carries `data-covers-native-view` so a page docked
 * elsewhere steps aside for it): passing anything narrower here would make the player's own marker read as an
 * overlay over its own frame, since a ref only excludes elements *inside* it, never its own ancestors.
 */
function BrowserPlayerFrame({ page, mount, boundary }: {
  readonly page: BrowserPage | undefined
  readonly mount: (bounds: BrowserBounds | null) => void
  readonly boundary: React.RefObject<HTMLElement | null>
}): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const covered = useOverlayOpen(boundary, host)
  const show = page !== undefined && page.status !== 'unavailable' && !covered
  useBrowserPageMount(host, show, mount)
  return <div className="browser-player__frame">
    {!page ? null : page.status === 'unavailable' ? <p className="browser-player__frame-note">This page could not load.</p>
      : <div ref={host} className="browser-player__viewport" data-covered={covered || undefined}>
        {covered ? <p className="browser-player__frame-note">The page steps aside while a menu or dialog is open.</p> : null}
      </div>}
  </div>
}

export interface BrowserPlayerProps {
  readonly state: AgentState
  readonly focusedThreadId: string | null
  readonly bridge: BrowserBridge | undefined
  readonly store: ToolsPanelStore
  /** Whether a newly opened page opens the player on its own: **Show the browser when an agent opens a page**. */
  readonly autoShow?: boolean
  readonly playerStore?: BrowserPlayerStore
}

/**
 * The focused thread's browser task, floating above the window. Never another thread's, pinned or not: the
 * corner preview it replaces had a pinned-thread exception that let one thread's page float over another's
 * composer (#331); this shows only `focusedThreadId`'s own task. It steps aside, drawing and mounting nothing,
 * while Tools > Browser already shows the same thread's same page, the way the old preview did.
 */
export function BrowserPlayer({ state, focusedThreadId, bridge, store, autoShow = true, playerStore = browserPlayerStore }: BrowserPlayerProps): ReactNode {
  const chrome = useToolsPanelChrome(store)
  const tasks = useBrowserTasks(store.browser)
  const ids = state.host.threads.map(thread => thread.id).join('\n')
  useEffect(() => { store.browser.watchTasks(bridge, ids.split('\n').filter(Boolean)) }, [bridge, store, ids])

  const task = focusedThreadId === null ? undefined : tasks.find(item => item.threadId === focusedThreadId && state.host.threads.some(thread => thread.id === item.threadId))
  const threadId = task?.threadId ?? null
  const taskId = task?.id
  useEffect(() => { if (threadId && taskId) playerStore.taskSeen(threadId, taskId, autoShow) }, [threadId, taskId, autoShow, playerStore])
  useEffect(() => { if (threadId && bridge) void store.browser.activate(bridge, threadId) }, [threadId, bridge, store])

  const visibility = useBrowserPlayerVisibility(playerStore, threadId)
  const threadBrowser = useThreadBrowser(store.browser, threadId)
  const rawRect = useBrowserPlayerRect(playerStore)
  const [size, setSize] = useState<WindowSize>(windowSize)
  useEffect(() => {
    const onResize = (): void => { const next = windowSize(); setSize(next); playerStore.reclamp(next) }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [playerStore])
  // `rectFor` is the one default (pane-anchored, `browserPlayerStore.ts`), so a first drag or resize starts from
  // exactly the rectangle just drawn rather than a second, disagreeing default kept here.
  const rect = rawRect ? clampBrowserPlayerRect(rawRect, size) : playerStore.rectFor(size)

  const [problem, setProblem] = useState<string | null>(null)
  const [stoppingGrant, setStoppingGrant] = useState(false)
  const [answering, setAnswering] = useState(false)
  useEffect(() => { setProblem(null) }, [taskId])
  const playerRoot = useRef<HTMLElement>(null)

  const mount = useCallback((bounds: BrowserBounds | null) => { if (threadId && task) store.browser.mount(bridge, threadId, task.pageId, bounds) }, [store, bridge, threadId, task])

  if (!task || !threadId) return null
  const thread = state.host.threads.find(item => item.id === threadId)
  if (!thread) return null
  const dockedSame = chrome.open && chrome.surface === 'browser' && toolsTarget(chrome, focusedThreadId) === threadId && threadBrowser?.activePageId === task.pageId
  if (visibility === 'hidden' || dockedSame) return null

  const page = threadBrowser?.pages.find(item => item.id === task.pageId)
  const titleText = page ? pageLabel(page) : task.description
  const active = task.status === 'working' || task.status === 'paused'
  const actionText = task.pendingAction ? 'Waiting for your answer' : task.status === 'paused' ? 'Browser paused' : task.summary || task.description
  const dotState = task.pendingAction ? 'waiting' : task.status === 'working' ? 'working' : 'idle'
  const grant = threadBrowser?.grant ?? null

  const escape = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    event.preventDefault()
    playerStore.shrink(threadId)
    document.querySelector<HTMLTextAreaElement>('.thread-pane[data-focused] .thread-prompt textarea')?.focus()
  }

  if (visibility === 'shrunk') {
    return <button type="button" className="browser-player-pill tt-focusable" onKeyDown={escape}
      style={{ right: Math.max(8, size.width - rect.x - rect.width), bottom: Math.max(8, size.height - rect.y - rect.height) }}
      aria-label={`Show the browser for ${thread.title}: ${actionText}`} onClick={() => playerStore.restore(threadId)}>
      <Globe size={15} aria-hidden="true" /><span className="browser-player-pill__dot" data-state={dotState} aria-hidden="true" /><span className="browser-player-pill__text">{actionText}</span>
    </button>
  }

  const startDrag = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
    event.preventDefault()
    const handle = event.currentTarget
    const startX = event.clientX, startY = event.clientY, start = rect
    handle.setPointerCapture?.(event.pointerId)
    const move = (next: globalThis.PointerEvent): void => playerStore.setRect({ ...start, x: start.x + next.clientX - startX, y: start.y + next.clientY - startY }, size)
    const end = (): void => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end) }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }
  const barKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    escape(event)
    if (event.defaultPrevented || event.target !== event.currentTarget) return
    const step = event.shiftKey ? BROWSER_PLAYER_MOVE_STEP_LARGE : BROWSER_PLAYER_MOVE_STEP
    const delta: Partial<Record<string, [number, number]>> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
    const move = delta[event.key]
    if (!move) return
    event.preventDefault()
    // From `rect`, the placement actually on screen (pane-anchored until the user has ever moved it), never the
    // store's own window-anchored default: a first arrow-key press must continue from there, not jump to it.
    playerStore.setRect({ ...rect, x: rect.x + move[0], y: rect.y + move[1] }, size)
  }
  const startResize = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    const startX = event.clientX, startY = event.clientY, start = rect
    handle.setPointerCapture?.(event.pointerId)
    // From `start` (the rectangle actually on screen), the same rule `startDrag` follows: never the store's own
    // notion of the current placement, which used to disagree with a pane-anchored default and jump on first use.
    const move = (next: globalThis.PointerEvent): void => playerStore.setRect({ ...start, width: start.width + next.clientX - startX, height: start.height + next.clientY - startY }, size)
    const end = (): void => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end) }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }
  const gripKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    escape(event)
    if (event.defaultPrevented) return
    const step = event.shiftKey ? BROWSER_PLAYER_MOVE_STEP_LARGE : BROWSER_PLAYER_MOVE_STEP
    const delta: Partial<Record<string, [number, number]>> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
    const move = delta[event.key]
    if (!move) return
    event.preventDefault()
    playerStore.setRect({ ...rect, width: rect.width + move[0], height: rect.height + move[1] }, size)
  }
  const moveIntoTools = (): void => {
    void store.showBrowserTask(task, bridge).then(opened => { if (opened) requestAnimationFrame(() => document.getElementById('tools-tab-browser')?.focus()) })
  }
  // Shrink hands focus to the pill that replaces it; Hide hands it to the composer, as Escape already does:
  // neither ever drops keyboard focus to the page body.
  const shrinkToPill = (): void => {
    playerStore.shrink(threadId)
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.browser-player-pill')?.focus())
  }
  const hideToComposer = (): void => {
    playerStore.hide(threadId)
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.thread-pane[data-focused] .thread-prompt textarea')?.focus())
  }
  const answer = (allow: boolean, forThread = false): void => {
    setProblem(null); setAnswering(true)
    void store.browser.answerAction(bridge, task, allow, forThread).then(error => { if (error) setProblem(error) }).finally(() => setAnswering(false))
  }
  const stopGrant = (): void => {
    setStoppingGrant(true); setProblem(null)
    void store.browser.stopGrant(bridge, threadId).then(error => { if (error) setProblem(error) }).finally(() => setStoppingGrant(false))
  }

  return <aside ref={playerRoot} className="browser-player" aria-label={`Browser for ${thread.title}`} data-covers-native-view style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }} onKeyDown={escape}>
    <div className="browser-player__bar" role="group" aria-roledescription="drag handle" tabIndex={0}
      aria-label="Move the browser. Drag, or use the arrow keys; hold Shift to move further."
      title="Drag to move" onPointerDown={startDrag} onKeyDown={barKeyDown}>
      <Globe size={15} aria-hidden="true" />
      <span className="browser-player__title" title={titleText}>{titleText}</span>
      {pageHost(page) !== titleText ? <span className="browser-player__host">{pageHost(page)}</span> : null}
      <button type="button" className="files-icon tt-focusable" aria-label="Move the browser into Tools" title="Move into Tools" onClick={moveIntoTools}><PanelRight size={15} aria-hidden="true" /></button>
      <button type="button" className="files-icon tt-focusable" aria-label="Shrink the browser to a pill" title="Shrink" onClick={shrinkToPill}><Minimize2 size={15} aria-hidden="true" /></button>
      <button type="button" className="files-icon tt-focusable" aria-label="Hide the browser; the agent keeps working" title="Hide" onClick={hideToComposer}><X size={15} aria-hidden="true" /></button>
    </div>
    <BrowserPlayerFrame page={page} mount={mount} boundary={playerRoot} />
    <div className="browser-player__foot">
      {task.pendingAction ? <div className="browser-player__request" role="group" aria-label="Browser action permission">
        <p>{task.pendingAction.description}</p>
        <div className="browser-player__request-row">
          <button type="button" className="tt-button tt-button--primary tt-focusable" disabled={answering || task.status === 'paused'} onClick={() => answer(true)}>Allow once</button>
          <button type="button" className="tt-button tt-focusable" aria-label="Allow this thread to use the browser without asking" title="Allow this thread to use the browser without asking" disabled={answering || task.status === 'paused'} onClick={() => answer(true, true)}>Allow this thread</button>
          <button type="button" className="tt-button tt-focusable" disabled={answering} onClick={() => answer(false)}>Deny</button>
        </div>
      </div> : null}
      <div className="browser-player__status">
        <span className="browser-player__dot" data-state={dotState} aria-hidden="true" /><span className="browser-player__action">{actionText}</span>
        {active ? <button type="button" className="browser-review-link tt-focusable" onClick={() => void store.browser.controlTask(bridge, task, task.status === 'paused' ? 'resume' : 'pause').then(error => setProblem(error))}>
          {task.status === 'paused' ? <Play size={13} aria-hidden="true" /> : <Pause size={13} aria-hidden="true" />}{task.status === 'paused' ? 'Resume' : 'Pause'}</button> : null}
      </div>
      {!task.pendingAction && grant ? <div className="browser-player__grant">
        <span>Uses the browser without asking</span>
        <button type="button" className="browser-review-link tt-focusable" aria-label="Stop letting this thread use the browser without asking" title="This thread will ask before opening, clicking or typing again" disabled={stoppingGrant} onClick={stopGrant}>Stop</button>
      </div> : null}
      {problem ? <p className="browser-review-problem" role="alert">{problem}</p> : null}
    </div>
    <div className="browser-player__grip" role="separator" tabIndex={0} aria-label="Resize the browser. Use the arrow keys; hold Shift to resize further."
      title="Drag to resize" onPointerDown={startResize} onKeyDown={gripKeyDown} />
  </aside>
}

