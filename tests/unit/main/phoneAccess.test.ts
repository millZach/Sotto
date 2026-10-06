// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HostService } from '../../../src/main/agents/hostService'
import { PhoneAccess, type PhoneAccessOptions, type PhoneAccessTailscale } from '../../../src/main/phones/phoneAccess'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import { serveTarget, type ServeConfig, type ServeResult, type TailscaleStatus } from '../../../src/main/phones/tailscale'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'sotto-phone-access-')) })
afterEach(async () => { if (dirname(root) === tmpdir() && root.includes('sotto-phone-access-')) await rm(root, { recursive: true, force: true }) })

const DNS = 'laptop-russh2j5.tail5728ca.ts.net'
/** A stand-in Tailscale: its Serve setting is one proxy on 8443, or someone else's. */
function fakeTailscale(options: { status?: TailscaleStatus; other?: string; serve?: ServeResult } = {}) {
  let status: TailscaleStatus = options.status ?? { state: 'running', dnsName: DNS, hostName: 'laptop-russh2j5' }
  let proxy: string | undefined = options.other
  const calls: string[] = []
  const tailscale: PhoneAccessTailscale = {
    status: vi.fn(async () => { calls.push('status'); return status }),
    serveStatus: vi.fn(async (): Promise<ServeConfig> => { calls.push('serve-status'); return proxy ? { TCP: { 8443: { HTTPS: true } }, Web: { [`${DNS}:8443`]: { Handlers: { '/': { Proxy: proxy } } } } } : {} }),
    serve: vi.fn(async (_port: number, loopback: number): Promise<ServeResult> => { calls.push(`serve ${loopback}`); const result = options.serve ?? { ok: true }; if (result.ok) proxy = serveTarget(loopback); return result }),
    unserve: vi.fn(async () => { calls.push('unserve'); proxy = undefined; return true }),
  }
  return { tailscale, calls, proxy: () => proxy, setStatus: (next: TailscaleStatus) => { status = next }, setOther: (target: string) => { proxy = target } }
}
/** A stand-in listener: its port, the clients connected to it, and whether it was closed. */
function fakeServer(options: { refusePort?: number } = {}) {
  const started: { port: number; closed: boolean; name: () => string | undefined; admin: unknown; onPaired?: (id: string) => void }[] = []
  let next = 41000
  const startServer = vi.fn(async (input: { port?: number; name?: () => string | undefined; admin?: boolean; onPaired?: (id: string) => void }) => {
    if (input.port !== undefined && input.port !== 0 && input.port === options.refusePort) throw Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })
    const port = input.port || next++
    const entry = { port, closed: false, name: input.name!, admin: input.admin, ...(input.onPaired ? { onPaired: input.onPaired } : {}) }
    started.push(entry)
    return { descriptor: { port }, connectedClients: () => [], dropRevoked: vi.fn(), refreshCapabilities: vi.fn(), stopServing: () => { entry.closed = true }, close: async () => { entry.closed = true } }
  })
  return { startServer: startServer as unknown as NonNullable<PhoneAccessOptions['startServer']>, started }
}
function create(options: Partial<PhoneAccessOptions> & { tailscale: PhoneAccessTailscale }, settings = { phoneAccess: true, phoneAccessName: '' }) {
  const current = { ...settings }
  const access = new PhoneAccess({ directory: root, service: {} as HostService, settings: () => current, openExternal: vi.fn(async () => undefined), hostname: () => 'LAPTOP', retryMs: 60_000, ...options })
  return { access, settings: current }
}
const record = async () => JSON.parse(await readFile(join(root, 'phone-access.json'), 'utf8')) as { port: number | null; mapped: boolean }

it('turns on: checks Tailscale, opens a loopback listener with no admin routes, then asks Serve for 8443', async () => {
  const fake = fakeTailscale(), server = fakeServer()
  const { access } = create({ tailscale: fake.tailscale, startServer: server.startServer })
  await access.start()
  expect(fake.calls).toEqual(['status', 'serve-status', 'serve 41000'])
  expect(server.started).toMatchObject([{ port: 41000, closed: false, admin: false }])
  expect(access.get()).toMatchObject({ enabled: true, phase: 'on', tailscale: { status: 'ok', dnsName: DNS }, serve: { status: 'ok' }, address: `https://${DNS}:8443`, computerName: 'laptop-russh2j5' })
  expect(await record()).toEqual({ port: 41000, mapped: true })
  await access.close()
})

