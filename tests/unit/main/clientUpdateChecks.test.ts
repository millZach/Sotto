// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentControl } from '../../../src/main/agents/control'
import { CLIENT_CHECK_INTERVAL_MS, CLIENT_PACKAGES, ProviderClients, type RunResult } from '../../../src/main/agents/providerClients'
import { E2EAgentHost } from '../../../src/main/e2e/agentEffects'
import type { AgentHostSnapshot, ProviderClientUpdate, ProviderId } from '../../../src/shared/agents'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'
import { testCredentials } from '../../fixtures/testCredentials'
import { createAgentControl } from '../../fixtures/agentControlFixture'
import { deferred } from '../../fixtures/deferred'

/**
 * ADR-0042: every machine checks its clients every five minutes while Sotto stays open, so a client published meanwhile
 * is noticed without a restart. The check installs nothing, follows the user's setting, and publishes only when a reading
 * moved. ADR-0077: a new version of Sotto has this computer check afresh, keeping what an update already run said.
 */
const roots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const IDS: readonly ProviderId[] = ['claude', 'codex', 'grok']

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

/** The registry: what each package publishes now, how many times it was asked, and a gate a test may close. */
function registry() {
  const published: Record<string, string> = { claude: '2.1.281', codex: '0.155.1', grok: '1.0.41' }
  // `now` is the clock each reading is stamped with, which a test moves on.
  const state = { asked: 0, located: 0, now: 1_000_000, gate: undefined as Promise<void> | undefined }
  const fetchImpl = async (url: string): Promise<Response> => {
    state.asked += 1
    if (state.gate) await state.gate
    const id = IDS.find(item => url.includes(encodeURIComponent(CLIENT_PACKAGES[item]!.split('/')[0]!)))!
    return new Response(JSON.stringify({ version: published[id] }), { status: 200 })
  }
  return { published, state, fetchImpl }
}

async function coordinator(options: { run?: (executable: string, args: readonly string[]) => Promise<RunResult> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-client-checks-')); roots.push(directory)
  const prefix = join(directory, 'npm')
  for (const id of IDS) {
    await mkdir(join(prefix, 'node_modules', ...CLIENT_PACKAGES[id]!.split('/')), { recursive: true })
    await writeFile(join(prefix, 'node_modules', ...CLIENT_PACKAGES[id]!.split('/'), 'package.json'), '{}')
  }
  const credentials = await testCredentials(join(directory, 'vault'), { mode: 'plain' })
  const host = new ThreeClients()
  const npm = registry()
  // Only the intervals are the test's: the coordinator's own reads and the disk run as they do.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const control = createAgentControl({
    schedule: immediatePublishScheduler, directory, host, credentials,
    clients: new ProviderClients({ fetchImpl: npm.fetchImpl, now: () => npm.state.now, npmPath: async () => join(prefix, 'npm-cli.js'),
      ...(options.run ? { run: options.run } : {}) }),
    // A check finds each client before it asks the registry, in the same turn as the tick that starts it.
    locateClient: async provider => { npm.state.located += 1; return join(prefix, `${provider}.exe`) },
    reasoner: {},
  })
  await control.start()
  await control.command({ type: 'connect' })
  await control.command({ type: 'check-client-updates' })
  // The check the connection started has finished too.
  await vi.waitFor(() => { expect(control.get().clientUpdates).toHaveLength(3) })
  const publishes = { count: 0 }
  control.subscribe(() => { publishes.count += 1 })
  return { control, host, npm, publishes }
}
const reading = (control: AgentControl, id: ProviderId): ProviderClientUpdate | undefined => control.get().clientUpdates?.find(item => item.id === id)
/** Runs the interval's next tick and waits until the registry has been asked `count` more times. */
async function tick(npm: ReturnType<typeof registry>, count: number): Promise<void> {
  const before = npm.state.asked
  vi.advanceTimersByTime(CLIENT_CHECK_INTERVAL_MS)
  await vi.waitFor(() => { expect(npm.state.asked).toBe(before + count) })
}

