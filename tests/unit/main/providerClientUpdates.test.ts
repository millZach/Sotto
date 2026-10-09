// @vitest-environment node

import { mkdir, readdir, writeFile } from 'node:fs/promises'

import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { clientVersionOf, compareClientVersions } from '../../../src/main/agents/clientVersions'
import { installerDetail } from '../../../src/main/agents/installerDetail'
import { clearLeftoverPackage, detectClientChannel, ProviderClients, updateActionFor, type RunLike } from '../../../src/main/agents/providerClients'
import { E2EAgentHost } from '../../../src/main/e2e/agentEffects'
import type { AgentHostSnapshot, ProviderId } from '../../../src/shared/agents'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'
import { root, codexPackage, codexInstall } from '../../fixtures/providerClientInstallFixture'

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

describe('what the installer is allowed to say back', () => {
  it('drops npm\u2019s log line and the home folder in it', () => {
    const stderr = ['npm ERR! code EACCES', 'npm ERR! syscall rename',
      String.raw`npm ERR! A complete log of this run can be found in: C:\Users\zache\AppData\Local\npm-cache\_logs\2026-09-21.log`].join('\n')
    expect(installerDetail(stderr)).toBe('npm ERR! syscall rename')
  })

  it('replaces a path left in the line it does show', () => {
    expect(installerDetail(String.raw`EPERM: operation not permitted, rename C:\Users\zache\.grok\bin\grok.exe`))
      .toBe('EPERM: operation not permitted, rename \u2026')
    expect(installerDetail('EACCES: permission denied, open /Users/zache/.npm/_cacache'))
      .toBe('EACCES: permission denied, open \u2026')
  })

  it('says nothing rather than something empty', () => {
    expect(installerDetail('   \n  \n')).toBeUndefined()
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
    // The fixture has no mise install, even when the developer's machine does.
    const environment = { GROK_HOME: home, MISE_DATA_DIR: join(home, 'mise') }
    expect(await detectClientChannel('grok', join(home, 'bin', 'grok.exe'), environment)).toBe('self-update')
    const clients = new ProviderClients({ fetchImpl: async () => answer('1.0.40') })
    const reading = await clients.check('grok', '1.0.5', join(home, 'bin', 'grok.exe'), environment)
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
      .toMatchObject({ behind: true, channel: 'npm', canInstall: true, command: 'npm install -g --allow-scripts=@xai-official/grok @xai-official/grok@latest' })
  })

  it('lets npm run the install scripts of the one package it installs, which npm 12 skips while still exiting 0', async () => {
    const action = await updateActionFor('grok', 'npm', undefined, async () => 'npm-cli.js')
    expect(action).toMatchObject({ asNode: true,
      args: ['npm-cli.js', 'install', '-g', '--allow-scripts=@xai-official/grok', '@xai-official/grok@latest'] })
  })

  it('leaves a client it cannot place without a command to press', async () => {
    const elsewhere = await root('sotto-elsewhere-')
    const clients = new ProviderClients({ fetchImpl: async () => answer('0.156.0') })
    const reading = await clients.check('codex', '0.155.1', join(elsewhere, 'codex'), {})
    expect(reading).toMatchObject({ behind: true, channel: 'unknown', canInstall: false })
    expect(reading.command).toBeUndefined()
  })
})

describe("what an earlier update left behind", () => {

  it('deletes the folder npm moved the last version to, and nothing else beside the package', async () => {
    const { scope } = await codexInstall()
    await codexPackage(scope, '.codex-6TeUjdn8')
    await codexPackage(scope, '.codex-HJxjGPEp.old-1759500000000')
    for (const name of ['.codex-short', '.grok-6TeUjdn8', 'codex-6TeUjdn8']) await mkdir(join(scope, name))
    await clearLeftoverPackage(join(scope, 'codex'))
    expect((await readdir(scope)).sort()).toEqual(['.codex-short', '.grok-6TeUjdn8', 'codex', 'codex-6TeUjdn8'])
  })

  it.runIf(process.platform === 'win32')('clears the leftover before npm runs, so npm finds its folder free', async () => {
    const { scope, executable } = await codexInstall()
    await codexPackage(scope, '.codex-6TeUjdn8')
    let seen: string[] = []
    const clients = new ProviderClients({ npmPath: async () => 'npm-cli.js', run: async () => { seen = await readdir(scope); return { ok: true } } })
    expect(await clients.install('codex', executable, {})).toMatchObject({ ok: true })
    expect(seen).toEqual(['codex'])
  })
})