it('honours tailnetConnections only when told which clients are desktops, so a desktop’s settings file never raises its phone listener', async () => {
  const fake = fakeTailscale(), server = fakeServer()
  // The desktop's own phone access: a hand-edited settings file naming the headless host's setting changes nothing.
  const desktop = create({ tailscale: fake.tailscale, startServer: server.startServer }, { phoneAccess: false, phoneAccessName: '', tailnetConnections: true } as { phoneAccess: boolean; phoneAccessName: string })
  await desktop.access.start()
  expect(server.started).toEqual([])
  expect(fake.calls).toEqual([])
  expect(desktop.access.get()).toMatchObject({ enabled: false, phase: 'off' })
  await desktop.access.close()

  // A headless host's, told its desktops: the listener and Serve come up for them with phone access off.
  const host = create({ tailscale: fake.tailscale, startServer: server.startServer, listener: { desktops: { refresh: async () => undefined, has: () => false } } },
    { phoneAccess: false, phoneAccessName: '', tailnetConnections: true } as { phoneAccess: boolean; phoneAccessName: string })
  // A watcher, which the host's descriptor follows, is told the brief state as each change lands.
  const briefs: unknown[] = []
  host.access.watch(brief => briefs.push(brief))
  await host.access.start()
  expect(server.started).toHaveLength(1)
  expect(host.access.get()).toMatchObject({ enabled: false, phase: 'on' })
  expect(host.access.brief()).toEqual({ enabled: false, phase: 'on', address: `https://${DNS}:8443`, phones: 0 })
  expect(briefs.at(-1)).toEqual(host.access.brief())
  await host.access.close()
})

it('turns off: removes only its own Serve setting and closes the listener, so phones lose their sockets', async () => {
  const fake = fakeTailscale(), server = fakeServer()
  const { access, settings } = create({ tailscale: fake.tailscale, startServer: server.startServer })
  await access.start()
  settings.phoneAccess = false
  access.settingsChanged()
  await expect(access.command({ type: 'show-code' })).rejects.toThrow('Turn on Let phones connect first')
  await vi.waitFor(() => expect(access.get().phase).toBe('off'))
  expect(fake.calls.slice(3)).toEqual(['serve-status', 'unserve'])
  expect(server.started[0]!.closed).toBe(true)
  expect(await record()).toEqual({ port: 41000, mapped: false })
  expect(access.get()).toMatchObject({ address: null, tailscale: { status: 'waiting' }, serve: { status: 'waiting' } })
})

it('leaves another app’s setting on 8443 alone, and says the port is taken', async () => {
  const fake = fakeTailscale({ other: 'http://127.0.0.1:3773' }), server = fakeServer()
  const { access, settings } = create({ tailscale: fake.tailscale, startServer: server.startServer })
  await access.start()
  expect(access.get()).toMatchObject({ phase: 'failed', tailscale: { status: 'ok' }, serve: { status: 'failed', reason: 'port-taken' }, address: null })
  expect(fake.tailscale.serve).not.toHaveBeenCalled()
  expect(server.started).toEqual([])
  settings.phoneAccess = false
  access.settingsChanged()
  await vi.waitFor(() => expect(access.get().phase).toBe('off'))
  expect(fake.tailscale.unserve).not.toHaveBeenCalled()
  expect(fake.proxy()).toBe('http://127.0.0.1:3773')
})

it('does not remove a setting someone else put on 8443 after Sotto’s, when phone access turns off', async () => {
  const fake = fakeTailscale(), server = fakeServer()
  const { access, settings } = create({ tailscale: fake.tailscale, startServer: server.startServer })
  await access.start()
  fake.setOther('http://127.0.0.1:3773')
  settings.phoneAccess = false
  access.settingsChanged()
  await vi.waitFor(() => expect(access.get().phase).toBe('off'))
  expect(fake.tailscale.unserve).not.toHaveBeenCalled()
  expect(server.started[0]!.closed).toBe(true)
})

