import React, { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Film, ImageIcon, Pause, Play } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'
import { plural } from '@lingui/core/macro'
import { WRITTEN_STEP_PREFIX, type AgentActivity, type AgentActivityMedia } from '../../../shared/agentActivity'
import { AttachmentViewer, type ViewerImage } from './AttachmentViewer'
import type { ActivityGroup } from './threadActivityView'
import { countVideoLoad, useThreadMediaSource, watchNear, watchOnScreen, type ThreadMediaOrigin } from './threadMediaSources'
import { threadVideoUrl } from '../../../shared/threadVideoUrl'
import { formatAttachmentSize } from '../../../shared/attachmentLabels'
import { useOwlFeature } from '../state/owlFeature'
import { OwlEasel } from './OwlEasel'

/** One picture as a tile and the viewer know it: its handle and where it is found. */
interface Shown { readonly origin: ThreadMediaOrigin; readonly media: AgentActivityMedia; readonly record: AgentActivity }

const TYPE_NAMES: Record<AgentActivityMedia['mimeType'], string> = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/gif': 'GIF', 'image/webp': 'WebP',
  'video/mp4': 'MP4', 'video/webm': 'WebM', 'video/quicktime': 'QuickTime' }
/** "PNG · 1280×800", or for a video, whose pixels are never read, "WebM · 14 MB" in a sent file's size words: what a tile says under its name. */
export function mediaDetails(media: AgentActivityMedia): string {
  const measure = media.kind === 'video' ? formatAttachmentSize(media.sizeBytes) : media.width && media.height ? `${media.width}×${media.height}` : null
  return [TYPE_NAMES[media.mimeType], measure].filter(Boolean).join(' · ')
}


/** The name of the step a picture came from: the host's words, or this window's for a step Sotto made itself. */
function stepTitle(t: ReturnType<typeof useLingui>['t'], record: AgentActivity): string {
  return record.id.startsWith(WRITTEN_STEP_PREFIX)
    ? t({ message: 'Pictures and videos it wrote', comment: 'The step that holds the pictures and videos an agent wrote in its folder during a turn.' }) : record.title
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
  // A GIF shows its first frame, still, until it is played; it plays only on screen, and stops the moment it leaves.
  const gif = shown.media.mimeType === 'image/gif'
  const [playing, setPlaying] = useState(false)
  useEffect(() => gif && frame.current ? watchOnScreen(frame.current, shown => { if (!shown) setPlaying(false) }) : undefined, [gif])
  const still = useThreadMediaSource(shown.origin, 'tile', near)
  const moving = useThreadMediaSource(shown.origin, 'full', near && playing)
  const { source, awaiting, failed: unread } = playing && moving.source ? moving : still
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
      aria-label={t({ message: `Open picture ${number} of ${count}, from ${stepTitle(t, shown.record)}`, comment: '{number} of {count} pictures in a turn; {title} names the step that made it.' })}
      title={t`Open picture`} onClick={event => onOpen(event.currentTarget)}>
      {source && !failed ? <img src={source} alt="" decoding="async" draggable={false} onError={() => setFailed(true)} />
        : <ImageIcon size={18} aria-hidden="true" className="thread-media__placeholder" />}
    </button>
    {gif && source && !failed ? <button type="button" className="thread-media__play thread-media__play--corner tt-focusable" aria-pressed={playing}
      aria-label={playing ? t({ message: `Stop GIF ${number}`, comment: '{number} is the place of an agent\'s GIF among the pictures of one turn.' })
        : t({ message: `Play GIF ${number}`, comment: '{number} is the place of an agent\'s GIF among the pictures of one turn.' })}
      onClick={() => setPlaying(now => !now)}>{playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}</button> : null}
    <figcaption><span className="rich-attachment__name" title={stepTitle(t, shown.record)}>{name}</span>
      <span className="rich-attachment__meta">{status ?? details}</span></figcaption>
  </figure>
}

/**
 * A video an agent wrote (ADR-0170, part 4), played in its tile from its thread's computer. Near the screen it loads
 * only enough to show its first frame; further away it lets go of it. It never plays until it is pressed, and it pauses
 * the moment it leaves the screen.
 */
