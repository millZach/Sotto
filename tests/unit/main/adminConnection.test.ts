// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { ADMIN_IDLE_MS, AdminConnection, SignInStopped, type PressConnection } from '../../../src/main/hosts/adminConnection'
import type { SshHostConnection } from '../../../src/main/hosts/sshLauncher'

afterEach(() => { vi.useRealTimers() })

/** An admin connection that counts its sign-ins and closes, with revokes that wait until the test lets them finish. */
function fixture() {
  let opened = 0, closed = 0
  const held: (() => void)[] = []
  const drops: (() => void)[] = []
  const wait = <T>(value: T) => () => new Promise<T>(resolve => { held.push(() => resolve(value)) })
  const open = vi.fn(async (dropped: () => void): Promise<SshHostConnection> => {
    opened++
    drops.push(dropped)
    return { url: `http://127.0.0.1:${4500 + opened}`, hostId: 'host', owned: true, route: { hostname: 'forge', identityFiles: [] }, close: async () => undefined,
      showHostPairingCode: vi.fn(), ensureDesktopAnswers: vi.fn(), updateHost: vi.fn(), boot: vi.fn(),
      revokeClient: vi.fn(wait(true)), hostAdminToken: vi.fn(async () => `token-${opened}`), stopHost: vi.fn(async () => true) }
  })
  const admin = new AdminConnection({ open, close: async () => { closed++ } })
  /** The address a press ran over, which names the sign-in it came from. */
  const url = (connection: PressConnection) => Promise.resolve(connection.url)
  return { admin, open, held, drops, url, opened: () => opened, closed: () => closed }
}

it('opens one admin connection for every press while it is open, and closes it a minute after the last', async () => {
  vi.useFakeTimers()
  const { admin, open, closed, url } = fixture()
  const [first, second] = await Promise.all([admin.run(url), admin.run(url)])
  expect(first).toBe(second)
  expect(open).toHaveBeenCalledTimes(1)
  expect(await admin.run(connection => connection.hostAdminToken())).toBe('token-1')
  await vi.advanceTimersByTimeAsync(ADMIN_IDLE_MS - 1)
  expect(await admin.run(url)).toBe(first)
  expect(closed()).toBe(0)
  // The minute starts again from that press.
  await vi.advanceTimersByTimeAsync(ADMIN_IDLE_MS - 1)
  expect(closed()).toBe(0)
  await vi.advanceTimersByTimeAsync(1)
  expect(closed()).toBe(1)
  // The next press signs in again, and its launch hands back the token afresh.
  expect(await admin.run(url)).not.toBe(first)
  expect(await admin.run(connection => connection.hostAdminToken())).toBe('token-2')
})

it('stays open while a press is still running, request and all, however long it takes', async () => {
  vi.useFakeTimers()
  const { admin, held, closed } = fixture()
  const revoking = admin.run(connection => connection.revokeClient('client'))
  // A request sent through the forward after the press's own call is part of the press.
  const request = Promise.withResolvers<void>()
  const reading = admin.run(async connection => { await connection.hostAdminToken(); await request.promise })
  await vi.advanceTimersByTimeAsync(3 * ADMIN_IDLE_MS)
  expect(closed()).toBe(0)
  held.shift()!()
  expect(await revoking).toBe(true)
  await vi.advanceTimersByTimeAsync(3 * ADMIN_IDLE_MS)
  expect(closed()).toBe(0)
  request.resolve()
  await reading
  await vi.advanceTimersByTimeAsync(ADMIN_IDLE_MS)
  expect(closed()).toBe(1)
})

it('runs a press only over a connection already open when asked to open none', async () => {
  const { admin, open, url } = fixture()
  expect(await admin.runIfOpen(url)).toBeUndefined()
  expect(open).not.toHaveBeenCalled()
  const first = await admin.run(url)
  expect(await admin.runIfOpen(url)).toBe(first)
  expect(open).toHaveBeenCalledTimes(1)
})

it('tries again on the next press after a connect that failed, and keeps nothing of it', async () => {
  const { admin, open, url } = fixture()
  open.mockRejectedValueOnce(new Error('SSH could not reach the host.'))
  await expect(admin.run(url)).rejects.toThrow('SSH could not reach the host.')
  await expect(admin.run(url)).resolves.toBe('http://127.0.0.1:4501')
  expect(open).toHaveBeenCalledTimes(2)
})

it('opens another after Stop host ends the connection it ran on, or the connection drops', async () => {
  const { admin, open, drops, url } = fixture()
  const first = await admin.run(url)
  expect(await admin.run(connection => connection.stopHost())).toBe(true)
  const after = await admin.run(url)
  expect(after).not.toBe(first)
  drops.at(-1)!()
  expect(await admin.run(url)).not.toBe(after)
  expect(open).toHaveBeenCalledTimes(3)
})

it('closes the connection that replaced a dropped one once it is idle, whatever the press on the dropped one does', async () => {
  vi.useFakeTimers()
  const { admin, held, drops, closed, url } = fixture()
  const revoking = admin.run(connection => connection.revokeClient('client'))
  await vi.advanceTimersByTimeAsync(0)
  drops[0]!()
  expect(await admin.run(url)).toBe('http://127.0.0.1:4502')
  // The press on the dropped connection ends after its replacement opened.
  held.shift()!()
  await revoking
  await vi.advanceTimersByTimeAsync(5 * ADMIN_IDLE_MS)
  expect(closed()).toBe(1)
})

it('stops a sign-in the user stopped before anything is sent, and opens again on the next press', async () => {
  const { admin, open, url } = fixture()
  const signedIn = Promise.withResolvers<void>()
  open.mockImplementationOnce(async () => { await signedIn.promise; throw new Error('The connection was cancelled.') })
  const press = vi.fn(url)
  const stopping = admin.run(press)
  expect(await admin.stopSigningIn()).toBe(true)
  signedIn.resolve()
  await expect(stopping).rejects.toBeInstanceOf(SignInStopped)
  expect(press).not.toHaveBeenCalled()
  expect(await admin.stopSigningIn()).toBe(false)
  await expect(admin.run(url)).resolves.toBe('http://127.0.0.1:4501')
})

it('closes at once when the host is forgotten or Sotto quits, and opens nothing after', async () => {
  const { admin, closed, url } = fixture()
  await admin.run(url)
  await admin.close()
  expect(closed()).toBe(1)
  await expect(admin.run(url)).rejects.toThrow('Sotto closed the connection to the host. Nothing was changed. Try again.')
})