it('says Tailscale is not running, changes nothing, and looks again later', async () => {
  vi.useFakeTimers()
  try {
    const fake = fakeTailscale({ status: { state: 'not-running' } }), server = fakeServer()
    const { access } = create({ tailscale: fake.tailscale, startServer: server.startServer })
    await access.start()
    expect(access.get()).toMatchObject({ phase: 'failed', tailscale: { status: 'failed', reason: 'not-running' }, serve: { status: 'waiting' } })
    expect(fake.tailscale.serveStatus).not.toHaveBeenCalled()
    expect(server.started).toEqual([])
    fake.setStatus({ state: 'running', dnsName: DNS, hostName: 'laptop-russh2j5' })
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(access.get().phase).toBe('on'))
    await access.close()
  } finally { vi.useRealTimers() }
})

it('shows the consent page when the tailnet has not turned Serve on, closes the listener, and opens the page only when asked', async () => {
  const enableUrl = 'https://login.tailscale.com/f/serve?node=abc'
  const fake = fakeTailscale({ serve: { ok: false, reason: 'not-enabled', enableUrl } }), server = fakeServer()
  const openExternal = vi.fn(async () => undefined)
  const { access } = create({ tailscale: fake.tailscale, startServer: server.startServer, openExternal })
  await access.start()
  expect(access.get()).toMatchObject({ phase: 'failed', serve: { status: 'failed', reason: 'not-enabled', canOpenSetup: true } })
  expect(JSON.stringify(access.get())).not.toContain('login.tailscale.com')
  expect(server.started[0]!.closed).toBe(true)
  expect(await record()).toMatchObject({ mapped: false })
  expect(openExternal).not.toHaveBeenCalled()
  await access.command({ type: 'open-serve-setup' })
  expect(openExternal).toHaveBeenCalledWith(enableUrl)
})

it('does nothing while the local host is off, and says so', async () => {
  const fake = fakeTailscale(), server = fakeServer()
  const { access } = create({ tailscale: fake.tailscale, startServer: server.startServer, service: undefined })
  await access.start()
  expect(access.get()).toMatchObject({ enabled: true, localHostRunning: false, phase: 'off', phones: [] })
  expect(fake.calls).toEqual([])
  expect(server.started).toEqual([])
})

it('never runs Tailscale at start when phone access is off and left nothing behind', async () => {
  const fake = fakeTailscale(), server = fakeServer()
  const { access } = create({ tailscale: fake.tailscale, startServer: server.startServer }, { phoneAccess: false, phoneAccessName: '' })
  await access.start()
  expect(fake.calls).toEqual([])
  expect(access.get()).toMatchObject({ phase: 'off', computerName: 'LAPTOP', defaultName: 'LAPTOP' })
})

it('removes a setting a crash left behind at the next start when phone access is off', async () => {
  await writeFile(join(root, 'phone-access.json'), JSON.stringify({ port: 41000, mapped: true }))
  const fake = fakeTailscale({ other: serveTarget(41000) }), server = fakeServer()
  const { access } = create({ tailscale: fake.tailscale, startServer: server.startServer }, { phoneAccess: false, phoneAccessName: '' })
  await access.start()
  expect(fake.calls).toEqual(['serve-status', 'unserve'])
  expect(await record()).toEqual({ port: 41000, mapped: false })
})

it('reuses the remembered port, so a setting a crash left is still its own, and falls back to any free one', async () => {
  await writeFile(join(root, 'phone-access.json'), JSON.stringify({ port: 45000, mapped: true }))
  const fake = fakeTailscale({ other: serveTarget(45000) }), server = fakeServer({ refusePort: 45000 })
  const { access } = create({ tailscale: fake.tailscale, startServer: server.startServer })
  await access.start()
  expect(access.get().phase).toBe('on')
  expect(server.startServer).toHaveBeenCalledTimes(2)
  expect(fake.proxy()).toBe(serveTarget(41000))
  expect(await record()).toEqual({ port: 41000, mapped: true })
  await access.close()
})

