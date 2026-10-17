// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { startSocketServer } from '../../src/host/socketServer'
import type { HostUpdateContext, HostUpdateRequest } from '../../src/host/selfUpdate'
import { PairedClients } from '../../src/main/agents/pairing'
import { LocalHostService } from '../../src/main/agents/hostService'
import { HostUpdateMissed, SocketHostService } from '../../src/main/agents/socketHostService'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import { HOST_UPDATE_ANSWER_DEADLINES_MS, type HostUpdateAnswer } from '../../src/shared/hostSelfUpdate'
import type { HostUpdateStep } from '../../src/shared/hostUpdates'
import { deferred } from '../fixtures/deferred'

/**
 * The desktop's side of a host that updates itself (ADR-0088): `SocketHostService.hostUpdate` against a real socket server
 * whose update is scripted. Its hello accepts the feature, the host's steps reach the call that asked, an unanswered step
 * says where it stopped by its class, and Cancel update asks the host to cancel and still waits for the download's answer.
 */
let directory: string | undefined
const servers: Awaited<ReturnType<typeof startSocketServer>>[] = [], clients: SocketHostService[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const client of clients.splice(0)) await client.close()
  for (const server of servers.splice(0)) await server.close()
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

type Run = (request: HostUpdateRequest, context: HostUpdateContext) => Promise<HostUpdateAnswer>
async function setUp(options: { hostUpdate?: boolean; desktop?: boolean } = {}) {
  directory = await mkdtemp(join(tmpdir(), 'sotto-self-update-client-'))
  const pairing = new PairedClients(directory); await pairing.load()
  const state = emptyDesktopState('11111111-1111-4111-8111-111111111111')
  const control = { get: () => state, shell: () => state, threadDetail: () => null, subscribe: () => () => undefined, commandShell: async () => state }
  const paired = await pairing.redeem(pairing.issuePairingCode().code, 'Sotto desktop')
  const asked: HostUpdateRequest[] = []
  let granted = true
  let run: Run = async () => ({ type: 'update-outcome', running: '9.9.8', restart: { state: 'none' } })
  const desktops = { refresh: async () => undefined, has: (id: string) => options.desktop !== false && id === paired.clientId }
  const server = await startSocketServer({ service: new LocalHostService({ control }), pairing, watcherDesktops: desktops, mayAnswer: () => granted,
    ...(options.hostUpdate === false ? {} : { hostUpdate: { run: (request, context) => { asked.push(request); return run(request, context) }, delivered: async () => undefined } }) })
  servers.push(server)
  const client = new SocketHostService({ url: `http://127.0.0.1:${server.descriptor.port}`, token: paired.token, catchUpEvents: false }); clients.push(client)
  return { server, client, asked, script: (next: Run) => { run = next }, revoke: () => { granted = false } }
}
const missed = (miss: string) => expect.objectContaining({ constructor: HostUpdateMissed, miss })

it('accepts host-update in its hello, sends the steps to the call that asked, and reads the answer with the shared schema', async () => {
  const { client, asked, script } = await setUp()
  script(async (_request, context) => { context.onStep('download'); context.onStep('check'); return { type: 'update-fetched', file: 'Sotto-host-9.9.9-linux-x64.tar.gz', sha256: 'a'.repeat(64) } })
  expect((await client.connect()).features).toContain('host-update')
  expect(client.offersHostUpdate()).toBe(true)
  const steps: HostUpdateStep[] = []
  expect(await client.hostUpdate({ action: 'fetch', version: '9.9.9' }, { onStep: step => steps.push(step) })).toEqual({ type: 'update-fetched', file: 'Sotto-host-9.9.9-linux-x64.tar.gz', sha256: 'a'.repeat(64) })
  await vi.waitFor(() => expect(steps).toEqual(['download', 'check']))
  // The request carries the version alone: no releases page, path or file.
  expect(asked).toEqual([{ action: 'fetch', version: '9.9.9', file: undefined, sha256: undefined }])
  // A step for no call this client is waiting on goes nowhere.
  script(async (_request, context) => { context.onStep('install'); return { type: 'update-installed', version: '9.9.9' } })
  expect(await client.hostUpdate({ action: 'install', version: '9.9.9', file: 'Sotto-host-9.9.9-linux-x64.tar.gz', sha256: 'a'.repeat(64) })).toEqual({ type: 'update-installed', version: '9.9.9' })
  expect(steps).toEqual(['download', 'check'])
})

