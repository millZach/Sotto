import React, { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import { DiagramExpanded, VisualActions, VisualCopyStatus, DiagramStage, diagramFrameState, useDiagramFrame } from './DiagramFrame'
import { useDiagramPalette, type DiagramPalette } from './diagramPalette'
import type { DiagramRenderResult } from './diagramRenderer'
import { inspectDiagramSource, type DiagramSourceInspection } from '../../../../shared/diagramSource'
import { keepRecent } from '../../../../shared/recentMap'
import './diagrams.css'

export interface MermaidDiagramProps {
  /** The fenced source exactly as the provider wrote it, without the fence lines. */
  readonly source: string
  /** False while a streaming message has not yet closed this fence. */
  readonly complete: boolean
}

export type MermaidDrawn = Extract<DiagramRenderResult, { ok: true }>
interface Settled { readonly code: string; readonly result: DiagramRenderResult }

// Mermaid is a large module; it loads the first time an answer holds a drawable diagram.
const loadDiagramRenderer = (): Promise<{ renderDiagram: (code: string, palette: DiagramPalette) => Promise<DiagramRenderResult> }> => import('./diagramRenderer')

/**
 * The drawings already made, readable during render. The renderer's own cache holds promises inside a
 * lazily loaded module, so without this a diagram drawn a moment ago would mount as its source and
 * "Drawing…" for a commit before the image, on every thread switch and remount, and the transcript
 * would lay out twice. Only drawings are kept: a failure or a slow render still asks the renderer again.
 */
const drawn = new Map<string, MermaidDrawn>()
const MAX_DRAWN = 24
const drawnKey = (palette: DiagramPalette, code: string): string => `${JSON.stringify(palette)}\n${code}`
function rememberDrawing(key: string, result: DiagramRenderResult): void {
  if (result.ok) keepRecent(drawn, key, result, MAX_DRAWN)
}

/** One Mermaid source as a reader sees it: what it is, its drawing once made, and what to say while there is none. */
export interface MermaidRendering {
  readonly inspection: DiagramSourceInspection
  /** The drawing for the current appearance, or null while it is drawing, cannot be drawn or failed. */
  readonly drawing: MermaidDrawn | null
  /** The kind and title as the image's accessible name, e.g. "Flowchart: Login". */
  readonly name: string
  /** Why there is no drawing yet, or null when there is one. */
  readonly notice: string | null
  /** True when the source cannot be drawn: the checks refused it or Mermaid failed on it. */
  readonly failed: boolean
}

/**
 * Draws one Mermaid source in the current appearance through the safe renderer, the way an answer's diagram is
 * drawn: checked first, drawn once per source and palette, and redrawn without dropping the old drawing when the
 * appearance changes. The visual card (ADR-0056) draws with this too.
 */
export function useMermaidRendering(source: string, complete: boolean): MermaidRendering {
  const inspection = useMemo(() => inspectDiagramSource(source), [source])
  const palette = useDiagramPalette()
  const drawable = complete && !inspection.problem
  const [settled, setSettled] = useState<Settled | null>(() => {
    const hit = drawable ? drawn.get(drawnKey(palette, inspection.code)) : undefined
    return hit === undefined ? null : { code: inspection.code, result: hit }
  })

  useEffect(() => {
    if (!drawable) return
    let live = true
    const code = inspection.code
    const key = drawnKey(palette, code)
    void loadDiagramRenderer()
      .then(renderer => renderer.renderDiagram(code, palette))
      .then(result => { rememberDrawing(key, result); return result })
      .catch((): DiagramRenderResult => ({ ok: false, reason: 'The diagram renderer could not load.' }))
      // A diagram that mounted drawn gets the same cached result back, and that confirmation is not a commit.
      .then(result => { if (live) setSettled(current => current?.code === code && current.result === result ? current : { code, result }) })
    return () => { live = false }
  }, [drawable, inspection.code, palette])

  // A redraw for a new appearance keeps the previous drawing on screen until the new one is ready.
  const current = drawable && settled?.code === inspection.code ? settled.result : null
  const drawing: MermaidDrawn | null = current?.ok ? current : null
  const name = [inspection.label, drawing?.title ?? inspection.title].filter(Boolean).join(': ')
  const notice = !complete ? 'Draws when the block is complete.'
    : inspection.problem ?? (current && !current.ok ? `Couldn't draw this diagram. ${current.reason}` : !current ? 'Drawing…' : null)
  const failed = !!inspection.problem || (current !== null && !current.ok)
  return { inspection, drawing, name, notice, failed }
}

/** A Mermaid block in an answer: the drawing when it can be drawn, otherwise its readable source and why. */
export const MermaidDiagram = memo(function MermaidDiagram({ source, complete }: MermaidDiagramProps): ReactNode {
  const rendering = useMermaidRendering(source, complete)
  const frame = useDiagramFrame(source, rendering)
  const { inspection, name } = rendering

  return <figure className="rich-diagram rich-code" data-state={diagramFrameState(rendering)} aria-label={name}>
    <div className="rich-code__bar">
      <span className="rich-code__language">{rendering.drawing || inspection.kind ? inspection.label : 'Mermaid'}</span>
      <VisualCopyStatus frame={frame} />
      <VisualActions frame={frame} showing={Boolean(frame.rendering.drawing)} shownTitle="Show diagram" copyLabel="Copy diagram source" expandLabel="Expand diagram" />
    </div>
    <DiagramStage frame={frame} name={name} sourceLabel={`${inspection.label} source`} block="rich-diagram" />
    <DiagramExpanded frame={frame} name={name} />
  </figure>
})
