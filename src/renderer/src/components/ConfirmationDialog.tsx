import React, { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react'

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
  readonly failureMessage?: ReactNode
  readonly pendingStatus?: ReactNode
  readonly fallbackFocusRef?: RefObject<HTMLElement | null>
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
  failureMessage,
  pendingStatus,
  fallbackFocusRef,
}: ConfirmationDialogProps): ReactNode {
  const [submitting, setSubmitting] = useState(false)
  const [failed, setFailed] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const submittingRef = useRef(false)
  const onCancelRef = useRef(onCancel)
  const titleId = useId()
  const descriptionId = useId()

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
      queueMicrotask(() => {
        if (target?.isConnected) target.focus()
        else fallbackFocusRef?.current?.focus()
      })
    }
  }, [fallbackFocusRef])

  const confirm = async (): Promise<void> => {
    if (submittingRef.current) return
    submittingRef.current = true
    setFailed(false)
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
      setFailed(true)
    }
  }

  return (
    <div className="tt-dialog-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="tt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={submitting || undefined}
      >
        <h2 id={titleId}>{title}</h2>
        <div id={descriptionId} className="tt-dialog__description">{description}</div>
        {submitting && pendingStatus !== undefined
          ? <div className="tt-dialog__status" role="status" aria-live="polite">{pendingStatus}</div>
          : null}
        {failed && failureMessage !== undefined
          ? <div className="tt-dialog__status tt-dialog__status--error" role="alert">{failureMessage}</div>
          : null}
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
