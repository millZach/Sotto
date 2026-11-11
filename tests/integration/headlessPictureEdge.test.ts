// @vitest-environment node
/**
 * `thread-media-edge` on a headless host (ADR-0202; #2395): a phone paired straight to a headless host, as forge's phones
 * are, asks a tile's picture at the tile's edge, 640 on the iPhone, and is sent a copy the host made in its picture worker
 * with the decoders compiled into it, where before it was sent the whole picture. A real headless host over its real
 * listener, with its own thread media store holding pictures made in the test at the size of forge's
 * (`syntheticPictures.ts`), and the worker built as the host's build builds it (`pictureWorker.ts`).
 *
 * With `SOTTO_PERF_BENCH=1` it prints the bytes each picture is sent at before and after; how long the worker takes to
 * answer each picture, the first time it is asked, with the worker's own start before the first of them, and again once
 * the worker is warm; and how long decoding, scaling and encoding each take on one thread, the median of the runs after
 * the first:
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/integration/headlessPictureEdge.test.ts --disable-console-intercept
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { PictureMaker } from '../../src/host/pictureMaker'
import { decodedPicture, encodedCopy, fittedSize, scaledDown } from '../../src/host/pictureCopy'
import { ThreadMediaStore } from '../../src/main/agents/threadMedia'
import { E2EAgentHost } from '../../src/main/e2e/agentEffects'
import type { AgentActivityMedia } from '../../src/shared/agentActivity'
import { startFixtureHeadlessHost } from '../fixtures/desktopHostStack'
import { builtPictureWorker } from '../fixtures/pictureWorker'
import { rawPeer } from '../fixtures/rawHostPeer'
import { dataUrl, movingGif, photoJpeg, screenshotPng, seeThroughPng } from '../fixtures/syntheticPictures'

/** The iPhone tile's edge, `PhotoPipeline.thumbnailEdge`. */
const TILE_EDGE = 640
/** The pictures the thread's step holds, in the order of its handles, `m0` to `m4`. */
const NAMES = ['png', 'jpeg', 'gif', 'clear', 'broken'] as const
type Name = typeof NAMES[number]
const pictures = {} as Record<Name, { readonly mimeType: string; readonly bytes: Buffer }>

let worker: Awaited<ReturnType<typeof builtPictureWorker>>
beforeAll(async () => {
  worker = await builtPictureWorker()
  const jpeg = await photoJpeg()
  Object.assign(pictures, {
    png: { mimeType: 'image/png', bytes: await screenshotPng() },
    jpeg: { mimeType: 'image/jpeg', bytes: jpeg },
    gif: { mimeType: 'image/gif', bytes: await movingGif() },
    clear: { mimeType: 'image/png', bytes: await seeThroughPng() },
    // A JPEG cut off a third of the way: it starts as one, so the host keeps it, but it will not decode.
    broken: { mimeType: 'image/jpeg', bytes: jpeg.subarray(0, Math.floor(jpeg.length / 3)) },
  })
}, 60_000)
afterAll(async () => { await worker?.dispose() })

const roots: string[] = []
const closers: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  for (const root of roots.splice(0)) if (dirname(root) === tmpdir() && root.includes('sotto-host-pictures-')) await rm(root, { recursive: true, force: true })
})

/**
 * A headless host whose provider's thread `workshop` has a step holding each picture, kept in the host's own thread media
 * store, with `pictures` its maker when given. Each phone pairs with its listener and says in its hello what it accepts.
 */
