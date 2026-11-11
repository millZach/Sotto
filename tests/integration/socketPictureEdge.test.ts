// @vitest-environment node
/**
 * `thread-media-edge` over the real listener (ADR-0170, November 10 amendment; #2395): a phone that accepts it asks a
 * tile's picture at the tile's longest edge, 640 on the iPhone, and is sent a copy made on the computer rather than the
 * whole picture; a phone that does not, the viewer, and every GIF are sent the whole file as before. The pictures are
 * made in the test at the size of forge's kept ones (`syntheticPictures.ts`), and the copies with a stand-in for the
 * desktop's Electron image tools, which a test under Node cannot load.
 *
 * With `SOTTO_PERF_BENCH=1` it prints the bytes each picture is sent at before and after:
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/integration/socketPictureEdge.test.ts --disable-console-intercept
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { startSocketServer } from '../../src/host/socketServer'
import { LocalHostService, type HostService, type LocalHostControl } from '../../src/main/agents/hostService'
import { KeptThumbnails, MEDIA_TILE_KEEP_BYTES, ReducedPictures } from '../../src/main/agents/mediaThumbnail'
import type { AgentAttachmentPreviewRequest, AgentThreadMediaRequest } from '../../src/shared/agents'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'
import { dataUrl, movingGif, photoJpeg, reduceLikeTheDesktop, screenshotPng, seeThroughPng } from '../fixtures/syntheticPictures'

const fixture = useSocketHostFixture()
const closers: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close() })

/** The iPhone tile's edge, `PhotoPipeline.thumbnailEdge`. */
const TILE_EDGE = 640
const pictures: Record<string, string> = {}
beforeAll(async () => {
  pictures.png = dataUrl('image/png', await screenshotPng())
  pictures.jpeg = dataUrl('image/jpeg', await photoJpeg())
  pictures.gif = dataUrl('image/gif', await movingGif())
  pictures.clear = dataUrl('image/png', await seeThroughPng())
}, 60_000)

/**
 * The desktop's phone listener over a host whose thread `pictures` holds a step for each picture (its activity ID is the
 * picture's name) and a sent photo, the JPEG. With `kept`, the host makes copies at an edge, kept there; without, it is
 * a host with no image tools.
 */
async function listen(kept?: KeptThumbnails) {
  const reads: string[] = []
  const control = {
    threadMedia: async ({ activityId }: AgentThreadMediaRequest) => { reads.push(activityId); return pictures[activityId] ? { dataUrl: pictures[activityId] } : null },
    attachmentPreview: async ({ attachmentId }: AgentAttachmentPreviewRequest) => { reads.push(attachmentId); return attachmentId === 'photo' ? { dataUrl: pictures.jpeg! } : null },
  }
  const local = new LocalHostService({ control: control as unknown as LocalHostControl, threadMedia: true,
    ...kept ? { reducedPictures: new ReducedPictures(reduceLikeTheDesktop, kept) } : {} })
  const base = fixture.host.service
  const service: HostService = {
    shell: () => base.shell(), state: () => base.state(), threadDetail: id => base.threadDetail(id), command: (command, identity) => base.command(command, identity),
    events: (afterSeq, threadId, limit) => base.events(afterSeq, threadId, limit), subscribe: listener => base.subscribe(listener),
    supportsThreadMedia: true, supportsPictureEdges: local.supportsPictureEdges,
    threadMedia: request => local.threadMedia(request), attachmentPreview: request => local.attachmentPreview(request),
  }
  const server = await startSocketServer({ service, pairing: fixture.host.pairing, admin: false })
  closers.push(() => server.close())
  let calls = 0
  const phone = async (accepts: string[]) => {
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Phone')
    const peer = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(paired.clientId))
    closers.push(() => peer.frames.close())
    const hello = await peer.call('hello', { op: 'hello', accepts })
    const call = async (op: 'thread-media' | 'preview', request: Record<string, unknown>) => await peer.call(`call-${++calls}`, { op, request })
    /** What the phone is sent for one of the thread's pictures, or its sent photo, at `edge` or whole. */
    const picture = async (name: string, edge?: number) => {
      const answer = await call(name === 'photo' ? 'preview' : 'thread-media', name === 'photo'
        ? { threadId: 'pictures', messageId: 'ask', attachmentId: 'photo', ...edge === undefined ? {} : { edge } }
        : { threadId: 'pictures', activityId: name, mediaId: 'm0', ...edge === undefined ? {} : { edge } })
      return (answer.result as { dataUrl: string } | null)?.dataUrl ?? null
    }
    return { features: (hello.result as { features: string[] }).features, call, picture }
  }
  return { phone, reads }
}

