import React, { useEffect, useRef, useState, type ReactNode } from 'react'

import { Button } from './Button'

export interface ConfirmationDialogProps {
  readonly title: string
  readonly description: ReactNode
  readonly confirmLabel: string
  readonly cancelLabel: string
  readonly onConfirm: () => Promise<boolean | void>
  readonly onCancel: () => void
  readonly danger?: boolean
  readonly confirmDisabled?: boolean
}

export function ConfirmationDialog({
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  danger = true,
  confirmDisabled = false,
}: ConfirmationDialogProps): ReactNode {
  const [submitting, setSubmitting] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const submittingRef = useRef(false)
  const onCancelRef = useRef(onCancel)

  onCancelRef.current = onCancel
  submittingRef.current = submitting

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    cancelRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !submittingRef.current) {
        event.preventDefault()
        onCancelRef.current()
        return
      }
      if (event.key === 'Tab') {
        const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
        ) ?? [])]
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable.at(-1)
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first?.focus()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      const target = returnFocusRef.current
      queueMicrotask(() => target?.isConnected && target.focus())
    }
  }, [])

  const confirm = async (): Promise<void> => {
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    let result: boolean | void
    try {
      result = await onConfirm()
    } catch {
      result = false
    }
    if (result !== false) onCancel()
    else {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  return (
    <div className="tt-dialog-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="tt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tt-confirmation-title"
        aria-describedby="tt-confirmation-description"
      >
        <h2 id="tt-confirmation-title">{title}</h2>
        <div id="tt-confirmation-description" className="tt-dialog__description">{description}</div>
        <div className="tt-dialog__actions">
          <Button ref={cancelRef} variant="secondary" disabled={submitting} onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} disabled={submitting || confirmDisabled} onClick={() => void confirm()}>
            {confirmLabel}
          </Button>
        </div>
      </section>
    </div>
  )
}
