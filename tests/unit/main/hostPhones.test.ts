// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { HOST_PHONES_WATCH_MS, HostPhones, type HostPhonesLink } from '../../../src/main/hosts/hostPhones'
import { ADMIN_IDLE_MS, AdminConnection, type PressConnection } from '../../../src/main/hosts/adminConnection'
import type { SshHostConnection } from '../../../src/main/hosts/sshLauncher'
import type { PhonesState } from '../../../src/shared/phones'

const HOST_ID = '11111111-1111-4111-8111-111111111111'
const ID = '22222222-2222-4222-8222-222222222222'
const state = (patch: Partial<PhonesState> = {}): PhonesState => ({
  enabled: false, localHostRunning: true, phase: 'off', tailscale: { status: 'waiting' }, serve: { status: 'waiting' }, address: null,
  computerName: 'forge', defaultName: 'forge', code: null, phones: [], answersAvailable: true, ...patch,
})

/** A connected host behind a stand-in for the forwarded port: what each request asked for, and what the host says next. */
function fixture() {
  let tokens = 0
  const sshConnection = (): PressConnection => ({ url: 'http://127.0.0.1:4500', hostId: HOST_ID, hostAdminToken: vi.fn(async () => `token-${++tokens}-0000000000000000`) }) as unknown as PressConnection
  const connection = sshConnection()
  /** What each request goes over: the connection the host is on, until a test hands out another, or none is open. */
  let current: PressConnection | undefined = connection
  /** How many times a request had to open a connection because none was open. */
  let signIns = 0
  const requests: { route: string; token: string; body: unknown }[] = []
  let answer: (route: string, body: unknown) => { status?: number; body?: unknown } = () => ({ body: { v: 1, hostId: HOST_ID, state: state() } })
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const route = String(url).replace('http://127.0.0.1:4500/v1/admin/', '')
    const body = JSON.parse(String(init?.body)) as unknown
    requests.push({ route, token: (init?.headers as Record<string, string>).Authorization!, body })
    const reply = answer(route, body)
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 })
  }) as unknown as typeof globalThis.fetch
  const press = vi.fn(async <T>(request: (connection: PressConnection) => Promise<T>): Promise<T> => {
    if (!current) { signIns++; current = sshConnection() }
    return request(current)
  })
  const pressIfOpen = vi.fn(async <T>(request: (connection: PressConnection) => Promise<T>): Promise<T | undefined> => current ? request(current) : undefined)
  let links: HostPhonesLink[] = [{ id: ID, name: 'forge', hostId: HOST_ID, generation: 1, press: press as HostPhonesLink['press'], pressIfOpen: pressIfOpen as HostPhonesLink['pressIfOpen'] }]
  const listeners = new Set<() => void>()
  const opened: string[] = []
  const phones = new HostPhones({ hosts: { links: () => links, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) } },
    openExternal: async url => { opened.push(url) }, fetch, pollMs: 1000 })
  return {
    phones, requests, opened, connection, press,
    answer: (next: typeof answer) => { answer = next },
    /** The admin connection closed while idle, and the next press opened another. */
    reopen: () => { current = sshConnection(); return current },
    /** The host's socket is on no SSH connection and its admin connection is closed, so a request has to open one. */
    closeAll: () => { current = undefined },
    signIns: () => signIns,
    disconnect: () => { links = []; for (const listener of listeners) listener() },
  }
}

/** A host whose socket is on no SSH connection, behind a real admin connection that counts its sign-ins. */
function adminFixture() {
  let signIns = 0, closes = 0
  const admin = new AdminConnection({
    open: async () => { signIns++; return { url: 'http://127.0.0.1:4500', hostId: HOST_ID, hostAdminToken: async () => `token-${signIns}-0000000000000000`, close: async () => undefined } as unknown as SshHostConnection },
    close: async () => { closes++ },
  })
  const fetch = vi.fn(async () => new Response(JSON.stringify({ v: 1, hostId: HOST_ID, state: state() }))) as unknown as typeof globalThis.fetch
  const link: HostPhonesLink = { id: ID, name: 'forge', hostId: HOST_ID, generation: 1, press: request => admin.run(request), pressIfOpen: request => admin.runIfOpen(request) }
  const phones = new HostPhones({ hosts: { links: () => [link], subscribe: () => () => undefined }, openExternal: async () => undefined, fetch, pollMs: 2000 })
  return { phones, fetch, signIns: () => signIns, closes: () => closes }
}