it('removes the Serve setting and closes the listener on quit, and keeps the setting for the next start', async () => {
  const fake = fakeTailscale(), server = fakeServer()
  const { access, settings } = create({ tailscale: fake.tailscale, startServer: server.startServer })
  await access.start()
  await access.close()
  expect(fake.proxy()).toBeUndefined()
  expect(server.started[0]!.closed).toBe(true)
  expect(settings.phoneAccess).toBe(true)
  expect(await record()).toEqual({ port: 41000, mapped: false })
})

it('serves the name phones show: the setting, or the Tailscale machine name', async () => {
  const fake = fakeTailscale(), server = fakeServer()
  const { access, settings } = create({ tailscale: fake.tailscale, startServer: server.startServer })
  await access.start()
  expect(server.started[0]!.name()).toBe('laptop-russh2j5')
  settings.phoneAccessName = 'Studio'
  access.settingsChanged()
  expect(server.started[0]!.name()).toBe('Studio')
  expect(access.get()).toMatchObject({ computerName: 'Studio', defaultName: 'laptop-russh2j5' })
  await access.close()
})

it('shows one pairing code at a time, only while phones can connect, and forgets it once a phone redeems it', async () => {
  const fake = fakeTailscale(), server = fakeServer()
  const { access, settings } = create({ tailscale: fake.tailscale, startServer: server.startServer }, { phoneAccess: false, phoneAccessName: '' })
  await access.start()
  await expect(access.command({ type: 'show-code' })).rejects.toThrow('Turn on Let phones connect first')
  settings.phoneAccess = true
  access.settingsChanged()
  await vi.waitFor(() => expect(access.get().phase).toBe('on'))
  const first = (await access.command({ type: 'show-code' })).code!
  expect(first.code).toMatch(/^[2-9A-HJKMNP-TV-Z]{8}$/u)
  expect(Date.parse(first.expiresAt) - Date.now()).toBeGreaterThan(4 * 60_000)
  const second = (await access.command({ type: 'show-code' })).code!
  expect(second.code).not.toBe(first.code)
  server.started[0]!.onPaired!('client')
  expect(access.get().code).toBeNull()
  await access.command({ type: 'show-code' })
  expect((await access.command({ type: 'cancel-code' })).code).toBeNull()
  await access.close()
})

it('keeps the listener shut when paired phones cannot be read, and never replaces them', async () => {
  await writeFile(join(root, 'paired-clients.json'), 'not json')
  const fake = fakeTailscale(), server = fakeServer()
  const { access } = create({ tailscale: fake.tailscale, startServer: server.startServer })
  await access.start()
  expect(access.get()).toMatchObject({ phase: 'failed', serve: { status: 'failed', reason: 'listener' }, phones: [] })
  expect(server.started).toEqual([])
  expect(fake.tailscale.serve).not.toHaveBeenCalled()
  expect(await readFile(join(root, 'paired-clients.json'), 'utf8')).toBe('not json')
})

it('removes a setting of its own left by a crash when a start then fails, so 8443 never points at a dead port', async () => {
  await writeFile(join(root, 'phone-access.json'), JSON.stringify({ port: 45000, mapped: true }))
  const fake = fakeTailscale({ other: serveTarget(45000), serve: { ok: false, reason: 'failed' } }), server = fakeServer({ refusePort: 45000 })
  const { access } = create({ tailscale: fake.tailscale, startServer: server.startServer })
  await access.start()
  expect(access.get()).toMatchObject({ phase: 'failed', serve: { status: 'failed', reason: 'failed' } })
  expect(fake.proxy()).toBeUndefined()
  expect(server.started.every(entry => entry.closed)).toBe(true)
  expect(await record()).toMatchObject({ mapped: false })
})

