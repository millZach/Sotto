import React, { type ReactNode } from 'react'
import { Minus, X } from 'lucide-react'

import { Button } from './Button'

export interface AppTitlebarProps {
  readonly onMinimize: () => Promise<void> | void
  readonly onClose: () => Promise<void> | void
}

export function AppTitlebar({ onMinimize, onClose }: AppTitlebarProps): ReactNode {
  return (
    <header className="app-titlebar">
      <div className="app-titlebar__brand" aria-label="TalkType application">
        <span className="app-titlebar__mark" aria-hidden="true">T</span>
        <span>TalkType</span>
      </div>
      <div className="app-titlebar__controls">
        <Button iconOnly variant="ghost" aria-label="Minimize TalkType" onClick={() => void onMinimize()}>
          <Minus size={18} />
        </Button>
        <Button iconOnly variant="ghost" aria-label="Close TalkType to tray" onClick={() => void onClose()}>
          <X size={18} />
        </Button>
      </div>
    </header>
  )
}
