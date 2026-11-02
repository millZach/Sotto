// @vitest-environment node
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { placeCallouts, type CalloutRequest } from '../../../src/main/agents/shownCallouts'
import { agentActivityMediaSchema, MAX_MEDIA_CALLOUTS, type AgentActivityMedia } from '../../../src/shared/agentActivity'

const folder = resolve('/work/shop')
const picture = (id: string, width?: number, height?: number): AgentActivityMedia => ({ id, digest: id.repeat(32).slice(0, 64).replace(/[^a-f0-9]/gu, 'a'), kind: 'image',
  mimeType: 'image/png', sizeBytes: 100, ...width && height ? { width, height } : {}, name: `${id}.png`, source: 'file' })
const video: AgentActivityMedia = { id: 'm2', digest: 'b'.repeat(64), kind: 'video', mimeType: 'video/mp4', sizeBytes: 100, name: 'flow.mp4', source: 'file' }
const shown = [
  { file: join(folder, 'checkout.png'), media: picture('m0', 1280, 800) },
  { file: join(folder, 'phone.png'), media: picture('m1', 390, 844) },
  { file: join(folder, 'flow.mp4'), media: video },
  { file: join(folder, 'unsized.png'), media: picture('m3') },
]
const box = (path: string, x: number, y: number, width: number, height: number, note = `At ${x},${y}`): CalloutRequest => ({ path, x, y, width, height, note })

describe('callouts an agent places on the pictures it shows (ADR-0170, part 6)', () => {
  it('goes on the picture its path names, as shares of its size, numbered by picture and then as given', () => {
    const placed = placeCallouts(folder, [
      box('phone.png', 191, 688, 199, 74, 'The Pay button runs off the screen.'),
      box('checkout.png', 768, 384, 429, 92, 'The Pay button sits on the total.'),
      box(join(folder, 'checkout.png'), 70, 292, 580, 66, 'The card field has no label.'),
    ], shown)
    expect(placed.placed).toBe(3)
    expect(placed.refused).toEqual([])
    expect(placed.media[0]!.callouts).toEqual([
      { n: 1, x: 0.6, y: 0.48, w: 0.3352, h: 0.115, note: 'The Pay button sits on the total.' },
      { n: 2, x: 0.0547, y: 0.365, w: 0.4531, h: 0.0825, note: 'The card field has no label.' },
    ])
    expect(placed.media[1]!.callouts).toEqual([{ n: 3, x: 0.4897, y: 0.8152, w: 0.5103, h: 0.0877, note: 'The Pay button runs off the screen.' }])
    // A picture without callouts and the video are kept as they were, and every handle still parses.
    expect(placed.media[2]).toBe(video)
    for (const media of placed.media) expect(agentActivityMediaSchema.parse(media)).toEqual(media)
  })

  it('cuts a box partly off the picture to it, and counts a box drawn from its far corner the same', () => {
    const placed = placeCallouts(folder, [box('checkout.png', 1200, 760, 200, 100), box('checkout.png', 640, 400, -320, -200)], shown)
    expect(placed.media[0]!.callouts).toEqual([
      { n: 1, x: 0.9375, y: 0.95, w: 0.0625, h: 0.05, note: 'At 1200,760' },
      { n: 2, x: 0.25, y: 0.25, w: 0.25, h: 0.25, note: 'At 640,400' },
    ])
  })

  it('refuses one whose picture was not shown, is a video or has no size, or whose box is outside it, and says which', () => {
    const placed = placeCallouts(folder, [box('missing.png', 0, 0, 10, 10, 'gone'), box('flow.mp4', 0, 0, 10, 10, 'video'), box('unsized.png', 0, 0, 10, 10, 'unsized'),
      box('checkout.png', 1300, 0, 50, 50, 'right of it'), box('checkout.png', 0, 799.5, 50, 50, 'under half a pixel')], shown)
    expect(placed.placed).toBe(0)
    expect(placed.refused).toEqual([{ note: 'gone', reason: 'not-shown' }, { note: 'video', reason: 'video' }, { note: 'unsized', reason: 'unsized' },
      { note: 'right of it', reason: 'outside' }, { note: 'under half a pixel', reason: 'outside' }])
    expect(placed.media.every(media => media.callouts === undefined)).toBe(true)
    // A relative path with no folder names nothing.
    expect(placeCallouts(undefined, [box('checkout.png', 0, 0, 10, 10, 'no folder')], shown).refused).toEqual([{ note: 'no folder', reason: 'not-shown' }])
  })

  it('places at most twelve', () => {
    const many = Array.from({ length: MAX_MEDIA_CALLOUTS + 3 }, (_, index) => box('checkout.png', index * 10, 0, 10, 10))
    const placed = placeCallouts(folder, many, shown)
    expect(placed.placed).toBe(MAX_MEDIA_CALLOUTS)
    expect(placed.media[0]!.callouts!.map(callout => callout.n)).toEqual(Array.from({ length: MAX_MEDIA_CALLOUTS }, (_, index) => index + 1))
  })
})
