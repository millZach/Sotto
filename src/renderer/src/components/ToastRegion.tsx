import React, { type ReactNode } from 'react'

export interface ToastMessage {
  readonly id: string
  readonly message: ReactNode
  readonly tone?: 'info' | 'success' | 'error'
}

export interface ToastRegionProps {
  readonly messages: readonly ToastMessage[]
  /**
   * Where the region stands: the window's corner, or in the Threads sidebar's own flow above its foot, where the settle
   * toast stands (ADR-0167). Empty, the sidebar's takes no room.
   */
  readonly placement?: 'corner' | 'sidebar'
}

export function ToastRegion({ messages, placement = 'corner' }: ToastRegionProps): ReactNode {
  return (
    <div className="tt-toast-region" data-placement={placement === 'corner' ? undefined : placement} aria-live="polite" aria-atomic="false">
      {messages.map((toast) => (
        <div className="tt-toast" data-tone={toast.tone ?? 'info'} key={toast.id} role={toast.tone === 'error' ? 'alert' : 'status'}>
          {toast.message}
        </div>
      ))}
    </div>
  )
}