function VideoTile({ shown, number, count }: { readonly shown: Shown; readonly number: number; readonly count: number }): ReactNode {
  const { t } = useLingui()
  const frame = useRef<HTMLDivElement>(null)
  const player = useRef<HTMLVideoElement>(null)
  const [near, setNear] = useState(false)
  const [started, setStarted] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => frame.current ? watchNear(frame.current, setNear) : undefined, [])
  useEffect(() => frame.current ? watchOnScreen(frame.current, shown => { if (!shown) player.current?.pause() }) : undefined, [])
  // Let go of, it starts over from its first frame when it comes near again.
  useEffect(() => { if (!near) setStarted(false) }, [near])
  const loads = near && !failed
  useEffect(() => { if (loads) countVideoLoad() }, [loads])
  const name = t({ message: `Video ${number}`, comment: '{number} is the place of an agent\'s video among the pictures and videos of one turn.' })
  const label = t({ message: `Video ${number} of ${count}, from ${stepTitle(t, shown.record)}`, comment: '{number} of {count} pictures and videos in a turn; {title} names the step that wrote it.' })
  const status = failed ? t`Could not play. The file may have changed or been removed on its computer. Ask the agent to write it again.` : null
  return <figure className="rich-attachment rich-attachment--image thread-media thread-media--video" role="listitem" data-media-id={shown.media.id}>
    <div ref={frame} className="rich-attachment__frame thread-media__video" role="group" aria-label={label}>
      {near && !failed ? <video ref={player} src={threadVideoUrl(shown.origin)} preload="metadata" playsInline controls={started} tabIndex={started ? 0 : -1} aria-label={label}
        onPlay={() => setStarted(true)} onError={() => setFailed(true)} /> : <Film size={18} aria-hidden="true" className="thread-media__placeholder" />}
      {near && !failed && !started ? <button type="button" className="thread-media__play tt-focusable"
        aria-label={t({ message: `Play video ${number}`, comment: '{number} is the place of an agent\'s video among the pictures and videos of one turn.' })}
        // The button goes once it plays, so the keyboard moves on to the player's own controls.
        onClick={() => { const video = player.current; void video?.play().then(() => video.focus(), () => setFailed(true)) }}><Play size={18} aria-hidden="true" /></button> : null}
    </div>
    <figcaption><span className="rich-attachment__name" title={shown.media.name}>{name}</span>
      <span className="rich-attachment__meta">{status ?? mediaDetails(shown.media)}</span></figcaption>
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
  const shown = useMemo<readonly Shown[]>(() => !enabled || !threadId || !groups ? [] : groups.flatMap(group => group.records.flatMap(record =>
    (record.media ?? []).map(media => ({ media, record, origin: { threadId, activityId: record.id, mediaId: media.id } })))), [enabled, groups, threadId])
  // The viewer steps through the pictures; a video plays in its own tile.
  const pictures = useMemo(() => shown.filter(item => item.media.kind === 'image'), [shown])
  const videos = useMemo(() => shown.filter(item => item.media.kind === 'video'), [shown])
  const makers = useMemo<readonly AgentActivity[]>(() => !enabled || !groups ? [] : groups.flatMap(group => group.records.filter(making)), [enabled, groups])
  const [open, setOpen] = useState<{ readonly id: string; readonly from: HTMLElement } | null>(null)
  const images = useMemo<readonly ViewerImage[]>(() => pictures.map((picture, index) => ({ id: `${picture.record.id}/${picture.media.id}`,
    name: pictureName(t, index + 1), details: mediaDetails(picture.media), media: picture.origin })), [pictures, t])
  if (!shown.length && !makers.length) return null
  const count = shown.length + makers.length
  return <div className="rich-attachments thread-media-tiles">
    <div className="rich-attachments__list" role="list" aria-label={plural(count, { one: 'Picture', other: '# pictures' })}>
      {pictures.map((picture, index) => <MediaTile key={`${picture.record.id}/${picture.media.id}`} shown={picture} index={index} count={pictures.length}
        onOpen={from => setOpen({ id: `${picture.record.id}/${picture.media.id}`, from })} />)}
      {videos.map((video, index) => <VideoTile key={`${video.record.id}/${video.media.id}`} shown={video} number={index + 1} count={videos.length} />)}
      {makers.map(record => <MakingTile key={`${record.id}/making`} record={record} />)}
    </div>
    {open ? <AttachmentViewer images={images} origin={undefined} startId={open.id} anchor={open.from} onClose={() => setOpen(null)} /> : null}
  </div>
})
