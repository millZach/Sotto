// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { clientVersionOf, compareClientVersions } from '../../../src/main/agents/clientVersions'
import { detectClientChannel, ProviderClients, type RunLike } from '../../../src/main/agents/providerClients'
import { E2EAgentHost } from '../../../src/main/e2e/agentEffects'
import type { AgentHostSnapshot, ProviderId } from '../../../src/shared/agents'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'

const roots: string[] = []
const root = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix)); roots.push(directory); return directory
}
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

const answer = (version: string): Response => new Response(JSON.stringify({ version }), { status: 200 })

describe('what a client publishes', () => {
  it('reads 1.0.40 as newer than 1.0.5, which is the case an exact pin got wrong', () => {
    expect(compareClientVersions('1.0.5', '1.0.40')).toBeLessThan(0)
    expect(compareClientVersions('1.0.40', '1.0.5')).toBeGreaterThan(0)
    expect(compareClientVersions('2.1.278', '2.1.278')).toBe(0)
    expect(compareClientVersions('1.0.40-rc.1', '1.0.40')).toBe(0)
  })

  it('finds the client’s own version in whatever the adapter reports', () => {
    expect(clientVersionOf('1.0.5 / ACP 1')).toBe('1.0.5')
    expect(clientVersionOf('3000.10.31 / ACP 1')).toBe('3000.10.31')
    expect(clientVersionOf('2.1.278')).toBe('2.1.278')
    // Codex answers with a user agent carrying its version, the OS version and Sotto's own.
    expect(clientVersionOf('sotto/0.155.1 (Windows 10.0.26200; x86_64) unknown (sotto; 1.0)')).toBe('0.155.1')
    expect(clientVersionOf('fixture')).toBe('')
  })

  it('asks the registry once an hour, as plain JSON, and keeps serving the answer in between', async () => {
    const asked: string[] = []
    const accepted: unknown[] = []
    let now = 1_000
    const clients = new ProviderClients({ now: () => now, fetchImpl: async (url, init) => {
      asked.push(url)
      accepted.push((init?.headers as Record<string, string> | undefined)?.accept)
      // The live registry answers 406 to the abbreviated packument type on /latest.
      return (init?.headers as Record<string, string> | undefined)?.accept === 'application/json'
        ? answer('1.0.40') : new Response('', { status: 406 })
    } })
    expect(await clients.publishedVersion('grok')).toBe('1.0.40')
    expect(await clients.publishedVersion('grok')).toBe('1.0.40')
    expect(asked).toEqual(['https://registry.npmjs.org/%40xai-official/grok/latest'])
    expect(accepted).toEqual(['application/json'])
    now += 60 * 60 * 1000 + 1
    expect(await clients.publishedVersion('grok')).toBe('1.0.40')
    expect(asked).toHaveLength(2)
  })

  it('claims nothing when the registry cannot be read', async () => {
    const clients = new ProviderClients({ fetchImpl: async () => { throw new Error('offline') } })
    const reading = await clients.check('grok', '1.0.5', undefined)
    expect(reading).toMatchObject({ behind: false, canInstall: false })
    expect(reading.published).toBeUndefined()
  })

  it('never calls an unreadable installed version behind', async () => {
    const clients = new ProviderClients({ fetchImpl: async () => answer('1.0.40') })
    expect(await clients.check('grok', 'fixture', undefined)).toMatchObject({ behind: false })
  })

  it('leaves Devin to its own app and asks no registry for it', async () => {
    let asked = 0
    const clients = new ProviderClients({ fetchImpl: async () => { asked += 1; return answer('9.9.9') } })
    const reading = await clients.check('devin', '3000.10.31', 'C:/Program Files/Devin/bin/devin.exe')
    expect(reading).toMatchObject({ channel: 'devin-app', behind: false, canInstall: false })
    expect(asked).toBe(0)
    expect(await clients.install('devin', undefined)).toEqual({ ok: false, detail: 'Devin updates with the Devin app.' })
  })
})

