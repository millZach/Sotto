import { isAbsolute, resolve } from 'node:path'
import { MAX_MEDIA_CALLOUTS, type AgentActivityMedia, type AgentMediaCallout } from '../../shared/agentActivity'
import type { ShownFile } from './shownMedia'

/**
 * Callouts an agent places on the pictures it shows (ADR-0170, part 6): numbered boxes with notes, given through
 * `show_in_thread` with the pictures themselves, in each picture's own pixels. Each is kept on its picture's handle as
 * shares of the picture's size, so it lands in the same place on a tile, in the viewer and on the iPhone.
 */

/** One callout as the agent asks for it: the picture it goes on, as named in `paths`, a box in its pixels, and a note. */
export interface CalloutRequest {
  readonly path: string
  readonly x: number; readonly y: number; readonly width: number; readonly height: number
  readonly note: string
}

/** Why a callout was not placed, in words the agent is told. */
export type CalloutRefusal = 'not-shown' | 'video' | 'unsized' | 'outside'

export interface PlacedCallouts {
  /** The call's handles, each picture with the callouts placed on it. */
  readonly media: AgentActivityMedia[]
  readonly placed: number
  readonly refused: { readonly note: string; readonly reason: CalloutRefusal }[]
}

/** A share of the picture, kept to four places: a ten-thousandth of a 4K picture is under half a pixel. */
const share = (value: number): number => Math.round(value * 10_000) / 10_000

/** Where `path` is, the way `shownMedia` read it: relative to the thread's folder, or absolute. */
function located(folder: string | undefined, path: string): string | undefined {
  return isAbsolute(path) ? resolve(path) : folder ? resolve(folder, path) : undefined
}

/**
 * Places each callout on the picture its path names, numbered across the call in the order of the pictures and then
 * the order given. A callout whose picture was not shown, is a video or has no known size, or whose box lies outside
 * the picture, is refused and named; a box partly outside is cut to the picture. At most `MAX_MEDIA_CALLOUTS`.
 */
export function placeCallouts(folder: string | undefined, requests: readonly CalloutRequest[], shown: readonly ShownFile[]): PlacedCallouts {
  const refused: PlacedCallouts['refused'] = []
  const byPicture = new Map<number, Omit<AgentMediaCallout, 'n'>[]>()
  const files = shown.map(item => resolve(item.file))
  for (const request of requests.slice(0, MAX_MEDIA_CALLOUTS)) {
    const at = located(folder, request.path)
    const index = at === undefined ? -1 : files.indexOf(at)
    const picture = shown[index]?.media
    if (!picture) { refused.push({ note: request.note, reason: 'not-shown' }); continue }
    if (picture.kind !== 'image') { refused.push({ note: request.note, reason: 'video' }); continue }
    const { width, height } = picture
    if (!width || !height) { refused.push({ note: request.note, reason: 'unsized' }); continue }
    const left = Math.max(0, Math.min(request.x, request.x + request.width)), right = Math.min(width, Math.max(request.x, request.x + request.width))
    const top = Math.max(0, Math.min(request.y, request.y + request.height)), bottom = Math.min(height, Math.max(request.y, request.y + request.height))
    // A box with nothing left once cut to the picture marks nothing on it; any overlap, a part of a pixel too, is kept.
    if (right <= left || bottom <= top) { refused.push({ note: request.note, reason: 'outside' }); continue }
    const callout = { x: share(left / width), y: share(top / height), w: Math.max(0.0001, share((right - left) / width)), h: Math.max(0.0001, share((bottom - top) / height)), note: request.note }
    byPicture.set(index, [...byPicture.get(index) ?? [], callout])
  }
  let next = 1
  const media = shown.map((item, index) => {
    const callouts = byPicture.get(index)
    return callouts ? { ...item.media, callouts: callouts.map(callout => ({ n: next++, ...callout })) } : item.media
  })
  return { media, placed: next - 1, refused }
}