afterEach(() => { vi.useRealTimers() })

it('reads a host once when it connects, and keeps what it said after it disconnects', async () => {
  const { phones, requests, disconnect, answer } = fixture()
  answer(() => ({ body: { v: 1, hostId: HOST_ID, state: state({ enabled: true, phase: 'on' }) } }))
  await vi.waitFor(() => expect(phones.state()).toMatchObject([{ id: ID, state: { enabled: true, phase: 'on' } }]))
  expect(requests.map(item => item.route)).toEqual(['phones'])
  disconnect()
  expect(phones.state()[0]!.state).toMatchObject({ enabled: true })
  await expect(phones.command(ID, { type: 'retry' })).rejects.toThrow('This host is not connected')
  phones.close()
})

it('reads an open dialog’s host every couple of seconds, and stops when the dialog closes or stops saying it is open', async () => {
  vi.useFakeTimers()
  const { phones, requests } = fixture()
  await vi.advanceTimersByTimeAsync(0)
  phones.watch(ID, true)
  await vi.advanceTimersByTimeAsync(3000)
  const watched = requests.length
  expect(watched).toBeGreaterThanOrEqual(4)
  phones.watch(ID, false)
  await vi.advanceTimersByTimeAsync(5000)
  expect(requests.length).toBe(watched)
  // A window that went away without closing the dialog: the watch runs out by itself.
  phones.watch(ID, true)
  await vi.advanceTimersByTimeAsync(HOST_PHONES_WATCH_MS + 2000)
  const lapsed = requests.length
  await vi.advanceTimersByTimeAsync(5000)
  expect(requests.length).toBe(lapsed)
  phones.close()
})

it('reads a host that is still starting its phone access again until it says how that went, with no dialog open', async () => {
  vi.useFakeTimers()
  const { phones, answer, requests } = fixture()
  answer(() => ({ body: { v: 1, hostId: HOST_ID, state: state({ enabled: true, phase: 'starting' }) } }))
  await vi.advanceTimersByTimeAsync(0)
  expect(phones.state()[0]!.state).toMatchObject({ phase: 'starting' })
  answer(() => ({ body: { v: 1, hostId: HOST_ID, state: state({ enabled: true, phase: 'on' }) } }))
  await vi.advanceTimersByTimeAsync(1000)
  expect(phones.state()[0]!.state).toMatchObject({ phase: 'on' })
  const settled = requests.length
  await vi.advanceTimersByTimeAsync(5000)
  expect(requests.length).toBe(settled)
  phones.close()
})

it('asks the connection for the token again once when the host no longer takes the one held', async () => {
  const { phones, requests, answer, connection } = fixture()
  await vi.waitFor(() => expect(phones.state()[0]?.state).toBeDefined())
  answer(() => requests.at(-1)!.token.endsWith('token-1-0000000000000000') ? { status: 401 } : { body: { v: 1, hostId: HOST_ID, state: state({ enabled: true }) } })
  await phones.command(ID, { type: 'set-enabled', enabled: true })
  expect(connection.hostAdminToken).toHaveBeenCalledTimes(2)
  expect(phones.state()[0]!.state).toMatchObject({ enabled: true })
  phones.close()
})

it('asks the connection each request runs over for its token, and keeps none of it', async () => {
  const { phones, requests, press, connection, reopen } = fixture()
  await vi.waitFor(() => expect(phones.state()[0]?.state).toBeDefined())
  await phones.command(ID, { type: 'retry' })
  expect(press).toHaveBeenCalledTimes(1)
  expect(connection.hostAdminToken).toHaveBeenCalledTimes(2)
  // Another connection, after the admin connection closed while idle: its own launch's token, and none of the old one's.
  const next = reopen()
  await phones.command(ID, { type: 'retry' })
  expect(next.hostAdminToken).toHaveBeenCalledTimes(1)
  expect(connection.hostAdminToken).toHaveBeenCalledTimes(2)
  expect(requests.map(item => item.token)).toEqual(['Bearer token-1-0000000000000000', 'Bearer token-2-0000000000000000', 'Bearer token-3-0000000000000000'])
  phones.close()
})

