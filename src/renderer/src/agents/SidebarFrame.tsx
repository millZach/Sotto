import React, { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'
import { Brain, CircleHelp, Clock, FolderPlus, MessageSquare, MessagesSquare, Search, Settings, SquareTerminal, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { AgentState } from '../../../shared/agents'
import type { SottoPlatform } from '../../../shared/platform'
import { Button } from '../components/Button'
import { SottoMark } from '../components/SottoMark'
import { useOptionalApp, type AppNavigation } from '../state/AppContext'
import { useMemoryEnabled } from '../state/memoryFeature'
import { useVoiceCoordinatorEnabled } from '../state/voiceCoordinator'
import type { AgentConnection } from './AgentContext'
import { useAddProject } from './addProject'

/** What the sidebar lists: threads, or the terminals of Terminal mode. */
export type SidebarMode = 'threads' | 'terminals'
export const SIDEBAR_MODE_KEY = 'sotto.threadWorkspace.mode'
const MODES: ReadonlyArray<{ readonly id: SidebarMode; readonly label: string; readonly Icon: LucideIcon }> = [
  { id: 'threads', label: 'Threads', Icon: MessagesSquare },
  { id: 'terminals', label: 'Terminal', Icon: SquareTerminal },
]

/** The page links in the foot, in the order the app footer listed them. Threads is the room switch's own tab; Memory joins only while memory is switched on. */
type FootPage = Extract<AppNavigation, 'chats' | 'history' | 'memory' | 'settings' | 'help'>
const PAGES: ReadonlyArray<{ readonly id: FootPage; readonly label: string; readonly Icon: LucideIcon }> = [
  { id: 'chats', label: 'Chats', Icon: MessageSquare },
  { id: 'history', label: 'History', Icon: Clock },
  { id: 'memory', label: 'Memory', Icon: Brain },
  { id: 'settings', label: 'Settings', Icon: Settings },
  { id: 'help', label: 'Help', Icon: CircleHelp },
]

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

/**
 * What the page hands the sidebar's foot. The update control is built by App from the flow it already owns, and
 * Terminal mode renders its own sidebar two components deeper, so it travels by context rather than by prop.
 */
interface SidebarChrome { readonly updateControl: ReactNode }
const SidebarChromeContext = createContext<SidebarChrome>({ updateControl: null })

export function SidebarChromeProvider({ updateControl, children }: { readonly updateControl?: ReactNode; readonly children: ReactNode }): ReactNode {
  const value = useMemo<SidebarChrome>(() => ({ updateControl: updateControl ?? null }), [updateControl])
  return <SidebarChromeContext.Provider value={value}>{children}</SidebarChromeContext.Provider>
}

/**
 * The sidebar's foot: the Dictate | Threads room switch, the other pages as icon links, and the update control.
 * The Threads page owns the whole window and has no app footer under it, so this is the only way off the page.
 */
export function SidebarFoot(): ReactNode {
  const app = useOptionalApp()
  const { updateControl } = useContext(SidebarChromeContext)
  const coordinator = useVoiceCoordinatorEnabled()
  const memory = useMemoryEnabled()
  const go = (destination: AppNavigation): void => { app?.actions.navigate(destination) }
  // The same rooms the strip offers: Agents joins only while the voice coordinator is switched on.
  const rooms: ReadonlyArray<{ readonly id: string; readonly label: string; readonly destination: AppNavigation }> = [
    { id: 'dictate', label: 'Dictate', destination: 'home' },
    ...(coordinator ? [{ id: 'agents', label: 'Agents', destination: 'agents' as const }] : []),
    { id: 'threads', label: 'Threads', destination: 'threads' },
  ]
  /** Arrow keys walk the switch, as they do in the strip: only the lit tab is in the Tab order, so this is how the others are reached. */
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % rooms.length
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + rooms.length) % rooms.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = rooms.length - 1
    if (next === null) return
    event.preventDefault()
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
    go(rooms[next]!.destination)
  }
  const pages = memory ? PAGES : PAGES.filter(page => page.id !== 'memory')
  return <div className="thread-nav__foot">
    <div className="thread-nav__seg" role="tablist" aria-label="Page">
      {rooms.map(({ id, label, destination }, index) => <button key={id} type="button" role="tab" className="tt-focusable" aria-selected={id === 'threads'}
        tabIndex={id === 'threads' ? 0 : -1} onClick={() => go(destination)} onKeyDown={event => onTabKey(event, index)}>{label}</button>)}
    </div>
    <nav className="thread-nav__pages" aria-label="Pages">
      {pages.map(({ id, label, Icon }) => <a key={id} href={`#${id}`} className="thread-nav__page tt-focusable" title={label}
        aria-current={app?.navigation === id ? 'page' : undefined} onClick={event => { event.preventDefault(); go(id) }}>
        <Icon size={16} aria-hidden="true" /><span className="tt-visually-hidden">{label}</span>
      </a>)}
    </nav>
    {updateControl}
  </div>
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
  /** Where the window says it runs; macOS keeps the traffic lights' room in the top row. Defaults to the app's. */
  readonly platform?: SottoPlatform | undefined
  /** What sits at the sidebar's bottom edge; the room switch, the page links and the update control by default. */
  readonly foot?: ReactNode
  readonly children: ReactNode
}

