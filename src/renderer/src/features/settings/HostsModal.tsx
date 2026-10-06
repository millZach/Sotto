import React, { useEffect, useId, useRef, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'

/** How many Hosts modals are open, so a saved host's SSH question waits rather than stacking on one. */
let openModals = 0
const modalListeners = new Set<() => void>()
const subscribeModals = (listener: () => void): (() => void) => { modalListeners.add(listener); return () => { modalListeners.delete(listener) } }
const modalsChanged = (change: number): void => { openModals += change; for (const listener of modalListeners) listener() }
/** Whether Add host, Edit connection or Rename is open. */
export const useHostsModalOpen = (): boolean => useSyncExternalStore(subscribeModals, () => openModals > 0)

/**
 * A modal for Settings > Hosts: focus starts inside it (on `data-autofocus` when a control has it), Tab stays inside it, Escape answers it (after
 * anything open inside has answered first) and focus goes back to what opened it.
 */
export function HostsModal({ title, onClose, busy = false, children, footer, className = '' }: {
  readonly title: string; readonly onClose: () => void; readonly busy?: boolean
  readonly children: ReactNode; readonly footer: ReactNode; readonly className?: string
}): ReactNode {
  const dialog = useRef<HTMLElement>(null)
  const titleId = useId()
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => { modalsChanged(1); return () => modalsChanged(-1) }, [])
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // Focus starts on the control marked for it, such as Add host's Device list below a Tailscale prompt, else on the first one.
    const start = dialog.current?.querySelector<HTMLElement>('[data-autofocus]:not(:disabled)') ?? dialog.current?.querySelector<HTMLElement>('input:not(:disabled), button:not(:disabled)')
    start?.focus()
    // Escape is heard on the document, so it still answers while focus sits on a control that just turned off.
    // Anything open inside the dialog (Add host's device list) answers it first and stops it there.
    const onEscape = (event: globalThis.KeyboardEvent): void => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); close.current() } }
    document.addEventListener('keydown', onEscape)
    return () => { document.removeEventListener('keydown', onEscape); queueMicrotask(() => { if (opener?.isConnected) opener.focus() }) }
  }, [])
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Tab') return
    const focusable = [...dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex]:not([tabindex="-1"])') ?? []]
    const first = focusable[0], last = focusable.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
  return <div className="tt-dialog-backdrop" role="presentation">
    <section ref={dialog} className={`tt-dialog hosts-dialog ${className}`.trim()} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy || undefined} onKeyDown={onKeyDown}>
      <h2 id={titleId}>{title}</h2>
      {children}
      <div className="tt-dialog__actions">{footer}</div>
    </section>
  </div>
}