it('never signs in for a read nobody asked for, and signs in for the open dialog', async () => {
  vi.useFakeTimers()
  const { phones, closeAll, signIns, requests } = fixture()
  closeAll()
  // A host that has just connected over a connection with no SSH beside it is not read.
  await vi.advanceTimersByTimeAsync(5000)
  expect(signIns()).toBe(0)
  expect(requests).toEqual([])
  expect(phones.state()).toEqual([{ id: ID }])
  phones.watch(ID, true)
  await vi.advanceTimersByTimeAsync(0)
  expect(signIns()).toBe(1)
  expect(phones.state()[0]!.state).toBeDefined()
  phones.close()
})

it('keeps one admin connection open while the dialog reads its host every couple of seconds, and lets it close after', async () => {
  vi.useFakeTimers()
  const { phones, fetch, signIns, closes } = adminFixture()
  phones.watch(ID, true)
  // The dialog says it is still open every half minute, for three times the idle time.
  for (let elapsed = 0; elapsed < 3 * ADMIN_IDLE_MS; elapsed += 30_000) {
    await vi.advanceTimersByTimeAsync(30_000)
    phones.watch(ID, true)
  }
  expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(80)
  expect(signIns()).toBe(1)
  expect(closes()).toBe(0)
  phones.watch(ID, false)
  await vi.advanceTimersByTimeAsync(ADMIN_IDLE_MS)
  expect(closes()).toBe(1)
  phones.close()
})

it('says the host cannot be reached when no connection to it opens, and changes nothing', async () => {
  const { phones, press, requests } = fixture()
  await vi.waitFor(() => expect(phones.state()[0]?.state).toBeDefined())
  press.mockRejectedValueOnce(new Error('SSH could not reach the host.'))
  await expect(phones.command(ID, { type: 'set-enabled', enabled: true })).rejects.toThrow('Phone access on forge could not be reached. Nothing was changed.')
  expect(requests).toHaveLength(1)
  phones.close()
})

it('shows what the host answered with, and throws the sentence it refused with', async () => {
  const { phones, answer } = fixture()
  await vi.waitFor(() => expect(phones.state()[0]?.state).toBeDefined())
  answer(() => ({ body: { v: 1, hostId: HOST_ID, state: state({ enabled: true, phase: 'on' }), error: 'That phone is no longer paired. Nothing was changed.' } }))
  await expect(phones.command(ID, { type: 'remove', clientId: 'gone' })).rejects.toThrow('That phone is no longer paired. Nothing was changed.')
  expect(phones.state()[0]).toMatchObject({ state: { phase: 'on' }, busy: false })
  phones.close()
})

it('opens only Tailscale’s own page for turning Serve on', async () => {
  const { phones, answer, opened } = fixture()
  await vi.waitFor(() => expect(phones.state()[0]?.state).toBeDefined())
  answer(() => ({ body: { v: 1, hostId: HOST_ID, state: state(), url: 'https://login.tailscale.com/f/serve?node=forge1' } }))
  await phones.command(ID, { type: 'open-serve-setup' })
  answer(() => ({ body: { v: 1, hostId: HOST_ID, state: state(), url: 'https://example.com/login.tailscale.com/f/serve' } }))
  await expect(phones.command(ID, { type: 'open-serve-setup' })).rejects.toThrow('Tailscale did not give a page to open')
  expect(opened).toEqual(['https://login.tailscale.com/f/serve?node=forge1'])
  phones.close()
})

it('says a host that cannot answer about phones needs updating, and one that answers for another host is refused', async () => {
  const { phones, answer } = fixture()
  answer(() => ({ status: 400, body: { v: 1, error: { code: 'invalid_request' } } }))
  await vi.waitFor(() => expect(phones.state()[0]?.error).toBe('The host on forge can’t share phone access with this computer. Nothing was changed. Update the host on forge from the Threads page, then try again.'))
  answer(() => ({ body: { v: 1, hostId: '33333333-3333-4333-8333-333333333333', state: state() } }))
  await expect(phones.command(ID, { type: 'retry' })).rejects.toThrow('Phone access on forge could not be reached')
  phones.close()
})
