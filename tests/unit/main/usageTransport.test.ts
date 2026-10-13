// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { DesktopHostRouter, type DesktopHostConnection } from '../../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { LocalHostService, desktopWindowClient, type HostUsageReads } from '../../../src/main/agents/hostService'
import { SocketHostService } from '../../../src/main/agents/socketHostService'
import { registerUsageIpc } from '../../../src/main/agents/usageIpc'
import { hostRequestSchema } from '../../../src/shared/hostProtocol'
import { USAGE_READ, USAGE_REFRESH, USAGE_CLEAR, type UsageBridge, type UsageLocalHostRead } from '../../../src/shared/usageDashboard'
import { ipcRegistry } from '../../fixtures/ipcHarness'

const LOCAL = '11111111-1111-4111-8111-111111111111'
const REMOTE = '22222222-2222-4222-8222-222222222222'
const metadata = { startedAt: '2026-10-12T12:00:00.000Z', revision: 1, generation: 0, legacySeedCompleted: true }
const knownZero = { value: 0, knownRows: 1, rows: 1, partial: false }
const aggregate = { tokens: { input: knownZero, output: knownZero, cached: knownZero, cacheWrite: knownZero, cacheWrite5m: knownZero, cacheWrite1h: knownZero, total: knownZero },
  prompts: { user: 2, watcher: 0, wakeUp: 0, total: 2, steered: 0 }, tokenRecords: 1, partialTokenRecords: 0, undatedTokenRecords: 1, activeThreads: 1, activeDays: 1 }
const result: UsageLocalHostRead = { status: 'ready', quotas: [{ providerId: 'codex', status: 'available', refreshable: true, windows: [{ id: 'primary', label: 'Current period', kind: 'primary', usedPercent: 0 }] }],
  activity: { metadata, timeZone: 'UTC', totals: aggregate, providers: [{ providerId: 'codex', ...aggregate }],
    models: [{ providerId: 'codex', modelId: 'same-local-model', ...aggregate }], modelCount: 1, modelsTruncated: false, daily: [], dailyCoverage: 'not-requested', hourly: [] } }
function connection(hostId: string, overrides: Partial<DesktopHostConnection['service']> = {}): DesktopHostConnection {
  const state = emptyDesktopState(hostId)
  return { hostId, name: hostId, kind: 'remote', service: {
    shell: () => state, command: vi.fn(async () => state), subscribe: () => () => undefined,
    supportsUsage: true, usageRead: vi.fn(async () => result), usageRefresh: vi.fn(async () => result),
    usageClear: vi.fn(async () => ({ status: 'stale' as const, metadata })), ...overrides,
  }, detail: () => null, preview: () => null }
}

