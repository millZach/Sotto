// @vitest-environment node
// A paired host's sounds on the desktop (the plugins plan's slice 12, part 4b): keys that name the host, what main keeps
// of them for while the host is away, the MP3 put together from its parts and checked here, and the router letting the
// host go.
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { SocketHostService } from '../../../src/main/agents/socketHostService'
import { DesktopHostRouter, type DesktopHostConnection } from '../../../src/main/hosts/desktopHostRouter'
import { HostSounds } from '../../../src/main/hosts/hostSounds'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import { SOUND_BYTES_MAX, SOUND_HOST_PART_BYTES, type HostSoundViews, type SoundHostBytes, type SoundHostBytesRequest, type SoundHostNews, type SoundView } from '../../../src/shared/sounds'

const FORGE = '33333333-3333-4333-8333-000000000001'
const HERE = '33333333-3333-4333-8333-000000000002'
const KEY = hostEntityKey(FORGE, 'narration')
const VIEW: SoundView = { id: 'narration', name: 'Opening narration', kind: 'speech', state: 'made', cost: 0.02, fileName: 'Opening narration.mp3', bytes: 100 }

/** Forge's connection, whose sounds `views` answers, as the router holds it; `up` says whether it is connected. */
function forge(views: HostSoundViews, up: { value: boolean }): DesktopHostConnection {
  const state = emptyDesktopState(FORGE)
  state.host.connected = true; state.connection = 'connected'
  const service = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'paired-token', catchUpEvents: false, elevenLabsSounds: true })
  Object.assign(service, { cached: state, features: ['plugin-elevenlabs-sounds'] })
  Object.defineProperty(service, 'pluginElevenLabsSounds', { value: views })
  return { hostId: FORGE, name: 'forge', kind: 'remote', service, detail: async () => null, preview: () => null, available: () => up.value }
}

/** An MP3 frame header and then `length` bytes of `fill`. */
const mp3 = (length: number, fill = 1): Uint8Array => { const bytes = new Uint8Array(4 + length).fill(fill); bytes.set([0xff, 0xfb, 0x90, 0x64]); return bytes }
/** The parts a host hands `file` over in, as `hostSoundViews` cuts them; `spoil` changes one before it goes. */
function parts(file: Uint8Array, spoil?: (answer: NonNullable<SoundHostBytes>, request: SoundHostBytesRequest) => SoundHostBytes) {
  const digest = createHash('sha256').update(file).digest('hex')
  return async (request: SoundHostBytesRequest): Promise<SoundHostBytes> => {
    const end = Math.min(file.byteLength, request.offset + SOUND_HOST_PART_BYTES)
    const answer = { data: Buffer.from(file.subarray(request.offset, end)).toString('base64'), total: file.byteLength, digest }
    return spoil ? spoil(answer, request) : answer
  }
}

/** Views whose reads the test answers, and whose news it sends. */
function hostViews(bytes: HostSoundViews['bytes'] = async () => null) {
  const news = new Set<(item: SoundHostNews) => void>()
  const stop = vi.fn()
  const views = {
    view: vi.fn(async (): Promise<SoundView | null> => VIEW), bytes: vi.fn(bytes),
    subscribe: (listener: (item: SoundHostNews) => void) => { news.add(listener); return () => { stop(); news.delete(listener) } },
  } satisfies HostSoundViews
  return { views, stop, tell: (item: SoundHostNews) => { for (const listener of news) listener(item) } }
}

function sounds(connections: () => DesktopHostConnection[], router?: DesktopHostRouter) {
  const changed = vi.fn()
  const made = new HostSounds({ connections, localHostId: () => HERE, changed,
    subscribeConnected: listener => router?.subscribeConnected(listener) ?? (() => undefined),
    subscribeRemoved: listener => router?.subscribeRemoved(listener) ?? (() => undefined) })
  return { made, changed }
}