it.each(['status', 'remove'] as const)('retries unfinished cleanup after a %s failure with the host protocol stopped', async failure => {
  vi.useFakeTimers()
  const fake = fakeTailscale(), server = fakeServer()
  const { access, settings } = create({ tailscale: fake.tailscale, startServer: server.startServer })
  try {
    await access.start()
    if (failure === 'status') vi.mocked(fake.tailscale.serveStatus).mockRejectedValueOnce(new Error('unavailable'))
    else vi.mocked(fake.tailscale.unserve).mockResolvedValueOnce(false)
    settings.phoneAccess = false
    access.settingsChanged()
    await access.command({ type: 'cancel-code' })
    await vi.waitFor(() => expect(access.get().phase).toBe('cleanup-failed'))
    expect(server.started[0]!.closed).toBe(true)
    expect(await record()).toMatchObject({ mapped: true })
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(access.get().phase).toBe('off'))
    expect(server.started[0]!.closed).toBe(true)
    expect(fake.proxy()).toBeUndefined()
  } finally { await access.close(); vi.useRealTimers() }
})

it('ends phone access when quit cleanup is unfinished', async () => {
  const fake = fakeTailscale(), server = fakeServer()
  const { access } = create({ tailscale: fake.tailscale, startServer: server.startServer })
  await access.start()
  vi.mocked(fake.tailscale.unserve).mockResolvedValue(false)
  await access.close()
  expect(access.get().phase).toBe('cleanup-failed')
  expect(server.started[0]!.closed).toBe(true)
  expect(await record()).toMatchObject({ mapped: true })
})


it('requires a saved phone access record before setup and recovers on retry', async () => {
  const fake = fakeTailscale(), server = fakeServer()
  const { access } = create({ tailscale: fake.tailscale, startServer: server.startServer })
  const originalWrite = AtomicJsonStore.prototype.write
  let refuse = true
  const write = vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(function (this: AtomicJsonStore<unknown>, value: unknown) {
    if (refuse && typeof value === 'object' && value !== null && 'mapped' in value) {
      refuse = false
      return Promise.reject(new Error('unavailable'))
    }
    return originalWrite.call(this, value)
  })
  try {
    await access.start()
    expect(access.get()).toMatchObject({ phase: 'failed', serve: { status: 'failed', reason: 'record' }, address: null })
    expect(fake.tailscale.serve).not.toHaveBeenCalled()
    expect(server.started[0]!.closed).toBe(true)
    expect(fake.tailscale.unserve).not.toHaveBeenCalled()
    await access.command({ type: 'retry' })
    expect(access.get().phase).toBe('on')
    expect(await record()).toMatchObject({ mapped: true })
  } finally { write.mockRestore(); await access.close() }
})


async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}
async function expectReserved(port: number): Promise<void> {
  const server = createServer()
  await expect(new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })).rejects.toMatchObject({ code: 'EADDRINUSE' })
  await new Promise<void>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    socket.on('error', reject)
    socket.on('close', () => resolve())
  })
}

it.each([false, true])('reserves pending cleanup at restart with phone access set to %s', async enabled => {
  const port = await freePort()
  await writeFile(join(root, 'phone-access.json'), JSON.stringify({ port, mapped: true }))
  const fake = fakeTailscale({ other: serveTarget(port) }), server = fakeServer()
  vi.mocked(fake.tailscale.unserve).mockResolvedValue(false)
  const { access, settings } = create({ tailscale: fake.tailscale, startServer: server.startServer }, { phoneAccess: enabled, phoneAccessName: '' })
  try {
    await access.start()
    expect(access.get().phase).toBe('cleanup-failed')
    expect(server.started).toEqual([])
    await expectReserved(port)
    settings.phoneAccess = false
    vi.mocked(fake.tailscale.unserve).mockResolvedValue(true)
    await access.command({ type: 'retry' })
    expect(access.get().phase).toBe('off')
    const rebound = createServer()
    await new Promise<void>(resolve => rebound.listen(port, '127.0.0.1', resolve))
    await new Promise<void>(resolve => rebound.close(() => resolve()))
  } finally { await access.close() }
})

