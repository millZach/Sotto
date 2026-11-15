// @vitest-environment node
// A paired host's 3D models shown on a recorded desktop (the Meshy plan's ticket 6, part 2): the host's listener keeps a
// 3D model's line for that desktop alone, answers its reads and pushes its news; and a real headless host's views and
// bytes reach the desktop's connection, checked again there.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startSocketServer } from '../../src/host/socketServer'
import type { HostService } from '../../src/main/agents/hostService'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import type { DesktopHostConnection } from '../../src/main/hosts/desktopHostRouter'
import { HostModels3d } from '../../src/main/hosts/hostModels3d'
import type { AgentMessage, AgentThreadDetail, AgentThreadDetailUpdate } from '../../src/shared/agents'
import { hostEntityKey } from '../../src/shared/clientIdentity'
import { DESKTOP_CLIENTS_FILE } from '../../src/shared/desktopClients'
import { deltaWithoutVisuals } from '../../src/shared/hostProtocol'
import { MODEL_3D_HOST_PART_BYTES, MODEL_VISUAL_KIND, type HostModelViews, type Model3dHostNews, type Model3dView } from '../../src/shared/models3d'
import { startFixtureHeadlessHost } from '../fixtures/desktopHostStack'
import { glbBytes, selfContainedGlb } from '../fixtures/glb'
import { rawPeer } from '../fixtures/rawHostPeer'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'

const fixture = useSocketHostFixture()
const at = '2026-11-15T09:00:00.000Z'
const reply: AgentMessage = { id: 'reply', role: 'assistant', text: 'Made it.', createdAt: at }
const modelLine: AgentMessage = { id: 'visual:model', role: 'assistant', text: '3D model: Oak barrel. The 3D model is in Sotto on your computer.', createdAt: at,
  visual: { id: 'model', title: 'Oak barrel', kind: '3d-model', source: 'barrel' } }
const diagram: AgentMessage = { id: 'visual:flow', role: 'assistant', text: '**Flow**', createdAt: at, visual: { id: 'flow', title: 'Flow', kind: 'diagram', source: 'flowchart TD\n  A --> B' } }
const view: Model3dView = { id: 'barrel', name: 'Oak barrel', source: 'words', state: 'done', credits: 30, folder: 'models', files: [{ name: 'Oak barrel.glb', bytes: 100 }] }

/** The fixture host's service, with one thread holding a 3D model's line and a diagram, and 3D models as `views` says. */
function modelsHost(views: HostModelViews | undefined, emit: { current: (update: AgentThreadDetailUpdate) => void }): HostService {
  const base = fixture.host.service
  const detail: AgentThreadDetail = { threadId: 'props', revision: 1, messages: [reply, modelLine, diagram] }
  return {
    shell: () => base.shell(), state: () => base.state(), threadDetail: id => id === 'props' ? structuredClone(detail) : null, events: () => [],
    command: (command, identity) => {
      if (command.type === 'observe-threads' && command.threadIds.includes('props')) emit.current(structuredClone(detail))
      return base.command(command, identity)
    },
    subscribe: listener => base.subscribe(listener), subscribeThreadDetail: listener => { emit.current = listener; return () => undefined },
    supportsPluginAccountCopies: views !== undefined, supportsPluginMeshyModels: views !== undefined, ...(views ? { pluginMeshyModels: views } : {}),
  }
}
const visualKinds = (detail: unknown): (string | undefined)[] => (detail as AgentThreadDetail).messages.map(message => message.visual?.kind)

