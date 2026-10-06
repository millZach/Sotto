// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { CLIENT_PACKAGES, ProviderClients, type RunResult } from '../../../src/main/agents/providerClients'
import { E2EAgentHost } from '../../../src/main/e2e/agentEffects'
import type { AgentHostSnapshot, ProviderClientUpdate, ProviderId } from '../../../src/shared/agents'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'

/**
 * #480: a machine's client updates run one at a time, in one line that a tile's Update and Update all share. Update all
 * carries on past a client that did not update, and a client still waiting can be taken out of the line.
 */
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

const PUBLISHED: Readonly<Record<string, string>> = { claude: '2.1.284', codex: '0.158.0', grok: '1.0.43' }
const IDS: readonly ProviderId[] = ['claude', 'codex', 'grok']

/** Three connected clients on disk: an install moves `onDisk`, and the host reads it once told a new client is there. */
class ThreeClients extends E2EAgentHost {
  readonly installed: Record<string, string> = { claude: '2.1.281', codex: '0.155.1', grok: '1.0.41' }
  readonly onDisk: Record<string, string> = { ...this.installed }
  private decorate(snapshot: AgentHostSnapshot): AgentHostSnapshot {
    return { ...snapshot, providers: IDS.map(id => ({ id, name: id, connection: snapshot.connected ? 'connected' as const : 'disconnected' as const,
      version: this.installed[id]!, capabilities: snapshot.capabilities })) }
  }
  override async connect(): Promise<AgentHostSnapshot> { return this.decorate(await super.connect()) }
  override async snapshot(): Promise<AgentHostSnapshot> { return this.decorate(await super.snapshot()) }
  async clientUpdated(provider: ProviderId): Promise<void> { this.installed[provider] = this.onDisk[provider]! }
}

/** An installer whose runs the test lets finish one at a time, in the order they started. */
function heldInstaller(host: ThreeClients, failing: ReadonlySet<ProviderId> = new Set()) {
  const started: ProviderId[] = []
  const releases: (() => void)[] = []
  const run = async (_executable: string, args: readonly string[]): Promise<RunResult> => {
    const provider = IDS.find(id => args.some(arg => arg === `${CLIENT_PACKAGES[id]}@latest`))!
    started.push(provider)
    await new Promise<void>(resolve => releases.push(resolve))
    if (failing.has(provider)) return { ok: false, detail: 'npm ERR! network socket hang up', printed: 'npm ERR! code ECONNRESET\nnpm ERR! network socket hang up' }
    host.onDisk[provider] = PUBLISHED[provider]!
    return { ok: true }
  }
  /** Lets the oldest running install finish, once it has started. */
  const finish = async (): Promise<void> => { await vi.waitFor(() => { expect(releases.length).toBeGreaterThan(0) }); releases.shift()!() }
  return { run, started, finish }
}

async function coordinator(host: ThreeClients, run: (executable: string, args: readonly string[]) => Promise<RunResult>) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-client-line-')); roots.push(directory)
  const prefix = join(directory, 'npm')
  for (const id of IDS) {
    await mkdir(join(prefix, 'node_modules', ...CLIENT_PACKAGES[id]!.split('/')), { recursive: true })
    await writeFile(join(prefix, 'node_modules', ...CLIENT_PACKAGES[id]!.split('/'), 'package.json'), '{}')
  }
  const credentials = new AgentCredentials(join(directory, 'vault'), { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() })
  await credentials.load()
  const control = new AgentControl({
    schedule: immediatePublishScheduler, directory, host, credentials,
    clients: new ProviderClients({ run, npmPath: async () => join(prefix, 'npm-cli.js'),
      fetchImpl: async url => new Response(JSON.stringify({ version: PUBLISHED[IDS.find(id => url.includes(encodeURIComponent(CLIENT_PACKAGES[id]!.split('/')[0]!)))!] }), { status: 200 }) }),
    locateClient: async provider => join(prefix, `${provider}.exe`),
    reasoner: { intent: async () => ({ type: 'clarify', text: '' }), decide: async () => ({ decision: 'human', text: '' }) },
  })
  await control.start()
  await control.command({ type: 'connect' })
  await control.command({ type: 'check-client-updates' })
  return control
}
const states = (control: AgentControl): Record<string, ProviderClientUpdate['state']> =>
  Object.fromEntries((control.get().clientUpdates ?? []).map(update => [update.id, update.state]))

