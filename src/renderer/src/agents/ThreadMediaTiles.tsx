import React, { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ImageIcon } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'
import { plural } from '@lingui/core/macro'
import type { AgentActivity, AgentActivityMedia } from '../../../shared/agentActivity'
import { AttachmentViewer, type ViewerImage } from './AttachmentViewer'
import type { ActivityGroup } from './threadActivityView'
import { useThreadMediaSource, type ThreadMediaOrigin } from './threadMediaSources'
import { useOwlFeature } from '../state/owlFeature'

/** One picture as a tile and the viewer know it: its handle and where it is found. */
interface Shown { readonly origin: ThreadMediaOrigin; readonly media: AgentActivityMedia; readonly record: AgentActivity }

const TYPE_NAMES: Record<AgentActivityMedia['mimeType'], string> = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/gif': 'GIF', 'image/webp': 'WebP' }
/** "PNG · 1280×800": what a tile says under its name. */
export function mediaDetails(media: AgentActivityMedia): string {
  return [TYPE_NAMES[media.mimeType], media.width && media.height ? `${media.width}×${media.height}` : null].filter(Boolean).join(' · ')
}

/**
 * Each scroller's one observer, shared by all its tiles: a tile is near when it is within a screen and a half of what is in
 * view, and only a near tile holds its picture (ADR-0170). A tile scrolled further away lets go of it.
 */
const observers = new WeakMap<Element, { observer: IntersectionObserver; listeners: Map<Element, (near: boolean) => void> }>()
function watchNear(element: Element, listener: (near: boolean) => void): () => void {
  const root = element.closest('.thread-workspace__transcript')
  if (typeof IntersectionObserver === 'undefined') { listener(true); return () => undefined }
  const key = root ?? document.documentElement
  let entry = observers.get(key)
  if (!entry) {
    const listeners = new Map<Element, (near: boolean) => void>()
    const observer = new IntersectionObserver(changes => { for (const change of changes) listeners.get(change.target)?.(change.isIntersecting) },
      { root, rootMargin: '150% 0px' })
    entry = { observer, listeners }
    observers.set(key, entry)
  }
  const held = entry
  held.listeners.set(element, listener)
  held.observer.observe(element)
  return () => { held.observer.unobserve(element); held.listeners.delete(element) }
}

/** "Picture 2": a picture's name on its tile and in the viewer, by its place among the turn's pictures. */
function pictureName(t: ReturnType<typeof useLingui>['t'], number: number): string {
  return t({ message: `Picture ${number}`, comment: '{number} is the place of an agent\'s picture among the pictures of one turn.' })
}

function MediaTile({ shown, index, count, onOpen }: {
  readonly shown: Shown; readonly index: number; readonly count: number; readonly onOpen: (from: HTMLElement) => void
}): ReactNode {
  const { t } = useLingui()
  const frame = useRef<HTMLButtonElement>(null)
  const [near, setNear] = useState(false)
  useEffect(() => frame.current ? watchNear(frame.current, setNear) : undefined, [])
  const { source, awaiting } = useThreadMediaSource(shown.origin, 'tile', near)
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [source])
  const number = index + 1
  const name = pictureName(t, number)
  const details = mediaDetails(shown.media)
  const missing = near && !awaiting && (source === null || failed)
  return <figure className="rich-attachment rich-attachment--image thread-media" role="listitem" data-media-id={shown.media.id}>
    <button type="button" ref={frame} className="rich-attachment__frame tt-focusable"
      aria-label={t({ message: `Open picture ${number} of ${count}, from ${shown.record.title}`, comment: '{number} of {count} pictures in a turn; {title} names the step that made it.' })}
      title={t`Open picture`} onClick={event => onOpen(event.currentTarget)}>
      {source && !failed ? <img src={source} alt="" decoding="async" draggable={false} onError={() => setFailed(true)} />
        : <ImageIcon size={18} aria-hidden="true" className="thread-media__placeholder" />}
    </button>
    <figcaption><span className="rich-attachment__name" title={shown.record.title}>{name}</span>
      <span className="rich-attachment__meta">{missing ? t`No longer kept on this computer` : details}</span></figcaption>
  </figure>
}

/**
 * The pictures a turn's agent made or looked at (ADR-0170), as tiles under its work, whether its steps are open or folded.
 * A press opens the viewer over the pane, where ← and → step through the turn's pictures. Nothing shows while the
 * `inline-media` Owl feature is off, and a turn with no pictures draws nothing.
 */
export const ThreadMediaTiles = memo(function ThreadMediaTiles({ groups, threadId }: {
  readonly groups: readonly ActivityGroup[] | undefined; readonly threadId: string | undefined
}): ReactNode {
  const { t } = useLingui()
  const enabled = useOwlFeature('inline-media')
  const pictures = useMemo<readonly Shown[]>(() => !enabled || !threadId || !groups ? [] : groups.flatMap(group => group.records.flatMap(record =>
    (record.media ?? []).map(media => ({ media, record, origin: { threadId, activityId: record.id, mediaId: media.id } })))), [enabled, groups, threadId])
  const [open, setOpen] = useState<{ readonly id: string; readonly from: HTMLElement } | null>(null)
  const images = useMemo<readonly ViewerImage[]>(() => pictures.map((picture, index) => ({ id: `${picture.record.id}/${picture.media.id}`,
    name: pictureName(t, index + 1), details: mediaDetails(picture.media), media: picture.origin })), [pictures, t])
  if (!pictures.length) return null
  return <div className="rich-attachments thread-media-tiles">
    <div className="rich-attachments__list" role="list" aria-label={plural(pictures.length, { one: 'Picture', other: '# pictures' })}>
      {pictures.map((picture, index) => <MediaTile key={`${picture.record.id}/${picture.media.id}`} shown={picture} index={index} count={pictures.length}
        onOpen={from => setOpen({ id: `${picture.record.id}/${picture.media.id}`, from })} />)}
    </div>
    {open ? <AttachmentViewer images={images} origin={undefined} startId={open.id} anchor={open.from} onClose={() => setOpen(null)} /> : null}
  </div>
})