/**
 * A provider host whose client sits on disk: the installer changes `onDisk`, and the host reports it only once it is
 * told a new client is there, the way an adapter reads its version from the binary when `clientUpdated` runs.
 */
class VersionedHost extends E2EAgentHost {
  installed = '1.0.5'
  onDisk = '1.0.5'
  working = false
  readonly log: string[] = []
  private decorate(snapshot: AgentHostSnapshot): AgentHostSnapshot {
    return { ...snapshot, providers: [{ id: 'grok', name: 'Grok Build', connection: snapshot.connected ? 'connected' : 'disconnected',
      version: `${this.installed} / ACP 1`, capabilities: snapshot.capabilities }],
      threads: snapshot.threads.map((thread, index) => index === 0 && this.working
        ? { ...thread, providerId: 'grok' as const, status: 'running' as const } : thread) }
  }
  override async connect(): Promise<AgentHostSnapshot> {
    this.log.push('connect')
    return this.decorate(await super.connect())
  }
  override async snapshot(): Promise<AgentHostSnapshot> { return this.decorate(await super.snapshot()) }
  override disconnect(): void { this.log.push('disconnect'); super.disconnect() }
  async clientUpdated(provider: ProviderId): Promise<void> { this.log.push(`clientUpdated ${provider}`); this.installed = this.onDisk }
}

/** A registry a test can publish to, with the clock its one-hour cache runs on. */
interface Registry { version: string; now: number }
const HOUR = 60 * 60 * 1000
/** Connect again, which checks without starting fresh, `after` ms on; resolves once that check's reading has landed. */
async function recheck(control: AgentControl, registry: Registry, after: number): Promise<void> {
  registry.now += after
  const at = new Date(registry.now).toISOString()
  await control.command({ type: 'connect' })
  await vi.waitFor(() => { expect(control.get().clientUpdates?.[0]?.checkedAt).toBe(at) })
}

async function coordinator(host: VersionedHost, run: RunLike, published: string | Registry = '1.0.40',
  extra: Partial<ConstructorParameters<typeof AgentControl>[0]> = {}): Promise<{ control: AgentControl }> {
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
    clients: new ProviderClients({ run, npmPath: async () => join(prefix, 'npm.cmd'),
      ...typeof published === 'string' ? { fetchImpl: async () => answer(published) }
        : { fetchImpl: async () => answer(published.version), now: () => published.now } }),
    locateClient: async (provider: ProviderId) => join(prefix, `${provider}.exe`),
    reasoner: {},

    ...extra,
  })
  await control.start()
  return { control }
}

