import React, { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { GitBranch, RotateCcw, Square, SquareTerminal } from 'lucide-react'
import type { TerminalWorkspaceBridge } from '../../../shared/terminalWorkspace'
import { PaneMenu, type PaneMenuItem } from '../agents/PaneMenu'
import { ProviderMark } from '../agents/ProviderMark'
import type { TerminalViewFactory } from '../tools/terminalStore'
import { TerminalViewProblem } from '../tools/TerminalViewProblem'
import { exitLabel, exitNote, type TerminalRow } from './terminalFacts'
import type { TerminalWorkspaceStore } from './terminalWorkspaceStore'
import '../tools/tools.css'
import './terminals.css'

const CHIP_MS = 4_000

function fileName(path: string): string {
  return path.split(/[\\/]/u).at(-1) ?? path
}

/**
 * One terminal in the pane grid: the same header as a thread pane, the screen, and a status line with the branch and
 * the two shortcuts. Main keeps the process alive while the pane is hidden or the mode changes.
 */
export function TerminalPane({ row, store, bridge, viewFactory, viewFailed, focused, focusNext, busy, platform }: {
  readonly row: TerminalRow
  readonly store: TerminalWorkspaceStore
  readonly bridge: TerminalWorkspaceBridge | undefined
  /** Null until the xterm chunk loads; viewFailed distinguishes failure from loading. */
  readonly viewFactory: TerminalViewFactory | null
  readonly viewFailed: boolean
  readonly focused: boolean
  /** Put the cursor in the terminal once it mounts; cleared once used. */
  readonly focusNext: React.MutableRefObject<string | null>
  readonly busy: boolean
  readonly platform: string | undefined
}): ReactNode {
  const { terminal } = row
  const id = terminal.id
  const host = useRef<HTMLDivElement>(null)
  const replaying = useSyncExternalStore(store.subscribe, () => store.replaying(id))
  const loadError = useSyncExternalStore(store.subscribe, () => store.loadError(id))
  const pasted = useSyncExternalStore(store.subscribe, () => store.pasted(id))

  useLayoutEffect(() => {
    const element = host.current
    if (!element || !viewFactory) return
    const view = store.attach(bridge, id, element, viewFactory)
    const fit = (): void => {
      const size = view?.fit()
      if (size) store.resize(bridge, id, size)
    }
    fit()
    if (focusNext.current === id) { focusNext.current = null; view?.focus() }
    if (typeof ResizeObserver === 'undefined') return () => store.detach(id)
    let frame = 0
    const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fit) })
    observer.observe(element)
    return () => { observer.disconnect(); cancelAnimationFrame(frame); store.detach(id) }
  }, [store, bridge, id, viewFactory, focusNext])
  useEffect(() => {
    if (!pasted) return
    const timer = window.setTimeout(() => store.clearPasted(id), Math.max(0, pasted.at + CHIP_MS - Date.now()))
    return () => window.clearTimeout(timer)
  }, [pasted, store, id])

  // A terminal still starting shows as it will look: the header, an empty screen and the status line, with no exit note.
  const starting = terminal.status === 'starting'
  const running = terminal.status === 'running' || starting
  const workingCopy = terminal.workingCopy === 'independent' ? 'Worktree' : 'Project folder'
  const modifier = platform === 'darwin' ? '⌘' : 'Ctrl'
  const actions: PaneMenuItem[] = [
    { id: 'restart', label: 'Restart', icon: <RotateCcw size={15} aria-hidden="true" />, disabled: busy || !bridge, run: () => { focusNext.current = id; void store.restart(bridge, id) } },
    ...(running ? [{ id: 'stop', label: 'Stop', icon: <Square size={15} aria-hidden="true" />, disabled: !bridge, run: () => void store.stop(bridge, id) }] : []),
  ]
  return <div className="terminal-pane" data-focused={focused || undefined}>
    <header className="thread-workspace__head">
      <div className="thread-workspace__title">
        {row.providerId ? <ProviderMark provider={row.providerId} name={row.provider} size={16} /> : <SquareTerminal size={16} aria-hidden="true" />}
        <h2>{terminal.title}</h2>
        <span className="thread-workspace__crumb">
          <span>{row.project?.title ?? row.provider} · {workingCopy}</span>
          {!running ? <span className="thread-workspace__tag">{exitLabel(terminal)}</span> : null}
        </span>
      </div>
      <div className="thread-workspace__actions"><PaneMenu groups={[actions]} /></div>
    </header>
    <div className="terminal-pane__body" data-ended={!running || undefined}>
      {!running ? <div className="terminal-ended" role="status">
        <p><strong>{exitLabel(terminal)}.</strong> {exitNote(terminal)}</p>
        <button type="button" className="files-link tt-focusable" disabled={busy || !bridge} onClick={() => { focusNext.current = id; void store.restart(bridge, id) }}>
          <RotateCcw size={14} aria-hidden="true" />Restart</button>
      </div> : null}
      {viewFailed ? <TerminalViewProblem /> : null}
      {loadError ? <div className="files-problem" role="status"><strong>{loadError}</strong>
        <button type="button" className="files-link tt-focusable" onClick={() => store.retry(bridge, id)}>Try again</button></div> : null}
      <div className="terminal-view" ref={host} aria-label={`${terminal.title}, terminal`} aria-busy={viewFactory === null && !viewFailed || undefined} data-replaying={replaying || undefined} />
      {replaying ? <p className="terminal-restoring" role="status">Restoring output…</p> : null}
      {pasted ? <p className="terminal-pane__chip" role="status">Image saved · {fileName(pasted.path)}</p> : null}
    </div>
    <p className="terminal-status">
      <span className="terminal-status__branch" title={terminal.workingDirectory}><GitBranch size={13} aria-hidden="true" />{terminal.branch ?? (starting ? 'Starting…' : 'No branch')}</span>
      <span className="terminal-status__hints">{modifier}+C copies a selection or interrupts · {modifier}+V pastes text or an image</span>
    </p>
  </div>
}
