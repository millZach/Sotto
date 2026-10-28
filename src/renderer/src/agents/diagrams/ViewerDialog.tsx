import React, { useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { stepDirection } from '../VisualStepper'
import type { ExpandedWalkthrough } from '../VisualWalkthrough'

/**
 * The expanded view's frame over the window: a modal dialog with a bar holding its title, a status read out once and
 * its controls. Escape closes it through `onClose`. The diagram viewer and an interactive visual's expanded page both
 * use it; each brings its own controls and body. A visual being stepped through brings its `walkthrough`: the card's
 * bar under the body, and Left and Right step anywhere in the dialog that does not take them for itself.
 */
export function ViewerDialog({ title, className, describedBy, status, controls, focusOnOpen, walkthrough, footer, onClose, onKeyDown, children }: {
  readonly title: string
  readonly className?: string
  readonly describedBy?: string | undefined
  readonly status: string | null
  readonly controls: ReactNode
  /** What has focus once the dialog opens. */
  readonly focusOnOpen: RefObject<HTMLElement | null>
  readonly walkthrough?: ExpandedWalkthrough | undefined
  /** What goes under the walkthrough, at the dialog's foot: the diagram viewer's line of keys. */
  readonly footer?: ReactNode
  readonly onClose: () => void
  readonly onKeyDown?: (event: KeyboardEvent) => void
  readonly children: ReactNode
}): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null)
  const walkthroughBar = useRef<HTMLDivElement>(null)
  const step = walkthrough?.current
  const titleId = useId()
  useLayoutEffect(() => {
    const element = dialog.current
    if (element?.showModal && !element.open) element.showModal()
    else element?.setAttribute('open', '')
    focusOnOpen.current?.focus({ preventScroll: true })
    return () => { element?.close?.() }
  }, [focusOnOpen])
  // A step too long for the bar scrolls in it; the next step starts at its count and the top of its words.
  useLayoutEffect(() => { if (walkthroughBar.current) walkthroughBar.current.scrollTop = 0 }, [step])
  const keyDown = (event: KeyboardEvent): void => {
    // The bar steps for itself while it has focus, and marks the key used.
    const direction = event.defaultPrevented ? null : stepDirection(event)
    const move = walkthrough?.step
    if (move && direction !== null) {
      event.preventDefault()
      move(direction)
      return
    }
    onKeyDown?.(event)
  }
  return <dialog ref={dialog} className={className ? `rich-diagram-viewer ${className}` : 'rich-diagram-viewer'} aria-labelledby={titleId} aria-describedby={describedBy}
    onCancel={event => { event.preventDefault(); onClose() }} onKeyDown={keyDown}>
    <header className="rich-diagram-viewer__bar">
      <h2 id={titleId} className="rich-diagram-viewer__title">{title}</h2>
      <span className="rich-code__status" role="status" aria-live="polite">{status}</span>
      <div className="rich-diagram-viewer__controls">{controls}</div>
    </header>
    {children}
    {walkthrough && <div ref={walkthroughBar} className="rich-diagram-viewer__walkthrough">{walkthrough.bar}</div>}
    {footer}
  </dialog>
}