/**
 * The sidebar both modes share: one top row carrying the mark, the Threads | Terminal switch and the two new
 * actions, then search, the scrolling list, and the foot. Only what the body lists changes with the mode. The
 * top row is the frameless window's drag region, which is why every control in it is marked no-drag.
 */
export function SidebarFrame({ state, command, mode, onMode, label, query, searchPlaceholder, onQuery, onNew, newLabel, NewIcon, platform, foot, children }: SidebarFrameProps): ReactNode {
  const app = useOptionalApp()
  const addProject = useAddProject(state, command)
  const mac = (platform ?? app?.platform) === 'darwin'
  return <aside className={mac ? 'thread-nav thread-nav--mac' : 'thread-nav'} aria-label={label} data-mode={mode}>
    <div className="thread-nav__top">
      <SottoMark className="thread-nav__glyph" />
      <h1 className="tt-visually-hidden">Threads</h1>
      <div className="thread-nav__seg thread-nav__seg--icons" role="radiogroup" aria-label="Sidebar mode">
        {MODES.map(({ id, label: modeLabel, Icon }) => <button key={id} type="button" role="radio" className="tt-focusable" title={modeLabel}
          aria-checked={id === mode} tabIndex={id === mode ? 0 : -1}
          onClick={() => onMode(id)}
          onKeyDown={event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            const next = MODES[(MODES.findIndex(candidate => candidate.id === mode) + (event.key === 'ArrowRight' ? 1 : MODES.length - 1)) % MODES.length]!.id
            onMode(next)
            window.setTimeout(() => document.querySelector<HTMLElement>('.thread-nav__seg[role="radiogroup"] [role="radio"][aria-checked="true"]')?.focus(), 0)
          }}><Icon size={15} aria-hidden="true" /><span className="tt-visually-hidden">{modeLabel}</span></button>)}
      </div>
      <Button variant="ghost" iconOnly aria-label="Add project" title="Add project" disabled={addProject.adding} onClick={() => void addProject.add()}><FolderPlus size={16} /></Button>
      <Button variant="ghost" iconOnly aria-label={newLabel} title={newLabel} onClick={onNew}><NewIcon size={16} /></Button>
    </div>
    <label className="threads-search"><span className="tt-visually-hidden">{searchPlaceholder}</span><Search size={15} aria-hidden="true" />
      <input className="tt-input tt-focusable" type="search" value={query} placeholder={searchPlaceholder} onChange={event => onQuery(event.currentTarget.value)}
        onKeyDown={event => { if (event.key === 'Escape' && query) { event.preventDefault(); onQuery('') } }} />
      {query ? <button type="button" className="threads-search__clear tt-focusable" aria-label="Clear search" title="Clear search" onClick={() => onQuery('')}><X size={14} /></button> : null}
    </label>
    {addProject.error ? <p className="thread-nav__error" role="alert">{addProject.error}<button type="button" className="thread-nav__action tt-focusable" aria-label="Dismiss" onClick={addProject.clearError}><X size={14} aria-hidden="true" /></button></p> : null}
    <div className="thread-nav__scroll">{children}</div>
    {foot ?? <SidebarFoot />}
  </aside>
}
