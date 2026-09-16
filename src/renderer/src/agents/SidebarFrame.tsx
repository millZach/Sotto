import React, { useCallback, useSyncExternalStore, type ReactNode } from 'react'
import { FolderPlus, Search, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { AgentState } from '../../../shared/agents'
import { Button } from '../components/Button'
import type { AgentConnection } from './AgentContext'
import { useAddProject } from './addProject'

/** What the sidebar lists: threads, or the terminals of Terminal mode. */
export type SidebarMode = 'threads' | 'terminals'
export const SIDEBAR_MODE_KEY = 'sotto.threadWorkspace.mode'
const MODES: ReadonlyArray<{ readonly id: SidebarMode; readonly label: string }> = [{ id: 'threads', label: 'Threads' }, { id: 'terminals', label: 'Terminal' }]

const modeListeners = new Set<() => void>()
function readMode(): SidebarMode {
  try { return localStorage.getItem(SIDEBAR_MODE_KEY) === 'terminals' ? 'terminals' : 'threads' } catch { return 'threads' }
}
/** The mode this window was last in; it is remembered per window like the pane arrangement. */
export function useSidebarMode(): readonly [SidebarMode, (mode: SidebarMode) => void] {
  const subscribe = useCallback((listener: () => void) => { modeListeners.add(listener); return () => { modeListeners.delete(listener) } }, [])
  const mode = useSyncExternalStore(subscribe, readMode, () => 'threads' as const)
  const set = useCallback((next: SidebarMode): void => {
    try { localStorage.setItem(SIDEBAR_MODE_KEY, next) } catch { /* Private mode: the switch still works for this render tree. */ }
    for (const listener of [...modeListeners]) listener()
  }, [])
  return [mode, set]
}

export interface SidebarFrameProps {
  readonly state: AgentState
  readonly command: AgentConnection['command']
  readonly mode: SidebarMode
  readonly onMode: (mode: SidebarMode) => void
  readonly label: string
  readonly query: string
  readonly searchPlaceholder: string
  readonly onQuery: (query: string) => void
  /** The header's New action. */
  readonly onNew: () => void
  readonly newLabel: string
  readonly NewIcon: LucideIcon
  readonly children: ReactNode
}

/**
 * The sidebar both modes share: the Threads header with Add project and New, the Threads | Terminal switch,
 * the search, and a scrolling body. Only what the body lists changes with the mode.
 */
export function SidebarFrame({ state, command, mode, onMode, label, query, searchPlaceholder, onQuery, onNew, newLabel, NewIcon, children }: SidebarFrameProps): ReactNode {
  const addProject = useAddProject(state, command)
  return <aside className="thread-nav" aria-label={label} data-mode={mode}>
    <header className="thread-nav__head"><h1>Threads</h1>
      <span className="thread-nav__head-actions">
        <Button variant="ghost" iconOnly aria-label="Add project" title="Add project" disabled={addProject.adding} onClick={() => void addProject.add()}><FolderPlus size={18} /></Button>
        <Button variant="ghost" iconOnly aria-label={newLabel} title={newLabel} onClick={onNew}><NewIcon size={18} /></Button>
      </span>
    </header>
    <div className="thread-nav__mode" role="radiogroup" aria-label="Sidebar mode">
      {MODES.map(item => <button key={item.id} type="button" role="radio" className="tt-focusable" aria-checked={item.id === mode} tabIndex={item.id === mode ? 0 : -1}
        onClick={() => onMode(item.id)}
        onKeyDown={event => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          const next = MODES[(MODES.findIndex(candidate => candidate.id === mode) + (event.key === 'ArrowRight' ? 1 : MODES.length - 1)) % MODES.length]!.id
          onMode(next)
          window.setTimeout(() => document.querySelector<HTMLElement>(`.thread-nav__mode [role="radio"][aria-checked="true"]`)?.focus(), 0)
        }}>{item.label}</button>)}
    </div>
    {addProject.error ? <p className="thread-nav__error" role="alert">{addProject.error}<button type="button" className="thread-nav__action tt-focusable" aria-label="Dismiss" onClick={addProject.clearError}><X size={14} aria-hidden="true" /></button></p> : null}
    <label className="threads-search"><span className="tt-visually-hidden">{searchPlaceholder}</span><Search size={16} aria-hidden="true" />
      <input className="tt-input tt-focusable" type="search" value={query} placeholder={searchPlaceholder} onChange={event => onQuery(event.currentTarget.value)}
        onKeyDown={event => { if (event.key === 'Escape' && query) { event.preventDefault(); onQuery('') } }} />
      {query ? <button type="button" className="threads-search__clear tt-focusable" aria-label="Clear search" title="Clear search" onClick={() => onQuery('')}><X size={14} /></button> : null}
    </label>
    <div className="thread-nav__scroll">{children}</div>
  </aside>
}
