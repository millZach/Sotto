import React, { createContext, useContext, useMemo, useLayoutEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Archive, ArchiveRestore, BarChart3, Brain, CircleHelp, FolderPlus, PanelLeftClose, PanelLeftOpen, Search, Settings, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { AgentState } from '../../../shared/agents'
import type { SottoPlatform } from '../../../shared/platform'
import { releaseTrackName } from '../../../shared/releaseTrack'
import { appRooms, roomFor, RoomTabFace, useRoomSwitch } from '../components/AppShell'
import { Button } from '../components/Button'
import { SottoMark } from '../components/SottoMark'
import { useOptionalApp, type AppNavigation } from '../state/AppContext'
import { useDictationOn } from '../state/dictationFeature'
import { useMemoryEnabled } from '../state/memoryFeature'
import { useReleaseTrack } from '../state/useReleaseTrack'
import { useWatcherEnabled } from '../state/watcherFeature'
import { useOwlFeature } from '../state/owlFeature'
import type { AgentConnection } from './AgentContext'
import { useAddProject } from './addProject'
import { OwlSky } from './OwlSky'
import { useSidebarSize } from './sidebarSize'
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
 * page draws. The sidebar foot and Watcher's floating switch both draw this one.
 */
export function RoomSwitch({ className }: { readonly className: string }): ReactNode {
  const app = useOptionalApp()
  const shown = app === null || app.navigation === 'onboarding' ? 'threads' : app.navigation
  const rooms = appRooms({ watcher: useWatcherEnabled(), dictation: useDictationOn() })
  const roomSwitch = useRoomSwitch(roomFor(shown), rooms, destination => app?.actions.navigate(destination))
  const { t } = useLingui()
  if (rooms.length < 2) return null
  return <div ref={roomSwitch.ref} className={className} role="tablist" aria-label={t({ message: 'Page', comment: 'The room switch: which page of the app is open.' })}>
    {rooms.map((target, index) => <button key={target.id} type="button" role="tab" className="tt-focusable" data-room={target.id} {...roomSwitch.tab(target, index)}>
      <RoomTabFace room={target} /></button>)}
  </div>
}

/** The pages the switch does not reach, as icon links: Usage, Settings and Help, and Memory while memory is switched on. */
export function PageLinks({ className, linkClassName }: { readonly className: string; readonly linkClassName: string }): ReactNode {
  const app = useOptionalApp()
  const memory = useMemoryEnabled()
  const usage = useOwlFeature('usage')
  const { t } = useLingui()
  const pages = PAGES.filter(page => (page.id !== 'memory' || memory) && (page.id !== 'usage' || usage)).map(page => ({ ...page, label: t(page.label) }))
  return <nav className={className} aria-label={t`Pages`}>
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
    <span className="thread-nav__foot-rule" aria-hidden="true" />
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
}

/**
 * The Threads sidebar's frame: one top row carrying the mark and the two new actions, then search, the scrolling
 * list, and the foot. The top row is the frameless window's drag region, which is why every control in it is marked no-drag. A Sotto Owl
 * build paints its night sky behind the top row and the search field while the sidebar is open.
 */
export function SidebarFrame({ state, command, label, query, searchPlaceholder, onQuery, onNew, newLabel, NewIcon, newShortcut, platform, foot, title, children, collapsedContent, extraError, onDismissExtraError, notice, onProjectAdded, afterSearch }: SidebarFrameProps): ReactNode {
  const app = useOptionalApp()
  const { t } = useLingui()
  const heading = title === undefined ? t`Threads` : title
  const addProject = useAddProject(state, command, { onAdded: onProjectAdded })
  const mac = (platform ?? app?.platform) === 'darwin'
  const size = useSidebarSize()
  const [resizing, setResizing] = useState(false)
  const toggle = useCollapseToggleFocus(size.collapsed)
  const sky = useReleaseTrack() === 'owl' && !size.collapsed
  return <aside className={mac ? 'thread-nav thread-nav--mac' : 'thread-nav'} aria-label={label} data-mode="threads" data-collapsed={size.collapsed || undefined} data-resizing={resizing || undefined}
    data-sky={sky || undefined} style={{ width: size.collapsed ? (mac ? 80 : 52) : size.width }}>
    <div className="thread-nav__expanded" hidden={size.collapsed}>
    {sky ? <OwlSky /> : null}
    <SidebarTop platform={platform ?? app?.platform}>
      {heading === null ? null : <h1 className="tt-visually-hidden">{heading}</h1>}
      <Button variant="ghost" iconOnly aria-label={t`Add project`} title={t`Add project`} disabled={addProject.adding} onClick={() => void addProject.add()}><FolderPlus size={16} /></Button>
      <Button variant="ghost" iconOnly data-tour="sidebar-new" aria-label={newLabel} title={newShortcut ? newShortcut.title : newLabel} aria-keyshortcuts={newShortcut?.keys} onClick={onNew}><NewIcon size={16} /></Button>
      <button ref={size.collapsed ? undefined : toggle} type="button" className="thread-nav__action tt-focusable thread-nav__collapse" aria-label={t`Collapse sidebar`} title={t`Collapse sidebar`} onClick={() => size.collapse(true)}><PanelLeftClose size={16} aria-hidden="true" /></button>
    </SidebarTop>
    <label className="threads-search"><span className="tt-visually-hidden">{searchPlaceholder}</span><Search size={15} aria-hidden="true" />
      <input className="tt-input tt-focusable" type="search" value={query} placeholder={searchPlaceholder} onChange={event => onQuery(event.currentTarget.value)}
        onKeyDown={event => { if (event.key === 'Escape' && query) { event.preventDefault(); onQuery('') } }} />
      {query ? <button type="button" className="threads-search__clear tt-focusable" aria-label={t`Clear search`} title={t`Clear search`} onClick={() => onQuery('')}><X size={14} /></button> : null}
    </label>
    {afterSearch}
    {addProject.dialog}
    {addProject.error ? <p className="thread-nav__error tt-paragraph" role="alert">{addProject.error}<button type="button" className="thread-nav__action tt-focusable" aria-label={t`Dismiss`} onClick={addProject.clearError}><X size={14} aria-hidden="true" /></button></p> : null}
    {extraError ? <p className="thread-nav__error tt-paragraph" role="alert">{extraError}{onDismissExtraError ? <button type="button" className="thread-nav__action tt-focusable" aria-label={t`Dismiss`} onClick={onDismissExtraError}><X size={14} aria-hidden="true" /></button> : null}</p> : null}
    {notice}
    <div className="thread-nav__scroll">{children}</div>
    {size.collapsed ? null : foot ?? <SidebarFoot />}
    </div>
    {size.collapsed ? <div className="thread-nav__rail">
      {mac ? null : <SottoMark className="thread-nav__glyph" />}
      <button ref={toggle} type="button" className="thread-nav__action tt-focusable" aria-label={t`Expand sidebar`} title={t`Expand sidebar`} onClick={() => size.collapse(false)}><PanelLeftOpen size={16} aria-hidden="true" /></button>
      <div className="thread-nav__rail-list">{collapsedContent ?? <button type="button" className="thread-nav__action tt-focusable" aria-label={newLabel} title={newLabel} onClick={onNew}><NewIcon size={16} aria-hidden="true" /></button>}</div>
      {foot ?? <SidebarFoot />}
    </div> : <SidebarResize size={size} onResizing={setResizing} />}
  </aside>
}

/** Settle project, or Restore project once settled, on a folder head in the sidebar. */
export function ProjectSettleAction({ projectId, title, settled, disabled, command }: {
  readonly projectId: string; readonly title: string; readonly settled: boolean; readonly disabled: boolean
  readonly command: AgentConnection['command']
}): ReactNode {
  const { t } = useLingui()
  return settled
    ? <button type="button" className="thread-nav__action tt-focusable" aria-label={t`Restore project ${title}`} title={t`Restore project`} disabled={disabled} onClick={() => void command({ type: 'restore-project', projectId })}><ArchiveRestore size={16} aria-hidden="true" /></button>
    : <button type="button" className="thread-nav__action tt-focusable" aria-label={t`Settle project ${title}`} title={t`Settle project`} disabled={disabled} onClick={() => void command({ type: 'settle-project', projectId })}><Archive size={16} aria-hidden="true" /></button>
}
