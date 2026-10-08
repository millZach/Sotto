import React, { useRef, type ReactNode } from 'react'
import { Check, Copy, X } from 'lucide-react'
import { INTERACTIVE_VISUAL_LABEL, type AgentVisual } from '../../../shared/visuals'
import type { VisualStepPlace } from '../../../shared/visualGuest'
import { useFrameControls, type FrameControls } from './diagrams/DiagramFrame'
import { ViewerDialog } from './diagrams/ViewerDialog'
import { InteractiveVisualPage } from './InteractiveVisual'
import { VisualCardShell } from './VisualCardShell'
import { pageStepFor, useWalkthroughPlace } from './VisualWalkthrough'

/** Where a reader can turn when the page is not shown, by what the visual has besides it. */
export function pageFallbackHint(visual: Pick<AgentVisual, 'intro' | 'steps'>): string {
  if (visual.steps?.length) return 'Its steps are below.'
  if (visual.intro) return 'What it shows is described below.'
  return 'Show source shows its HTML.'
}

/**
 * An interactive visual in its card (ADR-0060): the same card as a diagram's (`VisualCardShell`), with the agent's page
 * running sealed where a diagram's drawing would be. Each step the reader moves to goes to the page as a step message
 * with the names that step is about, so the page can show it. Escape inside the page gives focus back to the card.
 */
export function InteractiveVisualCard({ visual, threadId }: { readonly visual: AgentVisual; readonly threadId: string | undefined }): ReactNode {
  const frame = useFrameControls(visual.source)
  const card = useRef<HTMLElement>(null)
  const [place, movePlace] = useWalkthroughPlace(visual.id)
  const step = pageStepFor(visual.steps ?? [], place)
  const fallbackHint = pageFallbackHint(visual)
  // Escape from the page is a key, so focus lands on the card with its ring showing, until focus moves on.
  const returnFocus = (): void => {
    const element = card.current
    if (!element) return
    element.dataset.focusReturned = ''
    element.addEventListener('blur', () => { delete element.dataset.focusReturned }, { once: true })
    element.focus()
  }

  return <VisualCardShell visual={visual} kind={INTERACTIVE_VISUAL_LABEL} state="drawn" interactive cardRef={card} frame={frame} showing shownTitle="Show page"
    place={place} movePlace={movePlace}
    stage={frame.showSource
      ? <div className="visual-card__stage">
        <pre className="rich-code__scroll visual-card__source" tabIndex={0} aria-label={`${visual.title} source`}><code>{visual.source}</code></pre>
      </div>
      // The page stops while Expand shows it, so one visual never runs twice.
      : frame.expanded ? <div className="interactive-visual" data-state="expanded" aria-hidden="true" />
        : <InteractiveVisualPage threadId={threadId} visualId={visual.id} title={visual.title} step={step} fallbackHint={fallbackHint} onEscape={returnFocus} />}
    expandedView={frame.expanded && <InteractiveVisualViewer visual={visual} threadId={threadId} step={step} fallbackHint={fallbackHint} frame={frame} />} />
}

/** An interactive visual expanded over the window: the same sealed page with the room to fill, Copy source and Close. */
function InteractiveVisualViewer({ visual, threadId, step, fallbackHint, frame }: {
  readonly visual: AgentVisual; readonly threadId: string | undefined; readonly step: VisualStepPlace; readonly fallbackHint: string; readonly frame: FrameControls
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
      <InteractiveVisualPage threadId={threadId} visualId={visual.id} title={visual.title} step={step} fallbackHint={fallbackHint} expanded onEscape={close} />
    </div>
  </ViewerDialog>
}
