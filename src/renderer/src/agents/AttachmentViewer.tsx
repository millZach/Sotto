import React, { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, Scan, X, ZoomIn, ZoomOut } from 'lucide-react'
import type { AgentAttachmentReference } from '../../../shared/agents'
import { useAttachmentSource, type AttachmentOrigin } from './attachmentSources'
import { usePanZoom } from './diagrams/usePanZoom'
import { chordClaimed, chordMatches } from './branchToolbar.logic'
import { useOptionalApp } from '../state/AppContext'
import type { SottoPlatform } from '../../../shared/platform'
import { COPIED_IMAGE, useCopyImage } from './richActions'
import './diagrams/diagrams.css'

export interface ViewerImage extends Partial<Pick<AgentAttachmentReference, 'preview'>> {
  readonly id: string
  /** The name as the tile shows it. */
  readonly name: string
  /** Type and size, e.g. "PNG · 449 KB". */
  readonly details: string
}

/** One image of the strip under the viewer, which shows where the viewer is among the message's images. */
function StripThumb({ image, origin, index, count, current, onSelect }: {
  readonly image: ViewerImage; readonly origin: AttachmentOrigin | undefined; readonly index: number; readonly count: number
  readonly current: boolean; readonly onSelect: (index: number) => void
}): ReactNode {
  const { source } = useAttachmentSource(image, origin)
  return <button type="button" className="attachment-viewer__thumb tt-focusable" aria-label={`Show ${image.name}, ${index + 1} of ${count}`}
    aria-current={current || undefined} data-index={index} onClick={() => onSelect(index)}>
    {source ? <img src={source} alt="" decoding="async" draggable={false} /> : null}
  </button>
}

/**
 * A message's images, large, over the thread pane they were sent in (the window when there is no pane): zoom, pan,
 * Copy image and Close, from the keyboard or the pointer. With more than one image a strip under it steps between
 * them, as do ← and →. Escape closes it, and focus returns to the image that opened it.
 */