it('keeps cleanup pending after a setup failure while the setting remains on', async () => {
  const fake = fakeTailscale(), server = fakeServer()
  const { access } = create({ tailscale: fake.tailscale, startServer: server.startServer })
  vi.mocked(fake.tailscale.serve).mockImplementationOnce(async (_servePort, loopback) => {
    fake.setOther(serveTarget(loopback))
    return { ok: false, reason: 'failed' }
  })
  vi.mocked(fake.tailscale.unserve).mockResolvedValueOnce(false)
  try {
    await access.start()
    expect(access.get()).toMatchObject({ enabled: true, phase: 'cleanup-failed' })
    expect(server.started[0]!.closed).toBe(true)
    expect(await record()).toMatchObject({ mapped: true })
    await access.command({ type: 'retry' })
    expect(access.get().phase).toBe('on')
  } finally { await access.close() }
})

it('preserves a valid cleanup record until read access returns', async () => {
  const port = await freePort()
  await writeFile(join(root, 'phone-access.json'), JSON.stringify({ port, mapped: true }))
  const fake = fakeTailscale({ other: serveTarget(port) })
  const { access } = create({ tailscale: fake.tailscale }, { phoneAccess: false, phoneAccessName: '' })
  const peek = vi.spyOn(AtomicJsonStore.prototype, 'peek').mockRejectedValue(Object.assign(new Error('unavailable'), { code: 'EACCES' }))
  // Writes remain available while reads are refused.
  const write = vi.spyOn(AtomicJsonStore.prototype, 'write')
  try {
    await access.start()
    await access.command({ type: 'retry' })
    expect(access.get()).toMatchObject({ phase: 'cleanup-failed', serve: { reason: 'cleanup-record' } })
    expect(await record()).toEqual({ port, mapped: true })
    expect(write.mock.calls.some(([value]) => typeof value === 'object' && value !== null && 'mapped' in value)).toBe(false)
    expect(fake.tailscale.unserve).not.toHaveBeenCalled()
    peek.mockRestore()
    await access.command({ type: 'retry' })
    expect(fake.tailscale.unserve).toHaveBeenCalledOnce()
    expect(access.get().phase).toBe('off')
    expect(await record()).toEqual({ port, mapped: false })
  } finally { peek.mockRestore(); write.mockRestore(); await access.close() }
})

it('preserves pending cleanup across restart when a recovery write is refused', async () => {
  const path = join(root, 'phone-access.json')
  await writeFile(path, 'not json')
  const fake = fakeTailscale({ other: serveTarget(41000) })
  const { access } = create({ tailscale: fake.tailscale }, { phoneAccess: false, phoneAccessName: '' })
  const originalWrite = AtomicJsonStore.prototype.write
  let refused = false
  const write = vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(function (this: AtomicJsonStore<unknown>, value: unknown) {
    if (!refused && typeof value === 'object' && value !== null && 'mapped' in value) {
      refused = true
      return Promise.reject(new Error('unavailable'))
    }
    return originalWrite.call(this, value)
  })
  let restarted: PhoneAccess | undefined
  try {
    await access.start()
    expect(access.get()).toMatchObject({ phase: 'cleanup-failed', serve: { reason: 'cleanup-record' } })
    expect(await readFile(path, 'utf8')).toBe('not json')
    expect(refused).toBe(true)
    // A fresh instance reads the durable state before the first instance retries.
    restarted = create({ tailscale: fake.tailscale }, { phoneAccess: false, phoneAccessName: '' }).access
    vi.mocked(fake.tailscale.serveStatus).mockClear()
    await restarted.start()
    expect(fake.tailscale.serveStatus).toHaveBeenCalledOnce()
    expect(restarted.get()).toMatchObject({ enabled: false, phase: 'cleanup-failed', serve: { reason: 'cleanup-record' } })
    expect(await record()).toEqual({ port: null, mapped: true })
    const writes = write.mock.calls.length
    await restarted.command({ type: 'retry' })
    expect(write.mock.calls.length).toBe(writes + 1)
    expect(fake.tailscale.unserve).not.toHaveBeenCalled()
    vi.mocked(fake.tailscale.serveStatus).mockResolvedValue({})
    await restarted.command({ type: 'retry' })
    expect(restarted.get().phase).toBe('off')
  } finally { write.mockRestore(); await access.close(); await restarted?.close() }
})

