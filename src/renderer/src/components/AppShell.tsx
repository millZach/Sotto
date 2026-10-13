import React, { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { MessagesSquare } from 'lucide-react'

import type { SottoPlatform } from '../../../shared/platform'
import { releaseTrackName } from '../../../shared/releaseTrack'
import type { AppNavigation } from '../state/AppContext'
import { useMemoryEnabled } from '../state/memoryFeature'
import { useReleaseTrack } from '../state/useReleaseTrack'
import { useWatcherEnabled } from '../state/watcherFeature'
import { useOwlFeature } from '../state/owlFeature'
import { WatcherOwl } from '../watcher/WatcherOwl'
import { SottoMark } from './SottoMark'
import { VoiceWave } from './VoiceWave'
import { WindowControls } from './WindowControls'

type ManagementNavigation = Exclude<AppNavigation, 'onboarding'>

/** The rooms the switch flips between; Watcher's only while its gate is on. */
export type AppRoom = 'dictate' | 'watcher' | 'threads'
export type AppLayout = 'strip' | 'page' | 'sidebar'

export interface AppShellProps {
  /** The open page, or `null` while the window is loading, unavailable or onboarding (strip only). */
  readonly navigation: ManagementNavigation | null
  readonly platform: SottoPlatform
  /**
   * `strip` is the shell of the loading, onboarding and Memory surfaces. `page`
   * hands the whole window to a page that owns its own chrome (Threads,
   * Settings): its navigation, its window controls and the update
   * control live inside it. `sidebar` seats the Threads sidebar beside the
   * page (Dictate, History, Help), with the window controls on the room's top
   * edge and the page's sentence at its foot.
   */
  readonly layout?: AppLayout
  /** The sidebar of the `sidebar` layout: an aside that becomes the shell's first column. */
  readonly sidebar?: ReactNode
  /** One sentence for the footer's right-hand end. */
  readonly statusText?: ReactNode
  /** The update control, seated at the footer's far end after the status sentence. */
  readonly updateControl?: ReactNode
  readonly onNavigate?: ((destination: ManagementNavigation) => void) | undefined
  readonly maximized?: boolean
  readonly onMaximize: () => Promise<void> | void
  readonly onMinimize: () => Promise<void> | void
  readonly onClose: () => Promise<void> | void
  readonly children: ReactNode
}

export interface Room { readonly id: AppRoom; readonly label: string; readonly destination: ManagementNavigation }

const dictate: Room = { id: 'dictate', label: 'Dictate', destination: 'home' }
const watcher: Room = { id: 'watcher', label: 'Watcher', destination: 'watcher' }
const threads: Room = { id: 'threads', label: 'Threads', destination: 'threads' }

/**
 * The room switch, the one definition every switch draws: Dictate | Threads, with Watcher's owl between them
 * while the Watcher gate is on (ADR-0072, ADR-0073).
 */
export function appRooms(watcherEnabled: boolean): ReadonlyArray<Room> {
  return watcherEnabled ? [dictate, watcher, threads] : [dictate, threads]
}

/**
 * The room a switch press opened, so the switch in the page that opens can take focus back: each page draws its
 * own switch, and the one that was pressed is gone. Claimed once, by the switch whose lit room it names.
 */
let handedFocus: { readonly room: AppRoom; readonly at: number } | null = null
export function handRoomFocus(room: AppRoom): void { handedFocus = { room, at: Date.now() } }
export function claimRoomFocus(room: AppRoom | null): boolean {
  if (handedFocus === null || room === null) return false
  // A press the new page never answered is forgotten rather than stealing focus later.
  if (Date.now() - handedFocus.at > 2_000) { handedFocus = null; return false }
  if (handedFocus.room !== room) return false
  handedFocus = null
  return true
}

/** The next tab an arrow, Home or End key reaches in a switch of `count` tabs, or null for any other key. */
export function roomKeyTarget(key: string, index: number, count: number): number | null {
  if (key === 'ArrowRight' || key === 'ArrowDown') return (index + 1) % count
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (index - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}

/** What `useRoomSwitch` puts on each tab: its selection, its place in the Tab order, its name and what it answers. */
export interface RoomTabProps {
  readonly 'aria-selected': boolean
  readonly 'aria-label': string | undefined
  readonly title: string | undefined
  readonly tabIndex: 0 | -1
  readonly onClick: () => void
  readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
}

/**
 * How every room switch behaves, whatever it looks like (the strip's, the sidebar foot's, Watcher's floating one).
 * Only the lit tab is in the Tab order, or the first when the open page lights none; arrow keys, Home and End move
 * and open as they go; a press that opens another room hands focus to the lit tab of the switch the opened page
 * draws, and this switch takes it when its page is the one opened and `shown` says it is the switch on screen. The
 * owl stands alone, so its name is its tooltip and what a screen reader says. Each switch draws its own tablist and
 * tabs, spreading `tab(room, index)` on each.
 */
export function useRoomSwitch(room: AppRoom | null, rooms: ReadonlyArray<Room>, navigate: (destination: ManagementNavigation) => void, shown = true): {
  readonly ref: React.RefObject<HTMLDivElement | null>
  readonly tab: (target: Room, index: number) => RoomTabProps
} {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (shown && claimRoomFocus(room)) ref.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus()
  })
  const focusable = rooms.some(({ id }) => id === room) ? room : rooms[0]!.id
  // Only a press that opens another room hands focus on; the lit tab already has it.
  const enter = (target: Room): void => { if (target.id !== room) handRoomFocus(target.id); navigate(target.destination) }
  const tab = (target: Room, index: number): RoomTabProps => ({
    'aria-selected': target.id === room,
    'aria-label': target.id === 'watcher' ? target.label : undefined,
    title: target.id === 'watcher' ? target.label : undefined,
    tabIndex: target.id === focusable ? 0 : -1,
    onClick: () => enter(target),
    onKeyDown: event => {
      const next = roomKeyTarget(event.key, index, rooms.length)
      if (next === null) return
      event.preventDefault()
      ref.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
      enter(rooms[next]!)
    },
  })
  return { ref, tab }
}

