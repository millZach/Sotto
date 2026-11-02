import React, { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, PenLine, Scan, X, ZoomIn, ZoomOut } from 'lucide-react'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import type { AgentAttachmentReference } from '../../../shared/agents'
import { useAttachmentSource, type AttachmentOrigin } from './attachmentSources'
import { useThreadMediaSource, watchNear, type ThreadMediaOrigin } from './threadMediaSources'
import { usePanZoom } from './diagrams/usePanZoom'
import { chordClaimed, chordMatches } from './branchToolbar.logic'
import { useOptionalApp } from '../state/AppContext'
import type { SottoPlatform } from '../../../shared/platform'
import { useCopyImage } from './richActions'
import { shownCount } from '../state/interfaceNumbers'
import { useOwlFeature } from '../state/owlFeature'
import { useReplyAttach } from './replyAttach'
import { MarkupEditor } from './MarkupEditor'
import './diagrams/diagrams.css'

export interface ViewerImage extends Partial<Pick<AgentAttachmentReference, 'preview'>> {
  readonly id: string
  /** The name as the tile shows it. */
  readonly name: string
  /** Type and size, e.g. "PNG · 449 KB". */
  readonly details: string
  /** A picture an agent made, read by its handle rather than from a message (ADR-0170). */
  readonly media?: ThreadMediaOrigin | undefined
}

/** The image to draw: a sent attachment's, read by its message, or an agent's picture, read by its handle. */
function useViewerSource(image: ViewerImage, origin: AttachmentOrigin | undefined, size: 'tile' | 'full', wanted = true): { readonly source: string | null; readonly awaiting: boolean } {
  const attachment = useAttachmentSource(image.media ? { id: image.id } : image, image.media ? undefined : origin)
  const media = useThreadMediaSource(image.media, size, image.media !== undefined && wanted)
  return image.media ? media : attachment
}

/** One image of the strip under the viewer, which shows where the viewer is among the message's images. */
function StripThumb({ image, origin, index, count, current, onSelect }: {
  readonly image: ViewerImage; readonly origin: AttachmentOrigin | undefined; readonly index: number; readonly count: number
  readonly current: boolean; readonly onSelect: (index: number) => void
}): ReactNode {
  const { t } = useLingui()
  // An agent's picture in the strip is read only once its thumb is near view, as a tile's is (ADR-0170).
  const thumb = useRef<HTMLButtonElement>(null)
  const [near, setNear] = useState(image.media === undefined)
  useEffect(() => image.media !== undefined && thumb.current ? watchNear(thumb.current, setNear) : undefined, [image.media])
  const { source } = useViewerSource(image, origin, 'tile', near)
  const name = image.name, number = index + 1
  return <button type="button" ref={thumb} className="attachment-viewer__thumb tt-focusable" aria-label={t({ message: `Show ${name}, ${{ number: shownCount(number) }} of ${{ count: shownCount(count) }}`, comment: '{name} is the file name of an image.' })}
    aria-current={current || undefined} data-index={index} onClick={() => onSelect(index)}>
    {source ? <img src={source} alt="" decoding="async" draggable={false} /> : null}
  </button>
}

/**
 * A message's images, large, over the thread pane they were sent in (the window when there is no pane): zoom, pan,
 * Copy image and Close, from the keyboard or the pointer. With more than one image a strip under it steps between
 * them, as do ← and →. Escape closes it, and focus returns to the image that opened it. In a thread pane, with
 * inline media on, Mark up opens the picture in the mark-up editor, whose marked copy goes into the pane's reply box
 * (ADR-0170, part 5).
 */
