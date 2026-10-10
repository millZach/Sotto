import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { GitBranch, PanelBottomClose } from 'lucide-react'
import type { AgentProject } from '../../../shared/agents'
import type { TerminalBridge } from '../../../shared/terminal'
import { folderKey } from '../agents/projectFolders'
import { focusInPane } from '../agents/ThreadPanes'
import { describeWorkingCopy, type WorkingCopyThread } from '../agents/ThreadWorkingCopy'
import { isDrawerShortcut, setDrawerShortcut } from './paneTerminalShortcut'
import { usePaneTerminalShortcut } from './PaneTerminalToggle'
import { paneTerminalChromeStore, paneTerminalStore, usePaneTerminalChrome, type PaneTerminalChromeStore } from './paneTerminalStore'
import { TerminalSurface } from './TerminalSurface'
import { useThreadTerminals, windowTerminalBridge, type TerminalStore, type TerminalViewFactory } from './terminalStore'
import { useTerminalViewFactory } from './terminalViewLoader'
import './paneTerminal.css'

/** Whether two folders are the same, or one holds the other. */
function nested(first: string, second: string): boolean {
  const [a, b] = [folderKey(first), folderKey(second)]
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

/** Shorter than this, a terminal has nowhere useful to put a cursor. */
const MIN_DRAWER_HEIGHT = 120
/**
 * What the header, transcript and composer keep between them, whatever the drawer's height: roughly the
 * header's own 44px, the composer's own room, and about 160px of conversation, so the thread stays readable.
 */
const MIN_CONVERSATION_AREA = 320
const RESIZE_STEP = 24
/** A little wider and taller than a 13px monospace cell, so the estimate errs towards a shell narrower than its view. */
const CELL_WIDTH = 8
const CELL_HEIGHT = 17
/** The bar, the hint line and the view's padding: the room in the drawer that is not the terminal's grid. */
const CHROME_HEIGHT = 80
const CHROME_WIDTH = 40


/**
 * Hides a pane's drawer from inside it and puts focus back in the pane once the drawer has left the page, so focus
 * never lands on its terminal on the way out. The shells keep running.
 */
export function hideDrawerFromInside(threadId: string, chromeStore: PaneTerminalChromeStore = paneTerminalChromeStore): void {
  chromeStore.setOpen(threadId, false)
  requestAnimationFrame(() => focusInPane(threadId))
}

export interface PaneTerminalDrawerProps {
  readonly threadId: string
  readonly thread: WorkingCopyThread
  readonly project: Pick<AgentProject, 'path'> | undefined
  readonly bridge?: TerminalBridge | undefined
  /** Test seam: a light stand-in for xterm. Left out, the real view loads the first time a drawer opens. */
  readonly viewFactory?: TerminalViewFactory | undefined
  readonly store?: TerminalStore
  readonly chromeStore?: PaneTerminalChromeStore
}

/**
 * One pane's own terminal drawer, in the bottom third of the pane below the composer. Its shells are separate
 * from Tools' Terminal surface (`paneTerminalStore` is its own `TerminalStore` `place`); hiding the drawer only
 * takes the view off the page, the way Tools does, so a shell keeps running while the drawer is closed.
 */
export function PaneTerminalDrawer({ threadId, thread, project, bridge, viewFactory, store = paneTerminalStore, chromeStore = paneTerminalChromeStore }: PaneTerminalDrawerProps): ReactNode {
  const chrome = usePaneTerminalChrome(threadId, chromeStore)
  const { factory: baseFactory, failed } = useTerminalViewFactory(viewFactory, chrome.open)
  const shortcut = usePaneTerminalShortcut()
  useLayoutEffect(() => { setDrawerShortcut(shortcut) }, [shortcut])
  // A drawer's terminal leaves the drawer's chord to the page, and turns see-through with the frosted room.
  const factory = useMemo<TerminalViewFactory | null>(() => baseFactory && (handlers => baseFactory({
    ...handlers,
    isPageShortcut: isDrawerShortcut,
    followsFrost: true,
  })), [baseFactory])
  const root = useRef<HTMLDivElement>(null)
  const drag = useRef<{ readonly pointerId: number; readonly startY: number; readonly startHeight: number } | null>(null)
  const [paneAreaHeight, setPaneAreaHeight] = useState(0)
  const [dragging, setDragging] = useState(false)
  const hadSessions = useRef(false)
  const focusNext = useRef(false)

  useLayoutEffect(() => {
    if (!chrome.open) return
    const pane = root.current?.closest<HTMLElement>('.thread-pane')
    if (!pane) return
    const measure = (): void => setPaneAreaHeight(pane.clientHeight)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(pane)
    return () => observer.disconnect()
  }, [chrome.open])

  const terminalBridge = bridge ?? windowTerminalBridge()
  // The drawer's sessions live in main; opening only lists them again, the way Tools' own Terminal surface does.
  useEffect(() => {
    if (chrome.open) void store.activate(terminalBridge, threadId)
  }, [chrome.open, terminalBridge, store, threadId])
  const terminals = useThreadTerminals(store, chrome.open ? threadId : null)
  // Closing the last shell hides the drawer; a thread that has never had one yet (autoStart is still starting it)
  // is not that, so the effect only fires on an actual close.
  useLayoutEffect(() => {
    if (!chrome.open || !terminals) return
    if (terminals.sessions.length > 0) { hadSessions.current = true; return }
    if (hadSessions.current) {
      hadSessions.current = false
      const focusInside = root.current?.contains(document.activeElement) === true || document.activeElement === document.body
      if (focusInside) hideDrawerFromInside(threadId, chromeStore)
      else chromeStore.setOpen(threadId, false)
    }
  }, [chrome.open, terminals, chromeStore, threadId])
  useLayoutEffect(() => { if (!chrome.open) hadSessions.current = false }, [chrome.open])

  // The Ctrl+J shortcut sets this before opening by keyboard; consumed at most once, it reaches the terminal
  // once its first shell is ready, the same way the "Start terminal" and "Reopen" buttons already do. This runs
  // in the same commit that opens the drawer, before any shell (and the view that reads this ref) exists yet.
  // A shell that already runs has mounted its view before this parent effect runs, so it is focused here directly.
  useLayoutEffect(() => {
    if (!chrome.open || !chromeStore.consumeFocusRequest(threadId)) return
    const running = root.current?.querySelector<HTMLElement>('.xterm-helper-textarea')
    if (running) running.focus()
    else focusNext.current = true
  }, [chrome.open, chromeStore, threadId])

  if (!chrome.open) return null

  const min = MIN_DRAWER_HEIGHT
  const max = paneAreaHeight > 0 ? Math.max(min, paneAreaHeight - MIN_CONVERSATION_AREA) : Math.max(min, chrome.height ?? min)
  const clamp = (value: number): number => Math.min(max, Math.max(min, value))
  const defaultHeight = clamp(paneAreaHeight > 0 ? Math.round(paneAreaHeight / 3) : 200)
  const height = clamp(chrome.height ?? defaultHeight)

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: height }
    setDragging(true)
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const state = drag.current
    if (!state || state.pointerId !== event.pointerId) return
    // The divider sits above the drawer: dragging up grows it, dragging down shrinks it.
    chromeStore.setHeight(threadId, clamp(state.startHeight - (event.clientY - state.startY)))
  }
  const onPointerEnd = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = event.key === 'ArrowUp' ? height + RESIZE_STEP : event.key === 'ArrowDown' ? height - RESIZE_STEP
      : event.key === 'Home' ? min : event.key === 'End' ? max : null
    if (next === null) return
    event.preventDefault()
    chromeStore.setHeight(threadId, clamp(next))
  }

  const startSize = (): { cols: number; rows: number } | undefined => {
    const width = root.current?.clientWidth ?? 0
    if (width <= 0) return undefined
    return {
      cols: Math.max(20, Math.min(500, Math.floor((width - CHROME_WIDTH) / CELL_WIDTH))),
      rows: Math.max(5, Math.min(300, Math.floor((height - CHROME_HEIGHT) / CELL_HEIGHT))),
    }
  }

  const facts = describeWorkingCopy(thread, project)
  // The drawer's shells start in the project folder, so the branch is named only when the thread's own folder is that
  // folder or one inside it, or holds it: a worktree's branch, or another checkout's, would name a checkout the shell is not in.
  const branch = facts.mode === 'shared' && facts.directory && project && nested(facts.directory, project.path) ? facts.branch : undefined

  return <div className="pane-terminal" ref={root} style={{ '--pane-terminal-height': `${Math.round(height)}px` } as React.CSSProperties}>
    <div role="separator" aria-orientation="horizontal" aria-label="Resize terminal" tabIndex={0}
      aria-valuemin={min} aria-valuemax={Math.round(max)} aria-valuenow={Math.round(height)}
      className="pane-terminal__divider tt-focusable" data-dragging={dragging || undefined} title="Drag to resize · Double-click to reset to a third"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd} onLostPointerCapture={onPointerEnd}
      onDoubleClick={() => chromeStore.resetHeight(threadId)} onKeyDown={onKeyDown} />
    <div className="pane-terminal__body">
      <TerminalSurface threadId={threadId} store={store} bridge={terminalBridge} viewFactory={factory} viewFailed={failed}
        idSuffix={`-drawer-${threadId}`} chromeTitle={null} newLabel="New shell" autoStart startSize={startSize} focusNextRef={focusNext}
        barEnd={interrupt => <div className="terminal-bar__end">
          {branch ? <span className="pane-terminal__branch" title={`Branch ${branch}`}><GitBranch size={13} aria-hidden="true" /><bdi>{branch}</bdi></span> : null}
          {interrupt}
          <button type="button" className="files-icon tt-focusable" aria-label="Hide terminal drawer" title={shortcut ? `Hide terminal drawer (${shortcut.label})` : 'Hide terminal drawer'}
            aria-keyshortcuts={shortcut?.keys} onClick={() => hideDrawerFromInside(threadId, chromeStore)}><PanelBottomClose size={16} aria-hidden="true" /></button>
        </div>} />
    </div>
  </div>
}
