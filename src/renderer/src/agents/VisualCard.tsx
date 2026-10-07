import React, { memo, useMemo, type ReactNode } from 'react'
import { isVisualMessage, type AgentMessage } from '../../../shared/agents'
import { isKnownVisualKind, type AgentVisual } from '../../../shared/visuals'
import { DiagramActions, DiagramCopyStatus, DiagramExpanded, DiagramStage, diagramFrameState, useDiagramFrame } from './diagrams/DiagramFrame'
import { useMermaidRendering } from './diagrams/MermaidDiagram'
import { stepImage } from './diagrams/diagramSteps'
import { VisualStepper } from './VisualStepper'
import { InteractiveVisualCard } from './InteractiveVisualCard'
import { VisualReadAll } from './VisualReadAll'
import { ReadAllToggle, useWalkthroughPlace, walkthroughView } from './VisualWalkthrough'
import './visualCard.css'

/**
 * Whether a message is a visual this window can draw (ADR-0056): a visual message of a kind this version knows. Any
 * other visual message is drawn as its text, which says what the visual showed.
 */
export function isDrawableVisual(message: AgentMessage): message is AgentMessage & { visual: AgentVisual } {
  return isVisualMessage(message) && isKnownVisualKind(message.visual.kind)
}

/**
 * A visual an agent drew in its thread (ADR-0056): a header with its title and kind, Read all (Step through while it
 * shows every step) when it has steps, Show source, Copy source and Expand; the diagram, drawn by the same safe
 * renderer and frame as a diagram in an answer; and its explanation. A visual with steps is a walkthrough (#793): one step at a time, its part of the diagram lit and
 * the rest dimmed, in the card and in Expand. Read all swaps the walkthrough for the intro and the numbered steps, with
 * the whole diagram lit. When the diagram cannot be drawn, its source and the reason take its place and the steps stay
 * readable.
 */
export const VisualCard = memo(function VisualCard({ visual, threadId }: { readonly visual: AgentVisual; readonly threadId?: string | undefined }): ReactNode {
  // An agent's own page runs sealed (ADR-0057), in a card with the same header, walkthrough and explanation.
  return visual.kind === 'interactive' ? <InteractiveVisualCard visual={visual} threadId={threadId} /> : <DiagramVisualCard visual={visual} />
})

function DiagramVisualCard({ visual }: { readonly visual: AgentVisual }): ReactNode {
  const rendering = useMermaidRendering(visual.source, true)
  const frame = useDiagramFrame(visual.source, rendering)
  const [place, movePlace] = useWalkthroughPlace(visual.id)
  // The label is "Diagram" when the checks cannot name the kind.
  const kind = rendering.inspection.label
  const name = `${kind}: ${visual.title}`
  const steps = visual.steps ?? []
  const { walking, current, highlight } = walkthroughView(steps, place)
  const drawn = rendering.drawing
  // The step's picture, lit for it and cross-fading in from the last, in the card and in Expand.
  const stepPicture = useMemo(() => drawn ? { dataUrl: stepImage(drawn, highlight), crossFade: true } : undefined, [drawn, highlight])

  return <section className="visual-card" aria-label={`Visual: ${visual.title}`} data-state={diagramFrameState(rendering)}>
    <header className="visual-card__bar">
      <div className="visual-card__heading">
        <h3 className="visual-card__title" title={visual.title}>{visual.title}</h3>
        <span className="visual-card__kind">{kind}</span>
      </div>
      <DiagramCopyStatus frame={frame} />
      <div className="visual-card__actions">
        {/* Named for what a press does: Read all shows every step, Step through goes back to the walkthrough. */}
        {steps.length > 0 && <ReadAllToggle readAll={place.readAll} onToggle={() => movePlace({ readAll: !place.readAll })} />}
        <DiagramActions frame={frame} copyLabel="Copy source" expandLabel={`Expand ${visual.title}`} />
      </div>
    </header>
    <DiagramStage frame={frame} name={name} sourceLabel={`${visual.title} source`} block="visual-card" stage="visual-card__stage"
      picture={stepPicture} />
    {walking
      ? <VisualStepper steps={steps} index={current} onStep={index => movePlace({ step: index })} />
      : <VisualReadAll intro={visual.intro} steps={visual.steps} />}
    <DiagramExpanded frame={frame} name={name} picture={stepPicture} />
  </section>
}