it.each(['corrupt', 'unreadable'])('checks cleanup rather than declaring an occupied mapping another app’s with a %s record', async kind => {
  await writeFile(join(root, 'phone-access.json'), 'not json')
  const read = kind === 'unreadable' ? vi.spyOn(AtomicJsonStore.prototype, 'peek').mockRejectedValueOnce(new Error('unreadable')) : undefined
  const fake = fakeTailscale({ other: serveTarget(41000) }), server = fakeServer()
  const { access } = create({ tailscale: fake.tailscale, startServer: server.startServer })
  try {
    await access.start()
    expect(fake.tailscale.serveStatus).toHaveBeenCalled()
    expect(access.get()).toMatchObject({ phase: 'cleanup-failed', serve: { reason: 'cleanup-record' } })
    expect(server.started).toEqual([])
    expect(fake.tailscale.unserve).not.toHaveBeenCalled()
    expect(await record()).toEqual({ port: null, mapped: true })
    await access.close()
    const restarted = create({ tailscale: fake.tailscale, startServer: server.startServer }).access
    await restarted.start()
    expect(restarted.get()).toMatchObject({ phase: 'cleanup-failed', serve: { reason: 'cleanup-record' } })
    await writeFile(join(root, 'phone-access.json'), JSON.stringify({ port: 41000, mapped: true }))
    await restarted.command({ type: 'retry' })
    expect(fake.tailscale.unserve).toHaveBeenCalled()
    expect(restarted.get().phase).toBe('on')
    await restarted.close()
  } finally { read?.mockRestore(); await access.close() }
})


it.each([false, true])('stops phone access during pending setup and follows a later turn-on choice of %s', async turnBackOn => {
  const fake = fakeTailscale(), server = fakeServer()
  const { access, settings } = create({ tailscale: fake.tailscale, startServer: server.startServer })
  let finish!: () => void, reached!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  const requested = new Promise<void>(resolve => { reached = resolve })
  vi.mocked(fake.tailscale.serve).mockImplementationOnce(async (_servePort, loopback) => {
    fake.setOther(serveTarget(loopback))
    reached()
    await pending
    return { ok: true }
  })
  const starting = access.start()
  try {
    await requested
    settings.phoneAccess = false
    access.settingsChanged()
    expect(server.started[0]!.closed).toBe(true)
    await expect(access.command({ type: 'show-code' })).rejects.toThrow('Turn on Let phones connect first')
    if (turnBackOn) { settings.phoneAccess = true; access.settingsChanged() }
    finish()
    await starting
    await vi.waitFor(() => expect(access.get().phase).toBe(turnBackOn ? 'on' : 'off'))
    expect(server.started).toHaveLength(turnBackOn ? 2 : 1)
    if (turnBackOn) expect(server.started[1]!.closed).toBe(false)
  } finally { finish(); await starting; await access.close() }
})


it('finishes cleanup of a recognized setting when a new record cannot be saved', async () => {
  await writeFile(join(root, 'phone-access.json'), JSON.stringify({ port: 41000, mapped: false }))
  const fake = fakeTailscale({ other: serveTarget(41000) }), server = fakeServer()
  const { access } = create({ tailscale: fake.tailscale, startServer: server.startServer })
  const original = AtomicJsonStore.prototype.write
  const write = vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(function (this: AtomicJsonStore<unknown>, value: unknown) {
    if (typeof value === 'object' && value !== null && 'mapped' in value && value.mapped === true) return Promise.reject(new Error('unavailable'))
    return original.call(this, value)
  })
  try {
    await access.start()
    expect(access.get()).toMatchObject({ phase: 'failed', serve: { reason: 'record' } })
    expect(fake.tailscale.serve).not.toHaveBeenCalled()
    expect(fake.tailscale.unserve).toHaveBeenCalledOnce()
    expect(fake.proxy()).toBeUndefined()
    expect(server.started[0]!.closed).toBe(true)
  } finally { write.mockRestore(); await access.close() }
})

