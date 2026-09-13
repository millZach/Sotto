import React, { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { Minus, Square, Copy, X } from 'lucide-react'

import type { SottoPlatform } from '../../../shared/platform'
import type { AppNavigation } from '../state/AppContext'
import { Button } from './Button'
import { SottoMark } from './SottoMark'
import { VoiceWave } from './VoiceWave'

type ManagementNavigation = Exclude<AppNavigation, 'onboarding'>

/** The two rooms the switch flips between. */
export type AppRoom = 'dictate' | 'agents'

export interface AppShellProps {
  /** The open page, or `null` while the window is loading, unavailable or onboarding (strip only). */
  readonly navigation: ManagementNavigation | null
  readonly platform: SottoPlatform
  /** One sentence for the footer's right-hand end. */
  readonly statusText?: ReactNode
  readonly onNavigate?: ((destination: ManagementNavigation) => void) | undefined
  readonly maximized?: boolean
  readonly onMaximize: () => Promise<void> | void
  readonly onMinimize: () => Promise<void> | void
  readonly onClose: () => Promise<void> | void
  readonly children: ReactNode
}

const rooms: ReadonlyArray<{ id: AppRoom; label: string; destination: ManagementNavigation }> = [
  { id: 'dictate', label: 'Dictate', destination: 'home' },
  { id: 'agents', label: 'Agents', destination: 'agents' },
]

const footerLinks: ReadonlyArray<{ id: ManagementNavigation; label: string }> = [
  { id: 'threads', label: 'Threads' },
  { id: 'chats', label: 'Chats' },
  { id: 'history', label: 'History' },
  { id: 'memory', label: 'Memory' },
  { id: 'settings', label: 'Settings' },
  { id: 'help', label: 'Help' },
]

/** Which switch tab a page lights: Threads and Chats are the Agents room's conversations, so they count as Agents. */
export function roomFor(navigation: ManagementNavigation | null): AppRoom | null {
  if (navigation === 'home') return 'dictate'
  if (navigation === 'agents' || navigation === 'threads' || navigation === 'chats' || navigation === 'memory') return 'agents'
  return null
}

/**
 * The Crossing shell: a thin strip (mark, the Dictate/Agents switch, window
 * controls) over one black room, with the page links and one sentence of
 * status in a footer line. The strip is the frameless window's drag region.
 * macOS paints its own traffic lights over the strip's left end and closes to
 * the tray through the same intercepted close, so it gets no custom controls.
 */
export function AppShell({
  navigation,
  platform,
  statusText,
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
  const focusableRoom = room ?? 'dictate'

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

  return (
    <div className={management ? 'app-shell' : 'app-shell app-shell--bare'}>
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
                {id === 'dictate'
                  ? <VoiceWave stage="idle" value={0} label="" size="switch" />
                  : <span className="app-switch__orb" aria-hidden="true" />}
                {label}
              </button>
            ))}
          </div>
        ) : <span />}
        {nativeWindowControls ? <span /> : (
          <div className="app-controls">
            <Button iconOnly variant="ghost" aria-label="Minimize Sotto" onClick={() => void onMinimize()}>
              <Minus size={18} />
            </Button>
            <Button iconOnly variant="ghost" className="app-controls__maximize" aria-label={maximized ? 'Restore Sotto' : 'Maximize Sotto'} title={maximized ? 'Restore' : 'Maximize'} onClick={() => void onMaximize()}>
              {maximized ? <Copy size={16} /> : <Square size={16} />}
            </Button>
            <Button iconOnly variant="ghost" aria-label="Close Sotto to tray" onClick={() => void onClose()}>
              <X size={18} />
            </Button>
          </div>
        )}
      </header>
      <main className="app-room" id="main-content">{children}</main>
      {management ? (
        <footer className="app-footer">
          <nav aria-label="Pages">
            {footerLinks.map(({ id, label }) => (
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
