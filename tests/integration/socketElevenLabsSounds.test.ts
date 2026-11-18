// @vitest-environment node
// A paired host's sounds shown on a recorded desktop (the plugins plan's slice 12, part 4b): the host's listener keeps a
// sound's line for that desktop alone, answers its reads by ID and pushes its news; the MP3 crosses in parts and is put
// together and checked on the desktop's side; and a real headless host offers it, or, older, does not.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startSocketServer } from '../../src/host/socketServer'
import type { HostService } from '../../src/main/agents/hostService'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import type { DesktopHostConnection } from '../../src/main/hosts/desktopHostRouter'
import { HostSounds } from '../../src/main/hosts/hostSounds'
import { hostSoundViews } from '../../src/main/tools/elevenlabs/hostViews'
import type { SoundRecord } from '../../src/main/tools/elevenlabs/records'
import type { AgentMessage, AgentThreadDetail, AgentThreadDetailUpdate } from '../../src/shared/agents'
import { hostEntityKey } from '../../src/shared/clientIdentity'
import { DESKTOP_CLIENTS_FILE } from '../../src/shared/desktopClients'
import { deltaWithoutVisuals } from '../../src/shared/hostProtocol'
import type { HostModelViews } from '../../src/shared/models3d'
import { MODEL_VISUAL_KIND } from '../../src/shared/models3d'
import { SOUND_HOST_PART_BYTES, SOUND_VISUAL_KIND, type HostSoundViews, type SoundHostNews, type SoundView } from '../../src/shared/sounds'
import { startFixtureHeadlessHost } from '../fixtures/desktopHostStack'
import { holding } from '../fixtures/heldOwlFeatures'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()
const at = '2026-11-16T09:00:00.000Z'
const reply: AgentMessage = { id: 'reply', role: 'assistant', text: 'Made it.', createdAt: at }
const modelLine: AgentMessage = { id: 'visual:model', role: 'assistant', text: '3D model: Oak barrel.', createdAt: at, visual: { id: 'model', title: 'Oak barrel', kind: '3d-model', source: 'barrel' } }
const soundLine: AgentMessage = { id: 'visual:sound', role: 'assistant', text: 'Sound: Opening narration.', createdAt: at, visual: { id: 'sound', title: 'Opening narration', kind: 'sound', source: 'narration' } }
const diagram: AgentMessage = { id: 'visual:flow', role: 'assistant', text: '**Flow**', createdAt: at, visual: { id: 'flow', title: 'Flow', kind: 'diagram', source: 'flowchart TD\n  A --> B' } }
const view: SoundView = { id: 'narration', name: 'Opening narration', kind: 'speech', state: 'made', cost: 0.02, fileName: 'Opening narration.mp3', bytes: 100 }
const noModels: HostModelViews = { list: async () => [], view: async () => null, bytes: async () => null, remove: async () => 'no-record', subscribe: () => () => undefined }

/** The fixture host's service, with one thread holding a 3D model's line, a sound's line and a diagram. */
function soundsHost(sounds: HostSoundViews | undefined, emit: { current: (update: AgentThreadDetailUpdate) => void }, models?: HostModelViews): HostService {
  const base = fixture.host.service
  const detail: AgentThreadDetail = { threadId: 'props', revision: 1, messages: [reply, modelLine, soundLine, diagram] }
  return {
    shell: () => base.shell(), state: () => base.state(), threadDetail: id => id === 'props' ? structuredClone(detail) : null, events: () => [],
    command: (command, identity) => {
      if (command.type === 'observe-threads' && command.threadIds.includes('props')) emit.current(structuredClone(detail))
      return base.command(command, identity)
    },
    subscribe: listener => base.subscribe(listener), subscribeThreadDetail: listener => { emit.current = listener; return () => undefined },
    supportsPluginAccountCopies: sounds !== undefined || models !== undefined,
    supportsPluginElevenLabsSounds: sounds !== undefined, ...(sounds ? { pluginElevenLabsSounds: sounds } : {}),
    supportsPluginMeshyModels: models !== undefined, ...(models ? { pluginMeshyModels: models } : {}),
  }
}
const visualKinds = (detail: unknown): (string | undefined)[] => (detail as AgentThreadDetail).messages.map(message => message.visual?.kind)
const resultOf = (peer: { messages: Record<string, unknown>[] }, id: string): unknown => (peer.messages.find(message => message.id === id) as { result: unknown }).result
const emitter = (): { current: (update: AgentThreadDetailUpdate) => void } => ({ current: () => undefined })