describe('which channel owns an install', () => {
  it('reads an npm global install from the package beside the binary', async () => {
    const prefix = await root('sotto-npm-global-')
    await mkdir(join(prefix, 'node_modules', '@xai-official', 'grok'), { recursive: true })
    await writeFile(join(prefix, 'node_modules', '@xai-official', 'grok', 'package.json'), '{}')
    expect(await detectClientChannel('grok', join(prefix, 'grok.exe'))).toBe('npm')
  })

  it('will not drive an install another manager owns', async () => {
    const bun = await root('sotto-bun-')
    expect(await detectClientChannel('grok', join(bun, '.bun', 'bin', 'grok'))).toBe('unknown')
    expect(await detectClientChannel('codex', join(bun, 'homebrew', 'bin', 'codex'))).toBe('unknown')
  })

  it('reads a vendored npm binary buried inside the package', async () => {
    const prefix = await root('sotto-npm-vendor-')
    expect(await detectClientChannel('codex', join(prefix, 'node_modules', '@openai', 'codex', 'node_modules',
      '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'))).toBe('npm')
  })

  it('leaves a client whose own installer owns its binary to update itself', async () => {
    const home = await root('sotto-grok-home-')
    expect(await detectClientChannel('grok', join(home, 'bin', 'grok.exe'), { GROK_HOME: home })).toBe('self-update')
    const clients = new ProviderClients({ fetchImpl: async () => answer('1.0.40') })
    const reading = await clients.check('grok', '1.0.5', join(home, 'bin', 'grok.exe'), { GROK_HOME: home })
    expect(reading).toMatchObject({ behind: true, channel: 'self-update', canInstall: true, command: 'grok update' })
  })

  it('reads npm as the owner when the package is in the global root, wherever the binary itself sits', async () => {
    // Grok Build on Windows: npm installs @xai-official/grok, whose install script puts 142 MB of
    // grok.exe in ~/.grok/bin. `grok update --check --json` reports "installer":"npm" for it.
    const prefix = await root('sotto-npm-prefix-')
    const home = await root('sotto-grok-elsewhere-')
    await mkdir(join(prefix, 'node_modules', '@xai-official', 'grok'), { recursive: true })
    await writeFile(join(prefix, 'node_modules', '@xai-official', 'grok', 'package.json'), '{}')
    const environment = { GROK_HOME: home, npm_config_prefix: prefix }
    expect(await detectClientChannel('grok', join(home, 'bin', 'grok.exe'), environment)).toBe('npm')
    const clients = new ProviderClients({ fetchImpl: async () => answer('1.0.40'), npmPath: async () => join(prefix, 'npm.cmd') })
    expect(await clients.check('grok', '1.0.5', join(home, 'bin', 'grok.exe'), environment))
      .toMatchObject({ behind: true, channel: 'npm', canInstall: true, command: 'npm install -g @xai-official/grok@latest' })
  })

  it('leaves a client it cannot place without a command to press', async () => {
    const elsewhere = await root('sotto-elsewhere-')
    const clients = new ProviderClients({ fetchImpl: async () => answer('0.156.0') })
    const reading = await clients.check('codex', '0.155.1', join(elsewhere, 'codex'), {})
    expect(reading).toMatchObject({ behind: true, channel: 'unknown', canInstall: false })
    expect(reading.command).toBeUndefined()
  })
})

class VersionedHost extends E2EAgentHost {
  installed = '1.0.5'
  working = false
  refuseConnect: string | null = null
  readonly log: string[] = []
  private decorate(snapshot: AgentHostSnapshot): AgentHostSnapshot {
    return { ...snapshot, providers: [{ id: 'grok', name: 'Grok Build', connection: snapshot.connected ? 'connected' : 'disconnected',
      version: `${this.installed} / ACP 1`, capabilities: snapshot.capabilities }],
      threads: snapshot.threads.map((thread, index) => index === 0 && this.working
        ? { ...thread, providerId: 'grok' as const, status: 'running' as const } : thread) }
  }
  override async connect(): Promise<AgentHostSnapshot> {
    this.log.push('connect')
    if (this.refuseConnect) throw new Error(this.refuseConnect)
    return this.decorate(await super.connect())
  }
  override async snapshot(): Promise<AgentHostSnapshot> { return this.decorate(await super.snapshot()) }
  override disconnect(): void { this.log.push('disconnect'); super.disconnect() }
}