describe('Usage routing', () => {
  it('keeps same local model identities and quotas separate by owning host; excludes desktop hostIds from local requests', async () => {
    const router = new DesktopHostRouter(emptyDesktopState)
    const first = connection(LOCAL), second = connection(REMOTE)
    router.add(first); router.add(second)
    try {
      const query = { hostIds: [LOCAL, REMOTE], providerIds: ['codex' as const], from: '2026-10-01', timeZone: 'America/Los_Angeles' }
      const answer = await router.usageRead(query)
      expect(answer.hosts).toEqual([{ hostId: LOCAL, ...result }, { hostId: REMOTE, ...result }])
      for (const service of [first.service, second.service]) expect(service.usageRead).toHaveBeenCalledWith({ providerIds: ['codex'], from: query.from, timeZone: query.timeZone })
      expect(await router.usageRefresh({ hostIds: [REMOTE], providerIds: ['grok'] })).toEqual({ hosts: [{ hostId: REMOTE, ...result }] })
      expect(second.service.usageRefresh).toHaveBeenCalledWith(['grok'])
    } finally { router.dispose() }
  })
  it('returns partial failures, saved offline hosts and unsupported connections without a wire call', async () => {
    const router = new DesktopHostRouter(emptyDesktopState)
    const first = connection(LOCAL), old = connection(REMOTE, { supportsUsage: false })
    router.add(first); router.add(old)
    router.setUsageSavedHosts(['saved-offline'])
    try {
      expect((await router.usageRead({})).hosts.map(host => [host.hostId, host.status])).toEqual([[LOCAL, 'ready'], [REMOTE, 'unsupported'], ['saved-offline', 'offline']])
      expect(old.service.usageRead).not.toHaveBeenCalled()
      router.replace(connection(REMOTE, { usageRead: vi.fn(async () => { throw new Error('private provider detail') }) }))
      const partial = await router.usageRead({})
      expect(partial.hosts.map(host => host.status)).toEqual(['ready', 'error', 'offline'])
      expect(JSON.stringify(partial)).not.toContain('private provider detail')
    } finally { router.dispose() }
  })
  it('discards an in-flight reading when a host reconnects and reads the new connection next time', async () => {
    const router = new DesktopHostRouter(emptyDesktopState)
    let finish!: (reading: UsageLocalHostRead) => void
    const delayed = new Promise<UsageLocalHostRead>(resolve => { finish = resolve })
    const previous = connection(REMOTE, { usageRead: vi.fn(() => delayed) })
    const fresh = { ...result, activity: { ...result.activity!, metadata: { ...metadata, revision: 2 } } }
    const reconnected = connection(REMOTE, { usageRead: vi.fn(async () => fresh) })
    router.add(connection(LOCAL)); router.add(previous)
    try {
      const pending = router.usageRead({ hostIds: [LOCAL, REMOTE] })
      await expect.poll(() => vi.mocked(previous.service.usageRead!).mock.calls.length).toBe(1)
      router.replace(reconnected)
      finish(result)
      expect(await pending).toEqual({ hosts: [{ hostId: LOCAL, ...result }, { hostId: REMOTE, status: 'offline', quotas: [] }] })
      expect(reconnected.service.usageRead).not.toHaveBeenCalled()
      expect(await router.usageRead({ hostIds: [REMOTE] })).toEqual({ hosts: [{ hostId: REMOTE, ...fresh }] })
      expect(previous.service.usageRead).toHaveBeenCalledTimes(1)
      expect(reconnected.service.usageRead).toHaveBeenCalledTimes(1)
    } finally { finish(result); router.dispose() }
  })
  it('bounds concurrency, validates response schemas and leaves slow hosts independently unavailable', async () => {
    const router = new DesktopHostRouter(emptyDesktopState)
    let active = 0, peak = 0
    for (let i = 0; i < 9; i++) router.add(connection(`host-${i}`, { usageRead: vi.fn(async () => {
      active++; peak = Math.max(peak, active); await Promise.resolve(); active--; return result
    }) }))
    try {
      expect((await router.usageRead({})).hosts).toHaveLength(9)
      expect(peak).toBe(4)
      router.replace(connection('host-0', { usageRead: vi.fn(async () => ({ ...result, text: 'not numeric' } as UsageLocalHostRead)) }))
      expect((await router.usageRead({ hostIds: ['host-0', 'host-1'] })).hosts.map(host => host.status)).toEqual(['error', 'ready'])
      vi.useFakeTimers()
      router.replace(connection('host-0', { usageRead: vi.fn(() => new Promise<UsageLocalHostRead>(() => undefined)) }))
      const pending = router.usageRead({ hostIds: ['host-0', 'host-1'] })
      await vi.advanceTimersByTimeAsync(20000)
      expect((await pending).hosts.map(host => host.status)).toEqual(['error', 'ready'])
    } finally { vi.useRealTimers(); router.dispose() }
  })
  it('forwards only each host revision and refuses duplicate clear targets before mutating', async () => {
    const router = new DesktopHostRouter(emptyDesktopState), first = connection(LOCAL), second = connection(REMOTE)
    router.add(first); router.add(second)
    try {
      const client = desktopWindowClient('owner')
      expect(await router.usageClear({ hosts: [{ hostId: LOCAL, expectedRevision: 1 }, { hostId: REMOTE, expectedRevision: 5 }] }, client)).toEqual([
        { hostId: LOCAL, status: 'stale', metadata }, { hostId: REMOTE, status: 'stale', metadata },
      ])
      expect(first.service.usageClear).toHaveBeenCalledWith({ expectedRevision: 1 }, client)
      expect(second.service.usageClear).toHaveBeenCalledWith({ expectedRevision: 5 }, client)
      await expect(router.usageClear({ hosts: [{ hostId: LOCAL, expectedRevision: 1 }, { hostId: LOCAL, expectedRevision: 1 }] })).rejects.toThrow('each computer once')
      expect(first.service.usageClear).toHaveBeenCalledTimes(1)
    } finally { router.dispose() }
  })
})

