import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Plus, RotateCcw, Square, X } from 'lucide-react'
import type { TerminalBridge, TerminalSession } from '../../../shared/terminal'
import type { ToolsError } from '../../../shared/tools'
import { sessionStatusText, useThreadTerminals, type TerminalStore, type TerminalViewFactory } from './terminalStore'

export interface TerminalSurfaceProps {
  readonly threadId: string
  readonly store: TerminalStore
  readonly bridge: TerminalBridge | undefined
  /** Null while the xterm chunk is still loading; the screen renders empty and busy until it arrives. */
  readonly viewFactory: TerminalViewFactory | null
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
export function TerminalSurface({ threadId, store, bridge, viewFactory }: TerminalSurfaceProps): ReactNode {
  const terminals = useThreadTerminals(store, threadId)
  const [confirming, setConfirming] = useState<string | null>(null)
  const focusNext = useRef(false)
  if (!terminals || terminals.status === 'loading' && terminals.sessions.length === 0) return <p className="files-preview__loading" role="status">Loading terminals…</p>
  if (terminals.status === 'error' && terminals.sessions.length === 0) {
    return <div className="files-problem files-problem--root" role="status">
      <strong>{listProblem(terminals.error ?? { code: 'unavailable', message: '' }, bridge !== undefined)}</strong>
      {bridge ? <button type="button" className="files-link tt-focusable" onClick={() => void store.activate(bridge, threadId)}>Try again</button> : null}
    </div>
  }
  const start = (): void => { focusNext.current = true; void store.create(bridge, threadId) }
  const { sessions } = terminals
  const active = sessions.find(session => session.id === terminals.activeSessionId) ?? null
  const names = sessionNames(sessions)
  const full = sessions.length >= 32

  if (sessions.length === 0) {
    return <div className="terminal-surface">
      <div className="files-problem files-problem--root terminal-empty">
        <strong>No terminal is open for this thread.</strong>
        <p>A terminal starts in the thread’s working folder and keeps running while you work elsewhere.</p>
        <button type="button" className="tt-button tt-button--primary tt-focusable" disabled={terminals.busy || !bridge} onClick={start}>Start terminal</button>
        {terminals.notice ? <p className="terminal-notice" role="alert">{terminals.notice}</p> : null}
      </div>
    </div>
  }

  const focusTab = (id: string): void => document.getElementById(`terminal-tab-${id}`)?.focus()
  return <div className="terminal-surface">
    <div className="terminal-bar">
      <div className="terminal-tabs" role="tablist" aria-label="Terminals">
        {sessions.map((session, index) => {
          const selected = session.id === active?.id
          return <button key={session.id} id={`terminal-tab-${session.id}`} type="button" role="tab" className="terminal-tabs__tab tt-focusable"
            aria-selected={selected} aria-controls="terminal-screen" tabIndex={selected ? 0 : -1} data-status={session.status}
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
        })}
      </div>
      <div className="terminal-bar__actions">
        {active?.status === 'running' ? <button type="button" className="files-icon tt-focusable" aria-label="Send Ctrl+C" title="Send Ctrl+C (stop the running command)"
          onClick={() => store.interrupt(bridge, threadId, active.id)}><Square size={14} aria-hidden="true" /></button> : null}
        {active ? <button type="button" className="files-icon tt-focusable" aria-label={`Close ${names.get(active.id)}`} title="Close terminal" disabled={terminals.busy}
          onClick={() => active.status === 'running' ? setConfirming(active.id) : void store.close(bridge, threadId, active.id)}><X size={16} aria-hidden="true" /></button> : null}
        <button type="button" className="files-icon tt-focusable" aria-label="New terminal" title={full ? 'A thread can keep 32 terminals' : 'New terminal'}
          disabled={terminals.busy || full || !bridge} onClick={start}><Plus size={16} aria-hidden="true" /></button>
      </div>
    </div>
    {confirming !== null && confirming === active?.id ? <CloseConfirm name={names.get(active.id) ?? 'this terminal'}
      onEnd={() => { setConfirming(null); void store.close(bridge, threadId, active.id).then(() => { const next = store.thread(threadId)?.activeSessionId; if (next) focusTab(next) }) }}
      onKeep={() => { setConfirming(null); focusTab(active.id) }} /> : null}
    {terminals.notice ? <p className="terminal-notice" role="alert">{terminals.notice}</p> : null}
    {active ? <TerminalScreen key={active.id} session={active} name={names.get(active.id) ?? 'Terminal'} threadId={threadId} store={store} bridge={bridge}
      viewFactory={viewFactory} focusNext={focusNext} busy={terminals.busy} /> : null}
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

function TerminalScreen({ session, name, threadId, store, bridge, viewFactory, focusNext, busy }: {
  readonly session: TerminalSession; readonly name: string; readonly threadId: string; readonly store: TerminalStore; readonly bridge: TerminalBridge | undefined
  readonly viewFactory: TerminalViewFactory | null; readonly focusNext: React.MutableRefObject<boolean>; readonly busy: boolean
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
  return <div className="terminal-screen" id="terminal-screen" role="tabpanel" aria-labelledby={`terminal-tab-${sessionId}`} data-ended={ended || undefined}>
    {ended ? <div className="terminal-ended" role="status">
      <p><strong>{sessionStatusText(session)}.</strong> {session.status === 'interrupted' ? 'The output below is what it showed before; the shell is gone.'
        : session.status === 'unavailable' ? 'The shell could not start in this folder.' : 'Its output stays here until you close it.'}</p>
      <button type="button" className="files-link tt-focusable" disabled={busy} onClick={() => { focusNext.current = true; void store.reopen(bridge, threadId, sessionId) }}>
        <RotateCcw size={14} aria-hidden="true" />Reopen</button>
    </div> : null}
    {loadError ? <div className="files-problem" role="status"><strong>{loadError}</strong>
      <button type="button" className="files-link tt-focusable" onClick={() => store.retry(bridge, threadId, sessionId)}>Try again</button></div> : null}
    <div className="terminal-view" ref={host} aria-label={`${name}, terminal`} aria-busy={viewFactory === null || undefined} data-replaying={replaying || undefined} />
    {replaying ? <p className="terminal-restoring" role="status">Restoring output…</p> : null}
    <p className="terminal-hint">Ctrl+C copies a selection or stops the command · Ctrl+Tab leaves the terminal</p>
  </div>
}
