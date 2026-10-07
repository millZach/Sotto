import React, { memo, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Check, CircleAlert, CodeXml, Copy, Maximize2 } from 'lucide-react'
import { isVisualMessage, type AgentMessage } from '../../../shared/agents'
import { isKnownVisualKind, type AgentVisual } from '../../../shared/visuals'
import { useTransientFlag, writeClipboard } from './richActions'
import { DiagramViewer } from './diagrams/DiagramViewer'
import { useMermaidDrawing } from './diagrams/MermaidDiagram'
import './visualCard.css'

/**
 * Whether a message is a visual this window can draw (ADR-0055): a visual message of a kind this version knows. Any
 * other visual message is drawn as its text, which says what the visual showed.
 */
export function isDrawableVisual(message: AgentMessage): message is AgentMessage & { visual: AgentVisual } {
  return isVisualMessage(message) && isKnownVisualKind(message.visual.kind)
}

/**
 * A visual's explanation laid out to read all at once: the intro, then the numbered steps. This is the one place the
 * steps are drawn, so a walkthrough that shows them one at a time can take its place (#793).
 */
export function VisualReadAll({ intro, steps }: Pick<AgentVisual, 'intro' | 'steps'>): ReactNode {
  if (!intro && !steps?.length) return null
  return <div className="visual-card__explain">
    {intro ? <p className="visual-card__intro">{intro}</p> : null}
    {steps?.length ? <ol className="visual-card__steps">{steps.map((step, index) => <li key={index}>{step.text}</li>)}</ol> : null}
  </div>
}

/**
 * A visual an agent drew in its thread (ADR-0055): a header with its title and kind, Show source, Copy source and
 * Expand; the diagram, drawn by the same safe renderer as a diagram in an answer; and its explanation. When the
 * diagram cannot be drawn, its source and the reason take its place and the explanation stays readable.
 */
export const VisualCard = memo(function VisualCard({ visual }: { readonly visual: AgentVisual }): ReactNode {
  const { inspection, drawing, notice, failed } = useMermaidDrawing(visual.source, true)
  const [showSource, setShowSource] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [feedback, showFeedback] = useTransientFlag()
  const expandButton = useRef<HTMLButtonElement>(null)
  const noticeId = useId()
  const descriptionId = useId()
  const kind = inspection.kind ? inspection.label : 'Diagram'
  const name = `${kind}: ${visual.title}`

  useEffect(() => { if (!drawing) { setExpanded(false); setShowSource(false) } }, [drawing])

  const copy = (): void => { void writeClipboard(visual.source).then(() => showFeedback('Copied'), () => showFeedback('Copy failed')) }
  const close = (): void => {
    setExpanded(false)
    requestAnimationFrame(() => expandButton.current?.focus())
  }

  return <section className="visual-card" aria-label={`Visual: ${visual.title}`} data-state={drawing ? 'drawn' : failed ? 'failed' : 'source'}>
    <header className="visual-card__bar">
      <div className="visual-card__heading">
        <h3 className="visual-card__title" title={visual.title}>{visual.title}</h3>
        <span className="visual-card__kind">{kind}</span>
      </div>
      <span className="rich-code__status" role="status" aria-live="polite">{feedback}</span>
      <div className="visual-card__actions">
        {drawing && <button type="button" className="rich-code__copy tt-focusable" aria-pressed={showSource} aria-label="Show source" title={showSource ? 'Show diagram' : 'Show source'}
          onClick={() => setShowSource(value => !value)}><CodeXml size={16} aria-hidden="true" /></button>}
        <button type="button" className="rich-code__copy tt-focusable" data-copied={feedback === 'Copied' || undefined} aria-label="Copy source" title="Copy source" onClick={copy}>
          {feedback === 'Copied' ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
        </button>
        {drawing && <button ref={expandButton} type="button" className="rich-code__copy tt-focusable" aria-label={`Expand ${visual.title}`} title="Expand" aria-haspopup="dialog"
          onClick={() => setExpanded(true)}><Maximize2 size={15} aria-hidden="true" /></button>}
      </div>
    </header>
    {drawing && !showSource
      ? <div className="visual-card__canvas" onClick={() => setExpanded(true)}>
        <img src={drawing.dataUrl} alt={name} width={drawing.width} height={drawing.height} draggable={false} decoding="async"
          aria-describedby={drawing.description ? descriptionId : undefined} />
        {drawing.description && <span id={descriptionId} className="tt-visually-hidden">{drawing.description}</span>}
      </div>
      : <div className="visual-card__stage">
        {notice && <p id={noticeId} className="visual-card__notice" data-tone={failed ? 'problem' : 'waiting'}>
          {failed && <CircleAlert size={15} aria-hidden="true" />}<span>{notice}</span>
        </p>}
        <pre className="rich-code__scroll visual-card__source" tabIndex={0} aria-label={`${visual.title} source`} aria-describedby={notice ? noticeId : undefined}><code>{visual.source}</code></pre>
      </div>}
    <VisualReadAll intro={visual.intro} steps={visual.steps} />
    {expanded && drawing && <DiagramViewer dataUrl={drawing.dataUrl} width={drawing.width} height={drawing.height} name={name}
      description={drawing.description} copyFeedback={feedback} onCopy={copy} onClose={close} />}
  </section>
})
