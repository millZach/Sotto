import React, { type ReactNode } from 'react'
import { Minus, Square, Copy, X } from 'lucide-react'

import { Button } from './Button'

export interface WindowControlsProps {
  readonly maximized?: boolean
  readonly onMaximize: () => Promise<void> | void
  readonly onMinimize: () => Promise<void> | void
  readonly onClose: () => Promise<void> | void
  readonly className?: string | undefined
}

/**
 * The frameless window's minimize, maximize/restore and close-to-tray buttons.
 * Rendered once per window, in whatever chrome the open page has: the strip on
 * most pages, the Threads page's own top edge. macOS paints its own traffic
 * lights, so callers skip this on darwin.
 */
export function WindowControls({ maximized = false, onMaximize, onMinimize, onClose, className }: WindowControlsProps): ReactNode {
  return (
    <div className={className ? `app-controls ${className}` : 'app-controls'}>
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
  )
}