describe('a picture at the size a phone shows it (thread-media-edge)', () => {
  it('sends a phone that names its tile\'s edge at most a tenth of a large picture, and the whole file to one that does not', async () => {
    const kept = new KeptThumbnails()
    const host = await listen(kept)
    const phone = await host.phone(['thread-media-edge'])
    const older = await host.phone([])
    expect(phone.features).toContain('thread-media-edge')
    const rows: { picture: string; whole: number; atEdge: number }[] = []
    for (const name of ['png', 'jpeg', 'photo', 'gif', 'clear']) {
      const before = await older.picture(name)
      const after = await phone.picture(name, TILE_EDGE)
      rows.push({ picture: name, whole: before!.length, atEdge: after!.length })
      // A phone that does not ask for an edge, as every phone before this did, is sent the whole file, byte for byte.
      expect(before).toBe(name === 'photo' ? pictures.jpeg : pictures[name])
    }
    const sent = Object.fromEntries(rows.map(row => [row.picture, row]))
    // The screenshot, the photo and the sent photo come at most a tenth of their size, as JPEGs.
    for (const name of ['png', 'jpeg', 'photo']) {
      expect(sent[name]!.atEdge).toBeLessThanOrEqual(sent[name]!.whole / 10)
      expect((await phone.picture(name, TILE_EDGE))!.startsWith('data:image/jpeg;base64,')).toBe(true)
    }
    // A GIF keeps its frames: whole, whatever the phone asks.
    expect(sent.gif).toEqual({ picture: 'gif', whole: pictures.gif!.length, atEdge: pictures.gif!.length })
    // A picture that shows through stays a PNG, smaller, rather than a JPEG that would turn its background black.
    expect((await phone.picture('clear', TILE_EDGE))!.startsWith('data:image/png;base64,')).toBe(true)
    expect(sent.clear!.atEdge).toBeLessThan(sent.clear!.whole)
    // A copy made once is kept: a tile scrolled back into view reads nothing on the host again.
    const reads = host.reads.length
    await phone.picture('png', TILE_EDGE)
    expect(host.reads.length).toBe(reads)
    // The viewer asks with no edge and is sent the whole picture.
    expect(await phone.picture('png')).toBe(pictures.png)
    // The copies are kept in the thumbnails' budget, in bytes.
    expect(kept.bytes).toBeGreaterThan(0)
    expect(kept.bytes).toBeLessThanOrEqual(MEDIA_TILE_KEEP_BYTES)
    if (process.env.SOTTO_PERF_BENCH === '1') console.log(JSON.stringify({ benchmark: 'picture-edge', edge: TILE_EDGE, bytesAsSent: rows }))
  }, 60_000)

  it('is listed only where the host can make the copy, and takes an edge only from a phone that accepted it', async () => {
    // A host with no image tools, as every headless host is, lists nothing, and a phone that names an edge is refused.
    const plain = await listen()
    const unlisted = await plain.phone(['thread-media-edge'])
    expect(unlisted.features).not.toContain('thread-media-edge')
    expect(await unlisted.call('thread-media', { threadId: 'pictures', activityId: 'png', mediaId: 'm0', edge: TILE_EDGE })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect(await unlisted.picture('png')).toBe(pictures.png)

    const host = await listen(new KeptThumbnails())
    const older = await host.phone([])
    expect(older.features).toContain('thread-media-edge')
    for (const op of ['thread-media', 'preview'] as const) {
      const request = op === 'preview' ? { threadId: 'pictures', messageId: 'ask', attachmentId: 'photo' } : { threadId: 'pictures', activityId: 'png', mediaId: 'm0' }
      // Listed, but not accepted in its hello: an edge is refused, and nothing is read.
      const reads = host.reads.length
      expect(await older.call(op, { ...request, edge: TILE_EDGE })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
      expect(host.reads.length).toBe(reads)
      // An edge outside the closed few is refused even from a phone that accepted the feature.
      const phone = await host.phone(['thread-media-edge'])
      expect(await phone.call(op, { ...request, edge: 4096 })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
      expect(await phone.call(op, { ...request, edge: 600 })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    }
  }, 60_000)
})
