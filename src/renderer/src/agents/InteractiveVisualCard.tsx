import React, { useRef, type ReactNode } from 'react'
import { Check, Copy, X } from 'lucide-react'
import type { AgentVisual } from '../../../shared/visuals'
import type { VisualStepPlace } from '../../../shared/visualGuest'
import { DiagramActions, DiagramCopyStatus, useFrameControls, type FrameControls } from './diagrams/DiagramFrame'
import { ViewerDialog } from './diagrams/ViewerDialog'
import { InteractiveVisualPage } from './InteractiveVisual'
import { VisualReadAll } from './VisualReadAll'
import { VisualStepper } from './VisualStepper'
import { ReadAllToggle, useWalkthroughPlace, walkthroughView, type WalkthroughPlace } from './VisualWalkthrough'

/**
 * What the page is told of the walkthrough: the step shown, counted from 1, with the names that step is about; or, while
 * Read all shows every step (and for a visual with none), step 0 with nothing named.
 */
export function pageStep(visual: Pick<AgentVisual, 'steps'>, place: WalkthroughPlace): VisualStepPlace {
  const steps = visual.steps ?? []
  const { walking, current, highlight } = walkthroughView(steps, place)
  return walking ? { step: current + 1, total: steps.length, highlight: [...highlight ?? []] } : { step: 0, total: steps.length, highlight: [] }
}

/** What a reader can turn to when the page is not shown, by what the visual has besides it. */
export function pageOtherwise(visual: Pick<AgentVisual, 'intro' | 'steps'>): string {
  if (visual.steps?.length) return 'Its steps are below.'
  if (visual.intro) return 'What it shows is described below.'
  return 'Show source shows its HTML.'
}

/**
 * An interactive visual in its card (ADR-0057): the same header and controls as a diagram's (title, kind, Read all when
 * it has steps, Show source, Copy source, Expand), the agent's page running sealed in the middle, and under it the same
 * walkthrough as a diagram's (#793), or the intro and every step under Read all. Each step the reader moves to goes to
 * the page as a step message with the names that step is about, so the page can show it. Escape inside the page gives
 * focus back to the card.
 */
export function InteractiveVisualCard({ visual, threadId }: { readonly visual: AgentVisual; readonly threadId: string | undefined }): ReactNode {
  const frame = useFrameControls(visual.source)
  const card = useRef<HTMLElement>(null)
  const steps = visual.steps ?? []
  const [place, movePlace] = useWalkthroughPlace(visual.id)
  const { walking, current } = walkthroughView(steps, place)
  const step = pageStep(visual, place)
  const otherwise = pageOtherwise(visual)
  // Escape from the page is a key, so focus lands on the card with its ring showing, until focus moves on.
  const returnFocus = (): void => {
    const element = card.current
    if (!element) return
    element.dataset.focusReturned = ''
    element.addEventListener('blur', () => { delete element.dataset.focusReturned }, { once: true })
    element.focus()
  }

  return <section ref={card} className="visual-card" aria-label={`Visual: ${visual.title}`} data-state="drawn" data-kind="interactive" tabIndex={-1}>
    <header className="visual-card__bar">
      <div className="visual-card__heading">
        <h3 className="visual-card__title" title={visual.title}>{visual.title}</h3>
        <span className="visual-card__kind">Interactive page</span>
      </div>
      <DiagramCopyStatus frame={frame} />
      <div className="visual-card__actions">
        {steps.length > 0 && <ReadAllToggle readAll={place.readAll} onToggle={() => movePlace({ readAll: !place.readAll })} />}
        <DiagramActions frame={frame} copyLabel="Copy source" expandLabel={`Expand ${visual.title}`} shownTitle="Show page" />
      </div>
    </header>
    {frame.showSource
      ? <div className="visual-card__stage">
        <pre className="rich-code__scroll visual-card__source" tabIndex={0} aria-label={`${visual.title} source`}><code>{visual.source}</code></pre>
      </div>
      // The page stops while Expand shows it, so one visual never runs twice.
      : frame.expanded ? <div className="interactive-visual" data-state="expanded" aria-hidden="true" />
        : <InteractiveVisualPage threadId={threadId} visualId={visual.id} title={visual.title} step={step} otherwise={otherwise} onEscape={returnFocus} />}
    {walking
      ? <VisualStepper steps={steps} index={current} onStep={index => movePlace({ step: index })} />
      : <VisualReadAll intro={visual.intro} steps={visual.steps} />}
    {frame.expanded && <InteractiveVisualViewer visual={visual} threadId={threadId} step={step} otherwise={otherwise} frame={frame} />}
  </section>
}

/** An interactive visual expanded over the window: the same sealed page with the room to fill, Copy source and Close. */
function InteractiveVisualViewer({ visual, threadId, step, otherwise, frame }: {
  readonly visual: AgentVisual; readonly threadId: string | undefined; readonly step: VisualStepPlace; readonly otherwise: string; readonly frame: FrameControls
}): ReactNode {
  const closeButton = useRef<HTMLButtonElement>(null)
  const { feedback, copy, close } = frame
  return <ViewerDialog title={`Interactive page: ${visual.title}`} className="interactive-visual-viewer" status={feedback} focusOnOpen={closeButton} onClose={close}
    controls={<>
      <button type="button" className="rich-code__copy tt-focusable" data-copied={feedback === 'Copied' || undefined} aria-label="Copy page source" title="Copy source" onClick={copy}>
        {feedback === 'Copied' ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
      </button>
      <button ref={closeButton} type="button" className="rich-code__copy tt-focusable" aria-label="Close page" title="Close (Esc)" onClick={close}><X size={17} aria-hidden="true" /></button>
    </>}>
    <div className="interactive-visual-viewer__body">
      <InteractiveVisualPage threadId={threadId} visualId={visual.id} title={visual.title} step={step} otherwise={otherwise} expanded onEscape={close} />
    </div>
  </ViewerDialog>
}
