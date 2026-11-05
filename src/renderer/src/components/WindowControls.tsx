import React, { type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import { Minus, Square, Copy, X } from 'lucide-react'

import { useOptionalApp } from '../state/AppContext'
import { Button } from './Button'
import { MainFreezeNotice } from '../features/performance/MainFreezeNotice'

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
 * lights, and Linux leaves closing to the compositor, so callers draw this only on Windows.
 */
export function WindowControls({ maximized = false, onMaximize, onMinimize, onClose, className }: WindowControlsProps): ReactNode {
  const { t } = useLingui()
  return (
    <div className={className ? `app-controls ${className}` : 'app-controls'}>
      <Button iconOnly variant="ghost" aria-label={t`Minimize Sotto`} onClick={() => void onMinimize()}>
        <Minus size={18} />
      </Button>
      <Button iconOnly variant="ghost" className="app-controls__maximize" aria-label={maximized ? t`Restore Sotto` : t`Maximize Sotto`} title={maximized ? t({ message: 'Restore', context: 'window size' }) : t({ message: 'Maximize', context: 'window size' })} onClick={() => void onMaximize()}>
        {maximized ? <Copy size={16} /> : <Square size={16} />}
      </Button>
      <Button iconOnly variant="ghost" aria-label={t`Close Sotto to tray`} onClick={() => void onClose()}>
        <X size={18} />
      </Button>
    </div>
  )
}

/**
 * The window's own controls, seated once at the top-right corner of a page that owns the window (Threads,
 * Settings) rather than in any pane's header: such a page has no app strip above it. macOS paints its
 * traffic lights itself; Linux leaves closing to the compositor. Both get none.
 */
export function PageWindowControls(): ReactNode {
  const app = useOptionalApp()
  if (app === null) return null
  // The main freeze notice (an Owl feature, ADR-0098) sits left of the controls on Windows, and alone in the corner
  // where the system draws or omits them.
  if (app.platform !== 'win32') return <MainFreezeNotice frame="threads-view__winctl" />
  return <div className="threads-view__winctl">
    <MainFreezeNotice />
    <WindowControls maximized={app.windowMaximized} onMaximize={app.actions.toggleMaximizeApp} onMinimize={app.actions.minimizeApp} onClose={app.actions.hideApp} />
  </div>
}
