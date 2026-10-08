import React, { type ReactNode, type RefObject } from 'react'
import type { AgentVisual } from '../../../shared/visuals'
import { VisualActions, VisualCopyStatus, type FrameControls } from './diagrams/DiagramFrame'
import { VisualReadAll } from './VisualReadAll'
import { VisualStepper } from './VisualStepper'
import { ReadAllToggle, walkthroughView, type WalkthroughPlace } from './VisualWalkthrough'

/**
 * What every visual's card is, whatever it shows (ADR-0056, ADR-0060): a header with the title and kind, Read all
 * (Step through while every step shows) when it has steps, Show source, Copy source and Expand; then what it shows,
 * `stage`; then the walkthrough, one step at a time (#793), or the intro and every step under Read all; then the
 * expanded view while it is open. A diagram's card and an interactive page's card each bring their stage.
 */
export function VisualCardShell({ visual, kind, state, interactive = false, cardRef, frame, showing, shownTitle, place, movePlace, stage, expandedView }: {
  readonly visual: AgentVisual
  /** The kind as the header shows it: "Flowchart", "Interactive page". */
  readonly kind: string
  /** The card's `data-state`: drawn, failed, or showing its source. */
  readonly state: string
  /** An interactive page's card, which takes focus back from its page on Escape. */
  readonly interactive?: boolean
  readonly cardRef?: RefObject<HTMLElement | null>
  readonly frame: FrameControls
  /** Whether there is something to show, so Show source and Expand are offered. */
  readonly showing: boolean
  readonly shownTitle: string
  readonly place: WalkthroughPlace
  readonly movePlace: (change: Partial<WalkthroughPlace>) => void
  readonly stage: ReactNode
  readonly expandedView: ReactNode
}): ReactNode {
  const steps = visual.steps ?? []
  const { walking, current } = walkthroughView(steps, place)
  return <section ref={cardRef} className="visual-card" aria-label={`Visual: ${visual.title}`} data-state={state}
    data-kind={interactive ? 'interactive' : undefined} tabIndex={interactive ? -1 : undefined}>
    <header className="visual-card__bar">
      <div className="visual-card__heading">
        <h3 className="visual-card__title" title={visual.title}>{visual.title}</h3>
        <span className="visual-card__kind">{kind}</span>
      </div>
      <VisualCopyStatus frame={frame} />
      <div className="visual-card__actions">
        {steps.length > 0 && <ReadAllToggle readAll={place.readAll} onToggle={() => movePlace({ readAll: !place.readAll })} />}
        <VisualActions frame={frame} showing={showing} shownTitle={shownTitle} copyLabel="Copy source" expandLabel={`Expand ${visual.title}`} />
      </div>
    </header>
    {stage}
    {walking
      ? <VisualStepper steps={steps} index={current} onStep={index => movePlace({ step: index })} />
      : <VisualReadAll intro={visual.intro} steps={visual.steps} />}
    {expandedView}
  </section>
}