describe('a host’s 3D models over its listener', () => {
  it('keeps 3D models’ lines for a recorded desktop that accepted them, and every other visual from everyone', async () => {
    const listeners = new Set<(news: Model3dHostNews) => void>()
    const views: HostModelViews = {
      list: async () => [{ ...view, threadId: 'props', account: 'Studio', askedAt: at }], view: async id => id === 'barrel' ? view : null,
      bytes: async () => null, remove: async () => 'files-there', subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    }
    const emit: { current: (update: AgentThreadDetailUpdate) => void } = { current: () => undefined }
    const known = new Set<string>()
    const server = await startSocketServer({ service: modelsHost(views, emit), pairing: fixture.host.pairing,
      watcherDesktops: { has: (clientId: string) => known.has(clientId), refresh: async () => undefined } })
    const recorded = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Desktop')
    const older = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Older desktop')
    const phonePairing = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Phone')
    known.add(recorded.clientId); known.add(older.clientId)
    const desktop = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(recorded.clientId))
    const before = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(older.clientId))
    const phone = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(phonePairing.clientId))
    try {
      const hello = await desktop.call('hello', { op: 'hello', accepts: ['plugin-meshy-models'] }) as { result: { features: string[] } }
      expect(hello.result.features).toContain('plugin-meshy-models')
      await before.call('hello', { op: 'hello', accepts: [] })
      const phoneHello = await phone.call('hello', { op: 'hello', accepts: ['plugin-meshy-models'] }) as { result: { features: string[] } }
      expect(phoneHello.result.features).not.toContain('plugin-meshy-models')

      for (const peer of [desktop, before, phone]) await peer.call('read', { op: 'detail', threadId: 'props' })
      const read = (peer: typeof desktop) => visualKinds((peer.messages.find(message => message.id === 'read') as { result: unknown }).result)
      // The desktop keeps the 3D model's line and not the diagram; the older desktop and the phone keep neither.
      expect(read(desktop)).toEqual([undefined, '3d-model', undefined])
      expect(read(before)).toEqual([undefined, undefined, undefined])
      expect(read(phone)).toEqual([undefined, undefined, undefined])

      // The reads, by the host's IDs.
      expect(await desktop.call('list', { op: 'plugin-meshy-models', request: {} })).toMatchObject({ ok: true, result: [{ id: 'barrel', threadId: 'props' }] })
      expect(await desktop.call('view', { op: 'plugin-meshy-model', request: { id: 'barrel' } })).toMatchObject({ ok: true, result: view })
      expect(await desktop.call('remove', { op: 'plugin-meshy-model-remove', request: { id: 'barrel' } })).toMatchObject({ ok: true, result: 'files-there' })
      expect(await desktop.call('bytes', { op: 'plugin-meshy-model-bytes', request: { id: 'barrel', part: 'model', offset: 0 } })).toMatchObject({ ok: true, result: null })
      // Nobody else may read them.
      expect(await phone.call('list', { op: 'plugin-meshy-models', request: {} })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })

      // The news goes to the desktop that accepted it alone.
      for (const listener of listeners) listener({ changed: { threadId: 'props', view: { ...view, credits: 40 } }, removed: ['gone'] })
      await expect.poll(() => desktop.messages.filter(message => message.event === 'plugin-meshy-models').length).toBe(1)
      expect(desktop.messages.find(message => message.event === 'plugin-meshy-models')).toMatchObject({ news: { changed: { threadId: 'props', view: { credits: 40 } }, removed: ['gone'] } })
      await before.call('shell', { op: 'shell' }); await phone.call('shell', { op: 'shell' })
      expect([...before.messages, ...phone.messages].some(message => message.event === 'plugin-meshy-models')).toBe(false)
    } finally { desktop.frames.close(); before.frames.close(); phone.frames.close(); await server.close() }
  })

  it('sends a held thread again whole, with its 3D model’s line, once a desktop recorded after its hello lists them', async () => {
    // Bug Bot on #2617, L1.
    const views: HostModelViews = {
      list: async () => [{ ...view, threadId: 'props', account: 'Studio', askedAt: at }], view: async () => view,
      bytes: async () => null, remove: async () => 'files-there', subscribe: () => () => undefined,
    }
    const emit: { current: (update: AgentThreadDetailUpdate) => void } = { current: () => undefined }
    const known = new Set<string>()
    const server = await startSocketServer({ service: modelsHost(views, emit), pairing: fixture.host.pairing,
      watcherDesktops: { has: (clientId: string) => known.has(clientId), refresh: async () => undefined } })
    const added = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Desktop being added')
    const desktop = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(added.clientId))
    try {
      const hello = await desktop.call('hello', { op: 'hello', accepts: ['plugin-meshy-models'] }) as { result: { features: string[] } }
      expect(hello.result.features).not.toContain('plugin-meshy-models')
      await desktop.call('observe', { op: 'observe', threadIds: ['props'] })
      const details = () => desktop.messages.filter(message => message.event === 'detail') as { detail: unknown }[]
      await expect.poll(() => details().length).toBeGreaterThan(0)
      expect(visualKinds(details().at(-1)!.detail)).toEqual([undefined, undefined, undefined])
      // Recorded now, as Settings does a moment after the hello; its first list turns its lines on.
      known.add(added.clientId)
      const before = details().length
      expect(await desktop.call('list', { op: 'plugin-meshy-models', request: {} })).toMatchObject({ ok: true })
      await expect.poll(() => details().length).toBeGreaterThan(before)
      expect(visualKinds(details().at(-1)!.detail)).toEqual([undefined, '3d-model', undefined])
    } finally { desktop.frames.close(); await server.close() }
  })

  it('sends no more 3D models’ lines, whole or in a delta, to a desktop taken off the record while still paired', async () => {
    const views: HostModelViews = { list: async () => [], view: async () => null, bytes: async () => null, remove: async () => 'no-record', subscribe: () => () => undefined }
    const emit: { current: (update: AgentThreadDetailUpdate) => void } = { current: () => undefined }
    const known = new Set<string>()
    const server = await startSocketServer({ service: modelsHost(views, emit), pairing: fixture.host.pairing,
      watcherDesktops: { has: (clientId: string) => known.has(clientId), refresh: async () => undefined } })
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Desktop')
    known.add(paired.clientId)
    const desktop = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(paired.clientId))
    try {
      await desktop.call('hello', { op: 'hello', accepts: ['plugin-meshy-models', 'detail-delta'] })
      await desktop.call('kept', { op: 'detail', threadId: 'props' })
      expect(visualKinds((desktop.messages.find(message => message.id === 'kept') as { result: unknown }).result)).toEqual([undefined, '3d-model', undefined])
      await desktop.call('observe', { op: 'observe', threadIds: ['props'] })
      await expect.poll(() => desktop.messages.some(message => message.event === 'detail')).toBe(true)
      // The record of desktops is read again and no longer names it; it is still paired and still connected.
      known.delete(paired.clientId)
      await desktop.call('dropped', { op: 'detail', threadId: 'props' })
      expect(visualKinds((desktop.messages.find(message => message.id === 'dropped') as { result: unknown }).result)).toEqual([undefined, undefined, undefined])
      const another: AgentMessage = { ...modelLine, id: 'visual:model-2', visual: { id: 'model-2', title: 'Crate', kind: '3d-model', source: 'crate' } }
      emit.current({ threadId: 'props', baseRevision: 1, revision: 2, messageDeltas: [{ message: another }], activityDeltas: [] })
      await expect.poll(() => desktop.messages.some(message => message.event === 'detail-delta')).toBe(true)
      const delta = desktop.messages.find(message => message.event === 'detail-delta') as { delta: { messageDeltas: { message: AgentMessage }[] } }
      expect(delta.delta.messageDeltas[0]!.message.visual).toBeUndefined()
    } finally { desktop.frames.close(); await server.close() }
  })

  it('offers nothing of it on a host that keeps no copies, whose desktop is sent no 3D model’s line', async () => {
    const emit: { current: (update: AgentThreadDetailUpdate) => void } = { current: () => undefined }
    const server = await startSocketServer({ service: modelsHost(undefined, emit), pairing: fixture.host.pairing,
      watcherDesktops: { has: () => true, refresh: async () => undefined } })
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Desktop')
    const desktop = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(paired.clientId))
    try {
      const hello = await desktop.call('hello', { op: 'hello', accepts: ['plugin-meshy-models'] }) as { result: { features: string[] } }
      expect(hello.result.features).not.toContain('plugin-meshy-models')
      await desktop.call('read', { op: 'detail', threadId: 'props' })
      expect(visualKinds((desktop.messages.find(message => message.id === 'read') as { result: unknown }).result)).toEqual([undefined, undefined, undefined])
    } finally { desktop.frames.close(); await server.close() }
  })
})

