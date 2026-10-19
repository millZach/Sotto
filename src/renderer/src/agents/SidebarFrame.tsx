import React, { createContext, useCallback, useContext, useMemo, useLayoutEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Archive, ArchiveRestore, BarChart3, Brain, CircleHelp, Clock, FolderPlus, MessagesSquare, PanelLeftClose, PanelLeftOpen, Search, Settings, SquareTerminal, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { AgentState } from '../../../shared/agents'
import type { SottoPlatform } from '../../../shared/platform'
import { releaseTrackName } from '../../../shared/releaseTrack'
import { appRooms, roomFor, useRoomSwitch } from '../components/AppShell'
import { Button } from '../components/Button'
import { SottoMark } from '../components/SottoMark'
import { useOptionalApp, type AppNavigation } from '../state/AppContext'
import { useMemoryEnabled } from '../state/memoryFeature'
import { useReleaseTrack } from '../state/useReleaseTrack'
import { useWatcherEnabled } from '../state/watcherFeature'
import { useOwlFeature } from '../state/owlFeature'
import { WatcherOwl } from '../watcher/WatcherOwl'
import type { AgentConnection } from './AgentContext'
import { useAddProject } from './addProject'
import { OwlSky } from './OwlSky'
import { useSidebarSize } from './sidebarSize'

/** What the sidebar lists: threads, or the terminals of Terminal mode. */
export type SidebarMode = 'threads' | 'terminals'
export const SIDEBAR_MODE_KEY = 'sotto.threadWorkspace.mode'
const MODES: ReadonlyArray<{ readonly id: SidebarMode; readonly label: string; readonly Icon: LucideIcon }> = [
  { id: 'threads', label: 'Threads', Icon: MessagesSquare },
  { id: 'terminals', label: 'Terminal', Icon: SquareTerminal },
]

/** The page links in the foot, in the order the app footer listed them. Threads is the room switch's own tab; Memory joins only while memory is switched on. */
type FootPage = Extract<AppNavigation, 'history' | 'usage' | 'memory' | 'settings' | 'help'>
const PAGES: ReadonlyArray<{ readonly id: FootPage; readonly label: string; readonly Icon: LucideIcon }> = [
  { id: 'history', label: 'History', Icon: Clock },
  { id: 'usage', label: 'Usage', Icon: BarChart3 },
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
 * row's left end and the wordmark gives way to them. A Sotto Owl build shows the mark alone, as a larger tile in
 * the wordmark's place, and names itself.
 */
export function SidebarTop({ children }: { readonly children?: ReactNode }): ReactNode {
  const owl = useReleaseTrack() === 'owl'
  return <div className="thread-nav__top">
    {owl
      ? <span className="thread-nav__brand" role="img" aria-label={releaseTrackName('owl')}><SottoMark className="thread-nav__tile" /></span>
      : <span className="thread-nav__brand" aria-label="Sotto application"><SottoMark className="thread-nav__glyph" /><span className="thread-nav__wordmark">Sotto</span></span>}
    {children}
  </div>
}

/**
 * The room switch, drawn from the one room definition (`appRooms`): Dictate | Threads, with Watcher's owl between
 * them while its gate is on. It lights the room of the open page and answers the keyboard as every switch does
 * (`useRoomSwitch`): one Tab stop, arrow keys, Home and End, and focus handed to the lit tab of the switch the opened
 * page draws. The sidebar foot and Watcher's floating switch both draw this one.
 */
export function RoomSwitch({ className }: { readonly className: string }): ReactNode {
  const app = useOptionalApp()
  const shown = app === null || app.navigation === 'onboarding' ? 'threads' : app.navigation
  const rooms = appRooms(useWatcherEnabled())
  const roomSwitch = useRoomSwitch(roomFor(shown), rooms, destination => app?.actions.navigate(destination))
  return <div ref={roomSwitch.ref} className={className} role="tablist" aria-label="Page" data-rooms={rooms.length === 3 ? 3 : undefined}>
    {rooms.map((target, index) => <button key={target.id} type="button" role="tab" className="tt-focusable" data-room={target.id} {...roomSwitch.tab(target, index)}>
      {target.id === 'watcher' ? <WatcherOwl size={16} /> : target.label}</button>)}
  </div>
}

/** The pages the switch does not reach, as icon links: History, Settings and Help, and Memory while memory is switched on. */
export function PageLinks({ className, linkClassName }: { readonly className: string; readonly linkClassName: string }): ReactNode {
  const app = useOptionalApp()
  const memory = useMemoryEnabled()
  const usage = useOwlFeature('usage')
  const pages = PAGES.filter(page => (page.id !== 'memory' || memory) && (page.id !== 'usage' || usage))
  return <nav className={className} aria-label="Pages">
    {pages.map(({ id, label, Icon }) => <a key={id} href={`#${id}`} className={`${linkClassName} tt-focusable`} title={label}
      aria-current={app?.navigation === id ? 'page' : undefined} onClick={event => { event.preventDefault(); app?.actions.navigate(id) }}>
      <Icon size={16} aria-hidden="true" /><span className="tt-visually-hidden">{label}</span>
    </a>)}
  </nav>
}

/**
 * The sidebar's foot: the room switch, the other pages as icon links, and the update control. A page that carries
 * the sidebar, or a column that wears its frame, has no app footer under it, so this is the only way off the page.
 */
export function SidebarFoot(): ReactNode {
  const { updateControl } = useContext(SidebarChromeContext)
  return <div className="thread-nav__foot">
    <RoomSwitch className="thread-nav__seg" />
    <PageLinks className="thread-nav__pages" linkClassName="thread-nav__page" />
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
  /**
   * The New action's shortcut. `title` always shows in its tooltip once the chord claims one; `keys` sets
   * `aria-keyshortcuts` only when this exact button is what the chord invokes right now (a sidebar with a
   * focused thread answers the chord from that thread's own pen instead, so the top button carries none then).
   */
  readonly newShortcut?: { readonly title: string; readonly keys?: string | undefined } | undefined
  /** Where the window says it runs; macOS keeps the traffic lights' room in the top row. Defaults to the app's. */
  readonly platform?: SottoPlatform | undefined
  /** What sits at the sidebar's bottom edge; the room switch, the page links and the update control by default. */
  readonly foot?: ReactNode
  /** The page's hidden heading while the sidebar is the page's own; `null` beside a page with a heading of its own. */
  readonly title?: string | null | undefined
  readonly children: ReactNode
  readonly collapsedContent?: ReactNode
  /** A refusal from outside Add project, shown in the same place: an instant thread's creation, refused. */
  readonly extraError?: string | null | undefined
  readonly onDismissExtraError?: (() => void) | undefined
  /** What a project chosen with Add project opens in: the mode's own New action, there. */
  readonly onProjectAdded?: ((projectId: string) => void) | undefined
  /** A line directly under the search, above the list: the Threads sidebar's Needs attention count. */
  readonly afterSearch?: ReactNode
}

/**
 * The sidebar both modes share: one top row carrying the mark, the Threads | Terminal switch and the two new
 * actions, then search, the scrolling list, and the foot. Only what the body lists changes with the mode. The
 * top row is the frameless window's drag region, which is why every control in it is marked no-drag. A Sotto Owl
 * build paints its night sky behind the top row and the search field while the sidebar is open.
 */
export function SidebarFrame({ state, command, mode, onMode, label, query, searchPlaceholder, onQuery, onNew, newLabel, NewIcon, newShortcut, platform, foot, title = 'Threads', children, collapsedContent, extraError, onDismissExtraError, onProjectAdded, afterSearch }: SidebarFrameProps): ReactNode {
  const app = useOptionalApp()
  const addProject = useAddProject(state, command, { onAdded: onProjectAdded })
  const mac = (platform ?? app?.platform) === 'darwin'
  const size = useSidebarSize()
  const [resizing, setResizing] = useState(false)
  const toggle = useCollapseToggleFocus(size.collapsed)
  const sky = useReleaseTrack() === 'owl' && !size.collapsed
  return <aside className={mac ? 'thread-nav thread-nav--mac' : 'thread-nav'} aria-label={label} data-mode={mode} data-collapsed={size.collapsed || undefined} data-resizing={resizing || undefined}
    data-sky={sky || undefined} style={{ width: size.collapsed ? (mac ? 80 : 52) : size.width }}>
    <div className="thread-nav__expanded" hidden={size.collapsed}>
    {sky ? <OwlSky /> : null}
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
      <Button variant="ghost" iconOnly aria-label={newLabel} title={newShortcut ? newShortcut.title : newLabel} aria-keyshortcuts={newShortcut?.keys} onClick={onNew}><NewIcon size={16} /></Button>
      <button ref={size.collapsed ? undefined : toggle} type="button" className="thread-nav__action tt-focusable thread-nav__collapse" aria-label="Collapse sidebar" title="Collapse sidebar" onClick={() => size.collapse(true)}><PanelLeftClose size={16} aria-hidden="true" /></button>
    </SidebarTop>
    <label className="threads-search"><span className="tt-visually-hidden">{searchPlaceholder}</span><Search size={15} aria-hidden="true" />
      <input className="tt-input tt-focusable" type="search" value={query} placeholder={searchPlaceholder} onChange={event => onQuery(event.currentTarget.value)}
        onKeyDown={event => { if (event.key === 'Escape' && query) { event.preventDefault(); onQuery('') } }} />
      {query ? <button type="button" className="threads-search__clear tt-focusable" aria-label="Clear search" title="Clear search" onClick={() => onQuery('')}><X size={14} /></button> : null}
    </label>
    {afterSearch}
    {addProject.dialog}
    {addProject.error ? <p className="thread-nav__error" role="alert">{addProject.error}<button type="button" className="thread-nav__action tt-focusable" aria-label="Dismiss" onClick={addProject.clearError}><X size={14} aria-hidden="true" /></button></p> : null}
    {extraError ? <p className="thread-nav__error" role="alert">{extraError}{onDismissExtraError ? <button type="button" className="thread-nav__action tt-focusable" aria-label="Dismiss" onClick={onDismissExtraError}><X size={14} aria-hidden="true" /></button> : null}</p> : null}
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
