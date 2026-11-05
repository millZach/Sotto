import React, { createContext, useContext, useEffect, useMemo, useLayoutEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { Archive, ArchiveRestore, BarChart3, Brain, CircleHelp, FolderPlus, PanelLeftClose, PanelLeftOpen, Search, Settings, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { AgentState } from '../../../shared/agents'
import type { SottoPlatform } from '../../../shared/platform'
import { THREAD_SHORTCUT_IDS } from '../../../shared/threadShortcuts'
import { releaseTrackName } from '../../../shared/releaseTrack'
import { appRooms, roomFor, RoomTabFace, useRoomSwitch } from '../components/AppShell'
import { pageShortcutFor, usePageShortcutLabels } from '../components/pageShortcuts'
import { Button } from '../components/Button'
import { SottoMark } from '../components/SottoMark'
import { useOptionalApp, type AppNavigation } from '../state/AppContext'
import { useDictationOn } from '../state/dictationFeature'
import { useMemoryEnabled } from '../state/memoryFeature'
import { useReleaseTrack } from '../state/useReleaseTrack'
import { useWatcherEnabled } from '../state/watcherFeature'
import { useOwlFeature } from '../state/owlFeature'
import { WatcherOwl } from '../watcher/WatcherOwl'
import { useRoomWatcherThreadId } from '../watcher/watcherRoom'
import { useOptionalAgents } from './AgentContext'
import type { AgentConnection } from './AgentContext'
import { useAddProject } from './addProject'
import { OwlSky } from './OwlSky'
import { useSidebarSize } from './sidebarSize'
import { chordMatches } from './branchToolbar.logic'
import { claimedThreadChord, fixedKeyFree, sameThreadKeys, SIDEBAR_TOGGLE_CHORD, threadChordLabel, type ThreadChordLabel } from './threadShortcuts'
import { chordBelongsElsewhere } from '../tools/changesShortcut'
import { shownCount } from '../state/interfaceNumbers'

/**
 * The page links in the foot, in the order the app footer listed them. Threads and Dictate are the room switch's own
 * tabs, and transcripts live in the Dictate room's Journal; Memory joins only while memory is switched on.
 */
type FootPage = Extract<AppNavigation, 'usage' | 'memory' | 'settings' | 'help'>
const PAGES: ReadonlyArray<{ readonly id: FootPage; readonly label: MessageDescriptor; readonly Icon: LucideIcon }> = [
  { id: 'usage', label: msg({ message: 'Usage', comment: 'The Usage page.' }), Icon: BarChart3 },
  { id: 'memory', label: msg({ message: 'Memory', comment: 'The Memory page.' }), Icon: Brain },
  { id: 'settings', label: msg({ message: 'Settings', comment: 'The Settings page.' }), Icon: Settings },
  { id: 'help', label: msg({ message: 'Help', comment: 'The Help page.' }), Icon: CircleHelp },
]

/**
 * What the page hands the sidebar's foot. The update control is built by App from the flow it already owns, and
 * every page's sidebar draws the foot, so it travels by context rather than by prop.
 */
interface SidebarChrome { readonly updateControl: ReactNode }
const SidebarChromeContext = createContext<SidebarChrome>({ updateControl: null })

export function SidebarChromeProvider({ updateControl, children }: { readonly updateControl?: ReactNode; readonly children: ReactNode }): ReactNode {
  const value = useMemo<SidebarChrome>(() => ({ updateControl: updateControl ?? null }), [updateControl])
  return <SidebarChromeContext.Provider value={value}>{children}</SidebarChromeContext.Provider>
}

/**
 * The sidebar's top row: the mark with the wordmark beside it, then whatever controls the column adds. It is the
 * frameless window's drag region, so every control in it is marked no-drag. On macOS no mark sits beside the
 * traffic lights at the row's left end; a spacer keeps the controls at its right end. A Sotto Owl build shows
 * the mark alone, as a larger tile in the wordmark's place, and names itself.
 */
export function SidebarTop({ children, platform }: { readonly children?: ReactNode; readonly platform?: SottoPlatform | undefined }): ReactNode {
  const app = useOptionalApp()
  const mac = (platform ?? app?.platform) === 'darwin'
  const owl = useReleaseTrack() === 'owl'
  const { t } = useLingui()
  const brand = mac
    ? <span className="thread-nav__spacer" />
    : owl
      ? <span className="thread-nav__brand" role="img" aria-label={releaseTrackName('owl')}><SottoMark className="thread-nav__tile" /></span>
      : <span className="thread-nav__brand" aria-label={t`Sotto application`}><SottoMark className="thread-nav__glyph" /><span className="thread-nav__wordmark">Sotto</span></span>
  return <div className="thread-nav__top">
    {brand}
    {children}
  </div>
}

/**
 * The room switch, drawn from the one room definition (`appRooms`): Dictate | Threads, with Watcher's owl between
 * them while its gate is on and without Dictate while dictation is off (ADR-0107); left with one room it is not
 * drawn. It lights the room of the open page and answers the keyboard as every switch does
 * (`useRoomSwitch`): one Tab stop, arrow keys, Home and End, and focus handed to the lit tab of the switch the opened
 * page draws. The sidebar foot and Watcher's floating switch both draw this one; the foot draws it `iconOnly`, its
 * lit tile showing no name, so every tile there carries its name as a tooltip.
 */
export function RoomSwitch({ className, iconOnly = false }: { readonly className: string; readonly iconOnly?: boolean }): ReactNode {
  const app = useOptionalApp()
  const shown = app === null || app.navigation === 'onboarding' ? 'threads' : app.navigation
  const rooms = appRooms({ watcher: useWatcherEnabled(), dictation: useDictationOn() })
  const roomSwitch = useRoomSwitch(roomFor(shown), rooms, destination => app?.actions.navigate(destination))
  const { t } = useLingui()
  if (rooms.length < 2) return null
  return <div ref={roomSwitch.ref} className={className} role="tablist" aria-label={t({ message: 'Page', comment: 'The room switch: which page of the app is open.' })}>
    {rooms.map((target, index) => {
      const tab = roomSwitch.tab(target, index)
      // Where the lit tile shows no name (the sidebar foot), every tile names itself on hover, the lit one too.
      return <button key={target.id} type="button" role="tab" className="tt-focusable" data-room={target.id} {...tab}
        title={iconOnly ? tab.title ?? target.label : tab.title}>
        <RoomTabFace room={target} named={!iconOnly} /></button>
    })}
  </div>
}

/** The pages the switch does not reach, as icon links: Usage, Settings and Help, and Memory while memory is switched on. */
export function PageLinks({ className, linkClassName }: { readonly className: string; readonly linkClassName: string }): ReactNode {
  const app = useOptionalApp()
  const memory = useMemoryEnabled()
  const usage = useOwlFeature('usage')
  const { t } = useLingui()
  const keys = usePageShortcutLabels()
  const pages = PAGES.filter(page => (page.id !== 'memory' || memory) && (page.id !== 'usage' || usage)).map(page => ({ ...page, label: t(page.label) }))
  return <nav className={className} aria-label={t`Pages`}>
    {pages.map(({ id, label, Icon }) => {
      const page = pageShortcutFor(id)
      const shortcut = page === undefined ? undefined : keys[page]
      return <a key={id} href={`#${id}`} className={`${linkClassName} tt-focusable`} title={shortcut ? `${label} ${shortcut.suffix}` : label}
      aria-keyshortcuts={shortcut?.keys} aria-current={app?.navigation === id ? 'page' : undefined} onClick={event => { event.preventDefault(); app?.actions.navigate(id) }}>
      <Icon size={16} aria-hidden="true" /><span className="tt-visually-hidden">{label}</span>
    </a>
    })}
  </nav>
}

/**
 * The way off the page as one row of icons: the room switch, a hairline, the other pages as icon links, then the update
 * control. The sidebar's foot draws it, and so does Watcher's header, which has no sidebar (ADR-0152).
 */
export function WayOffThePage({ className, roomsClassName, pagesClassName, updateControl }: {
  readonly className: string
  readonly roomsClassName: string
  readonly pagesClassName: string
  readonly updateControl: ReactNode
}): ReactNode {
  return <div className={className}>
    <RoomSwitch className={roomsClassName} iconOnly />
    <span className="thread-nav__foot-rule" aria-hidden="true" />
    <PageLinks className={pagesClassName} linkClassName="thread-nav__page" />
    {updateControl}
  </div>
}

/**
 * The sidebar's foot, with the update control at the far end. A page that carries the sidebar, or a column that wears
 * its frame, has no app footer under it, so this is the only way off the page.
 */
export function SidebarFoot(): ReactNode {
  const { updateControl } = useContext(SidebarChromeContext)
  return <WayOffThePage className="thread-nav__foot" roomsClassName="thread-nav__seg" pagesClassName="thread-nav__pages" updateControl={updateControl} />
}

/**
 * Watcher's tile on the collapsed rail, under Expand (ADR-0146): the owl on a raised tile with Watcher's own status
 * ring, the same press as the room switch's owl. Watcher's thread is not in the sidebar's state, so its ring reads
 * the window's whole state.
 */
function RailWatcher(): ReactNode {
  const app = useOptionalApp()
  const threads = useOptionalAgents()?.state?.host.threads
  const watcherId = useRoomWatcherThreadId()
  const { t } = useLingui()
  const thread = watcherId === null ? undefined : threads?.find(item => item.id === watcherId)
  const ring = thread === undefined ? 'done' : thread.requests.length ? 'needs' : thread.status === 'running' ? 'working' : 'done'
  return <button type="button" className="thread-nav__rail-thread thread-nav__rail-watcher tt-focusable" aria-label={t`Open Watcher`} title={t`Open Watcher`}
    aria-current={app?.navigation === 'watcher' ? 'page' : undefined} onClick={() => app?.actions.navigate('watcher')}>
    <WatcherOwl size={18} /><span className="thread-nav__ring" data-state={ring} aria-hidden="true" />
  </button>
}

type SidebarSize = ReturnType<typeof useSidebarSize>

/** Whether the focus has gone with what was hidden: nowhere, or inside something now hidden or out of reach. */
function focusLost(): boolean {
  const active = document.activeElement
  return active === null || active === document.body || active.closest('[hidden], [inert]') !== null
}

/**
 * The collapse and expand buttons trade places; focus follows the press to whichever one is now shown. A window crossing
 * the narrow line trades them too, and then the focus moves only if it was in the part that went.
 */
export function useCollapseToggleFocus(collapsed: boolean): React.RefObject<HTMLButtonElement | null> {
  const toggle = useRef<HTMLButtonElement>(null)
  const previous = useRef(collapsed)
  useLayoutEffect(() => {
    if (previous.current !== collapsed && focusLost()) toggle.current?.focus()
    previous.current = collapsed
  }, [collapsed])
  return toggle
}

/**
 * The keys that show or hide the sidebar (`SIDEBAR_TOGGLE_CHORD`), unless one of dictation's shortcuts or a thread
 * shortcut the user saved means the same keys; either of those wins, and the sidebar keeps its buttons.
 */
function useSidebarChord(): { readonly label: ThreadChordLabel; readonly platform: SottoPlatform } | undefined {
  const app = useOptionalApp()
  const settings = app?.settings
  const platform: SottoPlatform = app?.platform ?? 'win32'
  return useMemo(() => fixedKeyFree(settings, SIDEBAR_TOGGLE_CHORD, platform)
    && !THREAD_SHORTCUT_IDS.some(id => { const chord = claimedThreadChord(settings, id, platform); return chord !== null && sameThreadKeys(chord, SIDEBAR_TOGGLE_CHORD, platform) })
    ? { label: threadChordLabel(SIDEBAR_TOGGLE_CHORD, platform), platform } : undefined, [settings, platform])
}

/** What a Tab inside the sidebar over the thread may land on, in order, so Tab can go round inside it. */
function tabStops(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')]
    .filter(item => item.tabIndex >= 0 && !(item as HTMLButtonElement).disabled && item.closest('[hidden], [inert]') === null
      && (typeof item.checkVisibility !== 'function' || item.checkVisibility()))
}

/** The handle on a sidebar's right edge: drag it, or focus it and use the arrow keys. Double-click resets the width. */
export function SidebarResize({ size, onResizing }: { readonly size: SidebarSize; readonly onResizing: (resizing: boolean) => void }): ReactNode {
  const helpId = useId()
  const { t } = useLingui()
  const width = size.width
  return <div className="thread-nav__resize tt-focusable" role="separator" tabIndex={0} aria-label={t`Resize sidebar`} aria-describedby={helpId} aria-orientation="vertical" aria-valuemin={260} aria-valuemax={size.maximum} aria-valuenow={size.width}
    aria-valuetext={t`${{ width: shownCount(width) }} pixels`} title={t`Drag to resize. Use arrow keys when focused. Double-click to reset.`}
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
    }}><span id={helpId} className="tt-visually-hidden"><Trans>Use Left and Right arrow keys to resize. Hold Shift for larger steps. Home chooses the narrowest width; End chooses the widest.</Trans></span></div>
}

