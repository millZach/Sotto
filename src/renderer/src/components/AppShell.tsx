import React, { type MouseEvent, type ReactNode } from 'react'
import { CircleHelp, Clock3, Home, Mic, Settings } from 'lucide-react'

import type { AppNavigation } from '../state/AppContext'

type ManagementNavigation = Exclude<AppNavigation, 'onboarding'>

export type AppStatusTone = 'ready' | 'listening' | 'processing' | 'attention'

export interface AppShellProps {
  readonly navigation: ManagementNavigation
  readonly statusText: string
  readonly statusTone: AppStatusTone
  readonly onNavigate: (destination: ManagementNavigation) => void
  /** The dictation deck, pinned above the page on every tab. */
  readonly deck?: ReactNode
  readonly children: ReactNode
}

const destinations = [
  { id: 'home' as const, label: 'Home', icon: Home },
  { id: 'history' as const, label: 'History', icon: Clock3 },
  { id: 'settings' as const, label: 'Settings', icon: Settings },
  { id: 'help' as const, label: 'Help', icon: CircleHelp },
]

/**
 * The rail: a 60px column of icon links with the session dot at its foot,
 * beside a stage that holds the dictation deck and the scrolling page.
 */
export function AppShell({
  navigation,
  statusText,
  statusTone,
  onNavigate,
  deck,
  children,
}: AppShellProps): ReactNode {
  const navigate = (event: MouseEvent<HTMLAnchorElement>, destination: ManagementNavigation): void => {
    event.preventDefault()
    onNavigate(destination)
  }

  return (
    <div className="app-shell">
      <aside className="app-navigation">
        <nav aria-label="Primary navigation">
          {destinations.map(({ id, label, icon: Icon }) => (
            <a
              key={id}
              href={`#${id}`}
              className="app-navigation__link tt-focusable"
              aria-current={navigation === id ? 'page' : undefined}
              title={label}
              onClick={(event) => navigate(event, id)}
            >
              <Icon size={18} aria-hidden="true" />
              <span className="tt-visually-hidden">{label}</span>
            </a>
          ))}
        </nav>
        <div className="app-navigation__status" data-tone={statusTone} title={statusText}>
          <span aria-hidden="true"><Mic size={15} /></span>
          <span aria-live="polite" aria-atomic="true">{statusText}</span>
        </div>
      </aside>
      <div className="app-stage">
        {deck}
        <main className="app-content" id="main-content">{children}</main>
      </div>
    </div>
  )
}
