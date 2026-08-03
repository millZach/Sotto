import React, { type ReactNode } from 'react'
import { Minus, X } from 'lucide-react'

import { Button } from './Button'
import { useApp } from '../state/AppContext'

export interface AppTitlebarProps {
  readonly onMinimize: () => Promise<void> | void
  readonly onClose: () => Promise<void> | void
}

export function AppTitlebar({ onMinimize, onClose }: AppTitlebarProps): ReactNode {
  // macOS draws native traffic lights over this bar and closes to the tray
  // through the same intercepted close, so the custom controls would duplicate
  // system chrome.
  const nativeWindowControls = useApp().platform === 'darwin'

  return (
    <header
      className={
        nativeWindowControls ? 'app-titlebar app-titlebar--mac' : 'app-titlebar'
      }
    >
      <div className="app-titlebar__brand" aria-label="Sotto application">
        {/* Inline copy of build/icon.svg so the mark matches the packaged app icon. */}
        <svg className="app-titlebar__mark" aria-hidden="true" viewBox="0 0 96 96">
          <defs>
            <linearGradient id="app-titlebar-mark-bg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#8b5cf6" />
              <stop offset="1" stopColor="#5b21b6" />
            </linearGradient>
          </defs>
          <rect width="96" height="96" rx="22" fill="url(#app-titlebar-mark-bg)" />
          <rect x="26" y="20" width="9" height="56" rx="4.5" fill="#ffffff" />
          <path
            d="M44 48c4.5-15 9-15 13.5 0s9 15 13.5 0"
            stroke="#ffffff"
            strokeWidth="7.5"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
        <span>Sotto</span>
      </div>
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
