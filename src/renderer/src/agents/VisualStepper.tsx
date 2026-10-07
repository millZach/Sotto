import React, { useRef, type KeyboardEvent, type ReactNode } from 'react'
import './visualStepper.css'

export interface VisualStepperProps {
  /** The visual's steps, in order. With none there is no walkthrough and nothing is drawn. */
  readonly steps: readonly { readonly text: string }[]
  /** The step shown, from 0. */
  readonly index: number
  /** Asked to show another step, from 0. The owner shows it, and lights its part of the visual. */
  readonly onStep: (index: number) => void
}

/** The step to show for `index` out of `count` steps: a whole number from 0 to the last step. */
export const clampStep = (index: number, count: number): number => Math.min(Math.max(Math.trunc(index) || 0, 0), Math.max(count - 1, 0))

/**
 * A visual's walkthrough (ADR-0056, #793): "Step n of N", a dot for each step, Back and Next ("Start over" on the last
 * step), and the step's words in larger type, read out as they change. Left and Right step while focus is anywhere in
 * it. The dots are one Tab stop, the current step's, and the focus moves with the step while it is on them. A visual
 * with one step shows its words alone. It holds no state of its own, so whatever shows the visual (a diagram's card, an
 * interactive page's card) keeps the step and lights it.
 */
export function VisualStepper({ steps, index, onStep }: VisualStepperProps): ReactNode {
  const dots = useRef<(HTMLButtonElement | null)[]>([])
  const count = steps.length
  if (!count) return null
  const current = clampStep(index, count)
  const first = current === 0
  const last = current === count - 1
  // One step has nowhere to go: its words alone, under its lit part of the visual.
  if (count === 1) return <div className="visual-stepper" role="group" aria-label="Walkthrough">
    <p className="visual-stepper__text visual-stepper__text--only">{steps[0]!.text}</p>
  </div>
  const go = (next: number): void => { if (next >= 0 && next < count && next !== current) onStep(next) }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const next = clampStep(current + (event.key === 'ArrowRight' ? 1 : -1), count)
    go(next)
    // On the dots, the focus goes with the step, so the one Tab stop stays the current step's dot.
    if (dots.current.includes(event.target as HTMLButtonElement)) dots.current[next]?.focus()
  }

  return <div className="visual-stepper" role="group" aria-label="Walkthrough" onKeyDown={onKeyDown}>
    <div className="visual-stepper__head">
      <span className="visual-stepper__count">Step {current + 1} of {count}</span>
      <div className="visual-stepper__dots" role="group" aria-label="Steps">
        {steps.map((_, step) => <button key={step} ref={element => { dots.current[step] = element }} type="button"
          tabIndex={step === current ? 0 : -1} className="visual-stepper__dot tt-focusable" aria-label={`Go to step ${step + 1}`}
          aria-current={step === current ? 'step' : undefined} data-state={step === current ? 'current' : step < current ? 'done' : undefined}
          onClick={() => go(step)} />)}
      </div>
      <div className="visual-stepper__nav">
        {/* Back stays focusable on the first step, so a press there does not drop the focus. */}
        <button type="button" className="tt-button visual-stepper__button tt-focusable" aria-disabled={first || undefined}
          onClick={() => go(current - 1)}>Back</button>
        <button type="button" className="tt-button tt-button--primary visual-stepper__button tt-focusable"
          onClick={() => last ? onStep(0) : go(current + 1)}>{last ? 'Start over' : 'Next'}</button>
      </div>
    </div>
    <p className="visual-stepper__text" aria-live="polite">{steps[current]!.text}</p>
  </div>
}
