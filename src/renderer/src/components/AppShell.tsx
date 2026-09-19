import React, { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { MessagesSquare } from 'lucide-react'

import type { SottoPlatform } from '../../../shared/platform'
import type { AppNavigation } from '../state/AppContext'
import { useMemoryEnabled } from '../state/memoryFeature'
import { useVoiceCoordinatorEnabled } from '../state/voiceCoordinator'
import { SottoMark } from './SottoMark'
import { VoiceWave } from './VoiceWave'
import { WindowControls } from './WindowControls'

type ManagementNavigation = Exclude<AppNavigation, 'onboarding'>

/** The rooms the switch flips between; Agents only appears with the voice coordinator on. */
export type AppRoom = 'dictate' | 'agents' | 'threads'

export interface AppShellProps {
  /** The open page, or `null` while the window is loading, unavailable or onboarding (strip only). */
  readonly navigation: ManagementNavigation | null
  readonly platform: SottoPlatform
  /**
   * `strip` is the shell of the loading, onboarding and voice surfaces. `page`
   * hands the whole window to a page that owns its own chrome (Threads,
   * Settings, Chats): its navigation, its window controls and the update
   * control live inside it. `sidebar` seats the Threads sidebar beside the
   * page (Dictate, History, Help), with the window controls on the room's top
   * edge and the page's sentence at its foot.
   */
  readonly layout?: 'strip' | 'page' | 'sidebar'
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

interface Room { readonly id: AppRoom; readonly label: string; readonly destination: ManagementNavigation }

const dictate: Room = { id: 'dictate', label: 'Dictate', destination: 'home' }
const agents: Room = { id: 'agents', label: 'Agents', destination: 'agents' }
const threads: Room = { id: 'threads', label: 'Threads', destination: 'threads' }

/** Dictate and Threads are the beta's two rooms; Agents joins them only when the voice coordinator is on. */
const withCoordinator: ReadonlyArray<Room> = [dictate, agents, threads]
const withoutCoordinator: ReadonlyArray<Room> = [dictate, threads]

const footerLinks: ReadonlyArray<{ id: ManagementNavigation; label: string }> = [
  { id: 'threads', label: 'Threads' },
  { id: 'chats', label: 'Chats' },
  { id: 'history', label: 'History' },
  { id: 'memory', label: 'Memory' },
  { id: 'settings', label: 'Settings' },
  { id: 'help', label: 'Help' },
]

/** Which switch tab a page lights: Chats and Memory are the Threads room's other conversations, so they count as Threads. */
export function roomFor(navigation: ManagementNavigation | null): AppRoom | null {
  if (navigation === 'home') return 'dictate'
  if (navigation === 'agents') return 'agents'
  if (navigation === 'threads' || navigation === 'chats' || navigation === 'memory') return 'threads'
  return null
}

/**
 * The Crossing shell. In the `strip` layout: a thin strip (mark, the room
 * switch, window controls) over one black room, with the page links and one
 * sentence of status in a footer line; the strip is the frameless window's
 * drag region. macOS paints its own traffic lights over the strip's left end
 * and closes to the tray through the same intercepted close, so it gets no
 * custom controls. In the `sidebar` layout the Threads sidebar stands in the
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
  const management = navigation !== null
  const room = roomFor(navigation)
  const rooms = useVoiceCoordinatorEnabled() ? withCoordinator : withoutCoordinator
  // Memory is hidden for the beta: its link goes with it.
  const links = useMemoryEnabled() ? footerLinks : footerLinks.filter(({ id }) => id !== 'memory')
  const focusableRoom = rooms.some(({ id }) => id === room) ? room : rooms[0]!.id

  const go = (destination: ManagementNavigation): void => { onNavigate?.(destination) }

  const followLink = (event: MouseEvent<HTMLAnchorElement>, destination: ManagementNavigation): void => {
    event.preventDefault()
    go(destination)
  }

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % rooms.length
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + rooms.length) % rooms.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = rooms.length - 1
    if (next === null) return
    event.preventDefault()
    const target = rooms[next]!
    const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    tabs?.[next]?.focus()
    go(target.destination)
  }

  // One tree for all three layouts, with the strip, the sidebar, the room's edges and the footer as empty
  // slots where a layout has none: the room keeps its position, so a page that hands the window over
  // (Threads) and one beside the sidebar (Dictate) swap without remounting what lives inside the room, and
  // the memory surface's dismissal survives.
  const page = layout === 'page'
  const beside = layout === 'sidebar'
  const shellClass = page ? 'app-shell app-shell--page' : beside ? 'app-shell app-shell--sidebar' : management ? 'app-shell' : 'app-shell app-shell--bare'
  return (
    <div className={shellClass}>
      {page || beside ? null : (
        <header className={nativeWindowControls ? 'app-strip app-strip--mac' : 'app-strip'}>
          <div className="app-mark" aria-label="Sotto application">
            <SottoMark className="app-mark__glyph" />
            <span>Sotto</span>
          </div>
          {management ? (
            <div className="app-switch" role="tablist" aria-label="Mode">
              {rooms.map(({ id, label, destination }, index) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  className="app-switch__tab tt-focusable"
                  aria-selected={room === id}
                  tabIndex={focusableRoom === id ? 0 : -1}
                  onClick={() => go(destination)}
                  onKeyDown={(event) => onTabKey(event, index)}
                >
                  {id === 'dictate' ? <VoiceWave stage="idle" value={0} label="" size="switch" /> : null}
                  {id === 'agents' ? <span className="app-switch__orb" aria-hidden="true" /> : null}
                  {id === 'threads' ? <MessagesSquare size={16} aria-hidden="true" /> : null}
                  {label}
                </button>
              ))}
            </div>
          ) : <span />}
          {nativeWindowControls ? <span /> : <WindowControls maximized={maximized} onMaximize={onMaximize} onMinimize={onMinimize} onClose={onClose} />}
        </header>
      )}
      {beside ? sidebar : null}
      {beside ? <div className="app-room__top">{nativeWindowControls ? null : <WindowControls maximized={maximized} onMaximize={onMaximize} onMinimize={onMinimize} onClose={onClose} />}</div> : null}
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