describe('a computer’s 3D models on a paired phone (the Meshy plan’s ticket 7)', () => {
  /** The phone's views: one 3D model, the bytes asked for and by whom, and the listeners its news goes to. */
  function phoneViews() {
    const listeners = new Set<(news: Model3dHostNews) => void>()
    const asked: { part: string; clientId: string }[] = []
    const views: HostModelViews = {
      list: async () => { throw new Error('a phone lists none') }, view: async id => id === 'barrel' ? view : null,
      bytes: async (request, clientId) => { asked.push({ part: request.part, clientId }); return { data: Buffer.from('usdz').toString('base64'), total: 4, digest: 'a'.repeat(64) } },
      remove: async () => { throw new Error('a phone removes none') }, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    }
    return { views, asked, listeners }
  }

  it('keeps 3D models’ lines for a phone that accepted them, answers its view and bytes, and pushes it their news', async () => {
    const { views, asked, listeners } = phoneViews()
    const emit: { current: (update: AgentThreadDetailUpdate) => void } = { current: () => undefined }
    // The desktop's phone listener: its own threads, no host copies, and this computer's 3D models for phones.
    const server = await startSocketServer({ service: modelsHost(undefined, emit), pairing: fixture.host.pairing, admin: false, phoneModels: views })
    const newer = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Phone')
    const older = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Older phone')
    const phone = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(newer.clientId))
    const before = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(older.clientId))
    try {
      const hello = await phone.call('hello', { op: 'hello', accepts: ['plugin-meshy-phone'] }) as { result: { features: string[] } }
      expect(hello.result.features).toContain('plugin-meshy-phone')
      expect(hello.result.features).not.toContain('plugin-meshy-models')
      await before.call('hello', { op: 'hello', accepts: [] })

      // The phone keeps the 3D model's line and not the diagram, read whole and pushed as it observes; an older phone neither.
      for (const peer of [phone, before]) await peer.call('read', { op: 'detail', threadId: 'props' })
      const read = (peer: typeof phone) => visualKinds((peer.messages.find(message => message.id === 'read') as { result: unknown }).result)
      expect(read(phone)).toEqual([undefined, '3d-model', undefined])
      expect(read(before)).toEqual([undefined, undefined, undefined])
      await phone.call('observe', { op: 'observe', threadIds: ['props'] })
      await expect.poll(() => phone.messages.some(message => message.event === 'detail')).toBe(true)
      expect(visualKinds((phone.messages.find(message => message.event === 'detail') as { detail: unknown }).detail)).toEqual([undefined, '3d-model', undefined])

      // Its reads: the view, and the still picture and USDZ, for itself. No GLB, no list, no removal.
      expect(await phone.call('view', { op: 'plugin-meshy-model', request: { id: 'barrel' } })).toMatchObject({ ok: true, result: view })
      expect(await phone.call('usdz', { op: 'plugin-meshy-model-bytes', request: { id: 'barrel', part: 'usdz', offset: 0 } })).toMatchObject({ ok: true, result: { total: 4 } })
      expect(await phone.call('still', { op: 'plugin-meshy-model-bytes', request: { id: 'barrel', part: 'still', offset: 0 } })).toMatchObject({ ok: true })
      expect(asked).toEqual([{ part: 'usdz', clientId: newer.clientId }, { part: 'still', clientId: newer.clientId }])
      for (const [id, request] of [['glb', { op: 'plugin-meshy-model-bytes', request: { id: 'barrel', part: 'model', offset: 0 } }], ['list', { op: 'plugin-meshy-models', request: {} }],
        ['remove', { op: 'plugin-meshy-model-remove', request: { id: 'barrel' } }]] as const) {
        expect(await phone.call(id, request)).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
      }
      // An older phone reads nothing of them.
      expect(await before.call('view', { op: 'plugin-meshy-model', request: { id: 'barrel' } })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
      expect(await before.call('usdz', { op: 'plugin-meshy-model-bytes', request: { id: 'barrel', part: 'usdz', offset: 0 } })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })

      // The news goes to the phone that accepted it alone.
      for (const listener of listeners) listener({ changed: { threadId: 'props', view: { ...view, credits: 40 } }, removed: ['gone'] })
      await expect.poll(() => phone.messages.filter(message => message.event === 'plugin-meshy-models').length).toBe(1)
      expect(phone.messages.find(message => message.event === 'plugin-meshy-models')).toMatchObject({ news: { changed: { view: { credits: 40 } }, removed: ['gone'] } })
      await before.call('shell', { op: 'shell' })
      expect(before.messages.some(message => message.event === 'plugin-meshy-models')).toBe(false)
    } finally { phone.frames.close(); before.frames.close(); await server.close() }
  })

  it('offers phones nothing of it on a listener that keeps no 3D models, and a desktop never reads a USDZ', async () => {
    const emit: { current: (update: AgentThreadDetailUpdate) => void } = { current: () => undefined }
    const server = await startSocketServer({ service: modelsHost(undefined, emit), pairing: fixture.host.pairing, admin: false })
    const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Phone')
    const phone = await rawPeer(server.descriptor.port, fixture.host.pairing.signSession(paired.clientId))
    const { views } = phoneViews()
    const known = new Set<string>()
    // A headless host keeping 3D models for its phones; its recorded desktop accepts both features (Sol on ticket 7).
    const host = await startSocketServer({ service: modelsHost(views, emit), pairing: fixture.host.pairing, phoneModels: views,
      watcherDesktops: { has: (clientId: string) => known.has(clientId), refresh: async () => undefined } })
    const recorded = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Desktop')
    known.add(recorded.clientId)
    const desktop = await rawPeer(host.descriptor.port, fixture.host.pairing.signSession(recorded.clientId))
    try {
      const hello = await phone.call('hello', { op: 'hello', accepts: ['plugin-meshy-phone'] }) as { result: { features: string[] } }
      expect(hello.result.features).not.toContain('plugin-meshy-phone')
      await phone.call('read', { op: 'detail', threadId: 'props' })
      expect(visualKinds((phone.messages.find(message => message.id === 'read') as { result: unknown }).result)).toEqual([undefined, undefined, undefined])
      const both = await desktop.call('hello', { op: 'hello', accepts: ['plugin-meshy-models', 'plugin-meshy-phone'] }) as { result: { features: string[] } }
      expect(both.result.features).toContain('plugin-meshy-phone')
      expect(await desktop.call('usdz', { op: 'plugin-meshy-model-bytes', request: { id: 'barrel', part: 'usdz', offset: 0 } })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    } finally { phone.frames.close(); desktop.frames.close(); await server.close(); await host.close() }
  })
})