describe('Usage transport boundary', () => {
  it('keeps LocalHostService disabled without its startup dependency and applies authoritative clear checks', async () => {
    const state = emptyDesktopState(LOCAL)
    const control = { get: () => state, shell: () => state, threadDetail: () => null, subscribe: () => () => undefined, commandShell: vi.fn(async () => state) }
    const disabled = new LocalHostService({ control })
    expect(disabled.supportsUsage).toBe(false)
    await expect(disabled.usageRead({})).rejects.toThrow('unavailable')
    const usage: HostUsageReads = { read: vi.fn(async () => result), refresh: vi.fn(async () => result), clear: vi.fn(async () => ({ status: 'stale' as const, metadata })) }
    const enabled = new LocalHostService({ control, usage })
    expect(enabled.supportsUsage).toBe(true)
    await expect(enabled.usageClear({ expectedRevision: 1 }, { clientId: 'paired', transport: 'socket', user: '' })).rejects.toThrow('not allowed')
    expect(usage.clear).not.toHaveBeenCalled()
    await enabled.usageClear({ expectedRevision: 1 }, desktopWindowClient())
    const granted = new LocalHostService({ control, usage, mayClearUsage: client => client.clientId === 'granted' })
    await granted.usageClear({ expectedRevision: 1 }, { clientId: 'granted', transport: 'socket', user: '' })
    expect(usage.clear).toHaveBeenCalledTimes(2)
  })
  it('does not send usage requests to old hosts and strictly validates negotiated replies', async () => {
    const client = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'paired' }), call = vi.fn(async () => result)
    Object.assign(client, { features: [], call })
    expect(client.supportsUsage).toBe(false)
    await expect(client.usageRead({})).rejects.toThrow('different version')
    await expect(client.usageRefresh()).rejects.toThrow('different version')
    await expect(client.usageClear({ expectedRevision: 1 }, desktopWindowClient())).rejects.toThrow('different version')
    expect(call).not.toHaveBeenCalled()
    Object.assign(client, { features: ['usage-dashboard'] })
    expect(await client.usageRead({ timeZone: 'UTC' })).toEqual(result)
    expect(call).toHaveBeenLastCalledWith({ op: 'usage-read', query: { timeZone: 'UTC' } }, undefined, undefined, 15000)
    call.mockResolvedValue({ ...result, activity: { text: 'bad reply' } } as never)
    await expect(client.usageRead({})).rejects.toThrow()
  })
  it('adds strict optional v1 operations without changing old operations', () => {
    const base = { v: 1, id: 'request', session: 'authenticated' }
    expect(hostRequestSchema.safeParse({ ...base, op: 'shell' }).success).toBe(true)
    expect(hostRequestSchema.safeParse({ ...base, op: 'usage-read', query: { timeZone: 'UTC', providerIds: ['codex'] } }).success).toBe(true)
    expect(hostRequestSchema.safeParse({ ...base, op: 'usage-read', query: { hostIds: [LOCAL] } }).success).toBe(false)
    expect(hostRequestSchema.safeParse({ ...base, op: 'usage-refresh', providerIds: Array(5).fill('codex') }).success).toBe(false)
    expect(hostRequestSchema.safeParse({ ...base, op: 'usage-clear', request: { expectedRevision: 1, approved: true } }).success).toBe(false)
  })
  it('registers nothing on stable and authorizes bounded main-window requests before invoking the service', async () => {
    const { ipc, handlers, main, widgetEvent, mainEvent } = ipcRegistry()
    const bridge: UsageBridge = { read: vi.fn(async () => ({ hosts: [] })), refresh: vi.fn(async () => ({ hosts: [] })), clear: vi.fn(async () => []) }
    registerUsageIpc(ipc, bridge, () => [main], false)()
    expect(handlers.size).toBe(0)
    const close = registerUsageIpc(ipc, bridge, () => [main], true)
    for (const channel of [USAGE_READ, USAGE_REFRESH, USAGE_CLEAR]) {
      const request = channel === USAGE_CLEAR ? { hosts: [{ hostId: LOCAL, expectedRevision: 1 }] } : {}
      await handlers.get(channel)!(mainEvent, request)
      expect(() => handlers.get(channel)!(widgetEvent, request)).toThrow('main Sotto window')
      expect(() => handlers.get(channel)!(mainEvent, request, 'extra')).toThrow()
      expect(() => handlers.get(channel)!(mainEvent, { ...request, nativeId: 'private' })).toThrow()
    }
    expect(bridge.read).toHaveBeenCalledOnce(); expect(bridge.refresh).toHaveBeenCalledOnce(); expect(bridge.clear).toHaveBeenCalledOnce()
    close(); expect(handlers.size).toBe(0)
  })
})
