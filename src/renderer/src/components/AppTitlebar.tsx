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
      <div className="app-titlebar__brand" aria-label="Sotto application">
        <span className="app-titlebar__mark" aria-hidden="true">S</span>
        <span>Sotto</span>
      </div>
      <div className="app-titlebar__controls">
        <Button iconOnly variant="ghost" aria-label="Minimize Sotto" onClick={() => void onMinimize()}>
          <Minus size={18} />
        </Button>
        <Button iconOnly variant="ghost" aria-label="Close Sotto to tray" onClick={() => void onClose()}>
          <X size={18} />
        </Button>
      </div>
    </header>
  )
}
