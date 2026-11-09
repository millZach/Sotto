import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Film, ImageIcon } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'
import { picturesStandInThread, WRITTEN_STEP_PREFIX, type AgentActivity } from '../../../shared/agentActivity'
import { shownCount } from '../state/interfaceNumbers'
import { AttachmentViewer, type ViewerImage } from './AttachmentViewer'
import { useThreadMediaSource, watchNear } from './threadMediaSources'
import { useOwlFeature } from '../state/owlFeature'
import { mediaDetails, pictureName, stepTitle, VideoTile, type Shown } from './ThreadMediaTiles'

/** How many of a line's pictures it shows before a count stands for the rest (Zach's pick, November 9, 2026). */
export const MOST_STEP_PICTURES = 3

/** The thread a transcript draws, and who wrote its turns, so a step's pictures can be read and their callouts named. */
export interface StepPicturesThread { readonly threadId: string; readonly who: string }
export const StepPicturesThreadContext = createContext<StepPicturesThread | null>(null)

/**
 * The records of the work around a line, its turn's or its group's, which a viewer opened from the line steps through, as
 * a turn's tiles did. Read only when a viewer opens, so a step arriving draws no line again.
 */
export interface PictureScope { records: readonly AgentActivity[] }
export const PictureScopeContext = createContext<PictureScope | null>(null)

/** A scope that stays the same object while its records change, so the lines under it are not drawn again for them. */
export function usePictureScope(records: readonly AgentActivity[]): PictureScope {
  const scope = useRef<PictureScope>({ records }).current
  useLayoutEffect(() => { scope.records = records }, [scope, records])
  return scope
}

const NONE: readonly Shown[] = []

/**
 * The pictures and videos of these records that sit in their steps, oldest first: in the order the steps came, and within a
 * step in the order it made them. A turn's written files arrive newest first (`writtenSince`), so they are turned round.
 */
export function picturesInSteps(records: readonly AgentActivity[], threadId: string): readonly Shown[] {
  let shown: Shown[] | undefined
  for (const record of records) {
    if (!record.media?.length || picturesStandInThread(record)) continue
    const media = record.id.startsWith(WRITTEN_STEP_PREFIX) ? record.media.toReversed() : record.media
    for (const item of media) (shown ??= []).push({ record, media: item, origin: { threadId, activityId: record.id, mediaId: item.id } })
  }
  return shown ?? NONE
}

/**
 * What a line shows of its pictures and what its count stands for. The newest three show, but a video comes before a
 * picture: the viewer reaches every picture of the line from any of them, and a video is reached only from its own mark.
 */
export function onTheLine(all: readonly Shown[]): { readonly shown: readonly Shown[]; readonly hidden: readonly Shown[] } {
  if (all.length <= MOST_STEP_PICTURES) return { shown: all, hidden: NONE }
  const kept = new Set<Shown>()
  for (let index = all.length - 1; index >= 0 && kept.size < MOST_STEP_PICTURES; index -= 1) if (all[index]!.media.kind === 'video') kept.add(all[index]!)
  for (let index = all.length - 1; index >= 0 && kept.size < MOST_STEP_PICTURES; index -= 1) kept.add(all[index]!)
  return { shown: all.filter(item => kept.has(item)), hidden: all.filter(item => !kept.has(item)) }
}

const keyOf = (shown: Shown): string => `${shown.record.id}/${shown.media.id}`

/** A record and every record under it, for a folded row, which shows the newest pictures of all it holds. */
export function withNested(record: AgentActivity, children: readonly { readonly record: AgentActivity; readonly children: readonly unknown[] }[]): readonly AgentActivity[] {
  if (!children.length) return [record]
  const all: AgentActivity[] = [record]
  const walk = (nodes: typeof children): void => { for (const node of nodes) { all.push(node.record); walk(node.children as typeof children) } }
  walk(children)
  return all
}

/** One of a line's pictures, small: its thumbnail is read once it comes near the screen, and a press opens the viewer. */
function Thumb({ shown, number, count, onOpen }: { readonly shown: Shown; readonly number: number; readonly count: number; readonly onOpen: (from: HTMLElement) => void }): ReactNode {
  const { t } = useLingui()
  const frame = useRef<HTMLButtonElement>(null)
  const [near, setNear] = useState(false)
  useEffect(() => frame.current ? watchNear(frame.current, setNear) : undefined, [])
  const { source } = useThreadMediaSource(shown.origin, 'tile', near)
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [source])
  const title = stepTitle(t, shown.record)
  return <button type="button" ref={frame} className="step-pictures__thumb tt-focusable" data-media-id={shown.media.id} title={t`Open picture`}
    aria-label={t({ message: `Open picture ${number} of ${count}, from ${title}`, comment: '{number} of {count} pictures an agent\'s steps made; {title} names the step that made it.' })}
    onClick={event => onOpen(event.currentTarget)}>
    {source && !failed ? <img src={source} alt="" decoding="async" draggable={false} onError={() => setFailed(true)} /> : <ImageIcon size={12} aria-hidden="true" />}
  </button>
}

/**
 * The pictures and videos a line stands for, sitting at its end (ADR-0170, pictures in steps; Zach's pick A on
 * the prototype tagged prototype/pictures-in-steps): the newest three, small, with a count for the rest. A picture opens the
 * viewer, where Mark up is, stepping through the pictures of the work around the line; a video plays in a tile under the line.
 * `strip` goes where the line ends and `player` under it. Nothing shows while `inline-media` is off, outside a thread's
 * transcript, or for records with no pictures in their steps; a picture that stands in the thread as a tile is not here.
 */
