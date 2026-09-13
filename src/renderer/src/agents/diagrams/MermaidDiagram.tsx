import React, { memo, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, CircleAlert, CodeXml, Copy, Maximize2 } from 'lucide-react'
import { useTransientFlag, writeClipboard } from '../richActions'
import { DiagramViewer } from './DiagramViewer'
import { useDiagramPalette, type DiagramPalette } from './diagramPalette'
import type { DiagramRenderResult } from './diagramRenderer'
import { inspectDiagramSource } from './diagramSource'
import './diagrams.css'

export interface MermaidDiagramProps {
  /** The fenced source exactly as the provider wrote it, without the fence lines. */
  readonly source: string
  /** False while a streaming message has not yet closed this fence. */
  readonly complete: boolean
}

type Drawing = Extract<DiagramRenderResult, { ok: true }>
interface Settled { readonly code: string; readonly result: DiagramRenderResult }

// Mermaid is a large module; it loads the first time an answer holds a drawable diagram.
const loadDiagramRenderer = (): Promise<{ renderDiagram: (code: string, palette: DiagramPalette) => Promise<DiagramRenderResult> }> => import('./diagramRenderer')

/** A Mermaid block in an answer: the drawing when it can be drawn, otherwise its readable source and why. */
export const MermaidDiagram = memo(function MermaidDiagram({ source, complete }: MermaidDiagramProps): ReactNode {
  const inspection = useMemo(() => inspectDiagramSource(source), [source])
  const palette = useDiagramPalette()
  const [settled, setSettled] = useState<Settled | null>(null)
  const [showSource, setShowSource] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [feedback, showFeedback] = useTransientFlag()
  const expandButton = useRef<HTMLButtonElement>(null)
  const noticeId = useId()
  const descriptionId = useId()
  const drawable = complete && !inspection.problem

  useEffect(() => {
    if (!drawable) return
    let live = true
    const code = inspection.code
    void loadDiagramRenderer()
      .then(renderer => renderer.renderDiagram(code, palette))
      .catch((): DiagramRenderResult => ({ ok: false, reason: 'The diagram renderer could not load.' }))
      .then(result => { if (live) setSettled({ code, result }) })
    return () => { live = false }
  }, [drawable, inspection.code, palette])

  // A redraw for a new appearance keeps the previous drawing on screen until the new one is ready.
  const current = drawable && settled?.code === inspection.code ? settled.result : null
  const drawing: Drawing | null = current?.ok ? current : null
  const name = [inspection.label, drawing?.title ?? inspection.title].filter(Boolean).join(': ')
  const notice = !complete ? 'Draws when the block is complete.'
    : inspection.problem ?? (current && !current.ok ? `Couldn't draw this diagram. ${current.reason}` : !current ? 'Drawing…' : null)
  const failed = !!inspection.problem || (current !== null && !current.ok)

  useEffect(() => { if (!drawing) { setExpanded(false); setShowSource(false) } }, [drawing])

  const copy = (): void => { void writeClipboard(source).then(() => showFeedback('Copied'), () => showFeedback('Copy failed')) }
  const close = (): void => {
    setExpanded(false)
    requestAnimationFrame(() => expandButton.current?.focus())
  }

  const sourceView = <pre className="rich-code__scroll rich-diagram__source" tabIndex={0} aria-label={`${inspection.label} source`} aria-describedby={notice ? noticeId : undefined}><code>{source}</code></pre>

  return <figure className="rich-diagram rich-code" data-state={drawing ? 'drawn' : failed ? 'failed' : 'source'} aria-label={name}>
    <div className="rich-code__bar">
      <span className="rich-code__language">{drawing || inspection.kind ? inspection.label : 'Mermaid'}</span>
      <span className="rich-code__status" role="status" aria-live="polite">{feedback}</span>
      {drawing && <button type="button" className="rich-code__copy tt-focusable" aria-pressed={showSource} aria-label="Show source" title={showSource ? 'Show diagram' : 'Show source'}
        onClick={() => setShowSource(value => !value)}><CodeXml size={16} aria-hidden="true" /></button>}
      <button type="button" className="rich-code__copy tt-focusable" data-copied={feedback === 'Copied' || undefined} aria-label="Copy diagram source" title="Copy source" onClick={copy}>
        {feedback === 'Copied' ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
      </button>
      {drawing && <button ref={expandButton} type="button" className="rich-code__copy tt-focusable" aria-label="Expand diagram" title="Expand" aria-haspopup="dialog"
        onClick={() => setExpanded(true)}><Maximize2 size={15} aria-hidden="true" /></button>}
    </div>
    {drawing && !showSource
      ? <div className="rich-diagram__canvas" onClick={() => setExpanded(true)}>
        <img src={drawing.dataUrl} alt={name} width={drawing.width} height={drawing.height} draggable={false} decoding="async"
          aria-describedby={drawing.description ? descriptionId : undefined} />
        {drawing.description && <span id={descriptionId} className="tt-visually-hidden">{drawing.description}</span>}
      </div>
      : <>
        {notice && <p id={noticeId} className="rich-diagram__notice" data-tone={failed ? 'problem' : 'waiting'}>
          {failed && <CircleAlert size={15} aria-hidden="true" />}<span>{notice}</span>
        </p>}
        {sourceView}
      </>}
    {expanded && drawing && <DiagramViewer dataUrl={drawing.dataUrl} width={drawing.width} height={drawing.height} name={name}
      description={drawing.description} copyFeedback={feedback} onCopy={copy} onClose={close} />}
  </figure>
})