describe('a host’s sounds over its listener', () => {
  it('offers them only to a recorded desktop, keeps their lines for one that accepted them, answers its reads by ID and pushes it their news', async () => {
    const listeners = new Set<(news: SoundHostNews) => void>()
    const asked: string[] = []
    const sounds: HostSoundViews = {
      view: async id => id === 'narration' ? view : null,
      bytes: async (request, clientId) => { asked.push(`${request.id}:${clientId}`); return null },
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    }
    const known = new Set<string>()
    const server = await startSocketServer({ service: soundsHost(sounds, emitter(), noModels), pairing: fixture.host.pairing,
      watcherDesktops: { has: (clientId: string) => known.has(clientId), refresh: async () => undefined } })
    const recorded = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Desktop')
    const both = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Desktop with 3D models')
    const older = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Older desktop')
    const phonePairing = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Phone')
    known.add(recorded.clientId); known.add(both.clientId); known.add(older.clientId)
    const desktop = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(recorded.clientId))
    const withModels = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(both.clientId))
    const before = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(older.clientId))
    const phone = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(phonePairing.clientId))
    try {
      const hello = await desktop.call('hello', { op: 'hello', accepts: ['plugin-elevenlabs-sounds'] }) as { result: { features: string[] } }
      expect(hello.result.features).toEqual(expect.arrayContaining(['plugin-elevenlabs-sounds', 'plugin-elevenlabs-copies']))
      await withModels.call('hello', { op: 'hello', accepts: ['plugin-elevenlabs-sounds', 'plugin-meshy-models'] })
      await before.call('hello', { op: 'hello', accepts: [] })
      const phoneHello = await phone.call('hello', { op: 'hello', accepts: ['plugin-elevenlabs-sounds'] }) as { result: { features: string[] } }
      expect(phoneHello.result.features).not.toContain('plugin-elevenlabs-sounds')

      for (const peer of [desktop, withModels, before, phone]) await peer.call('read', { op: 'detail', threadId: 'props' })
      // The desktop keeps the sound's line alone; one that accepted 3D models too keeps both; the older desktop and the phone neither.
      expect(visualKinds(resultOf(desktop, 'read'))).toEqual([undefined, undefined, 'sound', undefined])
      expect(visualKinds(resultOf(withModels, 'read'))).toEqual([undefined, '3d-model', 'sound', undefined])
      expect(visualKinds(resultOf(before, 'read'))).toEqual([undefined, undefined, undefined, undefined])
      expect(visualKinds(resultOf(phone, 'read'))).toEqual([undefined, undefined, undefined, undefined])

      // The reads, by the host's IDs; an unknown ID has no view.
      expect(await desktop.call('view', { op: 'plugin-elevenlabs-sound', request: { id: 'narration' } })).toMatchObject({ ok: true, result: view })
      expect(await desktop.call('unknown', { op: 'plugin-elevenlabs-sound', request: { id: 'nothing' } })).toMatchObject({ ok: true, result: null })
      expect(await desktop.call('bytes', { op: 'plugin-elevenlabs-sound-bytes', request: { id: 'narration', offset: 0 } })).toMatchObject({ ok: true, result: null })
      expect(asked).toEqual([`narration:${recorded.clientId}`])
      // A path or anything else is not a request.
      expect(await desktop.call('path', { op: 'plugin-elevenlabs-sound-bytes', request: { id: 'narration', offset: 0, path: 'C:/secret.mp3' } })).toMatchObject({ ok: false })
      // A client that is not a recorded desktop may not read them.
      expect(await phone.call('view', { op: 'plugin-elevenlabs-sound', request: { id: 'narration' } })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
      expect(await phone.call('bytes', { op: 'plugin-elevenlabs-sound-bytes', request: { id: 'narration', offset: 0 } })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
      // Nor may a recorded desktop whose hello did not ask for sounds, words or bytes (Sol's review).
      expect(await before.call('view', { op: 'plugin-elevenlabs-sound', request: { id: 'narration' } })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
      expect(await before.call('bytes', { op: 'plugin-elevenlabs-sound-bytes', request: { id: 'narration', offset: 0 } })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
      expect(asked).toEqual([`narration:${recorded.clientId}`])

      // The news goes to the desktops that accepted it alone.
      for (const listener of listeners) listener({ threadId: 'props', view: { ...view, cost: 0.03 } })
      await expect.poll(() => desktop.messages.filter(message => message.event === 'plugin-elevenlabs-sounds').length).toBe(1)
      expect(desktop.messages.find(message => message.event === 'plugin-elevenlabs-sounds')).toEqual({ v: 1, event: 'plugin-elevenlabs-sounds', news: { threadId: 'props', view: { ...view, cost: 0.03 } } })
      await expect.poll(() => withModels.messages.some(message => message.event === 'plugin-elevenlabs-sounds')).toBe(true)
      await before.call('shell', { op: 'shell' }); await phone.call('shell', { op: 'shell' })
      expect([...before.messages, ...phone.messages].some(message => message.event === 'plugin-elevenlabs-sounds')).toBe(false)
    } finally { for (const peer of [desktop, withModels, before, phone]) peer.frames.close(); await server.close() }
  })

  it('sends a held thread again whole, with its sound’s line, once a desktop recorded after its hello reads a view', async () => {
    const sounds: HostSoundViews = { view: async () => null, bytes: async () => null, subscribe: () => () => undefined }
    const known = new Set<string>()
    let refreshed = 0
    const server = await startSocketServer({ service: soundsHost(sounds, emitter()), pairing: fixture.host.pairing,
      watcherDesktops: { has: (clientId: string) => known.has(clientId), refresh: async () => { refreshed += 1 } } })
    const added = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Desktop being added')
    const desktop = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(added.clientId))
    try {
      const hello = await desktop.call('hello', { op: 'hello', accepts: ['plugin-elevenlabs-sounds'] }) as { result: { features: string[] } }
      expect(hello.result.features).not.toContain('plugin-elevenlabs-sounds')
      await desktop.call('observe', { op: 'observe', threadIds: ['props'] })
      const details = () => desktop.messages.filter(message => message.event === 'detail') as { detail: unknown }[]
      await expect.poll(() => details().length).toBeGreaterThan(0)
      expect(visualKinds(details().at(-1)!.detail)).toEqual([undefined, undefined, undefined, undefined])
      // Not recorded yet: the record is read again, and the read refused.
      const atHello = refreshed
      expect(await desktop.call('early', { op: 'plugin-elevenlabs-sound', request: { id: '-' } })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
      expect(refreshed).toBe(atHello + 1)
      // Recorded now, as Settings does a moment after the hello; its first view turns its lines on.
      known.add(added.clientId)
      const before = details().length
      expect(await desktop.call('probe', { op: 'plugin-elevenlabs-sound', request: { id: '-' } })).toMatchObject({ ok: true, result: null })
      await expect.poll(() => details().length).toBeGreaterThan(before)
      expect(visualKinds(details().at(-1)!.detail)).toEqual([undefined, undefined, 'sound', undefined])
      // From then on the record is not read again for each view.
      await desktop.call('again', { op: 'plugin-elevenlabs-sound', request: { id: 'narration' } })
      expect(refreshed).toBe(atHello + 2)
    } finally { desktop.frames.close(); await server.close() }
  })

  it('sends no more sounds’ lines, whole or in a delta, to a desktop taken off the record while still paired', async () => {
    const sounds: HostSoundViews = { view: async () => null, bytes: async () => null, subscribe: () => () => undefined }
    const emit = emitter()
    const known = new Set<string>()
    const server = await startSocketServer({ service: soundsHost(sounds, emit), pairing: fixture.host.pairing,
      watcherDesktops: { has: (clientId: string) => known.has(clientId), refresh: async () => undefined } })
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Desktop')
    known.add(paired.clientId)
    const desktop = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(paired.clientId))
    try {
      await desktop.call('hello', { op: 'hello', accepts: ['plugin-elevenlabs-sounds', 'detail-delta'] })
      await desktop.call('kept', { op: 'detail', threadId: 'props' })
      expect(visualKinds(resultOf(desktop, 'kept'))).toEqual([undefined, undefined, 'sound', undefined])
      await desktop.call('observe', { op: 'observe', threadIds: ['props'] })
      await expect.poll(() => desktop.messages.some(message => message.event === 'detail')).toBe(true)
      known.delete(paired.clientId)
      await desktop.call('dropped', { op: 'detail', threadId: 'props' })
      expect(visualKinds(resultOf(desktop, 'dropped'))).toEqual([undefined, undefined, undefined, undefined])
      const another: AgentMessage = { ...soundLine, id: 'visual:sound-2', visual: { id: 'sound-2', title: 'Chime', kind: 'sound', source: 'chime' } }
      emit.current({ threadId: 'props', baseRevision: 1, revision: 2, messageDeltas: [{ message: another }], activityDeltas: [] })
      await expect.poll(() => desktop.messages.some(message => message.event === 'detail-delta')).toBe(true)
      const delta = desktop.messages.find(message => message.event === 'detail-delta') as { delta: { messageDeltas: { message: AgentMessage }[] } }
      expect(delta.delta.messageDeltas[0]!.message.visual).toBeUndefined()
    } finally { desktop.frames.close(); await server.close() }
  })

  it('offers nothing of it on a host that keeps no sounds, whose desktop is sent no sound’s line', async () => {
    const server = await startSocketServer({ service: soundsHost(undefined, emitter()), pairing: fixture.host.pairing,
      watcherDesktops: { has: () => true, refresh: async () => undefined } })
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Desktop')
    const desktop = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(paired.clientId))
    try {
      const hello = await desktop.call('hello', { op: 'hello', accepts: ['plugin-elevenlabs-sounds'] }) as { result: { features: string[] } }
      expect(hello.result.features).not.toContain('plugin-elevenlabs-sounds')
      await desktop.call('read', { op: 'detail', threadId: 'props' })
      expect(visualKinds(resultOf(desktop, 'read'))).toEqual([undefined, undefined, undefined, undefined])
      expect(await desktop.call('view', { op: 'plugin-elevenlabs-sound', request: { id: 'narration' } })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    } finally { desktop.frames.close(); await server.close() }
  })
})