async function coordinator(host: VersionedHost, run: RunLike, published = '1.0.40'): Promise<{ control: AgentControl }> {
  const directory = await root('sotto-client-updates-')
  // A real npm global layout, so the channel is detected the way it is on a machine.
  const prefix = join(directory, 'npm')
  await mkdir(join(prefix, 'node_modules', '@xai-official', 'grok'), { recursive: true })
  await writeFile(join(prefix, 'node_modules', '@xai-official', 'grok', 'package.json'), '{}')
  const credentials = new AgentCredentials(join(directory, 'vault'), {
    isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString(),
  })
  await credentials.load()
  const control = new AgentControl({
    schedule: immediatePublishScheduler, directory, host, credentials,
    clients: new ProviderClients({ fetchImpl: async () => answer(published), run, npmPath: async () => join(prefix, 'npm.cmd') }),
    locateClient: async (provider: ProviderId) => join(prefix, `${provider}.exe`),
    reasoner: { intent: async () => ({ type: 'clarify', text: '' }), decide: async () => ({ decision: 'human', text: '' }) },
    membership: { status: async () => ({ status: 'beta', label: 'Fixture', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Fixture', expiresAt: null }) },
  })
  await control.start()
  return { control }
}

describe('updating a client from the app', () => {
  it('refuses while a thread of that provider is working, until it is told to anyway', async () => {
    const host = new VersionedHost()
    const { control } = await coordinator(host, async () => { host.installed = '1.0.40'; return { ok: true } })
    try {
      await control.command({ type: 'connect' })
      await control.command({ type: 'check-client-updates' })
      expect(control.get().clientUpdates).toEqual([expect.objectContaining({ id: 'grok', installed: '1.0.5', published: '1.0.40', behind: true, canInstall: true })])
      host.working = true
      await control.command({ type: 'refresh' })
      expect(control.get().host.threads.some(thread => thread.providerId === 'grok' && thread.status === 'running')).toBe(true)
      const refused = await control.command({ type: 'update-client', provider: 'grok' })
      expect(refused.error).toMatch(/working now. Updating stops/u)
      expect(host.log).not.toContain('disconnect')
      const forced = await control.command({ type: 'update-client', provider: 'grok', force: true })
      expect(forced.error).toBeNull()
    } finally { control.dispose() }
  })

  it('disconnects, installs, reconnects, and then reports the version it is running', async () => {
    const host = new VersionedHost()
    const order: string[] = []
    const { control } = await coordinator(host, async () => { order.push('install'); host.installed = '1.0.40'; return { ok: true } })
    try {
      await control.command({ type: 'connect' })
      await control.command({ type: 'check-client-updates' })
      host.log.length = 0
      const result = await control.command({ type: 'update-client', provider: 'grok', force: true })
      expect(result.error).toBeNull()
      expect([...host.log.slice(0, 1), ...order, ...host.log.slice(1, 2)]).toEqual(['disconnect', 'install', 'connect'])
      expect(control.get().clientUpdates).toEqual([expect.objectContaining({ installed: '1.0.40', behind: false, state: 'updated' })])
    } finally { control.dispose() }
  })

  it('says what failed, leaves the installed version alone and puts the connection back', async () => {
    const host = new VersionedHost()
    const { control } = await coordinator(host, async () => ({ ok: false, detail: 'npm ERR! code EACCES' }))
    try {
      await control.command({ type: 'connect' })
      await control.command({ type: 'check-client-updates' })
      host.log.length = 0
      const result = await control.command({ type: 'update-client', provider: 'grok', force: true })
      expect(result.error).toMatch(/did not update.*EACCES.*unchanged/u)
      expect(host.log).toEqual(['disconnect', 'connect'])
      expect(control.get().clientUpdates).toEqual([expect.objectContaining({ installed: '1.0.5', state: 'failed', error: 'npm ERR! code EACCES' })])
    } finally { control.dispose() }
  })

  it('says a client did not change when the installer runs but the version does not move', async () => {
    const host = new VersionedHost()
    const { control } = await coordinator(host, async () => ({ ok: true }))
    try {
      await control.command({ type: 'connect' })
      await control.command({ type: 'check-client-updates' })
      const result = await control.command({ type: 'update-client', provider: 'grok', force: true })
      expect(result.error).toMatch(/still reports 1\.0\.5.*Close other windows/u)
      expect(control.get().clientUpdates).toEqual([expect.objectContaining({ installed: '1.0.5', state: 'unchanged' })])
    } finally { control.dispose() }
  })

  it('still reports the install when the updated client will not connect again', async () => {
    const host = new VersionedHost()
    const { control } = await coordinator(host, async () => { host.installed = '1.0.40'; host.refuseConnect = 'Grok CLI 1.0.40 sent an invalid response.'; return { ok: true } })
    try {
      await control.command({ type: 'connect' })
      await control.command({ type: 'check-client-updates' })
      const result = await control.command({ type: 'update-client', provider: 'grok', force: true })
      expect(result.error).toMatch(/updated, but did not reconnect/u)
      expect(control.get().clientUpdates ?? []).not.toContainEqual(expect.objectContaining({ state: 'updating' }))
    } finally { control.dispose() }
  })

  it('leaves every other surface working while npm runs', async () => {
    const host = new VersionedHost()
    let release!: () => void
    const running = new Promise<void>(resolve => { release = resolve })
    const { control } = await coordinator(host, async () => { await running; return { ok: true } })
    try {
      await control.command({ type: 'connect' })
      await control.command({ type: 'check-client-updates' })
      const update = control.command({ type: 'update-client', provider: 'grok', force: true })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(control.get().globalLaneBusy, 'an install must not hold the one global lane').toBe(false)
      const other = await Promise.race([control.command({ type: 'compose', text: 'still usable' }),
        new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 300))])
      expect(other, 'other commands must not wait on an install').not.toBe('blocked')
      release()
      await update
    } finally { release(); control.dispose() }
  })

  it('asks nothing and holds no reading while the check is turned off', async () => {
    const host = new VersionedHost()
    const { control } = await coordinator(host, async () => ({ ok: true }))
    try {
      await control.command({ type: 'configure', patch: { checkClientUpdates: false } })
      await control.command({ type: 'connect' })
      await control.command({ type: 'check-client-updates' })
      expect(control.get().clientUpdates).toBeUndefined()
    } finally { control.dispose() }
  })
})
