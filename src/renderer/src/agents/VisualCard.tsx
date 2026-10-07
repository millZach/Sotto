import React, { memo, useMemo, useState, type ReactNode } from 'react'
import { isVisualMessage, type AgentMessage } from '../../../shared/agents'
import { isKnownVisualKind, type AgentVisual } from '../../../shared/visuals'
import { DiagramActions, DiagramCopyStatus, DiagramExpanded, DiagramStage, diagramFrameState, useDiagramFrame } from './diagrams/DiagramFrame'
import { useMermaidRendering } from './diagrams/MermaidDiagram'
import { stepImage } from './diagrams/diagramSteps'
import { VisualStepper } from './VisualStepper'
import './visualCard.css'

/**
 * Whether a message is a visual this window can draw (ADR-0056): a visual message of a kind this version knows. Any
 * other visual message is drawn as its text, which says what the visual showed.
 */
export function isDrawableVisual(message: AgentMessage): message is AgentMessage & { visual: AgentVisual } {
  return isVisualMessage(message) && isKnownVisualKind(message.visual.kind)
}

/**
 * A visual's explanation laid out to read all at once: the intro, then the numbered steps. A visual without steps shows
 * it always; one with steps shows it under Read all, in place of the walkthrough.
 */
export function VisualReadAll({ intro, steps }: Pick<AgentVisual, 'intro' | 'steps'>): ReactNode {
  if (!intro && !steps?.length) return null
  return <div className="visual-card__explain">
    {intro ? <p className="visual-card__intro">{intro}</p> : null}
    {steps?.length ? <ol className="visual-card__steps">{steps.map((step, index) => <li key={index}>{step.text}</li>)}</ol> : null}
  </div>
}

/**
 * Where each visual's walkthrough is, by the visual's id. A card is drawn again when its turn finishes and folds, or the
 * thread is opened again, and the reader stays on the step they were reading. Kept for this window's life only.
 */
const walkthroughs = new Map<string, { readonly step: number; readonly readAll: boolean }>()
const MAX_WALKTHROUGHS = 200

function useWalkthrough(id: string): [{ readonly step: number; readonly readAll: boolean }, (change: Partial<{ step: number; readAll: boolean }>) => void] {
  const [state, setState] = useState(() => walkthroughs.get(id) ?? { step: 0, readAll: false })
  const update = (change: Partial<{ step: number; readAll: boolean }>): void => setState(current => {
    const next = { ...current, ...change }
    walkthroughs.delete(id)
    walkthroughs.set(id, next)
    if (walkthroughs.size > MAX_WALKTHROUGHS) walkthroughs.delete(walkthroughs.keys().next().value!)
    return next
  })
  return [state, update]
}

/**
 * A visual an agent drew in its thread (ADR-0056): a header with its title and kind, Read all (Step through while it
 * shows every step) when it has steps, Show source, Copy source and Expand; the diagram, drawn by the same safe
 * renderer and frame as a diagram in an answer; and its explanation. A visual with steps is a walkthrough (#793): one step at a time, its part of the diagram lit and
 * the rest dimmed, in the card and in Expand. Read all swaps the walkthrough for the intro and the numbered steps, with
 * the whole diagram lit. When the diagram cannot be drawn, its source and the reason take its place and the steps stay
 * readable.
 */
export const VisualCard = memo(function VisualCard({ visual }: { readonly visual: AgentVisual }): ReactNode {
  const rendering = useMermaidRendering(visual.source, true)
  const frame = useDiagramFrame(visual.source, rendering)
  const [{ step, readAll }, walk] = useWalkthrough(visual.id)
  // The label is "Diagram" when the checks cannot name the kind.
  const kind = rendering.inspection.label
  const name = `${kind}: ${visual.title}`
  const steps = visual.steps ?? []
  const walking = steps.length > 0 && !readAll
  const current = Math.min(step, Math.max(steps.length - 1, 0))
  const drawn = rendering.drawing
  const highlight = walking ? steps[current]?.highlight : undefined
  const picture = useMemo(() => drawn ? stepImage(drawn, highlight) : undefined, [drawn, highlight])

  return <section className="visual-card" aria-label={`Visual: ${visual.title}`} data-state={diagramFrameState(rendering)}>
    <header className="visual-card__bar">
      <div className="visual-card__heading">
        <h3 className="visual-card__title" title={visual.title}>{visual.title}</h3>
        <span className="visual-card__kind">{kind}</span>
      </div>
      <DiagramCopyStatus frame={frame} />
      <div className="visual-card__actions">
        {/* Named for what a press does: Read all shows every step, Step through goes back to the walkthrough. */}
        {steps.length > 0 && <button type="button" className="tt-button visual-card__read-all tt-focusable" data-reading-all={readAll || undefined}
          onClick={() => walk({ readAll: !readAll })}>{readAll ? 'Step through' : 'Read all'}</button>}
        <DiagramActions frame={frame} copyLabel="Copy source" expandLabel={`Expand ${visual.title}`} />
      </div>
    </header>
    <DiagramStage frame={frame} name={name} sourceLabel={`${visual.title} source`} block="visual-card" stage="visual-card__stage"
      dataUrl={picture} crossFade />
    {walking
      ? <VisualStepper steps={steps} index={current} onStep={index => walk({ step: index })} />
      : <VisualReadAll intro={visual.intro} steps={visual.steps} />}
    <DiagramExpanded frame={frame} name={name} dataUrl={picture} />
  </section>
})