export function useStepPictures(records: readonly AgentActivity[] | undefined, visible = true): { readonly strip: ReactNode; readonly player: ReactNode; readonly count: number } {
  const { t } = useLingui()
  const enabled = useOwlFeature('inline-media')
  const thread = useContext(StepPicturesThreadContext)
  const scope = useContext(PictureScopeContext)
  const all = useMemo(() => enabled && thread && records?.length ? picturesInSteps(records, thread.threadId) : NONE, [enabled, thread, records])
  const [viewing, setViewing] = useState<{ readonly images: readonly ViewerImage[]; readonly id: string; readonly from: HTMLElement } | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  // The mark that set a video playing, which takes the focus back when Escape puts the video away.
  const mark = useRef<HTMLElement | null>(null)
  if (!thread || (!all.length && !viewing)) return { strip: null, player: null, count: 0 }
  // The viewer steps through the pictures of the work around the line, as a turn's tiles did, named by their place there.
  const open = (shown: Shown, from: HTMLElement): void => {
    const around = scope ? picturesInSteps(scope.records, thread.threadId) : all
    const pictures = (around.some(item => keyOf(item) === keyOf(shown)) ? around : all).filter(item => item.media.kind === 'image')
    setViewing({ id: keyOf(shown), from, images: pictures.map((picture, index) => ({ id: keyOf(picture), name: pictureName(t, index + 1), details: mediaDetails(picture.media), media: picture.origin })) })
  }
  const { shown: newest, hidden } = onTheLine(all)
  const rest = hidden.length
  const images = all.filter(item => item.media.kind === 'image')
  const videos = all.filter(item => item.media.kind === 'video')
  // The count opens the first picture it stands for, or plays its first video when it stands for videos alone.
  const firstHidden = hidden.find(item => item.media.kind === 'image') ?? hidden[0]
  const video = playing === null || !visible ? undefined : videos.find(item => keyOf(item) === playing)
  const play = (shown: Shown, from: HTMLElement): void => { mark.current = from; setPlaying(now => now === keyOf(shown) ? null : keyOf(shown)) }
  const putAway = (event: React.KeyboardEvent): void => {
    if (event.key !== 'Escape' || playing === null) return
    event.stopPropagation()
    setPlaying(null)
    mark.current?.focus()
  }
  const viewer = viewing ? <AttachmentViewer images={viewing.images} origin={undefined} startId={viewing.id} anchor={viewing.from} onClose={() => setViewing(null)} /> : null
  // The strip holds its room by what it shows, so a row can keep that room for it beside its time.
  const room = { '--step-pictures': newest.length, '--step-pictures-more': rest ? 1 : 0 } as CSSProperties
  const strip = visible && all.length ? <span className="step-pictures" role="group" style={room} data-count={all.length} onKeyDown={putAway}
    aria-label={t({ message: `Pictures: ${all.length}`, comment: 'Names the small pictures at the end of a step\'s line; {0} is how many it stands for.' })}>
    {rest > 0 && firstHidden ? <button type="button" className="step-pictures__more tt-focusable"
      aria-label={firstHidden.media.kind === 'image'
        ? t({ message: `Open all ${all.length} pictures`, comment: 'The count before a step\'s newest pictures, which opens the viewer at the first of the rest.' })
        : t({ message: 'Play the next video', comment: 'The count before a step\'s newest pictures when it stands for videos alone; a press plays the first of them under the line.' })}
      onClick={event => firstHidden.media.kind === 'image' ? open(firstHidden, event.currentTarget) : play(firstHidden, event.currentTarget)}>+{shownCount(rest)}</button> : null}
    {newest.map(shown => shown.media.kind === 'video'
      ? <button key={keyOf(shown)} type="button" className="step-pictures__thumb step-pictures__thumb--video tt-focusable" aria-pressed={playing === keyOf(shown)}
        aria-label={playing === keyOf(shown)
          ? t({ message: `Close video ${videos.indexOf(shown) + 1} of ${videos.length}, from ${stepTitle(t, shown.record)}`, comment: '{0} of {1} videos an agent\'s steps wrote; {2} names the step. A press takes the video under the line away.' })
          : t({ message: `Play video ${videos.indexOf(shown) + 1} of ${videos.length}, from ${stepTitle(t, shown.record)}`, comment: '{0} of {1} videos an agent\'s steps wrote; {2} names the step. A press plays it in a tile under the line.' })}
        title={playing === keyOf(shown) ? t`Close video` : t`Play video`} onClick={event => play(shown, event.currentTarget)}><Film size={13} aria-hidden="true" /></button>
      : <Thumb key={keyOf(shown)} shown={shown} number={images.indexOf(shown) + 1} count={images.length} onOpen={from => open(shown, from)} />)}
    {viewer}
  </span> : viewer
  const player = video ? <div className="step-pictures__player" onKeyDown={putAway}>
    <VideoTile key={keyOf(video)} shown={video} number={videos.indexOf(video) + 1} count={videos.length} playsAtOnce />
  </div> : null
  return { strip, player, count: all.length }
}

/** Room kept in a row's own line for the strip drawn over it (`useStepPictures`), so the row's words give way to it. */
export function StepPicturesSlot({ count, more }: { readonly count: number; readonly more: boolean }): ReactNode {
  if (!count) return null
  return <span className="step-pictures__slot" aria-hidden="true" style={{ '--step-pictures': count, '--step-pictures-more': more ? 1 : 0 } as CSSProperties} />
}