export function AttachmentViewer({ images, origin, startId, anchor, onClose }: {
  readonly images: readonly ViewerImage[]
  readonly origin: AttachmentOrigin | undefined
  readonly startId: string
  /** The tile that opened the viewer; its pane is where the viewer opens. */
  readonly anchor: HTMLElement
  readonly onClose: () => void
}): ReactNode {
  const { t } = useLingui()
  const [index, setIndex] = useState(() => Math.max(0, images.findIndex(image => image.id === startId)))
  const image = images[Math.min(index, images.length - 1)]!
  const { source, awaiting } = useViewerSource(image, origin, 'full')
  // The image's own size, read once it loads, and kept with the image it belongs to.
  const [measured, setMeasured] = useState<{ readonly id: string; readonly width: number; readonly height: number } | null>(null)
  const size = measured?.id === image.id ? measured : null
  // A screenshot is shown no larger than it is when it fits; zooming in is still possible.
  const zoom = usePanZoom(size?.width ?? 0, size?.height ?? 0, 1)
  const [feedback, copyImage, say, copied] = useCopyImage()
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
  // Mark up, where a reply box can take the marked copy: only inside a thread pane.
  const reply = useReplyAttach()
  const marks = useOwlFeature('inline-media') && reply !== null
  const [editing, setEditing] = useState(false)
  const [markRefusal, setMarkRefusal] = useState<string | null>(null)
  const markButton = useRef<HTMLButtonElement>(null)
  useEffect(() => { setMarkRefusal(null) }, [image.id])

  // Everything else in the pane is out of reach while the viewer covers it, so Tab stays inside, including what
  // the pane adds while it is open.
  useLayoutEffect(() => {
    const host = root.current
    if (!host) return
    // The pane never scrolls on purpose; a stray offset would leave the viewer above the part in view.
    if (inPane) { container.scrollTop = 0; container.scrollLeft = 0 }
    const quieted = new Set<HTMLElement>()
    const quiet = (element: Element): void => {
      if (!(element instanceof HTMLElement) || element === host || element.inert) return
      element.inert = true
      quieted.add(element)
    }
    for (const element of container.children) quiet(element)
    const observer = typeof MutationObserver === 'undefined' ? null
      : new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) if (node instanceof Element) quiet(node) })
    observer?.observe(container, { childList: true })
    zoom.viewport.current?.focus({ preventScroll: true })
    return () => {
      observer?.disconnect()
      for (const element of quieted) element.inert = false
      // Only once the pane is reachable again can the image that opened the viewer take focus back, and only when
      // the focus was still the viewer's: a viewer that goes with its pane leaves focus where it is.
      const focused = document.activeElement
      if (anchor.isConnected && (focused === null || focused === document.body || host.contains(focused))) anchor.focus({ preventScroll: true })
    }
  }, [container, inPane, anchor, zoom.viewport])

  // Another image opens fitted, whatever the last one was zoomed to.
  const reset = useRef(zoom.reset)
  reset.current = zoom.reset
  useEffect(() => { reset.current() }, [image.id])

  const select = (next: number, focusStrip = false): void => {
    const wrapped = (next + images.length) % images.length
    setIndex(wrapped)
    if (focusStrip) strip.current?.querySelector<HTMLElement>(`[data-index="${wrapped}"]`)?.focus()
  }
  const copy = (): void => {
    if (source) copyImage(source)
    else say(awaiting ? msg`The image is still loading. Try again in a moment.` : msg`This image is no longer available to copy.`)
  }

  const markUp = (): void => {
    if (!source || !size) { say(awaiting ? msg`The image is still loading. Try again in a moment.` : msg`This image is no longer available to mark up.`); return }
    const refusal = reply?.current?.refusal() ?? (reply?.current ? null : t`This pane has no reply box to take a marked copy.`)
    setMarkRefusal(refusal)
    if (!refusal) setEditing(true)
  }
  const keepFocusIn = (event: React.KeyboardEvent): void => {
    const focusable = [...(root.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]') ?? [])]
    const first = focusable[0]; const last = focusable.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    // The editor answers its own keys; only Tab is kept inside the viewer.
    if (editing) { if (event.key === 'Tab') keepFocusIn(event); return }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
    if (marks && (event.key === 'm' || event.key === 'M') && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); markUp(); return }
    if (copyChord && chordMatches(event, copyChord, platform) && !window.getSelection()?.toString()) {
      // A held chord copies once.
      if (event.repeat) { event.preventDefault(); return }
      event.preventDefault(); copy(); return
    }
    const inStrip = strip.current?.contains(event.target as Node) === true
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    // With several images ← and → step through them, zoomed or not; dragging and ↑ ↓ still move a zoomed one.
    if (several && step !== 0 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault(); select(index + step, inStrip); return
    }
    if (event.key === 'Tab') { keepFocusIn(event); return }
    if (!inStrip) zoom.onKeyDown(event)
  }

  const number = index + 1, total = images.length
  const position = several ? ` · ${t({ message: `${{ number: shownCount(number) }} of ${{ total: shownCount(total) }}`, comment: 'Which image of the message this is.' })}` : ''
  const chord = platform === 'darwin' ? 'Command+C' : 'Ctrl+C'
  if (editing && source && size && reply?.current) {
    const target = reply.current
    return createPortal(<div ref={root} className="attachment-viewer" data-scope={inPane ? 'pane' : 'window'} role="dialog" aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <span id={titleId} hidden>{t({ message: `Mark up ${image.name}`, comment: '{name} is the file name of a picture.' })}</span>
      <MarkupEditor name={image.name} source={source} size={size} reply={target}
        onCancel={() => { setEditing(false); requestAnimationFrame(() => markButton.current?.focus()) }}
        onAdded={() => { onClose(); setTimeout(() => target.focus(), 0) }} />
    </div>, container)
  }
  return createPortal(<div ref={root} className="attachment-viewer" data-scope={inPane ? 'pane' : 'window'} role="dialog" aria-labelledby={titleId} onKeyDown={onKeyDown}>
    <header className="attachment-viewer__bar">
      <h2 id={titleId} className="attachment-viewer__title">{image.name}<span className="attachment-viewer__details">{image.details}{position}</span></h2>
      <span className="rich-code__status" role="status" aria-live="polite">{feedback}</span>
      <div className="rich-diagram-viewer__controls">
        <button type="button" className="rich-code__copy tt-focusable" aria-label={t`Zoom out`} title={t`Zoom out (−)`} aria-disabled={zoom.atSmallest} onClick={zoom.zoomOut}><ZoomOut size={16} aria-hidden="true" /></button>
        <output className="rich-diagram-viewer__zoom" aria-label={t`Zoom`}>{zoom.percent}</output>
        <button type="button" className="rich-code__copy tt-focusable" aria-label={t`Zoom in`} title={t`Zoom in (+)`} aria-disabled={zoom.atLargest} onClick={zoom.zoomIn}><ZoomIn size={16} aria-hidden="true" /></button>
        <button type="button" className="rich-code__copy tt-focusable" aria-label={t`Fit to view`} title={t`Fit (0)`} aria-pressed={zoom.view.fitted} onClick={zoom.reset}><Scan size={16} aria-hidden="true" /></button>
        <span className="rich-diagram-viewer__divider" aria-hidden="true" />
        {marks ? <button ref={markButton} type="button" className="rich-code__copy attachment-viewer__copy tt-focusable" title={t`Mark up (M)`} aria-disabled={!source || !size} onClick={markUp}>
          <PenLine size={16} aria-hidden="true" /><span>{t`Mark up`}</span>
        </button> : null}
        <button type="button" className="rich-code__copy attachment-viewer__copy tt-focusable" data-copied={copied || undefined} title={copyChord ? t`Copy image (${chord})` : t`Copy image`}
          aria-disabled={!source} onClick={copy}>
          {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}<span>{t`Copy image`}</span>
        </button>
        <button type="button" className="rich-code__copy tt-focusable" aria-label={t`Close image`} title={t`Close (Esc)`} onClick={onClose}><X size={17} aria-hidden="true" /></button>
      </div>
    </header>
    <div ref={zoom.viewport} className="rich-diagram-viewer__viewport" tabIndex={0} role="group" aria-label={t`Image view`} aria-describedby={hintId} {...zoom.viewportProps}>
      {source
        ? <img key={image.id} className="rich-diagram-viewer__image" src={source} alt={image.name} draggable={false} decoding="async" {...zoom.pictureStyle}
          onLoad={event => setMeasured({ id: image.id, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
        : <p className="attachment-viewer__missing tt-paragraph">{awaiting ? t`Loading the image…` : t`This image is no longer available to show.`}</p>}
    </div>
    {several ? <div ref={strip} className="attachment-viewer__strip" role="group" aria-label={t`Images in this message`}>
      {images.map((item, itemIndex) => <StripThumb key={item.id} image={item} origin={origin} index={itemIndex} count={images.length} current={itemIndex === index} onSelect={select} />)}
    </div> : null}
    {markRefusal ? <p className="attachment-viewer__refusal tt-paragraph" role="alert">{markRefusal}</p> : null}
    <p id={hintId} className="rich-diagram-viewer__hint tt-paragraph">{several
      ? t`Drag to move · Scroll or +/− to zoom · 0 to fit · ← → for the next image`
      : t`Drag or use arrow keys to move · Scroll or +/− to zoom · 0 to fit`}</p>
  </div>, container)
}