describe('the five-minute client check', () => {
  it('finds a client published while Sotto stays open, asking the registry afresh, and installs nothing', async () => {
    const { control, npm, publishes } = await coordinator()
    try {
      expect(reading(control, 'codex')).toMatchObject({ behind: false })
      npm.published.codex = '0.158.0'
      await tick(npm, 3)
      await vi.waitFor(() => { expect(reading(control, 'codex')).toMatchObject({ installed: '0.155.1', published: '0.158.0', behind: true, canInstall: true, state: 'idle' }) })
      expect(publishes.count).toBeGreaterThan(0)
      // The next tick asks again rather than reading the answer it was just given.
      await tick(npm, 3)
    } finally { control.dispose() }
  })

  it('publishes only when a reading moved, and keeps when it last checked for the next publish', async () => {
    const { control, npm, publishes } = await coordinator()
    try {
      const checkedBefore = reading(control, 'claude')!.checkedAt
      npm.state.now += CLIENT_CHECK_INTERVAL_MS
      await tick(npm, 3)
      await vi.waitFor(() => { expect(reading(control, 'grok')!.checkedAt).not.toBe(checkedBefore) })
      expect(publishes.count).toBe(0)
    } finally { control.dispose() }
  })

  it('brings the card back by itself when a newer release appears after Not now', async () => {
    const { control, npm } = await coordinator()
    try {
      npm.published.grok = '1.0.43'
      await tick(npm, 3)
      await vi.waitFor(() => { expect(reading(control, 'grok')?.behind).toBe(true) })
      await control.command({ type: 'dismiss-client-updates' })
      // The same release again keeps it put away.
      await tick(npm, 3)
      expect(control.get().clientUpdatesDismissedAt).toBeDefined()
      npm.published.grok = '1.0.44'
      await tick(npm, 3)
      await vi.waitFor(() => { expect(control.get().clientUpdatesDismissedAt).toBeUndefined() })
    } finally { control.dispose() }
  })

  it('checks nothing while the setting is off', async () => {
    const { control, npm } = await coordinator()
    try {
      await control.command({ type: 'configure', patch: { checkClientUpdates: false } })
      const before = npm.state.located
      vi.advanceTimersByTime(CLIENT_CHECK_INTERVAL_MS * 3)
      expect(npm.state.located).toBe(before)
    } finally { control.dispose() }
  })

  it('lets a tick go while the last check still waits on the registry', async () => {
    const { control, npm } = await coordinator()
    try {
      const gate = deferred(); npm.state.gate = gate.promise
      await tick(npm, 1)
      const waiting = npm.state.asked, located = npm.state.located
      vi.advanceTimersByTime(CLIENT_CHECK_INTERVAL_MS * 2)
      expect(npm.state.located).toBe(located)
      npm.state.gate = undefined; gate.resolve()
      // The check that was waiting finishes its other two clients; no second check started beside it.
      await vi.waitFor(() => { expect(npm.state.asked).toBe(waiting + 2) })
      await tick(npm, 3)
    } finally { control.dispose() }
  })

  it('lets a tick go while a client updates, whose own check reads the new version', async () => {
    const started = deferred(), release = deferred()
    const fixture = await coordinator({ run: async () => { started.resolve(); await release.promise; return { ok: true } } })
    const { control, npm, host } = fixture
    try {
      npm.published.codex = '0.158.0'
      await control.command({ type: 'check-client-updates' })
      await control.command({ type: 'queue-client-updates', providers: ['codex'] })
      await started.promise
      const before = npm.state.located
      vi.advanceTimersByTime(CLIENT_CHECK_INTERVAL_MS)
      expect(npm.state.located).toBe(before)
      host.onDisk.codex = '0.158.0'; release.resolve()
      await vi.waitFor(() => { expect(reading(control, 'codex')?.state).toBe('updated') })
    } finally { control.dispose() }
  })

  it('stops when Sotto does', async () => {
    const { control, npm } = await coordinator()
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    control.dispose()
    // Nothing is left to fire: the five-minute check went with the rest.
    expect(vi.getTimerCount()).toBe(0)
    const before = npm.state.located
    vi.advanceTimersByTime(CLIENT_CHECK_INTERVAL_MS * 2)
    expect(npm.state.located).toBe(before)
  })
})

describe('checking afresh', () => {
  it('asks the registry for an explicit Check even when it answered a moment ago', async () => {
    const { control, npm } = await coordinator()
    try {
      npm.published.claude = '2.1.290'
      const before = npm.state.asked
      await control.command({ type: 'check-client-updates' })
      expect(npm.state.asked).toBe(before + 3)
      expect(reading(control, 'claude')).toMatchObject({ published: '2.1.290', behind: true })
    } finally { control.dispose() }
  })

  it('keeps what an update already run said when a new version of Sotto has this computer check afresh (ADR-0077)', async () => {
    const fixture = await coordinator({ run: async (_executable, args) => args.some(arg => arg.startsWith('@openai/codex'))
      ? { ok: false, detail: 'npm ERR! network socket hang up' } : { ok: true } })
    const { control, npm, host } = fixture
    try {
      npm.published.codex = '0.158.0'; npm.published.grok = '1.0.43'
      await control.command({ type: 'check-client-updates' })
      host.onDisk.grok = '1.0.43'
      await control.command({ type: 'queue-client-updates', providers: ['codex', 'grok'] })
      await vi.waitFor(() => { expect(control.get().clientUpdateRun).toBeUndefined() })
      const ran = { codex: reading(control, 'codex')!, grok: reading(control, 'grok')! }
      expect(ran.codex).toMatchObject({ state: 'failed', ranAt: expect.any(String) })
      expect(ran.grok).toMatchObject({ state: 'updated', installed: '1.0.43', ranAt: expect.any(String) })
      // Claude Code is published meanwhile. The registry answered a moment ago, and is asked again all the same.
      npm.published.claude = '2.1.290'
      const before = npm.state.asked
      await control.checkClientsAfresh()
      expect(npm.state.asked).toBe(before + 3)
      expect(reading(control, 'claude')).toMatchObject({ published: '2.1.290', behind: true, state: 'idle' })
      expect(reading(control, 'codex')).toMatchObject({ state: 'failed', ranAt: ran.codex.ranAt, error: ran.codex.error })
      expect(reading(control, 'grok')).toMatchObject({ state: 'updated', ranAt: ran.grok.ranAt })
    } finally { control.dispose() }
  })

  it('does nothing while the setting is off or a client updates', async () => {
    const started = deferred(), release = deferred()
    const { control, npm } = await coordinator({ run: async () => { started.resolve(); await release.promise; return { ok: false, detail: 'stopped' } } })
    try {
      npm.published.codex = '0.158.0'
      await control.command({ type: 'check-client-updates' })
      await control.command({ type: 'queue-client-updates', providers: ['codex'] })
      await started.promise
      const before = npm.state.asked
      await control.checkClientsAfresh()
      expect(npm.state.asked).toBe(before)
      release.resolve()
      await vi.waitFor(() => { expect(control.get().clientUpdateRun).toBeUndefined() })
      await control.command({ type: 'configure', patch: { checkClientUpdates: false } })
      await control.checkClientsAfresh()
      expect(npm.state.asked).toBe(before)
    } finally { control.dispose() }
  })
})
