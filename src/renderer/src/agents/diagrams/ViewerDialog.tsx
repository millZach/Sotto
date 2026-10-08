import React, { useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react'

/**
 * The expanded view's frame over the window: a modal dialog with a bar holding its title, a status read out once and
 * its controls. Escape closes it through `onClose`. The diagram viewer and an interactive visual's expanded page both
 * use it; each brings its own controls and body.
 */
export function ViewerDialog({ title, className, describedBy, status, controls, focusOnOpen, onClose, onKeyDown, children }: {
  readonly title: string
  readonly className?: string
  readonly describedBy?: string | undefined
  readonly status: string | null
  readonly controls: ReactNode
  /** What has focus once the dialog opens. */
  readonly focusOnOpen: RefObject<HTMLElement | null>
  readonly onClose: () => void
  readonly onKeyDown?: (event: KeyboardEvent) => void
  readonly children: ReactNode
}): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useLayoutEffect(() => {
    const element = dialog.current
    if (element?.showModal && !element.open) element.showModal()
    else element?.setAttribute('open', '')
    focusOnOpen.current?.focus({ preventScroll: true })
    return () => { element?.close?.() }
  }, [focusOnOpen])
  return <dialog ref={dialog} className={className ? `rich-diagram-viewer ${className}` : 'rich-diagram-viewer'} aria-labelledby={titleId} aria-describedby={describedBy}
    onCancel={event => { event.preventDefault(); onClose() }} onKeyDown={onKeyDown}>
    <header className="rich-diagram-viewer__bar">
      <h2 id={titleId} className="rich-diagram-viewer__title">{title}</h2>
      <span className="rich-code__status" role="status" aria-live="polite">{status}</span>
      <div className="rich-diagram-viewer__controls">{controls}</div>
    </header>
    {children}
  </dialog>
}
