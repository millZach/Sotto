import React, { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Check, CodeXml, Copy, Maximize2, X } from 'lucide-react'
import type { AgentVisual } from '../../../shared/visuals'
import { useTransientFlag, writeClipboard } from './richActions'
import { InteractiveVisualPage } from './InteractiveVisual'
import { VisualReadAll } from './VisualCard'

/** What the page is told while Read all shows every step at once: step 0 of the steps there are, nothing lit. */
const readAllStep = (visual: AgentVisual): { step: number; total: number; highlight: readonly string[] } => ({ step: 0, total: visual.steps?.length ?? 0, highlight: [] })

/**
 * An interactive visual in its card (ADR-0057): the same header as a diagram's (title, kind, Show source, Copy source,
 * Expand), the agent's page running sealed in the middle, and the intro and steps under it. Escape inside the page gives
 * focus back to the card.
 */
export function InteractiveVisualCard({ visual, threadId }: { readonly visual: AgentVisual; readonly threadId: string | undefined }): ReactNode {
  const [showSource, setShowSource] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [feedback, showFeedback] = useTransientFlag()
  const card = useRef<HTMLElement>(null)
  const expandButton = useRef<HTMLButtonElement>(null)
  const step = readAllStep(visual)

  const copy = (): void => { void writeClipboard(visual.source).then(() => showFeedback('Copied'), () => showFeedback('Copy failed')) }
  const close = (): void => {
    setExpanded(false)
    requestAnimationFrame(() => expandButton.current?.focus())
  }

  return <section ref={card} className="visual-card" aria-label={`Visual: ${visual.title}`} data-state="drawn" data-kind="interactive" tabIndex={-1}>
    <header className="visual-card__bar">
      <div className="visual-card__heading">
        <h3 className="visual-card__title" title={visual.title}>{visual.title}</h3>
        <span className="visual-card__kind">Interactive page</span>
      </div>
      <span className="rich-code__status" role="status" aria-live="polite">{feedback}</span>
      <div className="visual-card__actions">
        <button type="button" className="rich-code__copy tt-focusable" aria-pressed={showSource} aria-label="Show source" title={showSource ? 'Show page' : 'Show source'}
          onClick={() => setShowSource(value => !value)}><CodeXml size={16} aria-hidden="true" /></button>
        <button type="button" className="rich-code__copy tt-focusable" data-copied={feedback === 'Copied' || undefined} aria-label="Copy source" title="Copy source" onClick={copy}>
          {feedback === 'Copied' ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
        </button>
        <button ref={expandButton} type="button" className="rich-code__copy tt-focusable" aria-label={`Expand ${visual.title}`} title="Expand" aria-haspopup="dialog"
          onClick={() => setExpanded(true)}><Maximize2 size={15} aria-hidden="true" /></button>
      </div>
    </header>
    {showSource
      ? <div className="visual-card__stage">
        <pre className="rich-code__scroll visual-card__source" tabIndex={0} aria-label={`${visual.title} source`}><code>{visual.source}</code></pre>
      </div>
      // The page stops while Expand shows it, so one visual never runs twice.
      : expanded ? <div className="interactive-visual" data-state="expanded" aria-hidden="true" />
        : <InteractiveVisualPage threadId={threadId} visualId={visual.id} title={visual.title} step={step} onEscape={() => card.current?.focus()} />}
    <VisualReadAll intro={visual.intro} steps={visual.steps} />
    {expanded && <InteractiveVisualViewer visual={visual} threadId={threadId} step={step} copyFeedback={feedback} onCopy={copy} onClose={close} />}
  </section>
}

/** An interactive visual expanded over the window: the same sealed page with the room to fill, Copy source and Close. */
function InteractiveVisualViewer({ visual, threadId, step, copyFeedback, onCopy, onClose }: {
  readonly visual: AgentVisual; readonly threadId: string | undefined; readonly step: { step: number; total: number; highlight: readonly string[] }
  readonly copyFeedback: string | null; readonly onCopy: () => void; readonly onClose: () => void
}): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  useLayoutEffect(() => {
    const element = dialog.current
    if (element?.showModal && !element.open) element.showModal()
    else element?.setAttribute('open', '')
    closeButton.current?.focus({ preventScroll: true })
    return () => { element?.close?.() }
  }, [])
  const latestClose = useRef(onClose)
  useEffect(() => { latestClose.current = onClose }, [onClose])
  return <dialog ref={dialog} className="rich-diagram-viewer interactive-visual-viewer" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose() }}>
    <header className="rich-diagram-viewer__bar">
      <h2 id={titleId} className="rich-diagram-viewer__title">{`Interactive page: ${visual.title}`}</h2>
      <span className="rich-code__status" role="status" aria-live="polite">{copyFeedback}</span>
      <div className="rich-diagram-viewer__controls">
        <button type="button" className="rich-code__copy tt-focusable" data-copied={copyFeedback === 'Copied' || undefined} aria-label="Copy page source" title="Copy source" onClick={onCopy}>
          {copyFeedback === 'Copied' ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
        </button>
        <button ref={closeButton} type="button" className="rich-code__copy tt-focusable" aria-label="Close page" title="Close (Esc)" onClick={onClose}><X size={17} aria-hidden="true" /></button>
      </div>
    </header>
    <div className="interactive-visual-viewer__body">
      <InteractiveVisualPage threadId={threadId} visualId={visual.id} title={visual.title} step={step} fill onEscape={() => latestClose.current()} />
    </div>
  </dialog>
}
