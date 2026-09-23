import React, { createContext, useCallback, useContext, useMemo, useLayoutEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'
import { Archive, ArchiveRestore, Brain, CircleHelp, Clock, FolderPlus, MessageSquare, MessagesSquare, PanelLeftClose, PanelLeftOpen, Search, Settings, SquareTerminal, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { AgentState } from '../../../shared/agents'
import type { SottoPlatform } from '../../../shared/platform'
import { roomFor } from '../components/AppShell'
import { Button } from '../components/Button'
import { SottoMark } from '../components/SottoMark'
import { useOptionalApp, type AppNavigation } from '../state/AppContext'
import { useMemoryEnabled } from '../state/memoryFeature'
import { useVoiceCoordinatorEnabled } from '../state/voiceCoordinator'
import type { AgentConnection } from './AgentContext'
import { useAddProject } from './addProject'
import { useSidebarSize } from './sidebarSize'

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
 * The sidebar's top row: the mark with the wordmark beside it, then whatever controls the column adds. It is the
 * frameless window's drag region, so every control in it is marked no-drag. On macOS the traffic lights take the
 * row's left end and the wordmark gives way to them.
 */
export function SidebarTop({ children }: { readonly children?: ReactNode }): ReactNode {
  return <div className="thread-nav__top">
    <span className="thread-nav__brand" aria-label="Sotto application"><SottoMark className="thread-nav__glyph" /><span className="thread-nav__wordmark">Sotto</span></span>
    {children}
  </div>
}

/**
 * The sidebar's foot: the Dictate | Threads room switch, the other pages as icon links, and the update control.
 * A page that carries the sidebar, or a column that wears its frame, has no app footer under it, so this is the
 * only way off the page. The switch lights the room of the open page, the way the strip's did.
 */
export function SidebarFoot(): ReactNode {
  const app = useOptionalApp()
  const { updateControl } = useContext(SidebarChromeContext)
  const coordinator = useVoiceCoordinatorEnabled()
  const memory = useMemoryEnabled()
  // With the coordinator off the Agents page is the Threads page (App.tsx), so the foot lights Threads for it.
  const shown = app === null || app.navigation === 'onboarding' || (app.navigation === 'agents' && !coordinator) ? 'threads' : app.navigation
  const room = roomFor(shown)
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
  // Only one tab is in the Tab order: the lit one, or the first when the open page lights none (Settings, History, Help).
  const focusable = rooms.some(({ id }) => id === room) ? room : rooms[0]!.id
  return <div className="thread-nav__foot">
    <div className="thread-nav__seg" role="tablist" aria-label="Page">
      {rooms.map(({ id, label, destination }, index) => <button key={id} type="button" role="tab" className="tt-focusable" aria-selected={id === room}
        tabIndex={id === focusable ? 0 : -1} onClick={() => go(destination)} onKeyDown={event => onTabKey(event, index)}>{label}</button>)}
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

type SidebarSize = ReturnType<typeof useSidebarSize>

/** The collapse and expand buttons trade places; focus follows the press to whichever one is now shown. */
export function useCollapseToggleFocus(collapsed: boolean): React.RefObject<HTMLButtonElement | null> {
  const toggle = useRef<HTMLButtonElement>(null)
  const previous = useRef(collapsed)
  useLayoutEffect(() => {
    if (previous.current !== collapsed) toggle.current?.focus()
    previous.current = collapsed
  }, [collapsed])
  return toggle
}

/** The handle on a sidebar's right edge: drag it, or focus it and use the arrow keys. Double-click resets the width. */
export function SidebarResize({ size, onResizing }: { readonly size: SidebarSize; readonly onResizing: (resizing: boolean) => void }): ReactNode {
  const helpId = useId()
  return <div className="thread-nav__resize tt-focusable" role="separator" tabIndex={0} aria-label="Resize sidebar" aria-describedby={helpId} aria-orientation="vertical" aria-valuemin={260} aria-valuemax={size.maximum} aria-valuenow={size.width}
    aria-valuetext={`${size.width} pixels`} title="Drag to resize. Use arrow keys when focused. Double-click to reset."
    onPointerDown={event => {
      if (event.button !== 0) return
      event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); onResizing(true)
    }}
    onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) size.resize(event.clientX - event.currentTarget.parentElement!.getBoundingClientRect().left) }}
    onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); onResizing(false) }}
    onLostPointerCapture={() => onResizing(false)} onDoubleClick={size.reset}
    onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault(); event.stopPropagation()
      size.resize(event.key === 'Home' ? 260 : event.key === 'End' ? size.maximum : size.width + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 40 : 10))
    }}><span id={helpId} className="tt-visually-hidden">Use Left and Right arrow keys to resize. Hold Shift for larger steps. Home chooses the narrowest width; End chooses the widest.</span></div>
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
  /** The page's hidden heading while the sidebar is the page's own; `null` beside a page with a heading of its own. */
  readonly title?: string | null | undefined
  readonly children: ReactNode
  readonly collapsedContent?: ReactNode
}

