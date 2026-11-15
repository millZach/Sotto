// @vitest-environment node
// A paired host's 3D models on the desktop (the Meshy plan's ticket 6, part 2): what main keeps of them for while the host
// is away, against a removal that lands while a read is on its way, and against the router letting the host go.
import { describe, expect, it, vi } from 'vitest'
import { SocketHostService } from '../../../src/main/agents/socketHostService'
import { DesktopHostRouter, type DesktopHostConnection } from '../../../src/main/hosts/desktopHostRouter'
import { HostModels3d } from '../../../src/main/hosts/hostModels3d'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import type { HostModelViews, Model3dHostNews, Model3dListed, Model3dView } from '../../../src/shared/models3d'

const FORGE = '33333333-3333-4333-8333-000000000001'
const KEY = hostEntityKey(FORGE, 'barrel')
const VIEW: Model3dView = { id: 'barrel', name: 'Oak barrel', source: 'words', state: 'done', credits: 30, folder: 'models', files: [{ name: 'Oak barrel.glb', bytes: 100 }] }
const LISTED: Model3dListed = { ...VIEW, threadId: 'thread-1', account: 'Studio', askedAt: '2026-11-15T10:00:00.000Z' }

function later<Value>(): { readonly promise: Promise<Value>; readonly settle: (value: Value) => void } {
  let settle: (value: Value) => void = () => undefined
  return { promise: new Promise<Value>(done => { settle = done }), settle }
}

/** Forge's connection, whose 3D models `views` answers, as the router holds it; `up` says whether it is connected. */
function forge(views: HostModelViews, up: { value: boolean }): DesktopHostConnection {
  const state = emptyDesktopState(FORGE)
  state.host.connected = true; state.connection = 'connected'
  const service = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'paired-token', catchUpEvents: false, meshyModels: true })
  Object.assign(service, { cached: state, features: ['plugin-meshy-models'] })
  Object.defineProperty(service, 'pluginMeshyModels', { value: views })
  return { hostId: FORGE, name: 'forge', kind: 'remote', service, detail: async () => null, preview: () => null, available: () => up.value }
}

/** Views whose reads the test answers, and whose news it sends. */
function hostViews() {
  const news = new Set<(item: Model3dHostNews) => void>()
  const stop = vi.fn()
  const views = {
    list: vi.fn(async (): Promise<Model3dListed[]> => [LISTED]), view: vi.fn(async (): Promise<Model3dView | null> => VIEW),
    bytes: async () => null, remove: async () => 'files-there' as const,
    subscribe: (listener: (item: Model3dHostNews) => void) => { news.add(listener); return () => { stop(); news.delete(listener) } },
  } satisfies HostModelViews
  return { views, stop, tell: (item: Model3dHostNews) => { for (const listener of news) listener(item) } }
}

function models(connections: () => DesktopHostConnection[], router?: DesktopHostRouter) {
  const changed = vi.fn(), removed = vi.fn()
  const made = new HostModels3d({ connections, localHostId: () => undefined, changed, removed,
    subscribeConnected: listener => router?.subscribeConnected(listener) ?? (() => undefined),
    subscribeRemoved: listener => router?.subscribeRemoved(listener) ?? (() => undefined) })
  return { made, changed, removed }
}

describe('a host’s 3D models kept on the desktop', () => {
  it('puts back no view a read brought after its record went, and says nothing of it once the host is away', async () => {
    const host = hostViews(), up = { value: true }
    const connection = forge(host.views, up)
    const { made } = models(() => [connection])
    const reading = later<Model3dView | null>()
    host.views.view.mockImplementationOnce(() => reading.promise)
    const read = made.view(KEY)
    // The record goes while the read is on its way, and the read then answers with what it found before.
    host.tell({ removed: ['barrel'] })
    reading.settle(VIEW)
    await expect(read).resolves.toBeNull()
    up.value = false
    await expect(made.view(KEY)).resolves.toBeNull()
  })

  it('lists no record that went while the list was read, and keeps none of it', async () => {
    const host = hostViews(), up = { value: true }
    const connection = forge(host.views, up)
    const { made } = models(() => [connection])
    const reading = later<Model3dListed[]>()
    host.views.list.mockImplementationOnce(() => reading.promise)
    const listing = made.list()
    host.tell({ removed: ['barrel'] })
    reading.settle([LISTED])
    await expect(listing).resolves.toEqual([])
    up.value = false
    await expect(made.view(KEY)).resolves.toBeNull()
  })

  it('lets go of a change the host sent after the record’s removal', () => {
    const host = hostViews()
    const connection = forge(host.views, { value: true })
    const { changed, removed } = models(() => [connection])
    host.tell({ removed: ['barrel'] })
    host.tell({ changed: { threadId: 'thread-1', view: { ...VIEW, credits: 40 } } })
    expect(removed).toHaveBeenCalledWith([KEY])
    expect(changed).not.toHaveBeenCalled()
  })

  it('stops hearing a host the router lets go, and drops what it kept of it', async () => {
    const router = new DesktopHostRouter(emptyDesktopState)
    const host = hostViews()
    router.add(forge(host.views, { value: true }))
    const { made } = models(() => [...router.remoteConnections()], router)
    await expect(made.view(KEY)).resolves.toMatchObject({ id: KEY })
    router.remove(FORGE)
    expect(host.stop).toHaveBeenCalledTimes(1)
    await expect(made.view(KEY)).resolves.toBeNull()
    made.close()
  })
})
