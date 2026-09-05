import React, { type ReactNode } from 'react'
import { Minus, X } from 'lucide-react'

import { Button } from './Button'
import { SottoMark } from './SottoMark'
import { useApp } from '../state/AppContext'

export interface AppTitlebarProps {
  readonly onMinimize: () => Promise<void> | void
  readonly onClose: () => Promise<void> | void
  /** Anything that belongs between the page title and the window controls, such as search. */
  readonly children?: ReactNode
}

/** The titlebar names the page; each page keeps its own (visually hidden) h1. */
function pageCopy(app: ReturnType<typeof useApp>): { title: string; subtitle: string } | null {
  if (app.status !== 'ready' || app.settings === null || !app.settings.onboardingComplete) return null
  switch (app.navigation) {
    case 'history': {
      if (!app.settings.historyEnabled && app.history.length === 0) return { title: 'History', subtitle: 'History is off' }
      const count = app.history.length
      return { title: 'History', subtitle: `${count} ${count === 1 ? 'transcript' : 'transcripts'}, kept on this computer` }
    }
    case 'settings': return { title: 'Settings', subtitle: 'Changes save as you make them' }
    case 'help': return { title: 'Help', subtitle: 'Shortcuts, privacy, and troubleshooting' }
    case 'home': return { title: 'Home', subtitle: 'Dictation, kept on this computer' }
    default: return null
  }
}

export function AppTitlebar({ onMinimize, onClose, children }: AppTitlebarProps): ReactNode {
  const app = useApp()
  // macOS draws native traffic lights over this bar and closes to the tray
  // through the same intercepted close, so the custom controls would duplicate
  // system chrome.
  const nativeWindowControls = app.platform === 'darwin'
  const page = pageCopy(app)

  return (
    <header
      className={
        nativeWindowControls ? 'app-titlebar app-titlebar--mac' : 'app-titlebar'
      }
    >
      <div className="app-titlebar__brand" aria-label="Sotto application">
        <SottoMark className="app-titlebar__mark" />
        <span>Sotto</span>
      </div>
      {page === null ? null : (
        <div className="app-titlebar__page" aria-hidden="true">
          <span className="app-titlebar__title">{page.title}</span>
          <span className="app-titlebar__subtitle">{page.subtitle}</span>
        </div>
      )}
      {children}
      {nativeWindowControls ? null : (
        <div className="app-titlebar__controls">
          <Button iconOnly variant="ghost" aria-label="Minimize Sotto" onClick={() => void onMinimize()}>
            <Minus size={18} />
          </Button>
          <Button iconOnly variant="ghost" aria-label="Close Sotto to tray" onClick={() => void onClose()}>
            <X size={18} />
          </Button>
        </div>
      )}
    </header>
  )
}