it('sends nothing to a host that does not offer it, or to a desktop it does not offer it to', async () => {
  for (const options of [{ hostUpdate: false }, { desktop: false }]) {
    const { client, asked } = await setUp(options)
    expect((await client.connect()).features).not.toContain('host-update')
    expect(client.offersHostUpdate()).toBe(false)
    await expect(client.hostUpdate({ action: 'fetch', version: '9.9.9' })).rejects.toEqual(missed('unsent'))
    expect(asked).toEqual([])
    await client.close(); await servers.pop()!.close(); clients.pop()
    await rm(directory!, { recursive: true, force: true })
  }
})

it('names a refusal by its code', async () => {
  const { client, asked, revoke } = await setUp()
  await client.connect()
  revoke()
  await expect(client.hostUpdate({ action: 'fetch', version: '9.9.9' })).rejects.toEqual(missed('forbidden'))
  expect(asked).toEqual([])
})

it('says a step never went when the connection had already closed, and that its answer was lost when it closed while it waited', async () => {
  const { client, asked, script } = await setUp()
  const held = deferred<HostUpdateAnswer>()
  script(() => held.promise)
  await client.connect()
  const install = client.hostUpdate({ action: 'install', version: '9.9.9', file: 'Sotto-host-9.9.9-linux-x64.tar.gz', sha256: 'a'.repeat(64) })
  await vi.waitFor(() => expect(asked).toHaveLength(1))
  await client.close()
  await expect(install).rejects.toEqual(missed('closed'))
  held.resolve({ type: 'update-installed', version: '9.9.9' })
  await expect(client.hostUpdate({ action: 'outcome' })).rejects.toEqual(missed('unsent'))
  expect(asked).toHaveLength(1)
})

it('says a step’s deadline passed when the host has not answered by then', async () => {
  const { client, asked, script } = await setUp()
  const held = deferred<HostUpdateAnswer>()
  script(() => held.promise)
  await client.connect()
  // Only the request's own deadline is run on: the socket and the host are real.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const restart = client.hostUpdate({ action: 'restart', version: '9.9.9' })
  const settled = restart.catch((error: unknown) => error)
  await vi.waitFor(() => expect(asked).toHaveLength(1), { interval: 5 })
  vi.advanceTimersByTime(HOST_UPDATE_ANSWER_DEADLINES_MS.restart - 1)
  expect(await Promise.race([settled, Promise.resolve('waiting')])).toBe('waiting')
  vi.advanceTimersByTime(1)
  expect(await settled).toEqual(missed('timeout'))
  vi.useRealTimers()
  held.resolve({ type: 'update-restarting', version: '9.9.9' })
})

it('says once the connection open now has closed, and at once when none is', async () => {
  const { client } = await setUp()
  await expect(client.whenDisconnected()).resolves.toBeUndefined()
  await client.connect()
  expect(client.connected()).toBe(true)
  let dropped = false
  const waiting = client.whenDisconnected().then(() => { dropped = true })
  await client.readShell()
  expect(dropped).toBe(false)
  await client.close()
  await waiting
  expect(client.connected()).toBe(false)
})

it('asks the host to cancel on Cancel update, and still waits for the download’s own answer', async () => {
  const { client, asked, script } = await setUp()
  const cancelled = deferred<void>(), answer = deferred<void>()
  script(async request => {
    if (request.action === 'cancel') { cancelled.resolve(); return { type: 'update-cancelled', cancelled: true } }
    await answer.promise
    return { type: 'update-cancelled', cancelled: true }
  })
  await client.connect()
  const abort = new AbortController()
  let ended = false
  const fetch = client.hostUpdate({ action: 'fetch', version: '9.9.9' }, { signal: abort.signal }).finally(() => { ended = true })
  await vi.waitFor(() => expect(asked).toHaveLength(1))
  abort.abort()
  await cancelled.promise
  expect(asked.map(request => request.action)).toEqual(['fetch', 'cancel'])
  expect(ended).toBe(false)
  answer.resolve()
  expect(await fetch).toEqual({ type: 'update-cancelled', cancelled: true })
  // Nothing is asked once Cancel update has been pressed.
  await expect(client.hostUpdate({ action: 'fetch', version: '9.9.9' }, { signal: abort.signal })).rejects.toEqual(missed('unsent'))
  expect(asked).toHaveLength(2)
})
