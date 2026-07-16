import React, { type ReactNode } from 'react'

export interface ToastMessage {
  readonly id: string
  readonly message: string
  readonly tone?: 'info' | 'error'
}

export interface ToastRegionProps {
  readonly messages: readonly ToastMessage[]
}

export function ToastRegion({ messages }: ToastRegionProps): ReactNode {
  return (
    <div className="tt-toast-region" aria-live="polite" aria-atomic="false">
      {messages.map((toast) => (
        <div className="tt-toast" data-tone={toast.tone ?? 'info'} key={toast.id} role={toast.tone === 'error' ? 'alert' : 'status'}>
          {toast.message}
        </div>
      ))}
    </div>
  )
}