export function AttachmentViewer({ images, origin, startId, anchor, onClose }: {
  readonly images: readonly ViewerImage[]
  readonly origin: AttachmentOrigin | undefined
  readonly startId: string
  /** The tile that opened the viewer; its pane is where the viewer opens. */
  readonly anchor: HTMLElement
  readonly onClose: () => void
}): ReactNode {
  const [index, setIndex] = useState(() => Math.max(0, images.findIndex(image => image.id === startId)))
  const image = images[Math.min(index, images.length - 1)]!
  const { source, awaiting } = useAttachmentSource(image, origin)
  // The image's own size, read once it loads, and kept with the image it belongs to.
  const [measured, setMeasured] = useState<{ readonly id: string; readonly width: number; readonly height: number } | null>(null)
  const size = measured?.id === image.id ? measured : null
  // A screenshot is shown no larger than it is when it fits; zooming in is still possible.
  const zoom = usePanZoom(size?.width ?? 0, size?.height ?? 0, 1)
  const [feedback, copyImage] = useCopyImage()
  const root = useRef<HTMLDivElement>(null)
  const strip = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const hintId = useId()
  const [container] = useState<HTMLElement>(() => anchor.closest<HTMLElement>('.thread-pane') ?? document.body)
  const inPane = container !== document.body
  const several = images.length > 1
  // Ctrl+C (Command+C) copies the image unless it is the dictation hotkey, which then keeps it.
  const app = useOptionalApp()
  const platform: SottoPlatform = app?.platform ?? ((window.sotto as { platform?: SottoPlatform } | undefined)?.platform ?? 'win32')
  const copyChord = chordClaimed('mod+c', app?.settings?.hotkey, platform) ? 'mod+c' : null

  // Everything else in the pane is out of reach while the viewer covers it, so Tab stays inside.
  useLayoutEffect(() => {
    const host = root.current
    if (!host) return
    const quieted = [...container.children].filter((element): element is HTMLElement => element instanceof HTMLElement && element !== host && !element.inert)
    for (const element of quieted) element.inert = true
    zoom.viewport.current?.focus({ preventScroll: true })
    return () => {
      for (const element of quieted) element.inert = false
      // Only once the pane is reachable again can the image that opened the viewer take focus back.
      anchor.focus({ preventScroll: true })
    }
  }, [container, anchor, zoom.viewport])

  // Another image opens fitted, whatever the last one was zoomed to.
  const reset = useRef(zoom.reset)
  reset.current = zoom.reset
  useEffect(() => { reset.current() }, [image.id])

  const select = (next: number, focusStrip = false): void => {
    const wrapped = (next + images.length) % images.length
    setIndex(wrapped)
    if (focusStrip) strip.current?.querySelector<HTMLElement>(`[data-index="${wrapped}"]`)?.focus()
  }
  const copy = (): void => { if (source) copyImage(source) }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
    if (copyChord && chordMatches(event, copyChord, platform) && !window.getSelection()?.toString()) {
      event.preventDefault(); copy(); return
    }
    const inStrip = strip.current?.contains(event.target as Node) === true
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    // With several images ← and → step through them, zoomed or not; dragging and ↑ ↓ still move a zoomed one.
    if (several && step !== 0 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault(); select(index + step, inStrip); return
    }
    if (event.key === 'Tab') {
      const focusable = [...(root.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]') ?? [])]
      const first = focusable[0]; const last = focusable.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      return
    }
    if (!inStrip) zoom.onKeyDown(event)
  }

  const copied = feedback === COPIED_IMAGE
  const position = several ? ` · ${index + 1} of ${images.length}` : ''
  return createPortal(<div ref={root} className="attachment-viewer" data-scope={inPane ? 'pane' : 'window'} role="dialog" aria-labelledby={titleId} onKeyDown={onKeyDown}>
    <header className="attachment-viewer__bar">
      <h2 id={titleId} className="attachment-viewer__title">{image.name}<span className="attachment-viewer__details">{image.details}{position}</span></h2>
      <span className="rich-code__status" role="status" aria-live="polite">{feedback}</span>
      <div className="rich-diagram-viewer__controls">
        <button type="button" className="rich-code__copy tt-focusable" aria-label="Zoom out" title="Zoom out (−)" aria-disabled={zoom.atSmallest} onClick={zoom.zoomOut}><ZoomOut size={16} aria-hidden="true" /></button>
        <output className="rich-diagram-viewer__zoom" aria-label="Zoom">{zoom.percent}</output>
        <button type="button" className="rich-code__copy tt-focusable" aria-label="Zoom in" title="Zoom in (+)" aria-disabled={zoom.atLargest} onClick={zoom.zoomIn}><ZoomIn size={16} aria-hidden="true" /></button>
        <button type="button" className="rich-code__copy tt-focusable" aria-label="Fit to view" title="Fit (0)" aria-pressed={zoom.view.fitted} onClick={zoom.reset}><Scan size={16} aria-hidden="true" /></button>
        <span className="rich-diagram-viewer__divider" aria-hidden="true" />
        <button type="button" className="rich-code__copy attachment-viewer__copy tt-focusable" data-copied={copied || undefined} title={copyChord ? `Copy image (${platform === 'darwin' ? 'Command+C' : 'Ctrl+C'})` : 'Copy image'}
          aria-disabled={!source} onClick={copy}>
          {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}<span>Copy image</span>
        </button>
        <button type="button" className="rich-code__copy tt-focusable" aria-label="Close image" title="Close (Esc)" onClick={onClose}><X size={17} aria-hidden="true" /></button>
      </div>
    </header>
    <div ref={zoom.viewport} className="rich-diagram-viewer__viewport" tabIndex={0} role="group" aria-label="Image view" aria-describedby={hintId} {...zoom.viewportProps}>
      {source
        ? <img key={image.id} className="rich-diagram-viewer__image" src={source} alt={image.name} draggable={false} decoding="async" {...zoom.pictureStyle}
          onLoad={event => setMeasured({ id: image.id, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
        : <p className="attachment-viewer__missing">{awaiting ? 'Loading the image…' : 'This image is no longer available to show.'}</p>}
    </div>
    {several ? <div ref={strip} className="attachment-viewer__strip" role="group" aria-label="Images in this message">
      {images.map((item, itemIndex) => <StripThumb key={item.id} image={item} origin={origin} index={itemIndex} count={images.length} current={itemIndex === index} onSelect={select} />)}
    </div> : null}
    <p id={hintId} className="rich-diagram-viewer__hint">{several
      ? 'Drag to move · Scroll or +/− to zoom · 0 to fit · ← → for the next image'
      : 'Drag or use arrow keys to move · Scroll or +/− to zoom · 0 to fit'}</p>
  </div>, container)
}
