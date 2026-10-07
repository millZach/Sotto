import React, { memo, type ReactNode } from 'react'
import { isVisualMessage, type AgentMessage } from '../../../shared/agents'
import { isKnownVisualKind, type AgentVisual } from '../../../shared/visuals'
import { DiagramActions, DiagramCopyStatus, DiagramExpanded, DiagramStage, diagramFrameState, useDiagramFrame } from './diagrams/DiagramFrame'
import { useMermaidDrawing } from './diagrams/MermaidDiagram'
import { InteractiveVisualCard } from './InteractiveVisualCard'
import { VisualReadAll } from './VisualReadAll'
import './visualCard.css'

/**
 * Whether a message is a visual this window can draw (ADR-0056): a visual message of a kind this version knows. Any
 * other visual message is drawn as its text, which says what the visual showed.
 */
export function isDrawableVisual(message: AgentMessage): message is AgentMessage & { visual: AgentVisual } {
  return isVisualMessage(message) && isKnownVisualKind(message.visual.kind)
}


/**
 * A visual an agent drew in its thread (ADR-0056): a header with its title and kind, Show source, Copy source and
 * Expand; the diagram, drawn by the same safe renderer and frame as a diagram in an answer; and its explanation. When
 * the diagram cannot be drawn, its source and the reason take its place and the explanation stays readable.
 */
export const VisualCard = memo(function VisualCard({ visual, threadId }: { readonly visual: AgentVisual; readonly threadId?: string | undefined }): ReactNode {
  // An agent's own page runs sealed (ADR-0057), in a card with the same header and explanation.
  return visual.kind === 'interactive' ? <InteractiveVisualCard visual={visual} threadId={threadId} /> : <DiagramVisualCard visual={visual} />
})

function DiagramVisualCard({ visual }: { readonly visual: AgentVisual }): ReactNode {
  const drawing = useMermaidDrawing(visual.source, true)
  const frame = useDiagramFrame(visual.source, drawing)
  // The label is "Diagram" when the checks cannot name the kind.
  const kind = drawing.inspection.label
  const name = `${kind}: ${visual.title}`

  return <section className="visual-card" aria-label={`Visual: ${visual.title}`} data-state={diagramFrameState(drawing)}>
    <header className="visual-card__bar">
      <div className="visual-card__heading">
        <h3 className="visual-card__title" title={visual.title}>{visual.title}</h3>
        <span className="visual-card__kind">{kind}</span>
      </div>
      <DiagramCopyStatus frame={frame} />
      <div className="visual-card__actions">
        <DiagramActions frame={frame} copyLabel="Copy source" expandLabel={`Expand ${visual.title}`} />
      </div>
    </header>
    <DiagramStage frame={frame} name={name} sourceLabel={`${visual.title} source`} block="visual-card" stage="visual-card__stage" />
    {/* The explanation. #793's step-by-step walkthrough takes this one component's place. */}
    <VisualReadAll intro={visual.intro} steps={visual.steps} />
    <DiagramExpanded frame={frame} name={name} />
  </section>
}