it('shares a pairing store already loaded, as a headless host does, so a phone pairs into the host’s one set of clients', async () => {
  const { PairedClients } = await import('../../../src/main/agents/pairing')
  const pairing = new PairedClients(root)
  await pairing.load()
  const fake = fakeTailscale(), server = fakeServer()
  const policy = { mayGrant: () => ({ allowed: false }), setRemoteAnswers: vi.fn() }
  const { access } = create({ tailscale: fake.tailscale, startServer: server.startServer, pairing, policy })
  await access.start()
  // A desktop paired with the same host is no phone: it is never listed, and the dialog cannot remove it.
  const desktop = await pairing.redeem(pairing.issuePairingCode().code, 'Sotto desktop')
  const shown = await access.command({ type: 'show-code' })
  expect(shown.code).not.toBeNull()
  const phone = await pairing.redeem(shown.code!.code, 'Zach’s iPhone')
  server.started[0]!.onPaired!(phone.clientId)
  expect(access.get().phones).toMatchObject([{ name: 'Zach’s iPhone' }])
  await expect(access.command({ type: 'remove', clientId: desktop.clientId })).rejects.toThrow('no longer paired')
  await expect(access.command({ type: 'set-can-answer', clientId: desktop.clientId, allowed: true })).rejects.toThrow('no longer paired')
  expect(policy.setRemoteAnswers).not.toHaveBeenCalled()
  expect(pairing.list().map(client => client.name)).toEqual(['Sotto desktop', 'Zach’s iPhone'])
  await access.close()
  // The phones are remembered across a restart.
  const again = create({ tailscale: fake.tailscale, startServer: fakeServer().startServer, pairing })
  await again.access.start()
  expect(again.access.get().phones.map(item => item.name)).toEqual(['Zach’s iPhone'])
  await again.access.command({ type: 'remove', clientId: phone.clientId })
  expect(again.access.get().phones).toEqual([])
  await again.access.close()
})

it('says Tailscale refused this account when it will not show or change Serve, and changes nothing', async () => {
  const { TailscaleAccessDenied } = await import('../../../src/main/phones/tailscale')
  const refused = fakeTailscale(), server = fakeServer()
  refused.tailscale.serveStatus = vi.fn(async () => { throw new TailscaleAccessDenied('denied') })
  const { access } = create({ tailscale: refused.tailscale, startServer: server.startServer })
  await access.start()
  expect(access.get()).toMatchObject({ phase: 'failed', serve: { status: 'failed', reason: 'denied' }, address: null })
  expect(refused.tailscale.serve).not.toHaveBeenCalled()
  await access.close()

  const denied = fakeTailscale({ serve: { ok: false, reason: 'denied' } })
  const second = create({ tailscale: denied.tailscale, startServer: fakeServer().startServer })
  await second.access.start()
  expect(second.access.get()).toMatchObject({ phase: 'failed', serve: { status: 'failed', reason: 'denied' } })
  // A refusal set nothing up, so nothing is left for cleanup to take away.
  expect(await record()).toMatchObject({ mapped: false })
  expect(denied.tailscale.unserve).not.toHaveBeenCalled()
  await second.access.close()
})

it('hands back the page Tailscale gave for turning Serve on, only while setup stopped there', async () => {
  const fake = fakeTailscale({ serve: { ok: false, reason: 'not-enabled', enableUrl: 'https://login.tailscale.com/f/serve?node=abc' } })
  const { access } = create({ tailscale: fake.tailscale, startServer: fakeServer().startServer })
  await access.start()
  expect(access.serveSetupUrl()).toBe('https://login.tailscale.com/f/serve?node=abc')
  const other = create({ tailscale: fakeTailscale().tailscale, startServer: fakeServer().startServer })
  await other.access.start()
  expect(other.access.serveSetupUrl()).toBeUndefined()
  await access.close(); await other.access.close()
})