const footerLinks: ReadonlyArray<{ id: ManagementNavigation; label: string }> = [
  { id: 'threads', label: 'Threads' },
  { id: 'history', label: 'History' },
  { id: 'usage', label: 'Usage' },
  { id: 'memory', label: 'Memory' },
  { id: 'settings', label: 'Settings' },
  { id: 'help', label: 'Help' },
]

/** Which switch tab a page lights: Memory belongs to the Threads room. */
export function roomFor(navigation: ManagementNavigation | null): AppRoom | null {
  if (navigation === 'home') return 'dictate'
  if (navigation === 'watcher') return 'watcher'
  if (navigation === 'threads' || navigation === 'memory') return 'threads'
  return null
}

/**
 * Which layout a page takes. Threads, Watcher's room and Settings own the window, their left column wearing the
 * sidebar's frame; Dictate, History and Help stand beside the Threads sidebar itself; the strip and footer remain
 * for the Memory surface. `threadsPage` says whether the navigation lands on the Threads page, the beta gates
 * included; Watcher's room is the Threads page while its gate is off.
 */
export function layoutFor(navigation: AppNavigation, threadsPage: boolean): AppLayout {
  if (threadsPage || navigation === 'settings' || navigation === 'watcher') return 'page'
  if (navigation === 'home' || navigation === 'history' || navigation === 'usage' || navigation === 'help') return 'sidebar'
  return 'strip'
}

/**
 * The Crossing shell. In the `strip` layout: a thin strip (mark, the room
 * switch, window controls) over one black room, with the page links and one
 * sentence of status in a footer line; the strip is the frameless window's
 * drag region. macOS paints its own traffic lights over the strip's left end
 * and closes to the tray through the same intercepted close, so it gets no
 * custom controls. Linux keeps the drag regions without window controls; the
 * compositor asks it to close to the tray. In the `sidebar` layout the Threads sidebar stands in the
 * strip's and footer's stead: its top row drags, its foot carries the page
 * links and the update control, and the room keeps a top edge for the window
 * controls and a foot line for the sentence. The `page` layout hands over the
 * bare room.
 */