describe('a sound’s line in a detail delta', () => {
  it('is kept for a reader that keeps sounds’ lines, beside 3D models’ for one that keeps both, and every other visual is stripped as before', () => {
    const delta = { threadId: 'props', baseRevision: 1, revision: 2, messageDeltas: [{ message: modelLine }, { message: soundLine }, { message: diagram }], activityDeltas: [] }
    const kinds = (made: typeof delta) => made.messageDeltas.map(item => 'message' in item ? item.message.visual?.kind : undefined)
    expect(kinds(deltaWithoutVisuals(delta, [SOUND_VISUAL_KIND]) as typeof delta)).toEqual([undefined, 'sound', undefined])
    expect(kinds(deltaWithoutVisuals(delta, [MODEL_VISUAL_KIND, SOUND_VISUAL_KIND]) as typeof delta)).toEqual(['3d-model', 'sound', undefined])
    expect(kinds(deltaWithoutVisuals(delta) as typeof delta)).toEqual([undefined, undefined, undefined])
  })
})

describe('a host’s sounds on the desktop’s connection', () => {
  const cleanups: (() => Promise<void>)[] = []
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

  /** An MP3 frame header and then `length` bytes of `fill`. */
  const mp3 = (length: number, fill = 1): Uint8Array => { const bytes = new Uint8Array(4 + length).fill(fill); bytes.set([0xff, 0xfb, 0x90, 0x64]); return bytes }
  const temporary = async (prefix: string): Promise<string> => {
    const made = await realpath(await mkdtemp(join(tmpdir(), prefix)))
    cleanups.push(async () => { if (dirname(made) === await realpath(tmpdir())) await rm(made, { recursive: true, force: true }) })
    return made
  }

  it('reads a view and an MP3 in two parts by keys that name the host, checked again here, and hears its news', async () => {
    const thread = await temporary('sotto-host-sounds-thread-')
    const outside = await temporary('sotto-host-sounds-outside-')
    await mkdir(join(thread, 'sounds')); await mkdir(join(outside, 'sounds'))
    // A little over one part, so it crosses the connection in two.
    const file = mp3(SOUND_HOST_PART_BYTES + 3_000, 5)
    await writeFile(join(thread, 'sounds', 'Opening narration.mp3'), file)
    await writeFile(join(outside, 'sounds', 'Chime.mp3'), mp3(50))
    const record = (id: string, name: string, folder: string): SoundRecord => ({ id, threadId: 'thread-on-forge', accountId: '55555555-5555-4555-8555-000000000001', kind: 'effect',
      name, folder: join(folder, 'sounds'), fileName: `${name}.mp3`, cost: 0.02, askedAt: at, state: 'made' })
    const records = [record('narration', 'Opening narration', thread), record('chime', 'Chime', outside)]
    const views = hostSoundViews({ sound: async id => records.find(item => item.id === id), folderOf: async () => thread })
    const known = new Set<string>()
    const server = await startSocketServer({ service: soundsHost(views, emitter()), pairing: fixture.host.pairing,
      watcherDesktops: { has: (clientId: string) => known.has(clientId), refresh: async () => undefined } })
    cleanups.push(async () => { views.close(); await server.close() })
    const url = 'http://127.0.0.1:' + server.descriptor.port
    const pairing = await SocketHostService.pair(url, fixture.host.pairing.issuePairingCode().code, 'Synthetic desktop')
    known.add(pairing.clientId)
    const socket = new SocketHostService({ url, token: pairing.token, expectedHostId: pairing.hostId, elevenLabsSounds: true })
    cleanups.push(async () => { await socket.close() })
    await socket.connect()
    expect(socket.supportsPluginElevenLabsSounds).toBe(true)
    const connection = { hostId: pairing.hostId, name: 'forge', kind: 'remote', service: socket, available: () => true } as unknown as DesktopHostConnection
    const changed: SoundView[] = []
    const sounds = new HostSounds({ connections: () => [connection], subscribeConnected: () => () => undefined, subscribeRemoved: () => () => undefined, localHostId: () => undefined,
      changed: item => { changed.push(item) } })
    cleanups.push(async () => { sounds.close() })
    const key = (id: string): string => hostEntityKey(pairing.hostId, id)

    await expect(sounds.view(key('narration'))).resolves.toMatchObject({ id: key('narration'), name: 'Opening narration', fileName: 'Opening narration.mp3', bytes: file.byteLength })
    await expect(sounds.view(key('nothing'))).resolves.toBeNull()
    // The MP3 comes in two parts and is whole; an unknown ID and a folder outside the thread's give nothing.
    const whole = await sounds.bytes(key('narration'))
    expect(whole && Buffer.from(whole).equals(Buffer.from(file))).toBe(true)
    await expect(sounds.bytes(key('nothing'))).resolves.toBeNull()
    await expect(sounds.bytes(key('chime'))).resolves.toBeNull()
    // A change reaches the window by its key.
    views.changed(records[0]!)
    await expect.poll(() => changed.length).toBe(1)
    expect(changed[0]).toMatchObject({ id: key('narration'), state: 'made' })
  })
})

