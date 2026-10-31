import React, { useEffect, useRef, type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import { X } from 'lucide-react'

export interface ToastMessage {
  readonly id: string
  readonly message: ReactNode
  readonly tone?: 'info' | 'success' | 'error'
  readonly onDismiss?: () => void
}

function Toast({ toast }: { readonly toast: ToastMessage }): ReactNode {
  const { t } = useLingui()
  const ref = useRef<HTMLDivElement>(null)
  const dismiss = toast.onDismiss
  useEffect(() => {
    if (dismiss === undefined) return
    const clickAway = (event: PointerEvent): void => {
      if (event.target instanceof Node && !ref.current?.contains(event.target)) dismiss()
    }
    document.addEventListener('pointerdown', clickAway, true)
    window.addEventListener('blur', dismiss)
    return () => {
      document.removeEventListener('pointerdown', clickAway, true)
      window.removeEventListener('blur', dismiss)
    }
  }, [dismiss])
  return (
    <div ref={ref} className="tt-toast" data-dismissible={dismiss ? '' : undefined} data-tone={toast.tone ?? 'info'}
      role={toast.tone === 'error' ? 'alert' : 'status'} onKeyDown={event => {
        if (event.key !== 'Escape' || dismiss === undefined) return
        event.preventDefault()
        event.stopPropagation()
        dismiss()
      }}>
      {dismiss === undefined ? toast.message : <>
        <div>{toast.message}</div>
        <button type="button" className="tt-toast__dismiss tt-focusable" aria-label={t`Dismiss`} title={t`Dismiss`} onClick={dismiss}><X size={14} aria-hidden="true" /></button>
      </>}
    </div>
  )
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
      {messages.map(toast => <Toast key={toast.id} toast={toast} />)}
    </div>
  )
}