async function hostWithPictures(pictureMaker?: PictureMaker) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-host-pictures-')); roots.push(root)
  // The pictures are kept as a provider's tool pictures are, before the host starts, so the host's store finds them there.
  const store = new ThreadMediaStore(root)
  await store.load()
  const handles = store.capture(NAMES.map(name => ({ mimeType: pictures[name].mimeType, data: pictures[name].bytes.toString('base64') })), 'tool')
  await store.sweep()
  expect(handles.map(handle => handle.mimeType)).toEqual(NAMES.map(name => pictures[name].mimeType))
  const native = new E2EAgentHost()
  const host = await startFixtureHeadlessHost({ dataDirectory: root, port: 0, providers: { codex: native }, owlFeatures: { 'inline-media': true },
    ...pictureMaker ? { pictures: pictureMaker } : {} })
  closers.push(() => host.close())
  // The Codex fixture's own `workshop` thread, by its Sotto thread ID once the host lists it: each fixture provider has one.
  const workshop = () => host.service.shell().host.threads.find(thread => thread.title === 'Workshop' && thread.providerId === 'codex')?.id
  await expect.poll(workshop).toBeDefined()
  const threadId = workshop()!
  native.event({ type: 'ready', threadId: 'workshop', text: 'Here are the screenshots.', status: 'idle', activities: [{ id: 'shots', turnId: 'turn-1', sequence: 0,
    kind: 'tool', status: 'completed', title: 'Screenshots', media: handles.map((handle, index): AgentActivityMedia => ({ ...handle, id: `m${index}` })) }] })
  // The step is the host's once the thread's row counts it; the thread's media is read from the host's own record of it.
  await expect.poll(() => host.service.shell().host.threads.find(thread => thread.id === threadId)?.summary?.activityCount).toBe(1)
  const activityId = 'shots'
  let calls = 0
  const phone = async (accepts: string[]) => {
    const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'Phone')
    const peer = await rawPeer(host.descriptor!.port, host.pairing.signSession(paired.clientId))
    closers.push(() => peer.frames.close())
    const hello = await peer.call('hello', { op: 'hello', accepts })
    // The phone opens the thread, as the iPhone does before it shows the step's tiles.
    expect(await peer.call(`observe-${++calls}`, { op: 'observe', threadIds: [threadId] })).toMatchObject({ ok: true })
    const ask = async (name: Name, edge?: number) => await peer.call(`call-${++calls}`, { op: 'thread-media',
      request: { threadId, activityId, mediaId: `m${NAMES.indexOf(name)}`, ...edge === undefined ? {} : { edge } } })
    /** What the phone is sent for one of the step's pictures, at `edge` or whole. */
    const picture = async (name: Name, edge?: number): Promise<string> => {
      const answer = await ask(name, edge)
      expect(answer).toMatchObject({ ok: true })
      return (answer.result as { dataUrl: string }).dataUrl
    }
    return { features: (hello.result as { features: string[] }).features, ask, picture }
  }
  return { host, phone }
}

