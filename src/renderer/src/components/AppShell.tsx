import React, { type MouseEvent, type ReactNode } from 'react'
import { CircleHelp, Clock3, Home, Minus, Settings, X } from 'lucide-react'

import type { AppNavigation } from '../state/AppContext'
import { Button } from './Button'

type ManagementNavigation = Exclude<AppNavigation, 'onboarding'>

export interface AppShellProps {
  readonly navigation: ManagementNavigation
  readonly statusText: string
  readonly onNavigate: (destination: ManagementNavigation) => void
  readonly onMinimize: () => Promise<void> | void
  readonly onClose: () => Promise<void> | void
  readonly children: ReactNode
}

const destinations = [
  { id: 'home' as const, label: 'Home', icon: Home },
  { id: 'history' as const, label: 'History', icon: Clock3 },
  { id: 'settings' as const, label: 'Settings', icon: Settings },
  { id: 'help' as const, label: 'Help', icon: CircleHelp },
]

export function AppShell({
  navigation,
  statusText,
  onNavigate,
  onMinimize,
  onClose,
  children,
}: AppShellProps): ReactNode {
  const navigate = (event: MouseEvent<HTMLAnchorElement>, destination: ManagementNavigation): void => {
    event.preventDefault()
    onNavigate(destination)
  }

  return (
    <div className="app-shell">
      <header className="app-titlebar">
        <div className="app-titlebar__brand" aria-label="TalkType application">
          <span className="app-titlebar__mark" aria-hidden="true">T</span>
          <span>TalkType</span>
        </div>
        <div className="app-titlebar__controls">
          <Button iconOnly variant="ghost" aria-label="Minimize TalkType" onClick={() => void onMinimize()}><Minus size={18} /></Button>
          <Button iconOnly variant="ghost" aria-label="Close TalkType to tray" onClick={() => void onClose()}><X size={18} /></Button>
        </div>
      </header>
      <aside className="app-navigation">
        <nav aria-label="Primary navigation">
          {destinations.map(({ id, label, icon: Icon }) => (
            <a
              key={id}
              href={`#${id}`}
              className="app-navigation__link tt-focusable"
              aria-current={navigation === id ? 'page' : undefined}
              onClick={(event) => navigate(event, id)}
            >
              <Icon size={19} aria-hidden="true" />
              <span>{label}</span>
            </a>
          ))}
        </nav>
        <div className="app-navigation__privacy">
          <span aria-hidden="true" />
          <span>Local and private</span>
        </div>
      </aside>
      <main className="app-content" id="main-content">{children}</main>
      <footer className="app-status-footer">
        <span className="app-status-footer__indicator" aria-hidden="true" />
        <span aria-live="polite" aria-atomic="true">{statusText}</span>
      </footer>
    </div>
  )
}
