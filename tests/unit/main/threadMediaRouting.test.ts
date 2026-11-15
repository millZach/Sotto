// @vitest-environment node
/**
 * A window reads an agent's picture by its handle (ADR-0170): the router asks the host that runs the thread for the whole
 * picture and makes the tile's thumbnail itself, keeping them up to a budget in bytes; the IPC answers only the main window.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ipcRegistry, trustedIpcSender } from '../../fixtures/ipcHarness'
import { receiptEncoders } from '../../fixtures/receiptEncoders'
import { AGENT_THREAD_MEDIA, mediaTileScale, type AgentState, type AgentThreadMediaRequest } from '../../../src/shared/agents'
import { hostEntityKey } from '../../../src/shared/clientIdentity'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => 'D:/fixture' } }))
import { registerAgentIpc } from '../../../src/main/agents/ipc'
import { DesktopHostRouter, type DesktopHostConnection } from '../../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { KeptThumbnails, MEDIA_TILE_KEEP_BYTES, mediaEdgeMaker, mediaThumbnailMaker, ReducedPictures } from '../../../src/main/agents/mediaThumbnail'

const REMOTE = '22222222-2222-4222-8222-222222222222'
const WHOLE = 'data:image/png;base64,AAAA'
const TILE = 'data:image/jpeg;base64,BBBB'
const disposables: Array<() => void> = []
afterEach(() => { for (const dispose of disposables.splice(0)) dispose(); vi.clearAllMocks() })

function remoteHost() {
  const state = emptyDesktopState(REMOTE)
  state.host.connected = true; state.connection = 'connected'
  state.host.threads = [{ id: 'thread', projectId: 'project', title: 'T', modelId: '', providerId: 'claude', status: 'idle', messages: [], requests: [] }]
  const media = vi.fn(async (request: AgentThreadMediaRequest) => { void request; return { dataUrl: WHOLE } })
  const connection: DesktopHostConnection = { hostId: REMOTE, name: 'Forge', kind: 'remote',
    service: { shell: () => structuredClone(state), view: () => ({ ...state }), subscribe: () => () => undefined, command: vi.fn() } as unknown as DesktopHostConnection['service'],
    detail: async () => null, preview: () => null as never, available: () => true, media }
  return { connection, media }
}

describe('reading an agent\'s picture from the window', () => {
  it('reads the whole picture from the thread\'s host and makes and keeps the tile itself', async () => {
    const host = remoteHost()
    const thumbnail = vi.fn(() => TILE)
    const router = new DesktopHostRouter(emptyDesktopState, { mediaThumbnail: thumbnail })
    router.add(host.connection)
    const threadId = hostEntityKey(REMOTE, 'thread')
    const tile = { threadId, activityId: 'claude-tool-shot', mediaId: 'm0', size: 'tile' as const }
    await expect(router.threadMedia(tile)).resolves.toEqual({ dataUrl: TILE })
    expect(host.media).toHaveBeenCalledWith({ threadId: 'thread', activityId: 'claude-tool-shot', mediaId: 'm0' })
    expect(thumbnail).toHaveBeenCalledWith(WHOLE, 2)
    // Scrolled back into view, the tile is not read again.
    await expect(router.threadMedia(tile)).resolves.toEqual({ dataUrl: TILE })
    expect(host.media).toHaveBeenCalledTimes(1)
    // The viewer reads the whole picture, with no thumbnail.
    await expect(router.threadMedia({ ...tile, size: 'full' })).resolves.toEqual({ dataUrl: WHOLE })
    expect(thumbnail).toHaveBeenCalledTimes(1)
  })

  it('keeps every thumbnail of a long thread, so a second trip through it reads and decodes nothing', async () => {
    const host = remoteHost()
    // About the size of a 416x260 thumbnail of a screenshot.
    const thumbnail = vi.fn(() => `data:image/jpeg;base64,${'B'.repeat(37_000)}`)
    const router = new DesktopHostRouter(emptyDesktopState, { mediaThumbnail: thumbnail })
    router.add(host.connection)
    const threadId = hostEntityKey(REMOTE, 'thread')
    // 361 pictures, the longest thread measured (docs/perf/2026-11-04-thread-pictures-cost.md), up and back twice.
    const tiles = Array.from({ length: 361 }, (_, index) => ({ threadId, activityId: `step-${index}`, mediaId: 'm0', size: 'tile' as const }))
    for (const trip of [tiles, [...tiles].reverse(), tiles]) for (const tile of trip) await router.threadMedia(tile)
    expect(host.media).toHaveBeenCalledTimes(361)
    expect(thumbnail).toHaveBeenCalledTimes(361)
  })

  it('makes a thumbnail at the scale the window asks for, and keeps each scale apart', async () => {
    const host = remoteHost()
    const thumbnail = vi.fn((whole: string, scale: number) => { void whole; return `data:image/jpeg;base64,${scale * 4}` })
    const router = new DesktopHostRouter(emptyDesktopState, { mediaThumbnail: thumbnail })
    router.add(host.connection)
    const tile = { threadId: hostEntityKey(REMOTE, 'thread'), activityId: 'a', mediaId: 'm0', size: 'tile' as const }
    await expect(router.threadMedia({ ...tile, scale: 1 })).resolves.toEqual({ dataUrl: 'data:image/jpeg;base64,4' })
    await expect(router.threadMedia({ ...tile, scale: 1.5 })).resolves.toEqual({ dataUrl: 'data:image/jpeg;base64,6' })
    await expect(router.threadMedia({ ...tile, scale: 1 })).resolves.toEqual({ dataUrl: 'data:image/jpeg;base64,4' })
    expect(thumbnail.mock.calls.map(call => call[1])).toEqual([1, 1.5])
  })

  it('makes thumbnails no larger than the tile at the window\'s scale', () => {
    const resized: { width: number; height: number }[] = []
    const picture = (size: { width: number; height: number }) => ({ isEmpty: () => false, getSize: () => size,
      resize: (to: { width: number; height: number }) => { resized.push({ width: to.width, height: to.height }); return { toJPEG: () => Buffer.from('jpeg') } } })
    const make = mediaThumbnailMaker(() => picture({ width: 1600, height: 1000 }) as never)
    for (const scale of [1, 1.1, 1.25, 1.5, 2, undefined]) make('data:image/png;base64,AAAA', scale)
    // 1600x1000 fits the 208x140 tile by its width, at each scale; a window that names none gets twice the tile.
    expect(resized).toEqual([{ width: 208, height: 130 }, { width: 229, height: 143 }, { width: 260, height: 163 }, { width: 312, height: 195 }, { width: 416, height: 260 }, { width: 416, height: 260 }])
    // The screen's own ratio, to the hundredth above, from 1 to 4.
    expect([0.8, 1, 1.1, 1.125, 1.25, 1.5, 2, 2.625, 4, 5].map(mediaTileScale)).toEqual([1, 1, 1.1, 1.13, 1.25, 1.5, 2, 2.63, 4, 4])
  })

  it('makes a phone\'s copy no larger than its edge, a PNG only when something shows through, and hands back what it cannot make', () => {
    const made: string[] = []
    // Electron's image, as the maker sees it: its size, and what resizing and writing it give back.
    const picture = (size: { width: number; height: number }, alpha = 255) => ({ isEmpty: () => size.width === 0, getSize: () => size,
      resize: (to: { width: number; height: number }) => {
        made.push(`${to.width}x${to.height}`)
        return { toBitmap: () => Buffer.from([1, 2, 3, 255, 4, 5, 6, alpha]), toJPEG: (quality: number) => Buffer.from(`jpeg ${quality}`), toPNG: () => Buffer.from('png') }
      } })
    const make = (size: { width: number; height: number }, alpha?: number) => mediaEdgeMaker(() => picture(size, alpha) as never)
    const png = 'data:image/png;base64,AAAA'
    // A screenshot fits 640 by its width, a portrait photo by its height; both come as JPEGs at the tile thumbnail's quality.
    expect(make({ width: 1600, height: 1000 })(png, 640)).toBe(`data:image/jpeg;base64,${Buffer.from('jpeg 85').toString('base64')}`)
    expect(make({ width: 900, height: 1200 })(png, 640)).toBe(`data:image/jpeg;base64,${Buffer.from('jpeg 85').toString('base64')}`)
    expect(made).toEqual(['640x400', '480x640'])
    // One pixel less than opaque keeps it a PNG, since a JPEG would turn what shows through black.
    expect(make({ width: 1600, height: 1000 }, 254)(png, 640)).toBe(`data:image/png;base64,${Buffer.from('png').toString('base64')}`)
    // Already that small, it is handed back as it is; one Electron cannot read (a GIF, a WebP) is null.
    expect(make({ width: 640, height: 300 })(png, 640)).toBe(png)
    expect(make({ width: 0, height: 0 })('data:image/gif;base64,R0lG', 640)).toBeNull()
    expect(made).toHaveLength(3)
    // A JPEG with camera details is handed back whole, unread: they may say to turn it, which Electron does not do.
    const exif = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x0a, ...Buffer.from('Exif\0\0'), 0x00, 0x00, 0xff, 0xda, 0x00, 0x02])
    const plain = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x06, ...Buffer.from('JFIF'), 0xff, 0xda, 0x00, 0x02])
    const fromCamera = `data:image/jpeg;base64,${exif.toString('base64')}`
    expect(make({ width: 4000, height: 3000 })(fromCamera, 640)).toBe(fromCamera)
    expect(made).toHaveLength(3)
    expect(make({ width: 4000, height: 3000 })(`data:image/jpeg;base64,${plain.toString('base64')}`, 640)).toMatch(/^data:image\/jpeg;base64,/u)
    expect(made.at(-1)).toBe('640x480')
  })

  it('keeps a phone\'s copies in the thumbnails\' budget, and keeps no whole picture', async () => {
    const kept = new KeptThumbnails(100)
    const reduce = vi.fn(async (whole: string, edge: number) => whole.startsWith('data:image/webp') ? null : `data:image/jpeg;base64,${'C'.repeat(edge / 32)}`)
    const pictures = new ReducedPictures(reduce, kept)
    const big = { dataUrl: `data:image/png;base64,${'A'.repeat(400)}` }
    const whole = vi.fn(async () => big)
    await expect(pictures.read(['thread-media', 't', 'a', 'm0'], 640, whole)).resolves.toEqual({ dataUrl: `data:image/jpeg;base64,${'C'.repeat(20)}` })
    // Asked again, it comes from what is kept, unread; another edge is a copy of its own.
    await pictures.read(['thread-media', 't', 'a', 'm0'], 640, whole)
    await pictures.read(['thread-media', 't', 'a', 'm0'], 320, whole)
    expect(whole).toHaveBeenCalledTimes(2)
    expect(reduce.mock.calls.map(call => call[1])).toEqual([640, 320])
    expect(kept.bytes).toBeLessThanOrEqual(100)
    // A GIF is answered whole, never made into a copy, so it keeps its frames; so is a picture the maker cannot read.
    const gif = { dataUrl: 'data:image/gif;base64,R0lG' }
    await expect(pictures.read(['thread-media', 't', 'gif', 'm0'], 640, async () => gif)).resolves.toBe(gif)
    const webp = { dataUrl: `data:image/webp;base64,${'U'.repeat(400)}` }
    await expect(pictures.read(['preview', 't', 'm', 'a'], 640, async () => webp)).resolves.toBe(webp)
    expect(reduce).toHaveBeenCalledTimes(3)
    // A copy no smaller than the picture is not sent in its place, and a picture the host no longer keeps is null.
    const small = { dataUrl: 'data:image/png;base64,AA' }
    await expect(pictures.read(['thread-media', 't', 'small', 'm0'], 640, async () => small)).resolves.toBe(small)
    await expect(pictures.read(['thread-media', 't', 'gone', 'm0'], 640, async () => null)).resolves.toBeNull()
    expect(kept.bytes).toBeLessThanOrEqual(100)
  })

  it('makes a picture asked for again while its copy is being made once, for both (ADR-0203)', async () => {
    let finish!: (copy: string) => void
    const reduce = vi.fn(() => new Promise<string>(done => { finish = done }))
    const pictures = new ReducedPictures(reduce, new KeptThumbnails())
    const whole = vi.fn(async () => ({ dataUrl: `data:image/png;base64,${'A'.repeat(400)}` }))
    const first = pictures.read(['thread-media', 't', 'a', 'm0'], 640, whole)
    const second = pictures.read(['thread-media', 't', 'a', 'm0'], 640, whole)
    await vi.waitFor(() => expect(reduce).toHaveBeenCalledTimes(1))
    finish('data:image/jpeg;base64,CC')
    await expect(Promise.all([first, second])).resolves.toEqual([{ dataUrl: 'data:image/jpeg;base64,CC' }, { dataUrl: 'data:image/jpeg;base64,CC' }])
    expect(whole).toHaveBeenCalledTimes(1)
    // Once made it is kept, and a later ask neither reads nor makes it again.
    await pictures.read(['thread-media', 't', 'a', 'm0'], 640, whole)
    expect([whole.mock.calls.length, reduce.mock.calls.length]).toEqual([1, 1])
  })

  it('holds thumbnails to a budget in bytes, letting the one read longest ago go first', () => {
    const kept = new KeptThumbnails(100)
    for (const key of ['a', 'b', 'c']) kept.set(key, 'x'.repeat(30))
    expect(kept.get('a')).toBeDefined()
    kept.set('d', 'x'.repeat(30))
    // 'b' was read longest ago once 'a' was read again.
    expect([kept.get('a'), kept.get('b'), kept.get('c'), kept.get('d')].map(Boolean)).toEqual([true, false, true, true])
    expect(kept.bytes).toBe(90)
    kept.set('e', 'x'.repeat(101))
    expect(kept.get('e')).toBeUndefined()
    expect(kept.bytes).toBeLessThanOrEqual(100)
    // However many are made, what is kept stays within its budget.
    const real = new KeptThumbnails()
    for (let index = 0; index < 2_000; index++) real.set(String(index), 'x'.repeat(50_000))
    expect(real.bytes).toBeLessThanOrEqual(MEDIA_TILE_KEEP_BYTES)
    expect(real.get('1999')).toBeDefined()
    expect(real.get('0')).toBeUndefined()
  })

  it('reads nothing while the Owl feature is off, or when the host keeps no such picture', async () => {
    const host = remoteHost()
    const off = new DesktopHostRouter(emptyDesktopState)
    off.add(host.connection)
    const request = { threadId: hostEntityKey(REMOTE, 'thread'), activityId: 'a', mediaId: 'm0', size: 'tile' as const }
    await expect(off.threadMedia(request)).resolves.toBeNull()
    expect(host.media).not.toHaveBeenCalled()
    const on = new DesktopHostRouter(emptyDesktopState, { mediaThumbnail: () => TILE })
    on.add(host.connection)
    host.media.mockResolvedValueOnce(null as never)
    await expect(on.threadMedia(request)).resolves.toBeNull()
  })

  it('answers only the main window, and only a well-formed request', async () => {
    const registry = ipcRegistry()
    const threadMedia = vi.fn(async () => ({ dataUrl: TILE }))
    const control = { get: () => ({} as AgentState), shell: () => ({} as AgentState), threadDetail: () => null, attachmentPreview: async () => null, threadMedia }
    disposables.push(registerAgentIpc(registry.ipc, control, { command: vi.fn() }, () => [registry.main, registry.widget], { ...receiptEncoders() }))
    const request = { threadId: 'thread', activityId: 'a', mediaId: 'm0', size: 'tile' }
    await expect(registry.invoke(AGENT_THREAD_MEDIA, [request], registry.event(registry.main))).resolves.toEqual({ dataUrl: TILE })
    await expect(registry.invoke(AGENT_THREAD_MEDIA, [request], registry.event(registry.widget))).rejects.toThrow('AGENT_SENDER_REJECTED')
    const stranger = trustedIpcSender('main'); stranger.webContents.getURL = () => 'https://elsewhere.test/'
    await expect(registry.invoke(AGENT_THREAD_MEDIA, [request], registry.event(stranger))).rejects.toThrow('AGENT_SENDER_REJECTED')
    for (const payload of [{ ...request, mediaId: 'm8' }, { ...request, size: 'huge' }, { ...request, digest: 'a'.repeat(64) }, { ...request, scale: 0.5 }, { ...request, scale: 8 }]) {
      await expect(registry.invoke(AGENT_THREAD_MEDIA, [payload], registry.event(registry.main))).rejects.toThrow()
    }
    expect(threadMedia).toHaveBeenCalledTimes(1)
  })
})