describe('a picture at the size a phone shows it, from a headless host (thread-media-edge)', () => {
  it('sends a phone at most a tenth of a large PNG and JPEG, made on the worker, and the whole file to one that does not ask', async () => {
    const maker = new PictureMaker(worker.path)
    const { phone } = await hostWithPictures(maker)
    const asking = await phone(['thread-media-edge'])
    const older = await phone([])
    expect(asking.features).toContain('thread-media-edge')
    const rows: { picture: Name; whole: number; atEdge: number }[] = []
    for (const name of NAMES) {
      const before = await older.picture(name)
      const after = await asking.picture(name, TILE_EDGE)
      rows.push({ picture: name, whole: before.length, atEdge: after.length })
      // A phone that names no edge, as every phone before this did, is sent the whole file, byte for byte.
      expect(before).toBe(dataUrl(pictures[name].mimeType, pictures[name].bytes))
    }
    const sent = Object.fromEntries(rows.map(row => [row.picture, row])) as Record<Name, typeof rows[number]>
    // The screenshot and the photo come at most a tenth of their size, as JPEGs.
    for (const name of ['png', 'jpeg'] as const) {
      expect(sent[name].atEdge).toBeLessThanOrEqual(sent[name].whole / 10)
      expect((await asking.picture(name, TILE_EDGE)).startsWith('data:image/jpeg;base64,')).toBe(true)
    }
    // A picture that shows through stays a PNG, smaller, rather than a JPEG that would turn its background black.
    expect((await asking.picture('clear', TILE_EDGE)).startsWith('data:image/png;base64,')).toBe(true)
    expect(sent.clear.atEdge).toBeLessThan(sent.clear.whole)
    // A GIF keeps its frames, and one that will not decode is sent whole rather than refused.
    expect(sent.gif.atEdge).toBe(sent.gif.whole)
    expect(sent.broken.atEdge).toBe(sent.broken.whole)
    // The work happened in the worker, by its count of copies answered from a process other than the host's: one for each
    // of the three it could make, none for the GIF or the broken JPEG, and none again for a copy asked for a second time.
    expect(maker.made).toBe(3)
    // The viewer asks with no edge and is sent the whole picture.
    expect(await asking.picture('png')).toBe(dataUrl('image/png', pictures.png.bytes))
    if (process.env.SOTTO_PERF_BENCH === '1') console.log(JSON.stringify({ benchmark: 'headless-picture-edge', edge: TILE_EDGE, bytesAsSent: rows }))
  }, 60_000)

  it('makes a picture asked for twice at once only once, and lists the feature only with a worker to make it', async () => {
    const maker = new PictureMaker(worker.path)
    const { phone } = await hostWithPictures(maker)
    const one = await phone(['thread-media-edge']), two = await phone(['thread-media-edge'])
    // Two phones ask for the same picture at the same edge together: the second waits for the first's copy.
    const [first, second] = await Promise.all([one.picture('png', 320), two.picture('png', 320)])
    expect(first).toBe(second)
    expect(first.length).toBeLessThan(dataUrl('image/png', pictures.png.bytes).length / 10)
    expect(maker.made).toBe(1)

    // A host with no worker built beside it, as one under the test runner is, lists nothing and refuses an edge.
    const plain = await hostWithPictures()
    const phoneOfPlain = await plain.phone(['thread-media-edge'])
    expect(phoneOfPlain.features).toContain('thread-media')
    expect(phoneOfPlain.features).not.toContain('thread-media-edge')
    expect(await phoneOfPlain.ask('png', TILE_EDGE)).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  }, 60_000)

  it.runIf(process.env.SOTTO_PERF_BENCH === '1')('times the worker\'s answers, and decoding, scaling and encoding on one thread', async () => {
    const round = (value: number): number => Math.round(value * 10) / 10
    const maker = new PictureMaker(worker.path)
    const answers: { picture: Name; firstMs: number; warmMs: number }[] = []
    try {
      for (const name of ['png', 'jpeg', 'clear'] as const) {
        const url = dataUrl(pictures[name].mimeType, pictures[name].bytes)
        let at = performance.now()
        expect(await maker.reduce(url, TILE_EDGE)).not.toBeNull()
        const firstMs = performance.now() - at
        at = performance.now()
        await maker.reduce(url, TILE_EDGE)
        answers.push({ picture: name, firstMs: round(firstMs), warmMs: round(performance.now() - at) })
      }
    } finally { await maker.close() }
    console.log(JSON.stringify({ benchmark: 'headless-picture-worker-answers', edge: TILE_EDGE, answers }))
    const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!
    const rows = (['png', 'jpeg', 'clear'] as const).map(name => {
      const url = dataUrl(pictures[name].mimeType, pictures[name].bytes)
      const decode: number[] = [], scale: number[] = [], encode: number[] = []
      for (let run = 0; run < 7; run++) {
        let at = performance.now()
        const picture = decodedPicture(url)!
        decode.push(performance.now() - at)
        const size = fittedSize(picture.width, picture.height, TILE_EDGE)
        at = performance.now()
        const copy = scaledDown(picture, size.width, size.height)
        scale.push(performance.now() - at)
        at = performance.now()
        encodedCopy(copy)
        encode.push(performance.now() - at)
      }
      // The first run pays for compiling the code, as a worker's first picture does; the medians are of the six after it.
      return { picture: name, decodeMs: round(median(decode.slice(1))), scaleMs: round(median(scale.slice(1))), encodeMs: round(median(encode.slice(1))),
        firstRunMs: round(decode[0]! + scale[0]! + encode[0]!) }
    })
    console.log(JSON.stringify({ benchmark: 'headless-picture-copy-phases', edge: TILE_EDGE, runs: 6, rows }))
  }, 60_000)
})
