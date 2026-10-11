import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { CircleStop, Plus, RotateCcw, X } from 'lucide-react'
import type { TerminalBridge, TerminalSession } from '../../../shared/terminal'
import { TERMINAL_LIMIT_MESSAGE, TERMINAL_SESSIONS_MAX } from '../../../shared/terminal'
import { TerminalViewProblem } from './TerminalViewProblem'
import { ToolsChrome } from './ToolsChrome'
import type { ToolsError } from '../../../shared/tools'
import { sessionStatusText, useThreadTerminals, type TerminalStore, type TerminalViewFactory } from './terminalStore'

export interface TerminalSurfaceProps {
  readonly threadId: string
  readonly store: TerminalStore
  readonly bridge: TerminalBridge | undefined
  /** Null until the xterm chunk loads; viewFailed distinguishes failure from loading. */
  readonly viewFactory: TerminalViewFactory | null
  readonly viewFailed: boolean
  /** Appended to the literal `terminal-screen` element ID, so a drawer and Tools (or several drawers) can share a page. */
  readonly idSuffix?: string
  /** The loading/error/empty states' own chrome title; null leaves it out, for a surface that draws its own bar (the drawer). */
  readonly chromeTitle?: string | null
  /** The new-shell button's accessible name and title when nothing is full; "New terminal" in Tools, "New shell" in the drawer. */
  readonly newLabel?: string
  /**
   * Draws the end of the bar itself instead of the usual actions group: New shell moves beside the tabs, and
   * Send Ctrl+C (given here, so it still only renders while a shell is running) joins whatever else goes at the
   * end, the way the drawer's own bar puts tabs, New shell, then the branch, Send Ctrl+C and Hide, pushed right.
   */
  readonly barEnd?: (interrupt: ReactNode) => ReactNode
  /** Starts a shell on its own once the thread has none, instead of showing "Start terminal". */
  readonly autoStart?: boolean
  /**
   * The size a new shell should start at, before its view exists to measure. A shell prints its first prompt at
   * the size it starts with, and a hard-wrapped line does not reflow, so a narrow drawer starts it narrow.
   */
  readonly startSize?: () => { readonly cols: number; readonly rows: number } | undefined
  /** An external ref the drawer sets before opening by keyboard, so the terminal takes focus once its first shell is ready. */
  readonly focusNextRef?: React.MutableRefObject<boolean>
}

function listProblem(error: ToolsError, bridge: boolean): string {
  if (!bridge) return 'Terminal is not available in this window.'
  switch (error.code) {
    case 'thread-unavailable': return 'This thread is not available to Terminal.'
    case 'workspace-unavailable': return 'The working folder is not available.'
    default: return error.message || 'Terminal could not list its sessions.'
  }
}

/** Tab names: the shell's title, numbered once two share it. */
function sessionNames(sessions: readonly TerminalSession[]): Map<string, string> {
  const counts = new Map<string, number>()
  for (const session of sessions) counts.set(session.title, (counts.get(session.title) ?? 0) + 1)
  const seen = new Map<string, number>()
  return new Map(sessions.map(session => {
    const title = session.title || 'Terminal'
    if ((counts.get(session.title) ?? 0) < 2) return [session.id, title]
    const index = (seen.get(session.title) ?? 0) + 1
    seen.set(session.title, index)
    return [session.id, `${title} ${index}`]
  }))
}

/**
 * The thread's shells, running in its working folder. Main keeps each session alive while the panel is hidden,
 * another thread is focused or the page changes; closing a tab here is the only thing that ends one.
 */