describe('updating a client from the app', () => {
  it('installs while a thread of that provider is working, and never stops it', async () => {
    const host = new VersionedHost()
    const { control } = await coordinator(host, async () => { host.onDisk = '1.0.40'; return { ok: true } })
    try {
      await control.command({ type: 'connect' })
      await control.command({ type: 'check-client-updates' })
      expect(control.get().clientUpdates).toEqual([expect.objectContaining({ id: 'grok', installed: '1.0.5', published: '1.0.40', behind: true, canInstall: true })])
      host.working = true
      await control.command({ type: 'refresh' })
      host.log.length = 0
      const result = await control.command({ type: 'update-client', provider: 'grok' })
      expect(result.error).toBeNull()
      expect(host.log).toEqual(['clientUpdated grok'])
      expect(control.get().host.threads.some(thread => thread.providerId === 'grok' && thread.status === 'running'), 'the working thread keeps working').toBe(true)
      expect(control.get().host.providers).toEqual([expect.objectContaining({ id: 'grok', connection: 'connected' })])
    } finally { control.dispose() }
  })

  it('still accepts force, which changes nothing now that an update stops no thread', async () => {
    const host = new VersionedHost()
    const { control } = await coordinator(host, async () => { host.onDisk = '1.0.40'; return { ok: true } })
    try {
      await control.command({ type: 'connect' })
      await control.command({ type: 'check-client-updates' })
      host.log.length = 0
      const result = await control.command({ type: 'update-client', provider: 'grok', force: true })
      expect(result.error).toBeNull()
      expect(host.log).toEqual(['clientUpdated grok'])
    } finally { control.dispose() }
  })

  it('installs, tells the host once, and then reports the version the host reads from disk', async () => {
    const host = new VersionedHost()
    const order: string[] = []
    const { control } = await coordinator(host, async () => { order.push('install'); host.onDisk = '1.0.40'; return { ok: true } })
    try {
      await control.command({ type: 'connect' })
      await control.command({ type: 'check-client-updates' })
      host.log.length = 0
      const told = host.clientUpdated.bind(host)
      host.clientUpdated = async provider => { order.push('clientUpdated'); await told(provider) }
      const result = await control.command({ type: 'update-client', provider: 'grok' })
      expect(result.error).toBeNull()
      expect(order).toEqual(['install', 'clientUpdated'])
      expect(host.log).not.toContain('disconnect')
      expect(host.log).not.toContain('connect')
      expect(control.get().clientUpdates).toEqual([expect.objectContaining({ installed: '1.0.40', behind: false, state: 'updated' })])
      expect(control.get().notice).toMatch(/^Grok Build updated\.$/u)
    } finally { control.dispose() }
  })

  it('says what failed, leaves the installed version alone and tells no host anything', async () => {
    const host = new VersionedHost()
    const { control } = await coordinator(host, async () => ({ ok: false, detail: 'npm ERR! code EACCES' }))
    try {
      await control.command({ type: 'connect' })
      await control.command({ type: 'check-client-updates' })
      host.log.length = 0
      const result = await control.command({ type: 'update-client', provider: 'grok' })
      expect(result.error).toMatch(/did not update.*EACCES.*unchanged, and your threads kept working/u)
      expect(host.log, 'a failed install changes nothing, so nothing is put back').toEqual([])
      expect(control.get().clientUpdates).toEqual([expect.objectContaining({ installed: '1.0.5', state: 'failed', error: 'npm ERR! code EACCES' })])
    } finally { control.dispose() }
  })

  it('says a client did not change when the installer runs but the version on disk does not move', async () => {
    const host = new VersionedHost()
    const { control } = await coordinator(host, async () => ({ ok: true }))
    try {
      await control.command({ type: 'connect' })
      await control.command({ type: 'check-client-updates' })
      host.log.length = 0
      const result = await control.command({ type: 'update-client', provider: 'grok' })
      expect(result.error).toMatch(/still reports 1\.0\.5\. Nothing was lost and your threads kept working\. Run npm install -g/u)
      expect(host.log).toEqual(['clientUpdated grok'])
      expect(control.get().clientUpdates).toEqual([expect.objectContaining({ installed: '1.0.5', state: 'unchanged' })])
    } finally { control.dispose() }
  })

  it('keeps saying a client updated through the next check, until a newer release is published', async () => {
    const host = new VersionedHost()
    const registry: Registry = { version: '1.0.40', now: Date.now() }
    const { control } = await coordinator(host, async () => { host.onDisk = '1.0.40'; return { ok: true } }, registry)
    try {
      await control.command({ type: 'connect' })
      await control.command({ type: 'check-client-updates' })
      expect((await control.command({ type: 'update-client', provider: 'grok' })).error).toBeNull()
      // The same release keeps the update's finding.
      await recheck(control, registry, 1)
      expect(control.get().clientUpdates).toEqual([expect.objectContaining({ installed: '1.0.40', behind: false, state: 'updated' })])
      // A newer release, read once the cached answer runs out, makes the client behind again with Update to press.
      registry.version = '1.0.41'
      await recheck(control, registry, HOUR + 1)
      expect(control.get().clientUpdates).toEqual([expect.objectContaining({ installed: '1.0.40', published: '1.0.41', behind: true, canInstall: true, state: 'idle' })])
    } finally { control.dispose() }
  })

  it('offers a newer release to a client whose last update failed, rather than the failure', async () => {
    const host = new VersionedHost()
    const registry: Registry = { version: '1.0.40', now: Date.now() }
    const { control } = await coordinator(host, async () => ({ ok: false, detail: 'npm ERR! code EACCES' }), registry)
    try {
      await control.command({ type: 'connect' })
      await control.command({ type: 'check-client-updates' })
      await control.command({ type: 'update-client', provider: 'grok' })
      await recheck(control, registry, 1)
      expect(control.get().clientUpdates).toEqual([expect.objectContaining({ published: '1.0.40', state: 'failed' })])
      registry.version = '1.0.41'
      await recheck(control, registry, HOUR + 1)
      const [reading] = control.get().clientUpdates ?? []
      expect(reading).toEqual(expect.objectContaining({ installed: '1.0.5', published: '1.0.41', behind: true, state: 'idle' }))
      expect(reading?.error).toBeUndefined()
    } finally { control.dispose() }
  })

  it('keeps a finding through a check that cannot read the registry', async () => {
    const host = new VersionedHost()
    const registry: Registry = { version: '1.0.40', now: Date.now() }
    const { control } = await coordinator(host, async () => { host.onDisk = '1.0.40'; return { ok: true } }, registry)
    try {
      await control.command({ type: 'connect' })
      await control.command({ type: 'check-client-updates' })
      await control.command({ type: 'update-client', provider: 'grok' })
      // An empty version fails the registry's schema, which reads as no answer at all.
      registry.version = ''
      await recheck(control, registry, HOUR + 1)
      // The release the update was measured against stays, so the registry answering again with it changes nothing.
      expect(control.get().clientUpdates).toEqual([expect.objectContaining({ installed: '1.0.40', published: '1.0.40', state: 'updated' })])
      registry.version = '1.0.40'
      await recheck(control, registry, HOUR + 1)
      expect(control.get().clientUpdates).toEqual([expect.objectContaining({ installed: '1.0.40', published: '1.0.40', state: 'updated' })])
    } finally { control.dispose() }
  })

  it('says why when the host will not move to the new client, rather than blaming the installer', async () => {
    const host = new VersionedHost()
    const refusal = 'Grok Build was updated, but Sotto cannot run the new version. Threads that are working carry on and nothing was lost.'
    host.clientUpdated = async () => { throw new Error(refusal) }
    const failures: string[] = []
    const { control } = await coordinator(host, async () => { host.onDisk = '1.0.40'; return { ok: true } }, '1.0.40',
      { logFailure: (code, detail) => { failures.push(`${code} ${detail}`) } })
    try {
      await control.command({ type: 'connect' })
      await control.command({ type: 'check-client-updates' })
      const result = await control.command({ type: 'update-client', provider: 'grok' })
      expect(result.error).toBe(refusal)
      expect(failures).toEqual(['client-update-handoff-failed grok'])
      expect(result.error).not.toMatch(/in a terminal/u)
      expect(host.log).not.toContain('disconnect')
      expect(control.get().clientUpdates).toEqual([expect.objectContaining({ installed: '1.0.5', state: 'unchanged', error: refusal })])
    } finally { control.dispose() }
  })

  it('never runs two updates at once', async () => {
    const host = new VersionedHost()
    let release!: () => void
    const running = new Promise<void>(resolve => { release = resolve })
    let installs = 0
    const { control } = await coordinator(host, async () => { installs += 1; await running; host.onDisk = '1.0.40'; return { ok: true } })
    try {
      await control.command({ type: 'connect' })
      await control.command({ type: 'check-client-updates' })
      const update = control.command({ type: 'update-client', provider: 'grok' })
      await vi.waitFor(() => { expect(installs).toBe(1) })
      const second = await control.command({ type: 'update-client', provider: 'grok' })
      expect(second.error).toBe('Grok Build is already updating. Wait for it to finish.')
      release()
      expect((await update).error).toBeNull()
      expect(installs).toBe(1)
    } finally { release(); control.dispose() }
  })

  it('connects a provider pressed while an install runs, rather than refusing it', async () => {
    const host = new VersionedHost()
    let release!: () => void
    const running = new Promise<void>(resolve => { release = resolve })
    let installs = 0
    const { control } = await coordinator(host, async () => { installs += 1; await running; host.onDisk = '1.0.40'; return { ok: true } })
    try {
      await control.command({ type: 'connect' })
      await control.command({ type: 'check-client-updates' })
      const update = control.command({ type: 'update-client', provider: 'grok' })
      await vi.waitFor(() => { expect(installs).toBe(1) })
      host.log.length = 0
      const pressed = await control.command({ type: 'connect' })
      expect(pressed.error).toBeNull()
      expect(host.log).toEqual(['connect'])
      release()
      expect((await update).error).toBeNull()
      expect(control.get().clientUpdates).toEqual([expect.objectContaining({ installed: '1.0.40', state: 'updated' })])
    } finally { release(); control.dispose() }
  })

  it('leaves every other surface working while npm runs', async () => {
    const host = new VersionedHost()
    let release!: () => void
    const running = new Promise<void>(resolve => { release = resolve })
    let installs = 0
    const { control } = await coordinator(host, async () => { installs += 1; await running; return { ok: true } })
    try {
      await control.command({ type: 'connect' })
      await control.command({ type: 'check-client-updates' })
      const update = control.command({ type: 'update-client', provider: 'grok' })
      await vi.waitFor(() => { expect(installs).toBe(1) })
      expect(control.get().globalLaneBusy, 'an install must not hold the one global lane').toBe(false)
      // The install is still held here, so an answer at all shows the command did not wait on it.
      await control.command({ type: 'compose', text: 'still usable' })
      expect(installs).toBe(1)
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
