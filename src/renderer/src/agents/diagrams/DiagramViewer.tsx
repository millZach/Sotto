import React, { useId, type ReactNode } from 'react'
import { Check, Copy, Scan, X, ZoomIn, ZoomOut } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'
import { ViewerDialog } from './ViewerDialog'
import { DiagramImage } from './DiagramImage'
import { usePanZoom } from './usePanZoom'

export { clampPan, clampScale, fitScale } from './usePanZoom'

export interface DiagramViewerProps {
  readonly dataUrl: string
  readonly width: number
  readonly height: number
  /** Accessible name of the drawing, e.g. "Sequence diagram: Login". */
  readonly name: string
  readonly description: string | null
  readonly copyFeedback: string | null
  /** The last copy went through. */
  readonly copied: boolean
  readonly onCopy: () => void
  readonly onClose: () => void
}

/** The expanded drawing: zoom, pan, copy source and close, all from the keyboard or pointer. */
export function DiagramViewer({ dataUrl, width, height, name, description, copyFeedback, copied, onCopy, onClose }: DiagramViewerProps): ReactNode {
  const { t } = useLingui()
  // A small drawing is enlarged for inspection, but not so far that its strokes turn heavy.
  const zoom = usePanZoom(width, height, 2)
  const hintId = useId()
  const descriptionId = useId()
  // Opened before the viewport is measured, so the first painted frame is already fitted.
  return <ViewerDialog title={name} describedBy={description ? descriptionId : undefined} status={copyFeedback} focusOnOpen={zoom.viewport} onClose={onClose} onKeyDown={event => { zoom.onKeyDown(event) }}
    controls={<>
        <button type="button" className="rich-code__copy tt-focusable" aria-label={t`Zoom out`} title={t`Zoom out (−)`} aria-disabled={zoom.atSmallest} onClick={zoom.zoomOut}><ZoomOut size={16} aria-hidden="true" /></button>
        <output className="rich-diagram-viewer__zoom" aria-label={t`Zoom`}>{zoom.percent}</output>
        <button type="button" className="rich-code__copy tt-focusable" aria-label={t`Zoom in`} title={t`Zoom in (+)`} aria-disabled={zoom.atLargest} onClick={zoom.zoomIn}><ZoomIn size={16} aria-hidden="true" /></button>
        <button type="button" className="rich-code__copy tt-focusable" aria-label={t`Fit to window`} title={t`Fit (0)`} aria-pressed={zoom.view.fitted} onClick={zoom.reset}><Scan size={16} aria-hidden="true" /></button>
        <span className="rich-diagram-viewer__divider" aria-hidden="true" />
        <button type="button" className="rich-code__copy tt-focusable" data-copied={copied || undefined} aria-label={t`Copy diagram source`} title={t`Copy source`} onClick={onCopy}>
          {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
        </button>
        <button type="button" className="rich-code__copy tt-focusable" aria-label={t`Close diagram`} title={t`Close (Esc)`} onClick={onClose}><X size={17} aria-hidden="true" /></button>
    </>}>
    <div ref={zoom.viewport} className="rich-diagram-viewer__viewport" tabIndex={0} role="group" aria-label={t`Diagram view`} aria-describedby={hintId} {...zoom.viewportProps}>
      <DiagramImage className="rich-diagram-viewer__image" src={dataUrl} alt={name} {...zoom.pictureStyle} />
      {description && <p id={descriptionId} className="tt-visually-hidden">{description}</p>}
    </div>
    <p id={hintId} className="rich-diagram-viewer__hint tt-paragraph">{t`Drag or use arrow keys to move · Scroll or +/− to zoom · 0 to fit`}</p>
  </ViewerDialog>
}