export function TerminalSurface({ threadId, store, bridge, viewFactory, viewFailed, idSuffix = '', chromeTitle = 'Terminal', newLabel = 'New terminal', barEnd, autoStart = false, startSize, focusNextRef }: TerminalSurfaceProps): ReactNode {
  const terminals = useThreadTerminals(store, threadId)
  const sessionCount = useSyncExternalStore(store.subscribe, store.sessionCount)
  const [confirming, setConfirming] = useState<string | null>(null)
  const internalFocusNext = useRef(false)
  const focusNext = focusNextRef ?? internalFocusNext
  const autoStarted = useRef(false)
  const screenId = `terminal-screen${idSuffix}`
  const chrome = chromeTitle === null ? null : <ToolsChrome title={chromeTitle} />
  // A pane drawer starts its first shell on its own; it never shows "Start terminal" while that is on its way.
  useEffect(() => {
    if (!autoStart || autoStarted.current || !terminals || terminals.status !== 'ready' || terminals.sessions.length > 0 || terminals.busy || !bridge || sessionCount >= TERMINAL_SESSIONS_MAX) return
    autoStarted.current = true
    focusNext.current = true
    void store.create(bridge, threadId, startSize?.())
  }, [autoStart, terminals, bridge, store, threadId, focusNext, sessionCount])
  if (!terminals || terminals.status === 'loading' && terminals.sessions.length === 0) return <>{chrome}<p className="files-preview__loading" role="status">Loading terminals…</p></>
  if (terminals.status === 'error' && terminals.sessions.length === 0) {
    return <>{chrome}<div className="files-problem files-problem--root" role="status">
      <strong>{listProblem(terminals.error ?? { code: 'unavailable', message: '' }, bridge !== undefined)}</strong>
      {bridge ? <button type="button" className="files-link tt-focusable" onClick={() => void store.activate(bridge, threadId)}>Try again</button> : null}
    </div></>
  }
  const start = (): void => { focusNext.current = true; void store.create(bridge, threadId, startSize?.()) }
  const { sessions } = terminals
  const active = sessions.find(session => session.id === terminals.activeSessionId) ?? null
  const names = sessionNames(sessions)
  const full = sessionCount >= TERMINAL_SESSIONS_MAX
  const limitHint = TERMINAL_LIMIT_MESSAGE

  if (sessions.length === 0) {
    // An attempt that is still on its way shows only a quiet status; one that failed falls through to the usual
    // empty state below, whose button lets it be retried and whose notice says what happened.
    if (autoStart && !terminals.notice && !full) return <div className="terminal-surface">{chrome}<p className="files-preview__loading" role="status">Starting terminal…</p></div>
    return <div className="terminal-surface">
      {chrome}
      <div className="files-problem files-problem--root terminal-empty">
        <strong>No terminal is open for this thread.</strong>
        <p>A terminal starts in the thread’s working folder and keeps running while you work elsewhere.</p>
        <button type="button" className="tt-button tt-button--primary tt-focusable" title={full ? limitHint : undefined} disabled={terminals.busy || full || !bridge} onClick={start}>Start terminal</button>
        {full ? <p className="terminal-notice" role="status">{limitHint}</p> : null}
        {terminals.notice ? <p className="terminal-notice" role="alert">{terminals.notice}</p> : null}
      </div>
    </div>
  }

  const focusTab = (id: string): void => document.getElementById(`terminal-tab-${id}`)?.focus()
  const interrupt = active?.status === 'running' ? <button type="button" className="files-icon tt-focusable" aria-label="Send Ctrl+C" title="Send Ctrl+C (stop the running command)"
    onClick={() => store.interrupt(bridge, threadId, active.id)}><CircleStop size={16} aria-hidden="true" /></button> : null
  const newShell = <button type="button" className="files-icon tt-focusable" aria-label={newLabel} title={full ? limitHint : newLabel}
    disabled={terminals.busy || full || !bridge} onClick={start}><Plus size={16} aria-hidden="true" /></button>
  return <div className="terminal-surface">
    <div className="terminal-bar tools-chrome">
      <div className="terminal-tabs" role="tablist" aria-label="Terminals">
        {sessions.map((session, index) => {
          const selected = session.id === active?.id
          // The open shell carries its own close, the way a tab closes, so the line's end holds only New terminal.
          return <span key={session.id} className="terminal-tabs__item" data-selected={selected || undefined}><button id={`terminal-tab-${session.id}`} type="button" role="tab" className="terminal-tabs__tab tt-focusable"
            aria-selected={selected} aria-controls={screenId} tabIndex={selected ? 0 : -1} data-status={session.status}
            title={`${names.get(session.id)} · ${sessionStatusText(session)}`}
            onClick={() => { setConfirming(null); store.select(threadId, session.id) }}
            onKeyDown={event => {
              const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
              const next = event.key === 'Home' ? sessions[0] : event.key === 'End' ? sessions.at(-1) : delta ? sessions[(index + delta + sessions.length) % sessions.length] : undefined
              if (!next) return
              event.preventDefault()
              setConfirming(null)
              store.select(threadId, next.id)
              focusTab(next.id)
            }}>
            <span className="terminal-tabs__dot" aria-hidden="true" />
            <span className="terminal-tabs__name">{names.get(session.id)}</span>
            {session.status !== 'running' ? <span className="tt-visually-hidden">, {sessionStatusText(session)}</span> : null}
          </button>
          {selected ? <button type="button" className="terminal-tabs__close tt-focusable" aria-label={`Close ${names.get(session.id)}`} title="Close terminal" disabled={terminals.busy}
            onClick={() => session.status === 'running' ? setConfirming(session.id) : void store.close(bridge, threadId, session.id)}><X size={14} aria-hidden="true" /></button> : null}
          </span>
        })}
      </div>
      {barEnd ? <>{newShell}{barEnd(interrupt)}</> : <div className="terminal-bar__actions tools-chrome__actions">{interrupt}{newShell}</div>}
    </div>
    {confirming !== null && confirming === active?.id ? <CloseConfirm name={names.get(active.id) ?? 'this terminal'}
      onEnd={() => { setConfirming(null); void store.close(bridge, threadId, active.id).then(() => { const next = store.thread(threadId)?.activeSessionId; if (next) focusTab(next) }) }}
      onKeep={() => { setConfirming(null); focusTab(active.id) }} /> : null}
    {terminals.notice || full ? <p className="terminal-notice" role={terminals.notice ? 'alert' : 'status'}>{terminals.notice ?? limitHint}</p> : null}
    {active ? <TerminalScreen key={active.id} session={active} name={names.get(active.id) ?? 'Terminal'} threadId={threadId} store={store} bridge={bridge}
      viewFactory={viewFactory} viewFailed={viewFailed} focusNext={focusNext} busy={terminals.busy} screenId={screenId} /> : null}
  </div>
}

