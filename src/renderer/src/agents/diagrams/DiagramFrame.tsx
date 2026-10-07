import React, { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Check, CircleAlert, CodeXml, Copy, Maximize2 } from 'lucide-react'
import { useTransientFlag, writeClipboard } from '../richActions'
import { DiagramViewer } from './DiagramViewer'
import { CrossFadeImage, DiagramImage, type DiagramPicture } from './DiagramImage'
import type { MermaidRendering } from './MermaidDiagram'

/**
 * What a visual's frame keeps while it is on screen, whatever it shows: whether its source is shown instead, whether it
 * is expanded, and how the last copy went. A drawn diagram and an interactive visual's page (ADR-0057) both use it.
 */
export interface FrameControls {
  readonly source: string
  readonly showSource: boolean
  readonly expanded: boolean
  readonly feedback: string | null
  readonly expandButton: RefObject<HTMLButtonElement | null>
  toggleSource(): void
  expand(): void
  copy(): void
  /** Closes the expanded view and puts focus back on Expand. */
  close(): void
  /** Back to the frame's first state: neither the source nor the expanded view. */
  reset(): void
}

export function useFrameControls(source: string): FrameControls {
  const [showSource, setShowSource] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [feedback, showFeedback] = useTransientFlag()
  const expandButton = useRef<HTMLButtonElement>(null)
  return {
    source, showSource, expanded, feedback, expandButton,
    toggleSource: () => setShowSource(value => !value),
    expand: () => setExpanded(true),
    copy: () => { void writeClipboard(source).then(() => showFeedback('Copied'), () => showFeedback('Copy failed')) },
    close: () => {
      setExpanded(false)
      requestAnimationFrame(() => expandButton.current?.focus())
    },
    reset: () => { setExpanded(false); setShowSource(false) },
  }
}

/**
 * What every drawn diagram's frame keeps: the frame's controls, how drawing the source went, and the IDs its notice and
 * description are named by. An answer's diagram and an agent's visual (ADR-0056) both use it, with the pieces below,
 * and each lays the pieces out in its own header and body.
 */
export interface DiagramFrameState extends FrameControls {
  /** How drawing the source went: what it is, its drawing once made (`rendering.drawing`), and what to say until then. */
  readonly rendering: MermaidRendering
  readonly noticeId: string
  readonly descriptionId: string
}

/** The frame for one drawing of `source`. A drawing that goes away takes the source view and the expanded view with it. */
export function useDiagramFrame(source: string, rendering: MermaidRendering): DiagramFrameState {
  const controls = useFrameControls(source)
  const noticeId = useId()
  const descriptionId = useId()
  const drawn = rendering.drawing
  const reset = useRef(controls.reset)
  reset.current = controls.reset

  useEffect(() => { if (!drawn) reset.current() }, [drawn])

  return { ...controls, rendering, noticeId, descriptionId }
}

/** How the last copy went, read out once. */
export function DiagramCopyStatus({ frame }: { readonly frame: Pick<FrameControls, 'feedback'> }): ReactNode {
  return <span className="rich-code__status" role="status" aria-live="polite">{frame.feedback}</span>
}

/**
 * Show source and Expand while there is something to show, and Copy source always, each named for what a press does.
 * A diagram's frame has something to show once it is drawn; any other frame always does. `shownTitle` is the tooltip
 * that takes Show source back to what the frame shows.
 */
export function DiagramActions({ frame, copyLabel, expandLabel, shownTitle = 'Show diagram' }: {
  readonly frame: FrameControls & { readonly rendering?: MermaidRendering }; readonly copyLabel: string; readonly expandLabel: string; readonly shownTitle?: string
}): ReactNode {
  const drawn = frame.rendering ? Boolean(frame.rendering.drawing) : true
  return <>
    {drawn && <button type="button" className="rich-code__copy tt-focusable" aria-pressed={frame.showSource} aria-label="Show source" title={frame.showSource ? shownTitle : 'Show source'}
      onClick={frame.toggleSource}><CodeXml size={16} aria-hidden="true" /></button>}
    <button type="button" className="rich-code__copy tt-focusable" data-copied={frame.feedback === 'Copied' || undefined} aria-label={copyLabel} title="Copy source" onClick={frame.copy}>
      {frame.feedback === 'Copied' ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
    </button>
    {drawn && <button ref={frame.expandButton} type="button" className="rich-code__copy tt-focusable" aria-label={expandLabel} title="Expand" aria-haspopup="dialog"
      onClick={frame.expand}><Maximize2 size={15} aria-hidden="true" /></button>}
  </>
}

/**
 * The drawing, which expands on a click; or, while there is none or the source is asked for, why there is none and the
 * readable source. `block` is the class prefix of the frame's own styles (`block__canvas`, `block__notice`,
 * `block__source`), and `stage`, when set, is the class of an element the notice and source are wrapped in. `picture`
 * shows another picture of the same drawing, such as a visual's lit step, cross-fading from one to the next when it
 * asks to (`block__layers`).
 */
export function DiagramStage({ frame, name, sourceLabel, block, stage, picture }: {
  readonly frame: DiagramFrameState; readonly name: string; readonly sourceLabel: string; readonly block: string; readonly stage?: string
  readonly picture?: DiagramPicture | undefined
}): ReactNode {
  const { drawing: drawn, notice, failed } = frame.rendering
  if (drawn && !frame.showSource) {
    const describedBy = drawn.description ? frame.descriptionId : undefined
    const image = { src: picture?.dataUrl ?? drawn.dataUrl, alt: name, width: drawn.width, height: drawn.height, describedBy }
    return <div className={`${block}__canvas`} onClick={frame.expand}>
      {picture?.crossFade ? <CrossFadeImage className={`${block}__layers`} {...image} /> : <DiagramImage {...image} />}
      {drawn.description && <span id={frame.descriptionId} className="tt-visually-hidden">{drawn.description}</span>}
    </div>
  }
  const fallback = <>
    {notice && <p id={frame.noticeId} className={`${block}__notice`} data-tone={failed ? 'problem' : 'waiting'}>
      {failed && <CircleAlert size={15} aria-hidden="true" />}<span>{notice}</span>
    </p>}
    <pre className={`rich-code__scroll ${block}__source`} tabIndex={0} aria-label={sourceLabel} aria-describedby={notice ? frame.noticeId : undefined}><code>{frame.source}</code></pre>
  </>
  return stage ? <div className={stage}>{fallback}</div> : fallback
}

/** The expanded drawing, while it is open: `picture` when given (the one the stage shows), else the drawing itself. */
export function DiagramExpanded({ frame, name, picture }: { readonly frame: DiagramFrameState; readonly name: string; readonly picture?: DiagramPicture | undefined }): ReactNode {
  const drawn = frame.rendering.drawing
  if (!frame.expanded || !drawn) return null
  return <DiagramViewer dataUrl={picture?.dataUrl ?? drawn.dataUrl} width={drawn.width} height={drawn.height} name={name}
    description={drawn.description} copyFeedback={frame.feedback} onCopy={frame.copy} onClose={frame.close} />
}

/** The `data-state` a frame's root carries: drawn, failed, or showing its source while it draws. */
export const diagramFrameState = (rendering: MermaidRendering): 'drawn' | 'failed' | 'source' =>
  rendering.drawing ? 'drawn' : rendering.failed ? 'failed' : 'source'
