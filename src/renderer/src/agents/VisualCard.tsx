import React, { memo, useMemo, useState, type ReactNode } from 'react'
import { isVisualMessage, type AgentMessage } from '../../../shared/agents'
import { keepRecent, readRecent } from '../../../shared/recentMap'
import { isKnownVisualKind, type AgentVisual } from '../../../shared/visuals'
import { DiagramActions, DiagramCopyStatus, DiagramExpanded, DiagramStage, diagramFrameState, useDiagramFrame } from './diagrams/DiagramFrame'
import { useMermaidRendering } from './diagrams/MermaidDiagram'
import { stepImage } from './diagrams/diagramSteps'
import { VisualStepper, clampStep } from './VisualStepper'
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

/** Where a reader is in one visual's walkthrough: the step shown, and whether every step is shown instead. */
interface WalkthroughPlace { readonly step: number; readonly readAll: boolean }
const FIRST_STEP: WalkthroughPlace = { step: 0, readAll: false }

/**
 * Each visual's place, by the visual's id. A card is drawn again when its turn finishes and folds, or the thread is
 * opened again, and the reader stays where they were. Kept for this window's life only, the most recent 200.
 */
const places = new Map<string, WalkthroughPlace>()
const MAX_PLACES = 200

/** One visual's place, and a function that moves it and keeps where it went. */
function useWalkthroughPlace(id: string): [WalkthroughPlace, (change: Partial<WalkthroughPlace>) => void] {
  const [place, setPlace] = useState(() => readRecent(places, id) ?? FIRST_STEP)
  const move = (change: Partial<WalkthroughPlace>): void => setPlace(keepRecent(places, id, { ...place, ...change }, MAX_PLACES))
  return [place, move]
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
  const [{ step, readAll }, movePlace] = useWalkthroughPlace(visual.id)
  // The label is "Diagram" when the checks cannot name the kind.
  const kind = rendering.inspection.label
  const name = `${kind}: ${visual.title}`
  const steps = visual.steps ?? []
  const walking = steps.length > 0 && !readAll
  const current = clampStep(step, steps.length)
  const drawn = rendering.drawing
  const highlight = walking ? steps[current]?.highlight : undefined
  // The step's picture, lit for it and cross-fading in from the last, in the card and in Expand.
  const stepPicture = useMemo(() => drawn ? stepImage(drawn, highlight) : undefined, [drawn, highlight])

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
          onClick={() => movePlace({ readAll: !readAll })}>{readAll ? 'Step through' : 'Read all'}</button>}
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
})
