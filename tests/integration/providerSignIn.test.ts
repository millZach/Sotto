// @vitest-environment node
import { deferred } from '../fixtures/deferred'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startHeadlessHost } from '../../src/host'
import { ProviderSignIns } from '../../src/host/providerSignIn'
import { startSocketServer } from '../../src/host/socketServer'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import type { ProviderId } from '../../src/shared/agents'
import { hostSignInSchema, type HostSignIn } from '../../src/shared/hostProviders'
import { fakeSignInCommand, signInProviders } from '../fixtures/signInProviders'

/**
 * A provider's sign-in on a host, run by its own (fake) client over pipes and finished by the user in another computer's
 * browser (ADR-0037): the device-code shape of Codex and Grok Build, and Claude Code's code pasted back.
 */
let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'sotto-sign-in-')) })
afterEach(async () => { if (root && dirname(root) === tmpdir() && root.includes('sotto-sign-in-')) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

describe('the sign-in on the host', () => {
  const connected: [ProviderId, string][] = []
  const signIns = (options: { page?: string; split?: string; lifetimeMs?: number; startTimeoutMs?: number } = {}) => new ProviderSignIns({
    command: fakeSignInCommand(root, undefined, options.page, options.split),
    connect: async (provider, clientId) => { connected.push([provider, clientId]); return undefined },
    ...(options.lifetimeMs ? { lifetimeMs: options.lifetimeMs } : {}), ...(options.startTimeoutMs ? { startTimeoutMs: options.startTimeoutMs } : {}),
  })
  afterEach(() => { connected.length = 0 })

  it('reads Codex\'s page and device code through its colours, and connects it once the code is entered', async () => {
    const service = signIns()
    try {
      const started = await service.start('codex', 'desktop')
      expect(started).toMatchObject({ provider: 'codex', shape: 'device-code', stage: 'waiting', url: 'https://auth.openai.com/codex/device', page: 'auth.openai.com', code: 'WDJB-MJHTQ', expiresInMinutes: 15 })
      expect(JSON.parse(await readFile(join(root, 'codex.args.json'), 'utf8'))).toEqual(['login', '--device-auth'])
      // Only the client that started it reads it.
      expect(service.read(started.id, 'phone')).toBeNull()
      await writeFile(join(root, 'codex.approved'), '')
      await expect.poll(() => service.read(started.id, 'desktop')?.stage).toBe('connected')
      // Once it has ended, the page and the code are gone.
      expect(service.read(started.id, 'desktop')).toEqual({ id: started.id, provider: 'codex', shape: 'device-code', stage: 'connected' })
      expect(connected).toEqual([['codex', 'desktop']])
    } finally { service.close() }
  })

  it('reads Grok Build\'s device page, which carries the code, and says when the page refused it', async () => {
    const service = signIns()
    try {
      const started = await service.start('grok', 'desktop')
      expect(started).toMatchObject({ stage: 'waiting', page: 'accounts.x.ai', code: 'K7PX-2QRM' })
      expect(started.expiresInMinutes).toBeUndefined()
      await writeFile(join(root, 'grok.denied'), '')
      await expect.poll(() => service.read(started.id, 'desktop')?.stage).toBe('failed')
      expect(connected).toEqual([])
    } finally { service.close() }
  })

  it('hands Claude Code the pasted code as one line, and says when it refused the code', async () => {
    const service = signIns()
    try {
      const first = await service.start('claude', 'desktop')
      expect(first).toMatchObject({ shape: 'paste-code', stage: 'waiting', page: 'claude.com' })
      expect(first.code).toBeUndefined()
      expect(JSON.parse(await readFile(join(root, 'claude.args.json'), 'utf8'))).toEqual(['auth', 'login', '--claudeai'])
      // A code without its state never reaches the client, and the sign-in keeps waiting.
      expect(() => service.code(first.id, 'desktop', 'good-code')).toThrow('That is not the whole code.')
      expect(() => service.code(first.id, 'desktop', 'good\ncode#x')).toThrow('That code has characters a sign-in code does not.')
      expect(() => service.code(first.id, 'phone', 'good-code#fixture-state')).toThrow('This sign-in has ended.')
      expect(service.code(first.id, 'desktop', 'wrong-code#fixture-state').stage).toBe('finishing')
      await expect.poll(() => service.read(first.id, 'desktop')?.stage).toBe('refused')

      const second = await service.start('claude', 'desktop')
      service.code(second.id, 'desktop', '  good-code#fixture-state  ')
      await expect.poll(() => service.read(second.id, 'desktop')?.stage).toBe('connected')
      expect(connected).toEqual([['claude', 'desktop']])
    } finally { service.close() }
  })

  it('opens only the provider\'s own page, and stops a sign-in that is cancelled or runs out of time', async () => {
    const elsewhere = signIns({ page: 'https://login.example.com/device' })
    try {
      expect(await elsewhere.start('codex', 'desktop')).toMatchObject({ stage: 'failed', message: 'Codex asked to sign in on a page Sotto does not open. Nothing was signed in. Sign in to Codex on the host itself.' })
    } finally { elsewhere.close() }
    const service = signIns({ lifetimeMs: 1500 })
    try {
      const cancelled = await service.start('grok', 'desktop')
      service.cancel(cancelled.id, 'desktop')
      expect(service.read(cancelled.id, 'desktop')).toMatchObject({ stage: 'ended' })
      const late = await service.start('codex', 'desktop')
      await expect.poll(() => service.read(late.id, 'desktop')?.stage, { timeout: 10_000 }).toBe('ended')
      expect(service.read(late.id, 'desktop')?.message).toBe('The sign-in ran out of time.')
      // A newer sign-in for the same provider stops the older one.
      const older = await service.start('claude', 'desktop'), newer = await service.start('claude', 'desktop')
      expect(service.read(older.id, 'desktop')?.stage).toBe('ended')
      expect(service.read(newer.id, 'desktop')?.stage).toBe('waiting')
      await expect(service.start('devin', 'desktop')).rejects.toThrow('Devin signs in from a terminal on the host. Nothing was changed.')
    } finally { service.close() }
  })

  it('shortens a long reason the provider did not connect, so the client can still read how it ended', async () => {
    const service = new ProviderSignIns({ command: fakeSignInCommand(root), connect: async () => 'The provider said: ' + 'no '.repeat(400) })
    try {
      const started = await service.start('codex', 'desktop')
      await writeFile(join(root, 'codex.approved'), '')
      await expect.poll(() => service.read(started.id, 'desktop')?.stage).toBe('failed')
      const ended = service.read(started.id, 'desktop')!
      expect(ended.message).toMatch(/^Codex signed in, but did not connect: The provider said: no .*…$/u)
      expect(hostSignInSchema.safeParse(ended).success).toBe(true)
    } finally { service.close() }
  })

  it('reads a page or a code only once the client has printed all of it', async () => {
    const pageCut = signIns({ split: 'client_id=' })
    try {
      expect((await pageCut.start('claude', 'desktop')).url).toBe('https://claude.com/cai/oauth/authorize?code=true&client_id=fixture&state=fixture-state')
    } finally { pageCut.close() }
    const codeCut = signIns({ split: 'WDJB-MJ' })
    try {
      expect((await codeCut.start('codex', 'desktop')).code).toBe('WDJB-MJHTQ')
    } finally { codeCut.close() }
  })

  it('runs one sign-in per provider when two starts overlap, and spawns nothing once the host stops', async () => {
    // Each lookup waits until released, as a login shell's can, so both starts are past their first check before either
    // could spawn. The older one ends without running a client (a start that answers "ended" never spawned), the newer one runs.
    const lookups: (() => void)[] = []
    const fake = fakeSignInCommand(root)
    const slow = (provider: ProviderId) => (() => { const pending = deferred<void>(); lookups.push(pending.resolve); return pending.promise })().then(() => fake(provider))
    const service = new ProviderSignIns({ command: slow, connect: async () => undefined })
    try {
      const first = service.start('codex', 'desktop'), second = service.start('codex', 'desktop')
      await expect.poll(() => lookups.length).toBe(2)
      for (const release of lookups.splice(0)) release()
      const [older, newer] = await Promise.all([first, second])
      expect(older.stage).toBe('ended')
      expect(newer.stage).toBe('waiting')

      const late = service.start('grok', 'desktop')
      await expect.poll(() => lookups.length).toBe(1)
      service.close()
      lookups.splice(0)[0]!()
      expect(await late).toMatchObject({ stage: 'ended' })
      expect(existsSync(join(root, 'grok.args.json'))).toBe(false)
    } finally { service.close() }
  })
})

describe('signing a host\'s provider in from a paired client', () => {
  it('runs both shapes over the socket and the provider turns connected on the host', async () => {
    const host = await startHeadlessHost({ dataDirectory: root, port: 0, providers: signInProviders(root), reasoner: e2eAgentReasoner, signInCommand: fakeSignInCommand(root) })
    const url = 'http://127.0.0.1:' + host.descriptor!.port
    const clients: SocketHostService[] = []
    const pair = async (name: string) => {
      const paired = await SocketHostService.pair(url, host.pairing.issuePairingCode().code, name)
      const client = new SocketHostService({ url, token: paired.token, expectedHostId: paired.hostId }); clients.push(client)
      await client.connect(); return client
    }
    try {
      const desktop = await pair('Sotto desktop'), other = await pair('Another client')
      expect(desktop.offersSignIn()).toBe(true)
      const providers = () => Object.fromEntries((desktop.shell().host.providers ?? []).map(status => [status.id, [status.connection, status.problem ?? null]]))
      // The host tried every provider when it started (ADR-0036), and says why each is not connected.
      await expect.poll(providers).toEqual({ codex: ['error', 'signed-out'], claude: ['error', 'signed-out'], grok: ['error', 'signed-out'], devin: ['error', 'not-installed'] })

      // Device code: the code comes back to the client that asked and to no other, and the host connects Codex itself.
      const codex = await desktop.signIn({ op: 'sign-in-start', provider: 'codex' }) as HostSignIn
      expect(codex).toMatchObject({ stage: 'waiting', code: 'WDJB-MJHTQ', url: 'https://auth.openai.com/codex/device' })
      expect(await other.signIn({ op: 'sign-in-read', signInId: codex.id })).toBeNull()
      expect(JSON.stringify(desktop.shell())).not.toContain('WDJB-MJHTQ')
      await writeFile(join(root, 'codex.approved'), '')
      await expect.poll(async () => (await desktop.signIn({ op: 'sign-in-read', signInId: codex.id }))?.stage).toBe('connected')
      await expect.poll(() => providers().codex).toEqual(['connected', null])

      // Code pasted back: a refused code, then the right one.
      const refused = await desktop.signIn({ op: 'sign-in-start', provider: 'claude' }) as HostSignIn
      expect(refused).toMatchObject({ stage: 'waiting', page: 'claude.com' })
      await expect(desktop.signIn({ op: 'sign-in-code', signInId: refused.id, code: 'good-code' })).rejects.toThrow('That is not the whole code.')
      await desktop.signIn({ op: 'sign-in-code', signInId: refused.id, code: 'stale-code#fixture-state' })
      await expect.poll(async () => (await desktop.signIn({ op: 'sign-in-read', signInId: refused.id }))?.stage).toBe('refused')
      expect(providers().claude).toEqual(['error', 'signed-out'])
      const claude = await desktop.signIn({ op: 'sign-in-start', provider: 'claude' }) as HostSignIn
      await desktop.signIn({ op: 'sign-in-code', signInId: claude.id, code: 'good-code#fixture-state' })
      await expect.poll(async () => (await desktop.signIn({ op: 'sign-in-read', signInId: claude.id }))?.stage).toBe('connected')
      await expect.poll(() => providers().claude).toEqual(['connected', null])

      // Devin has no sign-in Sotto can run without a terminal.
      await expect(desktop.signIn({ op: 'sign-in-start', provider: 'devin' })).rejects.toThrow('Devin signs in from a terminal on the host. Nothing was changed.')
      // Check again on a provider still not there tries it again and finds it still missing; Disconnect and Connect act on this host.
      await desktop.command({ type: 'refresh', provider: 'devin' })
      expect(providers().devin).toEqual(['error', 'not-installed'])
      await desktop.command({ type: 'disconnect', provider: 'codex' })
      expect(providers().codex).toEqual(['disconnected', null])
      await desktop.command({ type: 'connect', provider: 'codex' })
      await expect.poll(() => providers().codex).toEqual(['connected', null])
    } finally {
      await Promise.all(clients.map(client => client.close()))
      await host.close()
    }
  })

  it('is not offered where there are no sign-ins to run, such as the desktop\'s phone listener', async () => {
    const host = await startHeadlessHost({ dataDirectory: root, providers: signInProviders(root), reasoner: e2eAgentReasoner })
    const server = await startSocketServer({ service: host.service, pairing: host.pairing })
    const url = 'http://127.0.0.1:' + server.descriptor.port
    const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'iPhone')
    const client = new SocketHostService({ url, token: paired.token })
    try {
      expect(server.descriptor.features).not.toContain('provider-sign-in')
      await client.connect()
      expect(client.offersSignIn()).toBe(false)
      await expect(client.signIn({ op: 'sign-in-start', provider: 'codex' })).rejects.toMatchObject({ code: 'version_mismatch' })
    } finally { await client.close(); await server.close(); await host.close() }
  })
})