describe('a host’s sounds on the desktop', () => {
  it('names a host’s sound by a key that says which host holds it, and this computer’s by its own ID', async () => {
    const host = hostViews()
    const { made } = sounds(() => [forge(host.views, { value: true })])
    expect(made.onHost(KEY)).toEqual({ hostId: FORGE, id: 'narration' })
    expect(made.onHost('narration')).toBeNull()
    expect(made.onHost(hostEntityKey(HERE, 'narration'))).toBeNull()
    await expect(made.view(KEY)).resolves.toEqual({ ...VIEW, id: KEY })
    expect(host.views.view).toHaveBeenCalledWith('narration')
    made.close()
  })

  it('keeps the last view heard for while the host is away, and reads it again once the host is back', async () => {
    const host = hostViews(), up = { value: true }
    const { made, changed } = sounds(() => [forge(host.views, up)])
    host.tell({ threadId: 'thread-1', view: { ...VIEW, cost: 0.03 } })
    expect(changed).toHaveBeenCalledWith({ ...VIEW, id: KEY, cost: 0.03 })
    up.value = false
    await expect(made.view(KEY)).resolves.toMatchObject({ id: KEY, cost: 0.03 })
    expect(host.views.view).not.toHaveBeenCalled()
    await expect(made.bytes(KEY)).resolves.toBeNull()
    up.value = true
    await expect(made.view(KEY)).resolves.toMatchObject({ id: KEY, cost: 0.02 })
    // A host that says it holds no such sound any more takes the kept view with it.
    host.views.view.mockResolvedValueOnce(null)
    await expect(made.view(KEY)).resolves.toBeNull()
    up.value = false
    await expect(made.view(KEY)).resolves.toBeNull()
    made.close()
  })

  it('puts an MP3 together from its parts and checks the whole against its digest', async () => {
    const file = mp3(SOUND_HOST_PART_BYTES + 500, 6)
    const host = hostViews(parts(file))
    const { made } = sounds(() => [forge(host.views, { value: true })])
    const whole = await made.bytes(KEY)
    expect(whole && Buffer.from(whole).equals(Buffer.from(file))).toBe(true)
    expect(host.views.bytes.mock.calls.map(([request]) => request)).toEqual([{ id: 'narration', offset: 0 }, { id: 'narration', offset: SOUND_HOST_PART_BYTES, digest: createHash('sha256').update(file).digest('hex') }])
    made.close()
  })

  it('takes nothing that does not add up: a part of another file, a short part, a wrong digest, a file past the cap or one that is not an MP3', async () => {
    const file = mp3(SOUND_HOST_PART_BYTES + 500, 6)
    const cases: HostSoundViews['bytes'][] = [
      parts(file, (answer, request) => request.offset > 0 ? { ...answer, digest: 'b'.repeat(64) } : answer),
      parts(file, (answer, request) => request.offset > 0 ? { ...answer, data: answer.data.slice(0, 8) } : answer),
      parts(file, answer => ({ ...answer, digest: 'c'.repeat(64) })),
      parts(file, answer => ({ ...answer, total: SOUND_BYTES_MAX + 1 })),
      parts(new Uint8Array(200).fill(4)),
      async () => { throw new Error('refused') },
    ]
    for (const bytes of cases) {
      const { made } = sounds(() => [forge(hostViews(bytes).views, { value: true })])
      await expect(made.bytes(KEY)).resolves.toBeNull()
      made.close()
    }
  })

  it('stops hearing a host the router lets go, and drops what it kept of it', async () => {
    const router = new DesktopHostRouter(emptyDesktopState)
    const host = hostViews()
    router.add(forge(host.views, { value: true }))
    const { made } = sounds(() => [...router.remoteConnections()], router)
    await expect(made.view(KEY)).resolves.toMatchObject({ id: KEY })
    router.remove(FORGE)
    expect(host.stop).toHaveBeenCalledTimes(1)
    await expect(made.view(KEY)).resolves.toBeNull()
    made.close()
  })
})
