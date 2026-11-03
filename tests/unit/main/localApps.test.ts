// @vitest-environment node
import { existsSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import { startSocketServer } from '../../../src/host/socketServer'
import type { HostService } from '../../../src/main/agents/hostService'
import type { PairedClients } from '../../../src/main/agents/pairing'
import { PolicyStore } from '../../../src/main/memory/policies'
import { MemoryStore } from '../../../src/main/memory/store'
import { LocalApps, type LocalAppsOptions } from '../../../src/main/phones/localApps'
import { fakeServer, root } from '../../fixtures/phoneAccessFixture'

const stores: MemoryStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

type Started = { port?: number; admin?: boolean; observationKey?: string; sottoVersion?: string; pairing: PairedClients; onRevoked: (clientId: string) => void; mayAnswer: (client: { clientId: string; user: string; transport: 'socket' }) => boolean }

function harness(options: { localApps?: boolean; service?: HostService | undefined; refusePort?: number; startServer?: LocalAppsOptions['startServer'] } = {}) {
  const memory = new MemoryStore(join(root, 'memory.sqlite'))
  memory.open()
  stores.push(memory)
  const policy = new PolicyStore(memory)
  const settings = { localApps: options.localApps ?? true }
  const server = fakeServer(options.refusePort === undefined ? {} : { refusePort: options.refusePort })
  const startServer = vi.fn(options.startServer ?? server.startServer)
  const log = vi.fn()
  const make = () => new LocalApps({ directory: root, service: 'service' in options ? options.service : {} as HostService, settings: () => settings,
    policy, log, startServer: startServer as unknown as NonNullable<LocalAppsOptions['startServer']>, listener: { sottoVersion: '0.1.42', delegation: true } })
  const started = (index = 0) => startServer.mock.calls[index]![0] as unknown as Started
  const mayAnswer = (clientId: string) => policy.mayGrant({ clientId, user: '', transport: 'socket' }).allowed
  return { make, settings, server, startServer, started, log, mayAnswer }
}

const filePath = () => join(root, 'local-apps.json')
const readLocalAppsFile = async () => JSON.parse(await readFile(filePath(), 'utf8')) as { version: number; port: number; token: string; clientId: string }

it('turns on: pairs one client without a code, offers it a phone’s listener on loopback and writes the file only this user can read', async () => {
  const { make, started, log, mayAnswer } = harness()
  const apps = make()
  await apps.start()
  expect(apps.get()).toEqual({ phase: 'on', localHostRunning: true })
  const file = await readLocalAppsFile()
  expect(file).toEqual({ version: 1, port: 41000, token: expect.any(String), clientId: expect.any(String) })
  if (process.platform !== 'win32') expect((await stat(filePath())).mode & 0o777).toBe(0o600)
  // A phone's listener: no administrative routes, the desktop's version and its own observations.
  expect(started()).toMatchObject({ admin: false, observationKey: 'local-apps-observations', sottoVersion: '0.1.42', delegation: true })
  expect(started().pairing.verifyToken(file.token)).toBe(file.clientId)
  expect(started().pairing.list()).toMatchObject([{ clientId: file.clientId, name: 'Apps on this computer' }])
  // The switch is the grant: its record lets the client answer (ADR-0004).
  expect(mayAnswer(file.clientId)).toBe(true)
  expect(started().mayAnswer({ clientId: file.clientId, user: '', transport: 'socket' })).toBe(true)
  // Its own store, so it never shows on the Phones page or counts as a phone.
  expect(existsSync(join(root, 'local-apps', 'paired-clients.json'))).toBe(true)
  expect(existsSync(join(root, 'paired-clients.json'))).toBe(false)
  expect(log.mock.calls).toEqual([['local-apps-on']])
  await apps.close()
})

it('keeps the client and token across a restart and tries the same port first', async () => {
  const { make, startServer, started } = harness()
  const first = make()
  await first.start()
  const before = await readLocalAppsFile()
  await first.close()
  const second = make()
  await second.start()
  expect(startServer).toHaveBeenCalledTimes(2)
  expect(started(1).port).toBe(before.port)
  expect(await readLocalAppsFile()).toEqual(before)
  expect(started(1).pairing.list()).toHaveLength(1)
  await second.close()
})

it('moves to a free port when the saved one is taken, and writes the new one', async () => {
  const { make, startServer, started } = harness({ refusePort: 45000 })
  await writeFile(filePath(), JSON.stringify({ version: 1, port: 45000, token: 'gone', clientId: 'gone' }))
  const apps = make()
  await apps.start()
  expect(startServer.mock.calls.map(call => (call[0] as { port?: number }).port)).toEqual([45000, 0])
  const file = await readLocalAppsFile()
  expect(file.port).toBe(41000)
  // A token the store does not know is replaced, not trusted.
  expect(file.token).not.toBe('gone')
  expect(started(1).pairing.verifyToken(file.token)).toBe(file.clientId)
  await apps.close()
})

it('makes a new token when the saved port is taken, since an app may have sent the old one to whatever holds it', async () => {
  const { make, started, mayAnswer } = harness({ refusePort: 45000 })
  const first = make()
  await first.start()
  const old = await readLocalAppsFile()
  await first.close()
  // Another program took the port while Sotto was closed.
  await writeFile(filePath(), JSON.stringify({ ...old, port: 45000 }))
  const apps = make()
  await apps.start()
  const file = await readLocalAppsFile()
  expect(started(1).port).toBe(45000)
  expect(file.port).toBe(41001)
  expect(file.token).not.toBe(old.token)
  expect(started(2).pairing.verifyToken(old.token)).toBeUndefined()
  expect(mayAnswer(old.clientId)).toBe(false)
  expect(mayAnswer(file.clientId)).toBe(true)
  await apps.close()
})

it('pairs again when the app unpairs itself, while the switch stays on', async () => {
  const { make, startServer, started, mayAnswer } = harness()
  const apps = make()
  await apps.start()
  const before = await readLocalAppsFile()
  // What `/v1/revoke` does on the listener: unpair, then say so.
  await started().pairing.revoke(before.clientId)
  started().onRevoked(before.clientId)
  await apps.settled()
  const after = await readLocalAppsFile()
  expect(after).toMatchObject({ port: before.port })
  expect(after.token).not.toBe(before.token)
  // On the same listener: the app's connection is not cut while it reads the answer.
  expect(startServer).toHaveBeenCalledTimes(1)
  expect(mayAnswer(before.clientId)).toBe(false)
  expect(mayAnswer(after.clientId)).toBe(true)
  expect(apps.get().phase).toBe('on')
  await apps.close()
})

it('replaces a damaged pairing store rather than leaving apps shut out', async () => {
  const { make, log } = harness()
  const first = make()
  await first.start()
  await first.close()
  await writeFile(join(root, 'local-apps', 'paired-clients.json'), '{ damaged')
  const apps = make()
  await apps.start()
  expect(apps.get().phase).toBe('on')
  expect(log.mock.calls).toContainEqual(['local-apps-pairing-replaced'])
  await apps.close()
})

it('turning off closes the listener, revokes the client and its record and deletes the file; on again mints a new token', async () => {
  const { make, settings, server, started, log, mayAnswer } = harness()
  const apps = make()
  await apps.start()
  const before = await readLocalAppsFile()
  const pairing = started().pairing
  settings.localApps = false
  apps.settingsChanged()
  await apps.settled()
  expect(server.started[0]!.closed).toBe(true)
  expect(existsSync(filePath())).toBe(false)
  expect(pairing.verifyToken(before.token)).toBeUndefined()
  expect(pairing.list()).toEqual([])
  expect(mayAnswer(before.clientId)).toBe(false)
  expect(apps.get().phase).toBe('off')
  expect(log.mock.calls).toEqual([['local-apps-on'], ['local-apps-off']])

  settings.localApps = true
  apps.settingsChanged()
  await apps.settled()
  const after = await readLocalAppsFile()
  expect(after.token).not.toBe(before.token)
  expect(after.clientId).not.toBe(before.clientId)
  expect(pairing.list()).toHaveLength(1)
  expect(mayAnswer(after.clientId)).toBe(true)
  await apps.close()
})

it('cleans up at the next start when the switch was turned off while Sotto was closed', async () => {
  const { make, settings, mayAnswer } = harness()
  const first = make()
  await first.start()
  const before = await readLocalAppsFile()
  await first.close()
  settings.localApps = false
  const second = make()
  await second.start()
  expect(existsSync(filePath())).toBe(false)
  expect(mayAnswer(before.clientId)).toBe(false)
  await second.close()
})

it('starts nothing without the local host, and leaves nothing behind while the switch was never on', async () => {
  const withoutHost = harness({ service: undefined })
  const waiting = withoutHost.make()
  await waiting.start()
  expect(waiting.get()).toEqual({ phase: 'off', localHostRunning: false })
  expect(withoutHost.startServer).not.toHaveBeenCalled()
  await waiting.close()

  const off = harness({ localApps: false })
  const apps = off.make()
  await apps.start()
  expect(off.startServer).not.toHaveBeenCalled()
  expect(existsSync(join(root, 'local-apps'))).toBe(false)
  expect(existsSync(filePath())).toBe(false)
  await apps.close()
})

it('says it failed when the listener cannot open, and writes no file', async () => {
  const { make, log } = harness({ startServer: (async () => { throw new Error('listen EACCES') }) as unknown as LocalAppsOptions['startServer'] })
  const apps = make()
  const states: unknown[] = []
  apps.subscribe(state => states.push(state))
  await apps.start()
  expect(apps.get().phase).toBe('failed')
  expect(states).toEqual([{ phase: 'failed', localHostRunning: true }])
  expect(existsSync(filePath())).toBe(false)
  expect(log.mock.calls).toEqual([['local-apps-listener-failed']])
  await apps.close()
})

it('lets an app do what Agent Popup does: read the file, check health, open a session with the token, as after a pairing', async () => {
  // The real listener over a stand-in service with Watcher's phone page, so health lists what a phone is offered.
  const service = { shell: () => ({ hostId: 'host-local', host: { threads: [] } }), subscribe: () => () => undefined, watcherPhone: { useAdmission: () => () => undefined } } as unknown as HostService
  const { make } = harness({ service, startServer: startSocketServer })
  const apps = make()
  await apps.start()
  try {
    const file = await readLocalAppsFile()
    const health = await (await fetch(`http://127.0.0.1:${file.port}/v1/health`)).json() as { v: number; status: string; features: string[] }
    expect(health).toMatchObject({ v: 1, status: 'ready' })
    expect(health.features).toContain('watcher-phone')
    const session = await fetch(`http://127.0.0.1:${file.port}/v1/session`, { method: 'POST', headers: { authorization: `Bearer ${file.token}` } })
    expect(session.status).toBe(200)
    expect(await session.json()).toMatchObject({ session: expect.stringMatching(/^.+\..+\..+$/u) })
    expect((await fetch(`http://127.0.0.1:${file.port}/v1/session`, { method: 'POST', headers: { authorization: 'Bearer not-the-token' } })).status).toBe(401)
    // An app that unpairs itself hears so, and the file names a new client on the same listener.
    const revoke = await fetch(`http://127.0.0.1:${file.port}/v1/revoke`, { method: 'POST', headers: { authorization: `Bearer ${file.token}` } })
    expect(revoke.status).toBe(200)
    await apps.settled()
    const after = await readLocalAppsFile()
    expect(after.port).toBe(file.port)
    expect((await fetch(`http://127.0.0.1:${file.port}/v1/session`, { method: 'POST', headers: { authorization: `Bearer ${file.token}` } })).status).toBe(401)
    expect((await fetch(`http://127.0.0.1:${after.port}/v1/session`, { method: 'POST', headers: { authorization: `Bearer ${after.token}` } })).status).toBe(200)
  } finally { await apps.close() }
})
