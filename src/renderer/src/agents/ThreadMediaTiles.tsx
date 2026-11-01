import React, { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ImageIcon } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'
import { plural } from '@lingui/core/macro'
import type { AgentActivity, AgentActivityMedia } from '../../../shared/agentActivity'
import { AttachmentViewer, type ViewerImage } from './AttachmentViewer'
import type { ActivityGroup } from './threadActivityView'
import { useThreadMediaSource, watchNear, type ThreadMediaOrigin } from './threadMediaSources'
import { useOwlFeature } from '../state/owlFeature'
import { OwlEasel } from './OwlEasel'

/** One picture as a tile and the viewer know it: its handle and where it is found. */
interface Shown { readonly origin: ThreadMediaOrigin; readonly media: AgentActivityMedia; readonly record: AgentActivity }

const TYPE_NAMES: Record<AgentActivityMedia['mimeType'], string> = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/gif': 'GIF', 'image/webp': 'WebP' }
/** "PNG · 1280×800": what a tile says under its name. */
export function mediaDetails(media: AgentActivityMedia): string {
  return [TYPE_NAMES[media.mimeType], media.width && media.height ? `${media.width}×${media.height}` : null].filter(Boolean).join(' · ')
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
  const { source, awaiting, failed: unread } = useThreadMediaSource(shown.origin, 'tile', near)
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [source])
  const number = index + 1
  const name = pictureName(t, number)
  const details = mediaDetails(shown.media)
  // A read that failed is tried again when the tile next comes near; a picture its host no longer keeps is gone.
  const status = !near || awaiting ? null : unread || failed ? t`Could not load. Nothing was lost. Scroll back to it to try again.`
    : source === null ? t`No longer kept on its computer` : null
  return <figure className="rich-attachment rich-attachment--image thread-media" role="listitem" data-media-id={shown.media.id}>
    <button type="button" ref={frame} className="rich-attachment__frame tt-focusable"
      aria-label={t({ message: `Open picture ${number} of ${count}, from ${shown.record.title}`, comment: '{number} of {count} pictures in a turn; {title} names the step that made it.' })}
      title={t`Open picture`} onClick={event => onOpen(event.currentTarget)}>
      {source && !failed ? <img src={source} alt="" decoding="async" draggable={false} onError={() => setFailed(true)} />
        : <ImageIcon size={18} aria-hidden="true" className="thread-media__placeholder" />}
    </button>
    <figcaption><span className="rich-attachment__name" title={shown.record.title}>{name}</span>
      <span className="rich-attachment__meta">{status ?? details}</span></figcaption>
  </figure>
}

/** A step making an image that has not landed yet: the owl at the easel in the picture's place (ADR-0170). */
function MakingTile({ record }: { readonly record: AgentActivity }): ReactNode {
  const { t } = useLingui()
  // Started when the step says it did, or when this tile first saw it.
  const [startedAt] = useState(() => Date.parse(record.startedAt ?? '') || Date.now())
  return <figure className="rich-attachment rich-attachment--image thread-media thread-media--making" role="listitem">
    <div className="rich-attachment__frame thread-media__making" role="img" aria-label={t`Making the image`}>
      <OwlEasel startedAt={startedAt} />
    </div>
    <figcaption><span className="rich-attachment__name" title={record.title}>{t`Making the image`}</span>
      <span className="rich-attachment__meta">{t`It shows here when it is done`}</span></figcaption>
  </figure>
}

/** Whether a step is making an image that has not landed: it runs and holds no picture yet. */
const making = (record: AgentActivity): boolean => record.generates === 'image' && record.status === 'running' && !record.media?.length

/**
 * The pictures a turn's agent made or looked at (ADR-0170), as tiles under its work, whether its steps are open or folded.
 * A press opens the viewer over the pane, where ← and → step through the turn's pictures. A step still making an image
 * shows the owl at the easel in its place. Nothing shows while the `inline-media` Owl feature is off, and a turn with no
 * pictures draws nothing.
 */
export const ThreadMediaTiles = memo(function ThreadMediaTiles({ groups, threadId }: {
  readonly groups: readonly ActivityGroup[] | undefined; readonly threadId: string | undefined
}): ReactNode {
  const { t } = useLingui()
  const enabled = useOwlFeature('inline-media')
  const pictures = useMemo<readonly Shown[]>(() => !enabled || !threadId || !groups ? [] : groups.flatMap(group => group.records.flatMap(record =>
    (record.media ?? []).map(media => ({ media, record, origin: { threadId, activityId: record.id, mediaId: media.id } })))), [enabled, groups, threadId])
  const makers = useMemo<readonly AgentActivity[]>(() => !enabled || !groups ? [] : groups.flatMap(group => group.records.filter(making)), [enabled, groups])
  const [open, setOpen] = useState<{ readonly id: string; readonly from: HTMLElement } | null>(null)
  const images = useMemo<readonly ViewerImage[]>(() => pictures.map((picture, index) => ({ id: `${picture.record.id}/${picture.media.id}`,
    name: pictureName(t, index + 1), details: mediaDetails(picture.media), media: picture.origin })), [pictures, t])
  if (!pictures.length && !makers.length) return null
  const count = pictures.length + makers.length
  return <div className="rich-attachments thread-media-tiles">
    <div className="rich-attachments__list" role="list" aria-label={plural(count, { one: 'Picture', other: '# pictures' })}>
      {pictures.map((picture, index) => <MediaTile key={`${picture.record.id}/${picture.media.id}`} shown={picture} index={index} count={pictures.length}
        onOpen={from => setOpen({ id: `${picture.record.id}/${picture.media.id}`, from })} />)}
      {makers.map(record => <MakingTile key={`${record.id}/making`} record={record} />)}
    </div>
    {open ? <AttachmentViewer images={images} origin={undefined} startId={open.id} anchor={open.from} onClose={() => setOpen(null)} /> : null}
  </div>
})
