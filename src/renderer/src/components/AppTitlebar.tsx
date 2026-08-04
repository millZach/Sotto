import React, { type ReactNode } from 'react'
import { Minus, X } from 'lucide-react'

import { Button } from './Button'
import { SottoMark } from './SottoMark'
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
        <SottoMark className="app-titlebar__mark" />
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