describe('a real headless host’s sounds on the desktop', () => {
  const cleanups: (() => Promise<void>)[] = []
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

  /** A host on `version` whose records hold a sound made in a thread it does not hold, so it has no folder to read. */
  async function connected(version: string, options: { readonly recordAfterHello?: boolean } = {}, owlFeatures?: ReturnType<typeof holding>) {
    const root = await mkdtemp(join(tmpdir(), 'sotto-elevenlabs-sounds-host-'))
    const data = join(root, 'data')
    await mkdir(data, { recursive: true })
    await writeFile(join(data, 'sounds.json'), JSON.stringify({ version: 1, sounds: [{ id: 'narration', threadId: 'thread-on-forge', accountId: '55555555-5555-4555-8555-000000000001',
      kind: 'speech', name: 'Opening narration', folder: join(root, 'sounds'), fileName: 'Opening narration.mp3', cost: 0.02, askedAt: at, state: 'made' }] }))
    const keyFile = join(root, 'host.key')
    await writeFile(keyFile, 'made-up-host-key-of-enough-length')
    const host = await startFixtureHeadlessHost({ dataDirectory: data, port: 0, sottoVersion: version, keyFile, ...owlFeatures ? { owlFeatures } : {} })
    const url = 'http://127.0.0.1:' + host.descriptor!.port
    const pairing = await SocketHostService.pair(url, host.pairing.issuePairingCode().code, 'Synthetic desktop')
    if (!options.recordAfterHello) await writeFile(join(data, DESKTOP_CLIENTS_FILE), JSON.stringify([pairing.clientId]))
    const socket = new SocketHostService({ url, token: pairing.token, expectedHostId: pairing.hostId, elevenLabsSounds: true })
    cleanups.push(async () => { await socket.close(); await host.close(); if (dirname(root) === tmpdir()) await rm(root, { recursive: true, force: true }) })
    await socket.connect()
    // A host being added records its desktop a moment after the hello, as Settings does.
    if (options.recordAfterHello) await writeFile(join(data, DESKTOP_CLIENTS_FILE), JSON.stringify([pairing.clientId]))
    const connection = { hostId: pairing.hostId, name: 'forge', kind: 'remote', service: socket, available: () => true } as unknown as DesktopHostConnection
    const sounds = new HostSounds({ connections: () => [connection], subscribeConnected: () => () => undefined, subscribeRemoved: () => () => undefined, localHostId: () => undefined,
      changed: () => undefined })
    cleanups.push(async () => { sounds.close() })
    return { socket, sounds, key: (id: string) => hostEntityKey(pairing.hostId, id) }
  }

  it('views a sound by its key, and hands over no MP3 from a thread whose folder it cannot find', async () => {
    const c = await connected('0.1.38-owl.20261013.1')
    expect(c.socket.supportsPluginElevenLabsSounds).toBe(true)
    const found = await c.sounds.view(c.key('narration'))
    expect(found).toMatchObject({ id: c.key('narration'), name: 'Opening narration', state: 'made', fileName: 'Opening narration.mp3' })
    expect(found).not.toHaveProperty('bytes')
    await expect(c.sounds.bytes(c.key('narration'))).resolves.toBeNull()
  })

  it('shows a newly added host’s sounds on its first connection, whose desktop was recorded after its hello', async () => {
    const c = await connected('0.1.38-owl.20261013.1', { recordAfterHello: true })
    expect(c.socket.supportsPluginElevenLabsSounds).toBe(true)
    await expect.poll(() => (c.socket as unknown as { features: string[] }).features.includes('plugin-elevenlabs-sounds')).toBe(true)
    await expect(c.sounds.view(c.key('narration'))).resolves.toMatchObject({ id: c.key('narration') })
  })

  it('tells an older host apart: one without the feature shows nothing', async () => {
    // An older host's version holds Plugins, as stable did until November 17, 2026 (ADR-0072).
    const c = await connected('0.1.38', {}, holding('plugins'))
    expect(c.socket.supportsPluginElevenLabsSounds).toBe(false)
    expect(c.socket.pluginElevenLabsSounds).toBeUndefined()
    await expect(c.sounds.view(c.key('narration'))).resolves.toBeNull()
    await expect(c.sounds.bytes(c.key('narration'))).resolves.toBeNull()
  })
})
