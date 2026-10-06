// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { ADMIN_IDLE_MS, AdminLink } from '../../../src/main/hosts/adminConnection'
import { revokeByHandCommand } from '../../../src/main/hosts/revokeCommand'
import type { SshHostConnection } from '../../../src/main/hosts/sshLauncher'

afterEach(() => { vi.useRealTimers() })

/** An admin connection that counts its sign-ins and closes, with presses that wait until the test lets them finish. */
function fixture() {
  let opened = 0, closed = 0
  const held: (() => void)[] = []
  const wait = <T>(value: T) => () => new Promise<T>(resolve => { held.push(() => resolve(value)) })
  const open = vi.fn(async (): Promise<SshHostConnection> => {
    opened++
    return { url: `http://127.0.0.1:${4500 + opened}`, hostId: 'host', owned: true, route: { hostname: 'forge', identityFiles: [] }, close: async () => undefined,
      showHostPairingCode: vi.fn(), ensureDesktopAnswers: vi.fn(), updateHost: vi.fn(),
      revokeClient: vi.fn(wait(true)), hostAdminToken: vi.fn(async () => `token-${opened}`), stopHost: vi.fn(async () => true) }
  })
  const link = new AdminLink({ open, close: async () => { closed++ } })
  return { link, open, held, opened: () => opened, closed: () => closed }
}

it('opens one admin connection for every press while it is open, and closes it a minute after the last', async () => {
  vi.useFakeTimers()
  const { link, open, closed } = fixture()
  const [first, second] = await Promise.all([link.connection(), link.connection()])
  expect(first).toBe(second)
  expect(open).toHaveBeenCalledTimes(1)
  expect(await first.hostAdminToken()).toBe('token-1')
  await vi.advanceTimersByTimeAsync(ADMIN_IDLE_MS - 1)
  expect(await link.connection()).toBe(first)
  expect(closed()).toBe(0)
  await first.hostAdminToken()
  // The minute starts again from that press.
  await vi.advanceTimersByTimeAsync(ADMIN_IDLE_MS - 1)
  expect(closed()).toBe(0)
  await vi.advanceTimersByTimeAsync(1)
  expect(closed()).toBe(1)
  // The next press signs in again, and its launch hands back the token afresh.
  const next = await link.connection()
  expect(next).not.toBe(first)
  expect(await next.hostAdminToken()).toBe('token-2')
})

it('stays open while a press is still running, however long it takes', async () => {
  vi.useFakeTimers()
  const { link, held, closed } = fixture()
  const admin = await link.connection()
  const revoking = admin.revokeClient('client')
  await vi.advanceTimersByTimeAsync(3 * ADMIN_IDLE_MS)
  expect(closed()).toBe(0)
  held.shift()!()
  expect(await revoking).toBe(true)
  await vi.advanceTimersByTimeAsync(ADMIN_IDLE_MS)
  expect(closed()).toBe(1)
})

it('tries again on the next press after a connect that failed, and keeps nothing of it', async () => {
  const { link, open } = fixture()
  open.mockRejectedValueOnce(new Error('SSH could not reach the host.'))
  await expect(link.connection()).rejects.toThrow('SSH could not reach the host.')
  await expect(link.connection()).resolves.toMatchObject({ url: 'http://127.0.0.1:4501' })
  expect(open).toHaveBeenCalledTimes(2)
})

it('opens another after Stop host ends the connection it ran on, or the connection drops', async () => {
  const { link, open } = fixture()
  const admin = await link.connection()
  expect(await admin.stopHost()).toBe(true)
  const after = await link.connection()
  expect(after).not.toBe(admin)
  link.dropped()
  expect(await link.connection()).not.toBe(after)
  expect(open).toHaveBeenCalledTimes(3)
})

it('closes at once when the host is forgotten or Sotto quits, and opens nothing after', async () => {
  const { link, closed } = fixture()
  await link.connection()
  await link.close()
  expect(closed()).toBe(1)
  await expect(link.connection()).rejects.toThrow('The connection to the host was closed. Nothing was changed.')
})

it('writes the command that revokes this computer by hand, resolving the version the host runs and expanding a home folder', () => {
  expect(revokeByHandCommand({ installPath: '~/.local/share/sotto-host', dataDirectory: '~/.sotto', clientId: '0f9c2d7e-1b2a-4c3d-8e9f-001122334455', node: '/home/zach/.local/share/mise/installs/node/24.4.0/bin/node' }))
    .toBe('I="$HOME/.local/share/sotto-host"; E="$I/host/index.js"; [ -f "$I/current" ] && V=$(cat "$I/current") && [ -f "$I/versions/$V/host/index.js" ] && E="$I/versions/$V/host/index.js"; '
      + '"/home/zach/.local/share/mise/installs/node/24.4.0/bin/node" "$E" --data "$HOME/.sotto" --revoke-client "0f9c2d7e-1b2a-4c3d-8e9f-001122334455"')
  // A Node it never saw is the one on the PATH, and a path the shell would read as more than a path stays one path.
  expect(revokeByHandCommand({ installPath: '/opt/sotto "release"', dataDirectory: '/data/$sotto`x`', clientId: 'client' }))
    .toBe('I="/opt/sotto \\"release\\""; E="$I/host/index.js"; [ -f "$I/current" ] && V=$(cat "$I/current") && [ -f "$I/versions/$V/host/index.js" ] && E="$I/versions/$V/host/index.js"; '
      + 'node "$E" --data "/data/\\$sotto\\`x\\`" --revoke-client "client"')
})
