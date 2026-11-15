// @vitest-environment node
/**
 * The headless host's read of the provider sessions it holds and what keeps each (#2398): the administrative route
 * answers it only with the admin bearer, and only on a listener that has the read.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { PairedClients } from '../../src/main/agents/pairing'
import type { HostService } from '../../src/main/agents/hostService'
import type { HostHeldSession } from '../../src/main/agents/sessionReaper'
import { startSocketServer, type SocketServerOptions } from '../../src/host/socketServer'

let directory: string | undefined
let listener: Awaited<ReturnType<typeof startSocketServer>> | undefined
afterEach(async () => {
  try { await listener?.close() } finally {
    listener = undefined
    if (directory) await rm(directory, { recursive: true, force: true })
    directory = undefined
  }
})

const sessions: HostHeldSession[] = [
  { provider: 'claude', threadId: '7f8e2a10-5b3c-4d1e-9a2f-1c0b3d4e5f60', idleMs: 7_200_000, holds: ['live-session'], pid: 4242 },
  { provider: 'codex', idleMs: 120_000, holds: ['request'] },
]
async function start(options: Partial<SocketServerOptions> = {}, withRead = true) {
  directory = await mkdtemp(join(tmpdir(), 'sotto-held-sessions-'))
  const pairing = new PairedClients(directory); await pairing.load()
  const service = { shell: () => ({ hostId: 'host' }), subscribe: () => () => {} } as unknown as HostService
  listener = await startSocketServer({ service, pairing, ...withRead ? { heldSessions: () => sessions } : {}, ...options })
  return listener
}
async function post(bearer: string | undefined, body: unknown = {}) {
  const response = await fetch(`http://127.0.0.1:${listener!.descriptor.port}/v1/admin/held-sessions`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...bearer === undefined ? {} : { Authorization: `Bearer ${bearer}` } }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

it('answers the held sessions to the admin bearer, and refuses a request without it or with another', async () => {
  const { adminToken } = await start()
  expect(await post(undefined)).toMatchObject({ status: 401, body: { error: { code: 'unauthenticated' } } })
  expect(await post('not-the-admin-token')).toMatchObject({ status: 401, body: { error: { code: 'unauthenticated' } } })
  expect(await post(adminToken)).toEqual({ status: 200, body: { v: 1, hostId: listener!.descriptor.hostId, sessions } })
})

it('refuses the read where it is not offered: a listener without administrative routes, or without the read', async () => {
  const { adminToken } = await start({ admin: false })
  expect(await post(adminToken)).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } })
  await listener!.close(); await rm(directory!, { recursive: true, force: true })
  const without = await start({}, false)
  expect(await post(without.adminToken)).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } })
})

it('takes an empty request only', async () => {
  const { adminToken } = await start()
  expect(await post(adminToken, { threadId: 'any' })).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } })
})