export interface SidebarFrameProps {
  readonly state: AgentState
  readonly command: AgentConnection['command']
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
  /** A quiet line under search and any refusal, in the open sidebar only: the Threads sidebar's working threads line. */
  readonly notice?: ReactNode
  /** What a project chosen with Add project opens in: the sidebar's own New action, there. */
  readonly onProjectAdded?: ((projectId: string) => void) | undefined
  /** A line directly under the search, above the list: the Threads sidebar's Needs attention count. */
  readonly afterSearch?: ReactNode
  /**
   * What stands just above the foot: the Threads sidebar's settle toast (ADR-0167). Open, it is in the column's own flow,
   * so it covers no row; on the collapsed rail it stands beside the rail's foot.
   */
  readonly toast?: ReactNode
}

/**
 * The Threads sidebar's frame: one top row carrying the mark and the two new actions, then search, the scrolling
 * list, and the foot. The top row is the frameless window's drag region, which is why every control in it is marked no-drag. A Sotto Owl
 * build paints its night sky behind the top row and the search field while the sidebar is open.
 */
export function SidebarFrame({ state, command, label, query, searchPlaceholder, onQuery, onNew, newLabel, NewIcon, newShortcut, platform, foot, title, children, collapsedContent, extraError, onDismissExtraError, notice, onProjectAdded, afterSearch, toast }: SidebarFrameProps): ReactNode {
  const app = useOptionalApp()
  const { t } = useLingui()
  const heading = title === undefined ? t`Threads` : title
  const addProject = useAddProject(state, command, { onAdded: onProjectAdded })
  const mac = (platform ?? app?.platform) === 'darwin'
  const size = useSidebarSize()
  const [resizing, setResizing] = useState(false)
  const toggle = useCollapseToggleFocus(size.collapsed)
  // In a narrow window the rail stands and Expand opens the whole sidebar over the thread (ADR-0110, November 5, 2026).
  const over = size.over
  const open = !size.collapsed || over
  const sky = useReleaseTrack() === 'owl' && open
  const chord = useSidebarChord()
  const panel = useRef<HTMLDivElement>(null)
  const aside = useRef<HTMLElement>(null)
  /** Where the focus was when the sidebar opened over the thread, to go back to when it closes. */
  const returnTo = useRef<HTMLElement | null>(null)
  const { narrow, closeOver } = size
  // The keys reach the sidebar as it stands at the press, without a new listener for every render.
  const toggleSidebar = useRef(size.toggle)
  toggleSidebar.current = size.toggle
  // The window widened past the line: the sidebar stands beside the thread again, and nothing stays open over it.
  useEffect(() => { if (!narrow) closeOver() }, [narrow, closeOver])
  // Opened over the thread, the sidebar takes the focus, on the thread on screen or else the search. Closed, it gives the
  // focus back to where it was, or to Expand, unless the focus has gone on somewhere else, such as a chosen thread's pane.
  useLayoutEffect(() => {
    if (over) {
      const active = document.activeElement
      returnTo.current = active instanceof HTMLElement && active !== document.body ? active : null
      const root = panel.current
      ;(root?.querySelector<HTMLElement>('.thread-nav__list [aria-current="page"]') ?? root?.querySelector<HTMLElement>('.threads-search input'))?.focus()
      return
    }
    const back = returnTo.current
    returnTo.current = null
    const active = document.activeElement
    if (!focusLost() && !(active !== null && panel.current?.contains(active) && size.collapsed)) return
    if (back !== null && back.isConnected && back.closest('[hidden], [inert]') === null) back.focus()
    else if (size.collapsed) toggle.current?.focus()
    // Only the sidebar's opening and closing moves the focus.
  }, [over])
  // A focus that moves out of it (F6 to the pane, a press in the window's strip) puts the sidebar over the thread away.
  useEffect(() => {
    if (!over) return undefined
    const away = (event: FocusEvent): void => {
      const target = event.target
      if (target instanceof Node && !aside.current?.contains(target)) { returnTo.current = null; closeOver() }
    }
    document.addEventListener('focusin', away, true)
    return () => document.removeEventListener('focusin', away, true)
  }, [over, closeOver])
  // Ctrl+Shift+B (Cmd+Shift+B) shows or hides the sidebar wherever it stands, unless the keys are typed into a terminal
  // or another dialog holds the window.
  useEffect(() => {
    if (chord === undefined) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat || !chordMatches(event, SIDEBAR_TOGGLE_CHORD, chord.platform) || chordBelongsElsewhere(event.target)) return
      if ([...document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]')].some(item => item !== panel.current)) return
      event.preventDefault()
      toggleSidebar.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [chord])
  /** Over the thread, Escape puts the sidebar away once whatever inside it answers Escape first has, and Tab goes round inside it. */
  const overKeys = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!over || event.defaultPrevented) return
    if (event.key === 'Escape') { event.preventDefault(); closeOver(); return }
    if (event.key !== 'Tab' || panel.current === null) return
    const stops = tabStops(panel.current)
    const first = stops[0], last = stops.at(-1)
    if (first === undefined || last === undefined) return
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }
  const chordTitle = (name: string): string => chord === undefined ? name : `${name} ${chord.label.suffix}`
  const railOn = useOwlFeature('sidebar-rail')
  const watcherOn = useWatcherEnabled()
  // A region F6 moves between (ADR-0164): it enters at the thread list's stop, or the rail's, or else the search field.
  return <aside ref={aside} className={mac ? 'thread-nav thread-nav--mac' : 'thread-nav'} aria-label={label} data-region="sidebar" data-mode="threads" data-collapsed={size.collapsed || undefined} data-resizing={resizing || undefined}
    data-sky={sky || undefined} data-over={over || undefined} style={{ width: size.collapsed ? (mac ? 80 : 52) : size.width }}>
    {/* A press beside the sidebar over the thread puts it away, and the thread under it has not moved. */}
    {over ? <div className="thread-nav__scrim" aria-hidden="true" onMouseDown={event => event.preventDefault()} onClick={closeOver} /> : null}
    <div ref={panel} className="thread-nav__expanded" hidden={!open} onKeyDown={overKeys}
      {...over ? { role: 'dialog', 'aria-modal': true, 'aria-label': label } : {}}>
    {sky ? <OwlSky /> : null}
    <SidebarTop platform={platform ?? app?.platform}>
      {heading === null ? null : <h1 className="tt-visually-hidden">{heading}</h1>}
      <Button variant="ghost" iconOnly aria-label={t`Add project`} title={t`Add project`} disabled={addProject.adding} onClick={() => void addProject.add()}><FolderPlus size={16} /></Button>
      <Button variant="ghost" className="thread-nav__new" data-tour="sidebar-new" aria-label={newLabel} title={newShortcut ? newShortcut.title : newLabel} aria-keyshortcuts={newShortcut?.keys} onClick={onNew}><NewIcon size={16} aria-hidden="true" /><span aria-hidden="true">{newLabel}</span></Button>
      <button ref={size.collapsed ? undefined : toggle} type="button" className="thread-nav__action tt-focusable thread-nav__collapse" aria-label={t`Collapse sidebar`} title={chordTitle(t`Collapse sidebar`)}
        aria-keyshortcuts={chord?.label.keys} onClick={() => size.collapse(true)}><PanelLeftClose size={16} aria-hidden="true" /></button>
    </SidebarTop>
    <label className="threads-search"><span className="tt-visually-hidden">{searchPlaceholder}</span><Search size={15} aria-hidden="true" />
      <input className="tt-input tt-focusable" type="search" data-region-entry="2" value={query} placeholder={searchPlaceholder} onChange={event => onQuery(event.currentTarget.value)}
        onKeyDown={event => { if (event.key === 'Escape' && query) { event.preventDefault(); onQuery('') } }} />
      {query ? <button type="button" className="threads-search__clear tt-focusable" aria-label={t`Clear search`} title={t`Clear search`} onClick={() => onQuery('')}><X size={14} aria-hidden="true" /></button> : null}
    </label>
    {afterSearch}
    {addProject.dialog}
    {addProject.error ? <p className="thread-nav__error tt-paragraph" role="alert">{addProject.error}<button type="button" className="thread-nav__action tt-focusable" aria-label={t`Dismiss`} title={t`Dismiss`} onClick={addProject.clearError}><X size={14} aria-hidden="true" /></button></p> : null}
    {extraError ? <p className="thread-nav__error tt-paragraph" role="alert">{extraError}{onDismissExtraError ? <button type="button" className="thread-nav__action tt-focusable" aria-label={t`Dismiss`} title={t`Dismiss`} onClick={onDismissExtraError}><X size={14} aria-hidden="true" /></button> : null}</p> : null}
    {notice}
    <div className="thread-nav__scroll">{children}</div>
    {open ? toast : null}
    {open ? foot ?? <SidebarFoot /> : null}
    </div>
    {/* Under the sidebar over the thread the rail keeps its place, out of reach, so nothing beside it moves. */}
    {size.collapsed ? <div className="thread-nav__rail" inert={over}>
      {mac ? null : <SottoMark className="thread-nav__glyph" />}
      <button ref={toggle} type="button" className="thread-nav__action tt-focusable" aria-label={t`Expand sidebar`} title={chordTitle(t`Expand sidebar`)}
        aria-keyshortcuts={chord?.label.keys} aria-haspopup={size.narrow ? 'dialog' : undefined} aria-expanded={size.narrow ? over : undefined} onClick={() => size.collapse(false)}><PanelLeftOpen size={16} aria-hidden="true" /></button>
      {railOn && watcherOn ? <RailWatcher /> : null}
      <div className="thread-nav__rail-list">{collapsedContent ?? <button type="button" className="thread-nav__action tt-focusable" aria-label={newLabel} title={newLabel} onClick={onNew}><NewIcon size={16} aria-hidden="true" /></button>}</div>
      {over ? null : toast}
      {over ? null : foot ?? <SidebarFoot />}
    </div> : <SidebarResize size={size} onResizing={setResizing} />}
  </aside>
}

/**
 * Settle project, or Restore project once settled, on a folder head in the sidebar. The pointer's: the folder's menu
 * says the same in words for the keyboard (ADR-0164), so it is out of the Tab order.
 */
export function ProjectSettleAction({ projectId, title, settled, disabled, command }: {
  readonly projectId: string; readonly title: string; readonly settled: boolean; readonly disabled: boolean
  readonly command: AgentConnection['command']
}): ReactNode {
  const { t } = useLingui()
  return settled
    ? <button type="button" className="thread-nav__action tt-focusable" tabIndex={-1} aria-label={t`Restore project ${title}`} title={t`Restore project`} disabled={disabled} onClick={() => void command({ type: 'restore-project', projectId })}><ArchiveRestore size={16} aria-hidden="true" /></button>
    : <button type="button" className="thread-nav__action tt-focusable" tabIndex={-1} aria-label={t`Settle project ${title}`} title={t`Settle project`} disabled={disabled} onClick={() => void command({ type: 'settle-project', projectId })}><Archive size={16} aria-hidden="true" /></button>
}