function CloseConfirm({ name, onEnd, onKeep }: { readonly name: string; readonly onEnd: () => void; readonly onKeep: () => void }): ReactNode {
  const end = useRef<HTMLButtonElement>(null)
  useEffect(() => { end.current?.focus() }, [])
  return <div className="terminal-confirm" role="group" aria-label={`Close ${name}`} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onKeep() } }}>
    <p><strong>End {name}?</strong> Whatever is running in it stops.</p>
    <div className="terminal-confirm__actions">
      <button type="button" className="tt-button tt-focusable" onClick={onKeep}>Keep running</button>
      <button ref={end} type="button" className="tt-button tt-button--danger tt-focusable" onClick={onEnd}>End terminal</button>
    </div>
  </div>
}

function TerminalScreen({ session, name, threadId, store, bridge, viewFactory, viewFailed, focusNext, busy, screenId }: {
  readonly session: TerminalSession; readonly name: string; readonly threadId: string; readonly store: TerminalStore; readonly bridge: TerminalBridge | undefined
  readonly viewFactory: TerminalViewFactory | null; readonly viewFailed: boolean; readonly focusNext: React.MutableRefObject<boolean>; readonly busy: boolean; readonly screenId: string
}): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const sessionId = session.id
  const replaying = useSyncExternalStore(store.subscribe, () => store.replaying(sessionId))
  const loadError = useSyncExternalStore(store.subscribe, () => store.loadError(sessionId))

  useLayoutEffect(() => {
    const element = host.current
    if (!element || !viewFactory) return
    const view = store.attach(bridge, threadId, sessionId, element, viewFactory)
    const fit = (): void => {
      const size = view?.fit()
      if (size) store.resize(bridge, threadId, sessionId, size)
    }
    fit()
    if (focusNext.current) { focusNext.current = false; view?.focus() }
    if (typeof ResizeObserver === 'undefined') return () => store.detach(sessionId)
    let frame = 0
    const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fit) })
    observer.observe(element)
    return () => { observer.disconnect(); cancelAnimationFrame(frame); store.detach(sessionId) }
  }, [store, bridge, threadId, sessionId, viewFactory, focusNext])

  const ended = session.status !== 'running'
  return <div className="terminal-screen" id={screenId} role="tabpanel" aria-labelledby={`terminal-tab-${sessionId}`} data-ended={ended || undefined}>
    {ended ? <div className="terminal-ended" role="status">
      <p><strong>{sessionStatusText(session)}.</strong> {session.status === 'interrupted' ? 'Nothing it showed was kept.'
        : session.status === 'unavailable' ? 'The shell could not start in this folder.' : 'Its output stays here until you close it.'}</p>
      <button type="button" className="files-link tt-focusable" disabled={busy} onClick={() => { focusNext.current = true; void store.reopen(bridge, threadId, sessionId) }}>
        <RotateCcw size={14} aria-hidden="true" />Reopen</button>
    </div> : null}
    {viewFailed ? <TerminalViewProblem /> : null}
    {loadError ? <div className="files-problem" role="status"><strong>{loadError}</strong>
      <button type="button" className="files-link tt-focusable" onClick={() => store.retry(bridge, threadId, sessionId)}>Try again</button></div> : null}
    <div className="terminal-view" ref={host} aria-label={`${name}, terminal`} aria-busy={viewFactory === null && !viewFailed || undefined} data-replaying={replaying || undefined} />
    {replaying ? <p className="terminal-restoring" role="status">Restoring output…</p> : null}
    <p className="terminal-hint">Ctrl+C copies a selection or stops the command · Ctrl+Tab leaves the terminal</p>
  </div>
}