/**
 * The sidebar both modes share: one top row carrying the mark, the Threads | Terminal switch and the two new
 * actions, then search, the scrolling list, and the foot. Only what the body lists changes with the mode. The
 * top row is the frameless window's drag region, which is why every control in it is marked no-drag.
 */
export function SidebarFrame({ state, command, mode, onMode, label, query, searchPlaceholder, onQuery, onNew, newLabel, NewIcon, platform, foot, title = 'Threads', children, collapsedContent }: SidebarFrameProps): ReactNode {
  const app = useOptionalApp()
  const addProject = useAddProject(state, command)
  const mac = (platform ?? app?.platform) === 'darwin'
  const size = useSidebarSize()
  const [resizing, setResizing] = useState(false)
  const toggle = useCollapseToggleFocus(size.collapsed)
  return <aside className={mac ? 'thread-nav thread-nav--mac' : 'thread-nav'} aria-label={label} data-mode={mode} data-collapsed={size.collapsed || undefined} data-resizing={resizing || undefined}
    style={{ width: size.collapsed ? (mac ? 80 : 52) : size.width }}>
    <div className="thread-nav__expanded" hidden={size.collapsed}>
    <SidebarTop>
      {title === null ? null : <h1 className="tt-visually-hidden">{title}</h1>}
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
      <button ref={size.collapsed ? undefined : toggle} type="button" className="thread-nav__action tt-focusable thread-nav__collapse" aria-label="Collapse sidebar" title="Collapse sidebar" onClick={() => size.collapse(true)}><PanelLeftClose size={16} aria-hidden="true" /></button>
    </SidebarTop>
    <label className="threads-search"><span className="tt-visually-hidden">{searchPlaceholder}</span><Search size={15} aria-hidden="true" />
      <input className="tt-input tt-focusable" type="search" value={query} placeholder={searchPlaceholder} onChange={event => onQuery(event.currentTarget.value)}
        onKeyDown={event => { if (event.key === 'Escape' && query) { event.preventDefault(); onQuery('') } }} />
      {query ? <button type="button" className="threads-search__clear tt-focusable" aria-label="Clear search" title="Clear search" onClick={() => onQuery('')}><X size={14} /></button> : null}
    </label>
    {addProject.error ? <p className="thread-nav__error" role="alert">{addProject.error}<button type="button" className="thread-nav__action tt-focusable" aria-label="Dismiss" onClick={addProject.clearError}><X size={14} aria-hidden="true" /></button></p> : null}
    <div className="thread-nav__scroll">{children}</div>
    {size.collapsed ? null : foot ?? <SidebarFoot />}
    </div>
    {size.collapsed ? <div className="thread-nav__rail">
      <SottoMark className="thread-nav__glyph" />
      <button ref={toggle} type="button" className="thread-nav__action tt-focusable" aria-label="Expand sidebar" title="Expand sidebar" onClick={() => size.collapse(false)}><PanelLeftOpen size={16} aria-hidden="true" /></button>
      <div className="thread-nav__rail-list">{collapsedContent ?? <button type="button" className="thread-nav__action tt-focusable" aria-label={newLabel} title={newLabel} onClick={onNew}><NewIcon size={16} aria-hidden="true" /></button>}</div>
      {foot ?? <SidebarFoot />}
    </div> : <SidebarResize size={size} onResizing={setResizing} />}
  </aside>
}

/** Settle project, or Restore project once settled: the same action on a folder head in either sidebar mode. */
export function ProjectSettleAction({ projectId, title, settled, disabled, command }: {
  readonly projectId: string; readonly title: string; readonly settled: boolean; readonly disabled: boolean
  readonly command: AgentConnection['command']
}): ReactNode {
  return settled
    ? <button type="button" className="thread-nav__action tt-focusable" aria-label={`Restore project ${title}`} title="Restore project" disabled={disabled} onClick={() => void command({ type: 'restore-project', projectId })}><ArchiveRestore size={16} aria-hidden="true" /></button>
    : <button type="button" className="thread-nav__action tt-focusable" aria-label={`Settle project ${title}`} title="Settle project" disabled={disabled} onClick={() => void command({ type: 'settle-project', projectId })}><Archive size={16} aria-hidden="true" /></button>
}