export function AppShell({
  navigation,
  platform,
  layout = 'strip',
  sidebar,
  statusText,
  updateControl,
  onNavigate,
  onMinimize,
  maximized = false,
  onMaximize,
  onClose,
  children,
}: AppShellProps): ReactNode {
  const nativeWindowControls = platform === 'darwin'
  // A Sotto Owl build shows the mark alone in the strip, as the sidebar's top row does.
  const owl = useReleaseTrack() === 'owl'
  const management = navigation !== null
  const room = roomFor(navigation)
  const rooms = appRooms(useWatcherEnabled())
  // Memory is hidden for the beta: its link goes with it.
  const memory = useMemoryEnabled()
  const usage = useOwlFeature('usage')
  const links = footerLinks.filter(({ id }) => (id !== 'memory' || memory) && (id !== 'usage' || usage))
  const go = (destination: ManagementNavigation): void => { onNavigate?.(destination) }
  // A switch press that opened this page's room hands focus to the strip's lit tab, when the strip is what shows.
  const roomSwitch = useRoomSwitch(room, rooms, go, layout === 'strip' && management)

  const followLink = (event: MouseEvent<HTMLAnchorElement>, destination: ManagementNavigation): void => {
    event.preventDefault()
    go(destination)
  }

  // One tree for all three layouts, with the strip, the sidebar, the room's edges and the footer as empty
  // slots where a layout has none: the room keeps its position, so a page that hands the window over
  // (Threads) and one beside the sidebar (Dictate) swap without remounting what lives inside the room, and
  // the memory surface's dismissal survives.
  const page = layout === 'page'
  const beside = layout === 'sidebar'
  const shellClass = page ? 'app-shell app-shell--page' : beside ? 'app-shell app-shell--sidebar' : management ? 'app-shell' : 'app-shell app-shell--bare'
  return (
    <div className={shellClass} data-platform={platform}>
      {page || beside ? null : (
        <header className={nativeWindowControls ? 'app-strip app-strip--mac' : 'app-strip'}>
          {owl ? (
            <div className="app-mark" role="img" aria-label={releaseTrackName('owl')}>
              <SottoMark className="app-mark__tile" />
            </div>
          ) : (
            <div className="app-mark" aria-label="Sotto application">
              <SottoMark className="app-mark__glyph" />
              <span>Sotto</span>
            </div>
          )}
          {management ? (
            <div ref={roomSwitch.ref} className="app-switch" role="tablist" aria-label="Mode">
              {rooms.map((target, index) => (
                <button
                  key={target.id}
                  type="button"
                  role="tab"
                  className="app-switch__tab tt-focusable"
                  data-room={target.id}
                  {...roomSwitch.tab(target, index)}
                >
                  {target.id === 'dictate' ? <VoiceWave stage="idle" value={0} label="" size="switch" /> : null}
                  {target.id === 'threads' ? <MessagesSquare size={16} aria-hidden="true" /> : null}
                  {target.id === 'watcher' ? <WatcherOwl size={16} /> : target.label}
                </button>
              ))}
            </div>
          ) : <span />}
          {platform === 'win32' ? <WindowControls maximized={maximized} onMaximize={onMaximize} onMinimize={onMinimize} onClose={onClose} /> : <span />}
        </header>
      )}
      {beside ? sidebar : null}
      {beside ? <div className="app-room__top">{platform === 'win32' ? <WindowControls maximized={maximized} onMaximize={onMaximize} onMinimize={onMinimize} onClose={onClose} /> : null}</div> : null}
      <main className={page ? 'app-room app-room--page' : 'app-room'} id="main-content">{children}</main>
      {beside ? <footer className="app-room__foot"><FooterStatus>{statusText}</FooterStatus></footer> : null}
      {!page && !beside && management ? (
        <footer className="app-footer">
          <nav aria-label="Pages">
            {links.map(({ id, label }) => (
              <a
                key={id}
                href={`#${id}`}
                className="app-footer__link tt-focusable"
                aria-current={navigation === id ? 'page' : undefined}
                onClick={(event) => followLink(event, id)}
              >
                {label}
              </a>
            ))}
          </nav>
          <FooterStatus>{statusText}</FooterStatus>
          {updateControl}
        </footer>
      ) : null}
    </div>
  )
}

/**
 * The footer's sentence. When the window is narrow, or a minimized theme editor
 * rests beside it, the sentence ends in an ellipsis; only then does it carry
 * the whole sentence as its tooltip.
 */
function FooterStatus({ children }: { readonly children: ReactNode }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const [clipped, setClipped] = useState<string | undefined>(undefined)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = (): void => setClipped(element.scrollWidth > element.clientWidth ? element.textContent ?? undefined : undefined)
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(element)
    return () => observer?.disconnect()
  }, [children])
  return (
    <div ref={ref} className="app-footer__status" aria-live="polite" aria-atomic="true" title={clipped}>
      {children}
    </div>
  )
}