describe('a 3D model’s line in a detail delta', () => {
  it('is kept for a reader that keeps 3D models’ lines, and every other visual is stripped as before', () => {
    const delta = { threadId: 'props', baseRevision: 1, revision: 2, messageDeltas: [{ message: modelLine }, { message: diagram }], activityDeltas: [] }
    const kinds = (made: typeof delta) => made.messageDeltas.map(item => 'message' in item ? item.message.visual?.kind : undefined)
    expect(kinds(deltaWithoutVisuals(delta, MODEL_VISUAL_KIND) as typeof delta)).toEqual(['3d-model', undefined])
    expect(kinds(deltaWithoutVisuals(delta) as typeof delta)).toEqual([undefined, undefined])
    // A delta with nothing to strip goes as it is.
    const plain = { ...delta, messageDeltas: [{ message: modelLine }] }
    expect(deltaWithoutVisuals(plain, MODEL_VISUAL_KIND)).toBe(plain)
  })
})

describe('a real headless host’s 3D models on the desktop', () => {
  const cleanups: (() => Promise<void>)[] = []
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

  /** A host on `version` whose records hold a finished barrel in its thread's folder and a crate whose folder is outside it. */
  async function connected(version: string, options: { readonly recordAfterHello?: boolean } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'sotto-meshy-models-host-'))
    const data = join(root, 'data')
    const thread = await realpath(await mkdtemp(join(tmpdir(), 'sotto-meshy-models-thread-')))
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'sotto-meshy-models-outside-')))
    await mkdir(data, { recursive: true }); await mkdir(join(thread, 'models')); await mkdir(join(outside, 'models'))
    // A little over one part, so it crosses the connection in two.
    const glb = glbBytes({ asset: { version: '2.0' } }, new Uint8Array(MODEL_3D_HOST_PART_BYTES + 4_000).fill(3))
    await writeFile(join(thread, 'models', 'Oak barrel.glb'), glb)
    await writeFile(join(outside, 'models', 'Crate.glb'), selfContainedGlb())
    const record = (id: string, name: string, folder: string, askedAt: string) => ({ id, threadId: 'thread-on-forge', accountId: '22222222-2222-4222-8222-000000000001', name,
      source: { kind: 'words' }, root: thread, folder, formats: ['glb'], state: 'done', credits: 30, askedAt, files: [`${name}.glb`], job: {} })
    await writeFile(join(data, '3d-models.json'), JSON.stringify({ version: 1, models: [
      record('barrel', 'Oak barrel', join(thread, 'models'), '2026-11-15T10:00:00.000Z'), record('crate', 'Crate', join(outside, 'models'), '2026-11-15T09:00:00.000Z')] }))
    const keyFile = join(root, 'host.key')
    await writeFile(keyFile, 'made-up-host-key-of-enough-length')
    const host = await startFixtureHeadlessHost({ dataDirectory: data, port: 0, sottoVersion: version, keyFile })
    const url = 'http://127.0.0.1:' + host.descriptor!.port
    const pairing = await SocketHostService.pair(url, host.pairing.issuePairingCode().code, 'Synthetic desktop')
    if (!options.recordAfterHello) await writeFile(join(data, DESKTOP_CLIENTS_FILE), JSON.stringify([pairing.clientId]))
    const socket = new SocketHostService({ url, token: pairing.token, expectedHostId: pairing.hostId, meshyModels: true })
    cleanups.push(async () => {
      await socket.close(); await host.close()
      for (const made of [root, thread, outside]) if (dirname(made) === await realpath(tmpdir()) || dirname(made) === tmpdir()) await rm(made, { recursive: true, force: true })
    })
    await socket.connect()
    // A host being added records its desktop a moment after the hello, as Settings does.
    if (options.recordAfterHello) await writeFile(join(data, DESKTOP_CLIENTS_FILE), JSON.stringify([pairing.clientId]))
    const connection = { hostId: pairing.hostId, name: 'forge', kind: 'remote', service: socket, available: () => true } as unknown as DesktopHostConnection
    const changed: Model3dView[] = []
    const models = new HostModels3d({ connections: () => [connection], subscribeConnected: () => () => undefined, subscribeRemoved: () => () => undefined, localHostId: () => undefined,
      changed: item => { changed.push(item) }, removed: () => undefined })
    cleanups.push(async () => { models.close() })
    return { socket, models, glb, thread, key: (id: string) => hostEntityKey(pairing.hostId, id), hostId: pairing.hostId }
  }

  it('lists, views and draws them by keys that name the host, and removes a record only once its files are gone', async () => {
    const c = await connected('0.1.38-owl.20261013.1')
    expect(c.socket.supportsPluginMeshyModels).toBe(true)
    const listed = await c.models.list()
    expect(listed.map(model => [model.id, model.threadId, model.computer])).toEqual([
      [c.key('barrel'), c.key('thread-on-forge'), 'forge'], [c.key('crate'), c.key('thread-on-forge'), 'forge']])
    expect(await c.models.list(c.key('thread-on-forge'))).toHaveLength(2)
    expect(await c.models.list(c.key('another-thread'))).toEqual([])
    await expect(c.models.view(c.key('barrel'))).resolves.toMatchObject({ id: c.key('barrel'), name: 'Oak barrel', files: [{ name: 'Oak barrel.glb', bytes: c.glb.byteLength }] })

    // The GLB comes in two parts and is whole; an unknown ID and a folder outside the thread's give nothing.
    const bytes = await c.models.bytes({ id: c.key('barrel'), part: 'model' })
    expect(bytes && Buffer.from(bytes).equals(Buffer.from(c.glb))).toBe(true)
    await expect(c.models.bytes({ id: c.key('nothing'), part: 'model' })).resolves.toBeNull()
    await expect(c.models.bytes({ id: c.key('crate'), part: 'model' })).resolves.toBeNull()

    // Remove from 3D models refuses while the files are there, and removes the record, and no file, once they are gone.
    await expect(c.models.remove(c.key('barrel'))).resolves.toBe('files-there')
    await rm(join(c.thread, 'models', 'Oak barrel.glb'))
    await expect(c.models.remove(c.key('barrel'))).resolves.toBe('removed')
    expect((await c.models.list()).map(model => model.id)).toEqual([c.key('crate')])
  })

  it('shows a newly added host’s 3D models on its first connection, whose desktop was recorded after its hello', async () => {
    // Bug Bot on #2617, L1: the hello listed no 3D models; the host's health did.
    const c = await connected('0.1.38-owl.20261013.1', { recordAfterHello: true })
    expect(c.socket.supportsPluginMeshyModels).toBe(true)
    expect((await c.models.list()).map(model => model.id)).toEqual([c.key('barrel'), c.key('crate')])
    const bytes = await c.models.bytes({ id: c.key('barrel'), part: 'model' })
    expect(bytes && Buffer.from(bytes).equals(Buffer.from(c.glb))).toBe(true)
  })

  it('tells an older host apart: one without the feature lists nothing and draws nothing', async () => {
    const c = await connected('0.1.38')
    expect(c.socket.supportsPluginMeshyModels).toBe(false)
    expect(c.socket.pluginMeshyModels).toBeUndefined()
    await expect(c.models.list()).resolves.toEqual([])
    await expect(c.models.view(c.key('barrel'))).resolves.toBeNull()
    await expect(c.models.bytes({ id: c.key('barrel'), part: 'model' })).resolves.toBeNull()
    await expect(c.models.remove(c.key('barrel'))).resolves.toBe('away')
  })
})