describe('the client update line', () => {
  it('runs Update all one client at a time, and answers before the first has finished', async () => {
    const host = new ThreeClients()
    const installer = heldInstaller(host)
    const control = await coordinator(host, installer.run)
    try {
      expect(states(control)).toEqual({ claude: 'idle', codex: 'idle', grok: 'idle' })
      const answered = await control.command({ type: 'queue-client-updates', providers: ['claude', 'codex', 'grok'] })
      expect(answered.error).toBeNull()
      await vi.waitFor(() => { expect(installer.started).toEqual(['claude']) })
      expect(states(control)).toEqual({ claude: 'updating', codex: 'queued', grok: 'queued' })
      expect(control.get().clientUpdateRun).toEqual({ total: 3, done: 0, line: ['codex', 'grok'] })
      await installer.finish()
      await vi.waitFor(() => { expect(installer.started).toEqual(['claude', 'codex']) })
      expect(control.get().clientUpdateRun).toEqual({ total: 3, done: 1, line: ['grok'] })
      expect(states(control)).toMatchObject({ claude: 'updated', codex: 'updating', grok: 'queued' })
      await installer.finish()
      await installer.finish()
      await vi.waitFor(() => { expect(states(control)).toEqual({ claude: 'updated', codex: 'updated', grok: 'updated' }) })
      expect(control.get().clientUpdateRun).toBeUndefined()
      expect(control.get().clientUpdates?.map(update => update.installed)).toEqual(['2.1.284', '0.158.0', '1.0.43'])
    } finally { control.dispose() }
  })

  it('carries on past a client that did not update, and says how that one failed', async () => {
    const host = new ThreeClients()
    const installer = heldInstaller(host, new Set(['codex']))
    const control = await coordinator(host, installer.run)
    try {
      await control.command({ type: 'queue-client-updates', providers: ['claude', 'codex', 'grok'] })
      for (let index = 0; index < 3; index += 1) await installer.finish()
      await vi.waitFor(() => { expect(control.get().clientUpdateRun).toBeUndefined() })
      expect(installer.started).toEqual(['claude', 'codex', 'grok'])
      expect(states(control)).toEqual({ claude: 'updated', codex: 'failed', grok: 'updated' })
      expect(control.get().clientUpdates?.find(update => update.id === 'codex')).toMatchObject({
        installed: '0.155.1', behind: true, canInstall: true, failure: 'download', error: 'npm ERR! network socket hang up',
        printed: 'npm ERR! code ECONNRESET\nnpm ERR! network socket hang up' })
      // Try again runs it again, alone, and the failure it had goes with the new run.
      await control.command({ type: 'queue-client-updates', providers: ['codex'] })
      expect(control.get().clientUpdates?.find(update => update.id === 'codex')).not.toHaveProperty('failure')
      expect(control.get().clientUpdateRun).toEqual({ total: 1, done: 0 })
    } finally { control.dispose() }
  })

  it('puts a tile’s Update in the same line behind the update that is running', async () => {
    const host = new ThreeClients()
    const installer = heldInstaller(host)
    const control = await coordinator(host, installer.run)
    try {
      const first = control.command({ type: 'update-client', provider: 'claude' })
      await vi.waitFor(() => { expect(installer.started).toEqual(['claude']) })
      await control.command({ type: 'queue-client-updates', providers: ['grok'] })
      expect(states(control)).toMatchObject({ claude: 'updating', grok: 'queued' })
      expect(control.get().clientUpdateRun).toEqual({ total: 2, done: 0, line: ['grok'] })
      // A client already in the line is not put in it twice.
      expect((await control.command({ type: 'queue-client-updates', providers: ['grok'] })).error).toBe('Grok Build is already updating. Wait for it to finish.')
      await installer.finish()
      expect((await first).error).toBeNull()
      await vi.waitFor(() => { expect(installer.started).toEqual(['claude', 'grok']) })
      await installer.finish()
      await vi.waitFor(() => { expect(states(control)).toMatchObject({ grok: 'updated' }) })
    } finally { control.dispose() }
  })

  it('takes a client still waiting out of the line, and leaves the one running to finish', async () => {
    const host = new ThreeClients()
    const installer = heldInstaller(host)
    const control = await coordinator(host, installer.run)
    try {
      await control.command({ type: 'queue-client-updates', providers: ['claude', 'codex'] })
      expect((await control.command({ type: 'cancel-client-updates', providers: ['codex'] })).error).toBeNull()
      expect(states(control)).toMatchObject({ claude: 'updating', codex: 'idle' })
      expect((await control.command({ type: 'cancel-client-updates', providers: ['claude'] })).error)
        .toBe('Claude Code is already updating, so it cannot be cancelled. Your threads keep working.')
      await installer.finish()
      await vi.waitFor(() => { expect(control.get().clientUpdateRun).toBeUndefined() })
      expect(installer.started).toEqual(['claude'])
      expect(states(control)).toMatchObject({ claude: 'updated', codex: 'idle' })
    } finally { control.dispose() }
  })

  it('says the order the line runs in, which is the order the clients joined it, not the tiles’', async () => {
    const host = new ThreeClients()
    const installer = heldInstaller(host)
    const control = await coordinator(host, installer.run)
    try {
      await control.command({ type: 'queue-client-updates', providers: ['claude'] })
      await control.command({ type: 'queue-client-updates', providers: ['grok'] })
      await control.command({ type: 'queue-client-updates', providers: ['codex'] })
      expect(control.get().clientUpdateRun).toEqual({ total: 3, done: 0, line: ['grok', 'codex'] })
    } finally { control.dispose() }
  })

  it('puts a cancelled client back as it was, with the failure it had', async () => {
    const host = new ThreeClients()
    const installer = heldInstaller(host, new Set(['codex']))
    const control = await coordinator(host, installer.run)
    try {
      await control.command({ type: 'queue-client-updates', providers: ['codex'] })
      await installer.finish()
      await vi.waitFor(() => { expect(states(control)).toMatchObject({ codex: 'failed' }) })
      await control.command({ type: 'queue-client-updates', providers: ['claude', 'codex'] })
      expect(states(control)).toMatchObject({ claude: 'updating', codex: 'queued' })
      await control.command({ type: 'cancel-client-updates', providers: ['codex'] })
      expect(control.get().clientUpdates?.find(update => update.id === 'codex')).toMatchObject({ state: 'failed', failure: 'download', error: 'npm ERR! network socket hang up' })
      await installer.finish()
    } finally { control.dispose() }
  })

  it('keeps what the line said while a check was waiting on the registry', async () => {
    const host = new ThreeClients()
    const installer = heldInstaller(host, new Set(['codex']))
    let holdCheck: Promise<void> | undefined
    let releaseCheck!: () => void
    const control = await coordinator(host, installer.run)
    // From here on, a check waits on the registry until the test lets it go.
    const clients = (control as unknown as { clients: ProviderClients }).clients
    const check = clients.check.bind(clients)
    clients.check = async (...args) => { if (holdCheck) await holdCheck; return check(...args) }
    try {
      await control.command({ type: 'queue-client-updates', providers: ['codex'] })
      holdCheck = new Promise<void>(resolve => { releaseCheck = resolve })
      const checking = control.command({ type: 'check-client-updates' })
      await installer.finish()
      await vi.waitFor(() => { expect(control.get().clientUpdateRun).toBeUndefined() })
      expect(states(control)).toMatchObject({ codex: 'failed' })
      releaseCheck()
      await checking
      expect(control.get().clientUpdates?.find(update => update.id === 'codex')).toMatchObject({ state: 'failed', failure: 'download' })
    } finally { releaseCheck?.(); control.dispose() }
  })

  it('puts a cancelled client back as behind, not with its old failure, when a newer release came out while it waited', async () => {
    const host = new ThreeClients()
    const installer = heldInstaller(host, new Set(['codex']))
    const control = await coordinator(host, installer.run)
    try {
      await control.command({ type: 'queue-client-updates', providers: ['codex'] })
      await installer.finish()
      await vi.waitFor(() => { expect(states(control)).toMatchObject({ codex: 'failed' }) })
      await control.command({ type: 'queue-client-updates', providers: ['claude', 'codex'] })
      const clients = (control as unknown as { clients: ProviderClients }).clients
      clients.publishedVersion = async provider => provider === 'codex' ? '0.159.0' : PUBLISHED[provider]
      await control.command({ type: 'check-client-updates' })
      expect(states(control)).toMatchObject({ claude: 'updating', codex: 'queued' })
      await control.command({ type: 'cancel-client-updates', providers: ['codex'] })
      const codex = control.get().clientUpdates?.find(update => update.id === 'codex')
      expect(codex).toMatchObject({ state: 'idle', published: '0.159.0', behind: true, canInstall: true })
      expect(codex).not.toHaveProperty('failure')
      await installer.finish()
    } finally { control.dispose() }
  })

  it('lets a newer release found by a waiting check win over how an update ended meanwhile', async () => {
    const host = new ThreeClients()
    const installer = heldInstaller(host, new Set(['codex']))
    let holdCheck: Promise<void> | undefined
    let releaseCheck!: () => void
    const control = await coordinator(host, installer.run)
    const clients = (control as unknown as { clients: ProviderClients }).clients
    const check = clients.check.bind(clients)
    clients.check = async (...args) => { if (holdCheck) await holdCheck; return check(...args) }
    try {
      await control.command({ type: 'queue-client-updates', providers: ['codex'] })
      holdCheck = new Promise<void>(resolve => { releaseCheck = resolve })
      const checking = control.command({ type: 'check-client-updates' })
      await installer.finish()
      await vi.waitFor(() => { expect(states(control)).toMatchObject({ codex: 'failed' }) })
      // The check that was waiting reads a release newer than the one the update failed to reach.
      clients.publishedVersion = async provider => provider === 'codex' ? '0.159.0' : PUBLISHED[provider]
      releaseCheck()
      await checking
      const codex = control.get().clientUpdates?.find(update => update.id === 'codex')
      expect(codex).toMatchObject({ state: 'idle', published: '0.159.0', behind: true })
      expect(codex).not.toHaveProperty('failure')
    } finally { releaseCheck?.(); control.dispose() }
  })

  it('keeps a client’s place in the line through a fresh check', async () => {
    const host = new ThreeClients()
    const installer = heldInstaller(host)
    const control = await coordinator(host, installer.run)
    try {
      await control.command({ type: 'queue-client-updates', providers: ['claude', 'codex'] })
      await control.command({ type: 'check-client-updates' })
      expect(states(control)).toMatchObject({ claude: 'updating', codex: 'queued' })
      await installer.finish(); await installer.finish()
      await vi.waitFor(() => { expect(states(control)).toMatchObject({ claude: 'updated', codex: 'updated' }) })
    } finally { control.dispose() }
  })

  it('shows Grok Build’s two steps as they run, and which one did not finish', async () => {
    const host = new ThreeClients()
    let next!: () => void
    const clients = new (class extends ProviderClients {
      override async check(provider: ProviderId, installed: string): Promise<ProviderClientUpdate> {
        return { id: provider, installed, published: PUBLISHED[provider]!, behind: true, channel: 'mise', command: 'mise upgrade npm:@xai-official/grok', steps: provider === 'grok' ? 2 : 1,
          canInstall: true, checkedAt: new Date().toISOString(), state: 'idle' }
      }
      override async install(_provider: ProviderId, _executable: string | undefined, _environment: NodeJS.ProcessEnv, onStep?: (step: number) => void) {
        onStep?.(1); await new Promise<void>(resolve => { next = resolve })
        onStep?.(2); await new Promise<void>(resolve => { next = resolve })
        return { ok: false, step: 2, failure: 'install-step' as const, detail: 'EACCES: permission denied' }
      }
    })()
    const directory = await mkdtemp(join(tmpdir(), 'sotto-client-steps-')); roots.push(directory)
    const credentials = new AgentCredentials(join(directory, 'vault'), { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() })
    await credentials.load()
    const control = new AgentControl({ schedule: immediatePublishScheduler, directory, host, credentials, clients, locateClient: async () => undefined,
      reasoner: { intent: async () => ({ type: 'clarify', text: '' }), decide: async () => ({ decision: 'human', text: '' }) },
    })
    await control.start()
    try {
      await control.command({ type: 'connect' })
      await control.command({ type: 'check-client-updates' })
      const grok = (): ProviderClientUpdate | undefined => control.get().clientUpdates?.find(update => update.id === 'grok')
      const update = control.command({ type: 'update-client', provider: 'grok' })
      await vi.waitFor(() => { expect(grok()).toMatchObject({ state: 'updating', step: 1, steps: 2 }) })
      next()
      await vi.waitFor(() => { expect(grok()).toMatchObject({ state: 'updating', step: 2 }) })
      next()
      expect((await update).error).toBe('mise installed Grok Build 1.0.43, but its install step did not finish (EACCES: permission denied). Sotto still starts 1.0.41, and your threads kept working.')
      expect(grok()).toMatchObject({ state: 'failed', step: 2, failure: 'install-step', installed: '1.0.41' })
    } finally { control.dispose() }
  })

  it('refuses a line with nothing it can update, with the first reason', async () => {
    const host = new ThreeClients()
    host.installed.codex = '0.158.0'; host.onDisk.codex = '0.158.0'
    const control = await coordinator(host, heldInstaller(host).run)
    try {
      expect((await control.command({ type: 'queue-client-updates', providers: ['codex'] })).error).toBe('Codex is already at the published version.')
      expect(control.get().clientUpdateRun).toBeUndefined()
    } finally { control.dispose() }
  })
})
