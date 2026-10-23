// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { startHeadlessHost } from '../../src/host'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import { publicProviderEntityId } from '../../src/shared/agents'
import { e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { HostCredentialEncryption } from '../../src/host/credentials'
import { SshHostLauncher, type SshCallbacks, type SshHostConfiguration, type SshHostConnection } from '../../src/main/hosts/sshLauncher'
import { HOST_ANSWER_LOST, opencodeHostNeedsUpdate, opencodeSignInComesBack, SIGN_IN_WORDS, type ModelSources } from '../../src/shared/opencodeSignIn'
import { startFixtureHeadlessHost } from '../fixtures/desktopHostStack'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import { DesktopHosts } from '../../src/main/hosts/desktopHosts'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { opencodeFixture } from '../fixtures/fakeOpenCodeFixture'
import { rawPeer } from '../fixtures/rawHostPeer'
import { ensureFixtureDesktopAnswers } from '../fixtures/sshDesktopAnswers'
import { testCredentials } from '../fixtures/testCredentials'

/**
 * OpenCode on a headless host (#1107, ADR-0087): the host runs it under the same Owl gate as this computer, sends it only
 * to clients that know it, and signs its own OpenCode in to model sources for the desktop that asks.
 */
const OWL = '0.1.37-owl.20261012.1'
// Made up for this test; no real key ever goes near a fixture.
const KEY = 'sk-host-fixture-made-up-key-41c9e0'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })
async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return root
}
const fakes = () => ({ codex: new FakeProviderHost(), claude: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost(), muse: new FakeProviderHost(), opencode: new FakeProviderHost() })

it.each([['stable', '0.1.37'], ['Owl', OWL]])('a headless host on %s runs OpenCode only where its Owl answer does', async (track, sottoVersion) => {
  const root = await scratch('sotto-host-opencode-')
  const providers = fakes()
  const host = await startHeadlessHost({ dataDirectory: root, providers, reasoner: {}, sottoVersion })
  cleanup.push(host.close)
  await expect.poll(() => host.service.shell().host.providers?.find(provider => provider.id === 'codex')?.connection).toBe('connected')
  if (track === 'stable') {
    // Stable holds OpenCode, as it does on this computer: nothing of it starts, and its state names none of it.
    expect(providers.opencode.connectCalls).toBe(0)
    expect(JSON.stringify(host.service.shell())).not.toContain('"opencode"')
    return
  }
  // Owl's answer is in force on a host now that hosts take OpenCode (it was held on every host until #1107).
  await expect.poll(() => providers.opencode.connectCalls).toBe(1)
  await expect.poll(() => host.service.shell().host.providers?.find(provider => provider.id === 'opencode')?.connection).toBe('connected')
  expect(host.service.shell().host.threads.some(thread => thread.providerId === 'opencode')).toBe(true)
})

it('sends OpenCode only to a client whose hello accepts provider-opencode, and hides its threads from every other client', async () => {
  const root = await scratch('sotto-host-opencode-peers-')
  const providers = fakes()
  const host = await startHeadlessHost({ dataDirectory: root, port: 0, providers, reasoner: {}, sottoVersion: OWL })
  cleanup.push(host.close)
  await expect.poll(() => host.service.shell().host.providers?.find(provider => provider.id === 'opencode')?.connection).toBe('connected')
  const port = host.descriptor!.port
  const url = 'http://127.0.0.1:' + port
  const paired = await SocketHostService.pair(url, host.pairing.issuePairingCode().code, 'Sotto desktop')
  const desktop = new SocketHostService({ url, token: paired.token, expectedHostId: paired.hostId, heldProviders: new Set() })
  cleanup.push(() => desktop.close())
  await desktop.connect()
  // This desktop knows OpenCode: it is sent OpenCode's row, models and threads.
  expect(desktop.shell().host.providers?.map(provider => provider.id)).toContain('opencode')
  const opencodeThread = desktop.shell().host.threads.find(thread => thread.providerId === 'opencode')!
  const codexThread = desktop.shell().host.threads.find(thread => thread.providerId === 'codex')!
  expect(opencodeThread).toBeDefined()

  // A phone or desktop from before OpenCode: its hello accepts no provider-opencode.
  const older = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'An older iPhone')
  const peer = await rawPeer(port, host.pairing.signSession(older.clientId))
  cleanup.push(async () => peer.frames.close())
  const hello = await peer.call('hello', { op: 'hello', afterSeq: 0, accepts: ['detail-delta', 'activity-summaries', 'model-catalog-revision'] }) as { ok: boolean; result: { shell: unknown; features: string[]; events: unknown[] } }
  expect(hello.ok).toBe(true)
  expect(hello.result.features).toContain('provider-opencode')
  // Nothing it is sent names OpenCode: no row, model, project, thread or event of it.
  const named = (value: unknown): boolean => /"opencode"|native:opencode:/u.test(JSON.stringify(value))
  expect(named(hello.result.shell)).toBe(false)
  expect(named(hello.result.events)).toBe(false)
  expect((hello.result.shell as { host: { threads: { id: string }[] } }).host.threads.map(thread => thread.id)).toContain(codexThread.id)
  // Its threads are not read, observed or commanded by it, any more than a thread it was never sent.
  expect(await peer.call('detail', { op: 'detail', threadId: opencodeThread.id })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  expect(await peer.call('select', { op: 'command', command: { type: 'select-thread', threadId: opencodeThread.id } })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  expect(await peer.call('observe', { op: 'observe', threadIds: [opencodeThread.id, codexThread.id] })).toMatchObject({ ok: true })
  expect(await peer.call('events', { op: 'events', afterSeq: 0, threadId: opencodeThread.id })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  // A change on the host goes to it without OpenCode in it, whatever changed.
  const before = peer.messages.length
  providers.opencode.state.threads[0]!.title = 'Renamed on OpenCode'
  providers.opencode.emit()
  providers.codex.state.threads[0]!.title = 'Renamed on Codex'
  providers.codex.emit()
  await expect.poll(() => peer.messages.slice(before).some(message => message.event === 'shell' && JSON.stringify(message).includes('Renamed on Codex'))).toBe(true)
  await expect.poll(() => desktop.shell().host.threads.some(thread => thread.title === 'Renamed on OpenCode')).toBe(true)
  expect(peer.messages.some(named)).toBe(false)

  // A client that knows OpenCode, whatever else it is, is sent all of it.
  const newer = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'A newer iPhone')
  const phone = await rawPeer(port, host.pairing.signSession(newer.clientId))
  cleanup.push(async () => phone.frames.close())
  const current = await phone.call('hello', { op: 'hello', accepts: ['detail-delta', 'provider-opencode'] }) as { result: { shell: unknown } }
  expect(named(current.result.shell)).toBe(true)
  expect(await phone.call('detail', { op: 'detail', threadId: opencodeThread.id })).toMatchObject({ ok: true })
})

// An answer lost on the way back from a host says nothing of what the host did: the key may be saved or the sign-in gone all
// the same. So the desktop never says nothing changed; it reads the host's model sources again and says what they show.
it('reads a host’s model sources again when its answer to a sign-in or sign-out is lost, and says what they show', { timeout: 90_000 }, async () => {
  const f = await opencodeFixture()
  cleanup.push(f.cleanup)
  const { hosts, forge } = await desktopWithForge(OWL, f)
  await vi.waitFor(() => expect(hosts.providerStatus(forge, 'opencode')?.connection).toBe('connected'), { timeout: 30_000 })
  const ask = (call: Parameters<typeof hosts.opencodeSignIn>[0]['call']) => hosts.opencodeSignIn({ id: forge, call })
  const through = SocketHostService.prototype.opencodeSignIn
  /** The next call reaches the host, which acts on it, and its answer never comes back. */
  const loseAnswer = (reach: boolean) => vi.spyOn(SocketHostService.prototype, 'opencodeSignIn').mockImplementationOnce(async function (this: SocketHostService, call) {
    if (reach) await through.call(this, call as never)
    throw new Error('The connection closed before the answer came back.')
  })
  cleanup.push(async () => { vi.restoreAllMocks() })

  // The key was saved on forge: the answer says so, from the list read again.
  loseAnswer(true)
  const saved = await ask({ action: 'key', request: { sourceId: 'anthropic', key: KEY } })
  expect(saved).toMatchObject({ status: 'ok', warning: HOST_ANSWER_LOST.took('forge', 'Anthropic', true) })
  expect(sources(saved).find(source => source.id === 'anthropic')?.signedIn).toBeDefined()
  // The sign-out went through on forge.
  loseAnswer(true)
  const out = await ask({ action: 'sign-out', request: { sourceId: 'anthropic' } })
  expect(out).toMatchObject({ status: 'ok', warning: HOST_ANSWER_LOST.took('forge', 'Anthropic', false) })
  expect(sources(out).find(source => source.id === 'anthropic')?.signedIn).toBeUndefined()
  // The key never reached forge: nothing was saved, and the answer says so because the list says so.
  loseAnswer(false)
  expect(await ask({ action: 'key', request: { sourceId: 'anthropic', key: KEY } }))
    .toEqual({ status: 'refused', reason: 'answer-lost', message: HOST_ANSWER_LOST.notTaken('forge', 'Anthropic', true) })
  // A call that names no source, such as a pasted code, cannot be checked that way: the window reads the list itself.
  loseAnswer(true)
  expect(await ask({ action: 'finish', request: { attemptId: 'con_gone', code: 'abc' } })).toEqual({ status: 'refused', reason: 'answer-lost', message: HOST_ANSWER_LOST.untold('forge') })
  // The list cannot be read again either: Sotto says it cannot tell.
  vi.spyOn(SocketHostService.prototype, 'opencodeSignIn').mockRejectedValue(new Error('The connection closed.'))
  expect(await ask({ action: 'sign-out', request: { sourceId: 'anthropic' } })).toEqual({ status: 'refused', reason: 'answer-lost', message: HOST_ANSWER_LOST.unknown('forge') })
  expect(await ask({ action: 'sources' })).toEqual({ status: 'refused', message: HOST_ANSWER_LOST.unread('forge') })
})

// A wait is only a read: one whose answer is lost leaves the sign-in waiting on the host, so the dialog keeps asking. Sotto
// says it cannot tell only when what the host did is truly unknown (#1143).
it('keeps waiting on a host’s sign-in through a lost answer, and says it cannot tell only when it cannot', { timeout: 90_000 }, async () => {
  const f = await opencodeFixture()
  cleanup.push(f.cleanup)
  await f.script({ oauth: { 'gitlab:pkce': { mode: 'code' } } })
  const { hosts, forge } = await desktopWithForge(OWL, f)
  await vi.waitFor(() => expect(hosts.providerStatus(forge, 'opencode')?.connection).toBe('connected'), { timeout: 30_000 })
  const ask = (call: Parameters<typeof hosts.opencodeSignIn>[0]['call']) => hosts.opencodeSignIn({ id: forge, call })
  const through = SocketHostService.prototype.opencodeSignIn
  const loseAnswer = (reach: boolean) => vi.spyOn(SocketHostService.prototype, 'opencodeSignIn').mockImplementationOnce(async function (this: SocketHostService, call) {
    if (reach) await through.call(this, call as never)
    throw new Error('The connection closed before the answer came back.')
  })
  cleanup.push(async () => { vi.restoreAllMocks() })
  const start = async () => {
    const started = await ask({ action: 'browser', request: { sourceId: 'gitlab', methodId: 'pkce', answer: { instanceUrl: 'https://gitlab.com' } } }) as { status: string; attempt: { id: string } }
    expect(started.status).toBe('waiting')
    return started.attempt.id
  }

  const attemptId = await start()
  // A lost wait: the sign-in still waits on forge, so the dialog waits on and asks again.
  loseAnswer(true)
  expect(await ask({ action: 'wait', request: { attemptId } })).toEqual({ status: 'pending' })
  expect(await ask({ action: 'wait', request: { attemptId } })).toEqual({ status: 'pending' })
  // A pasted code whose answer was lost before forge took it: the sign-in still waits, so the code is asked for again.
  loseAnswer(false)
  expect(await ask({ action: 'finish', request: { attemptId, code: 'good-code' } })).toEqual({ status: 'refused', reason: 'code-refused', message: HOST_ANSWER_LOST.code('forge') })
  // One forge took and finished: the sign-in waits no longer, and Sotto cannot tell how it ended, so it says so.
  loseAnswer(true)
  expect(await ask({ action: 'finish', request: { attemptId, code: 'good-code' } })).toEqual({ status: 'refused', reason: 'answer-lost', message: HOST_ANSWER_LOST.untold('forge') })

  // A sign-in that ended on forge after a wait's answer was lost: how it ended was in the answer that never came.
  const second = await start()
  loseAnswer(true)
  expect(await ask({ action: 'wait', request: { attemptId: second } })).toEqual({ status: 'pending' })
  await f.host.signIn.cancel({ attemptId: second })
  expect(await ask({ action: 'wait', request: { attemptId: second } })).toEqual({ status: 'refused', reason: 'answer-lost', message: HOST_ANSWER_LOST.untold('forge') })
  // A sign-in whose waits all came back ends in OpenCode's own words.
  const third = await start()
  expect(await ask({ action: 'cancel', request: { attemptId: third } })).toEqual({ status: 'ok' })
  expect(await ask({ action: 'wait', request: { attemptId: third } })).toEqual({ status: 'refused', message: SIGN_IN_WORDS.notRunning })
})

// A host gives no thread Sotto's tool servers: the browser, visuals, pull request tools and delegation are this computer's
// own (docs/agent-control.md), so a host's Codex threads have none, and its OpenCode threads have none either.
it('gives an OpenCode thread on a host none of Sotto’s tool servers, as the host gives no other provider’s threads', { timeout: 90_000 }, async () => {
  const f = await opencodeFixture()
  cleanup.push(f.cleanup)
  const host = await startHeadlessHost({ dataDirectory: await scratch('sotto-host-opencode-tools-'), providers: { opencode: f.host }, reasoner: e2eAgentReasoner, sottoVersion: OWL })
  cleanup.push(host.close)
  const client = desktopWindowClient('host-opencode-tools')
  const command = (value: Parameters<typeof host.service.command>[0]) => host.service.command(value, client)
  await command({ type: 'configure', patch: { enabledProviders: ['opencode'], provider: 'opencode' } })
  expect((await command({ type: 'connect', provider: 'opencode' })).error).toBeNull()
  const created = await command({ type: 'create-project', provider: 'opencode', title: 'Project', path: f.root, useExisting: true })
  const projectId = created.host.projects.find(project => project.path === f.root)!.id
  const threadId = randomUUID()
  expect((await command({ type: 'create-thread', threadId, projectId, title: 'Thread', modelId: publicProviderEntityId('opencode', 'model', f.modelId), workingCopy: 'shared' })).error).toBeNull()
  await command({ type: 'observe-threads', threadIds: [threadId] })
  expect((await command({ type: 'manual-send', threadId, text: 'Use whatever tools you have' })).error).toBeNull()
  await expect.poll(async () => (await f.driver.requests()).filter(record => record.method === 'session.prompt').length, { timeout: 30_000 }).toBe(1)
  // Its server was asked to add no MCP server and was never asked which it had, and the thread is not marked as missing
  // tools it was never offered.
  expect((await f.driver.requests()).filter(record => record.method?.startsWith('experimental.mcp.') === true || record.method === 'mcp.list')).toEqual([])
  expect(host.service.shell().host.threads.find(thread => thread.id === threadId)?.sottoToolsWithheld).toBeUndefined()
})

/** SSH that reaches the headless host running in this process, as the launch script would have started it. */
class LocalSsh extends SshHostLauncher {
  constructor(private readonly remote: Awaited<ReturnType<typeof startHeadlessHost>>, private readonly dataDirectory: string) { super() }
  override async connect(_configuration: SshHostConfiguration, callbacks: SshCallbacks = {}): Promise<SshHostConnection> {
    callbacks.onStep?.('sign-in'); callbacks.onStep?.('install'); callbacks.onStep?.('start')
    const hostId = this.remote.descriptor!.hostId
    return { url: 'http://127.0.0.1:' + this.remote.descriptor!.port, hostId, owned: true, route: { hostname: 'forge', identityFiles: [] }, close: async () => undefined,
      showHostPairingCode: async () => ({ ...this.remote.pairing.issuePairingCode(), hostId }), ensureDesktopAnswers: clientId => ensureFixtureDesktopAnswers(this.dataDirectory, hostId, clientId),
      revokeClient: async () => true, hostAdminToken: async () => { throw new Error('Nothing here administers phone access.') }, stopHost: async () => true,
      updateHost: async () => { throw new Error('Nothing here updates a host.') }, boot: async () => { throw new Error('Nothing here starts a host at boot.') } }
  }
  override async disconnect(): Promise<void> { /* nothing to close */ }
}

/** Every file under a folder, read as text, so a test can say a secret is in none of them. */
async function everything(folder: string): Promise<string> {
  const names = await readdir(folder, { recursive: true }).catch(() => [] as string[])
  const texts = await Promise.all(names.map(async name => {
    const path = join(folder, name)
    return (await stat(path)).isFile() ? readFile(path, 'utf8').catch(() => '') : ''
  }))
  return texts.join('\n')
}

/** A desktop that reaches `forge`, a headless host in this process, over its own SSH stand-in, as Settings > Hosts & phones does. */
async function desktopWithForge(sottoVersion: string, opencode: Awaited<ReturnType<typeof opencodeFixture>> | undefined) {
  const root = await scratch('sotto-host-opencode-sign-in-')
  const hostLog: string[] = []
  const remote = await startFixtureHeadlessHost({ dataDirectory: join(root, 'remote'), port: 0, reasoner: e2eAgentReasoner, sottoVersion, log: event => hostLog.push(event),
    ...(opencode ? { providers: { opencode: opencode.host } } : {}) })
  cleanup.push(() => remote.close())
  const credentials = await testCredentials(join(root, 'desktop'), { encryption: new HostCredentialEncryption('synthetic-desktop-credential-key') })
  const opened: string[] = []
  const browser = { fails: false }
  // An Owl desktop: OpenCode is held nowhere on it, in its router as in its hosts.
  const router = new DesktopHostRouter(emptyDesktopState, { heldProviders: new Set() })
  const hosts = new DesktopHosts({ router, directory: join(root, 'desktop'), credentials, localHostRunning: true, localHostEnabled: () => true, restart: () => undefined,
    heldProviders: new Set(), launcher: () => new LocalSsh(remote, join(root, 'remote')), openExternal: async url => { if (browser.fails) throw new Error('No browser.'); opened.push(url) } })
  cleanup.push(async () => router.dispose())
  await hosts.start(); cleanup.push(() => hosts.close())
  const forge = randomUUID()
  await hosts.command({ type: 'add', host: { id: forge, name: 'forge', target: 'zach@forge', identityFile: '', installPath: '/opt/sotto', dataDirectory: '/data/sotto' } })
  await vi.waitFor(() => expect(hosts.get().hosts.find(item => item.id === forge)?.phase).toBe('connected'), { timeout: 30_000 })
  return { root, remote, hosts, forge, opened, browser, hostLog }
}
const sources = (read: ModelSources | unknown): Extract<ModelSources, { status: 'ok' }>['sources'] => {
  const value = read as ModelSources | { status: 'ok'; sources: ModelSources }
  const list = 'sources' in value && !Array.isArray(value.sources) ? value.sources : value as ModelSources
  if (list.status !== 'ok') throw new Error(JSON.stringify(read))
  return list.sources
}

it('signs the host’s own OpenCode in from this computer: a key once, a device code in this computer’s browser, sign-out, and no key in any log', { timeout: 90_000 }, async () => {
  const f = await opencodeFixture(undefined, undefined, {}, { signInIdleMs: 500 })
  cleanup.push(f.cleanup)
  await f.script({ oauth: { 'xai:device': { mode: 'auto', code: 'QX7M-4LRT' }, 'gitlab:pkce': { mode: 'code' } } })
  const logged: string[] = []
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const spy = vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')) })
    cleanup.push(async () => spy.mockRestore())
  }
  const { root, hosts, forge, opened, browser, hostLog } = await desktopWithForge(OWL, f)
  await vi.waitFor(() => expect(hosts.providerStatus(forge, 'opencode')?.connection).toBe('connected'), { timeout: 30_000 })
  const ask = (call: Parameters<typeof hosts.opencodeSignIn>[0]['call']) => hosts.opencodeSignIn({ id: forge, call })

  // Every source forge's OpenCode lists, signed in to none.
  expect(sources(await ask({ action: 'sources' })).map(source => source.id)).toContain('anthropic')

  // A key goes to forge's OpenCode once, and the source turns signed in there.
  const signedIn = await ask({ action: 'key', request: { sourceId: 'anthropic', key: KEY } })
  expect(sources(signedIn).find(source => source.id === 'anthropic')).toMatchObject({ signedIn: { how: 'API key' } })
  expect((await f.driver.requests()).filter(record => record.method === 'integration.connect.key').map(record => record.params?.key)).toEqual([KEY])
  await vi.waitFor(() => expect(hosts.providerStatus(forge, 'opencode')?.account).toBe('Signed in to Anthropic'), { timeout: 30_000 })

  // A device code: the page opens in this computer's browser, from main, and the sign-in finishes by itself on forge.
  const started = await ask({ action: 'browser', request: { sourceId: 'xai', methodId: 'device' } }) as { status: string; attempt: { id: string; code?: string } }
  expect(started).toMatchObject({ status: 'waiting', attempt: { code: 'QX7M-4LRT' } })
  expect(opened).toEqual([])
  expect(await ask({ action: 'reopen', request: { attemptId: started.attempt.id } })).toEqual({ status: 'ok' })
  expect(opened).toEqual(['https://sign-in.fixture.invalid/xai/device?user_code=QX7M-4LRT'])
  browser.fails = true
  expect(await ask({ action: 'reopen', request: { attemptId: started.attempt.id } }))
    .toEqual({ status: 'not-opened', message: SIGN_IN_WORDS.pageNotOpened, address: 'https://sign-in.fixture.invalid/xai/device?user_code=QX7M-4LRT' })
  browser.fails = false
  expect(await ask({ action: 'wait', request: { attemptId: started.attempt.id } })).toEqual({ status: 'pending' })
  await writeFile(join(f.root, 'approve.json'), JSON.stringify({ integrationID: 'xai' }))
  expect(sources(await ask({ action: 'wait', request: { attemptId: started.attempt.id } })).find(source => source.id === 'xai')?.signedIn).toBeDefined()

  // A pasted code works from here too, and Cancel ends a sign-in on forge.
  const pasted = await ask({ action: 'browser', request: { sourceId: 'gitlab', methodId: 'pkce', answer: { instanceUrl: 'https://gitlab.com' } } }) as { status: string; attempt: { id: string } }
  expect(pasted).toMatchObject({ status: 'waiting', attempt: { mode: 'code' } })
  expect(await ask({ action: 'cancel', request: { attemptId: pasted.attempt.id } })).toEqual({ status: 'ok' })
  expect((await f.driver.requests()).filter(record => record.method === 'integration.connect.oauth.cancel').map(record => record.params?.itemID)).toContain(pasted.attempt.id)

  // Sign out removes the key from forge's OpenCode.
  const out = await ask({ action: 'sign-out', request: { sourceId: 'anthropic' } })
  expect(sources(out).find(source => source.id === 'anthropic')?.signedIn).toBeUndefined()

  // The key is in no log on either side, and in nothing either Sotto keeps: only forge's OpenCode held it.
  expect(JSON.stringify([logged, hostLog, f.events])).not.toContain(KEY)
  expect(await everything(root)).not.toContain(KEY)
  expect(hostLog.every(event => /^[a-z0-9-]+$/u.test(event))).toBe(true)
})

it('refuses on a host a browser sign-in that sends the browser back to OpenCode on that machine, and cancels it there', { timeout: 90_000 }, async () => {
  const f = await opencodeFixture()
  cleanup.push(f.cleanup)
  await f.script({ oauth: { 'openai:chatgpt-token-sharing': { mode: 'auto' } } })
  const { hosts, forge, opened } = await desktopWithForge(OWL, f)
  await vi.waitFor(() => expect(hosts.providerStatus(forge, 'opencode')?.connection).toBe('connected'), { timeout: 30_000 })
  expect(await hosts.opencodeSignIn({ id: forge, call: { action: 'browser', request: { sourceId: 'openai', methodId: 'chatgpt-token-sharing' } } }))
    .toEqual({ status: 'refused', reason: 'finishes-on-host', message: opencodeSignInComesBack('forge') })
  expect(opened).toEqual([])
  await expect.poll(async () => (await f.driver.requests()).filter(record => record.method === 'integration.connect.oauth.cancel').length).toBe(1)
})

it('lets only the client that started a host’s OpenCode sign-in read it, and says an older host needs an update', { timeout: 90_000 }, async () => {
  const f = await opencodeFixture()
  cleanup.push(f.cleanup)
  await f.script({ oauth: { 'xai:device': { mode: 'auto', code: 'QX7M-4LRT' } } })
  const root = await scratch('sotto-host-opencode-owners-')
  const host = await startHeadlessHost({ dataDirectory: root, port: 0, providers: { opencode: f.host }, reasoner: e2eAgentReasoner, sottoVersion: OWL })
  cleanup.push(host.close)
  const url = 'http://127.0.0.1:' + host.descriptor!.port
  const pair = async (name: string) => {
    const paired = await SocketHostService.pair(url, host.pairing.issuePairingCode().code, name)
    const client = new SocketHostService({ url, token: paired.token, expectedHostId: paired.hostId, heldProviders: new Set() })
    cleanup.push(() => client.close())
    await client.connect(); return client
  }
  const desktop = await pair('Sotto desktop'), other = await pair('Another desktop')
  await expect.poll(() => desktop.shell().host.providers?.find(provider => provider.id === 'opencode')?.connection).toBe('connected')
  expect(desktop.offersOpenCodeSignIn()).toBe(true)
  const started = await desktop.opencodeSignIn({ action: 'browser', request: { sourceId: 'xai', methodId: 'device' } })
  if (started.status !== 'waiting') throw new Error(started.message)
  await expect(other.opencodeSignIn({ action: 'page', request: { attemptId: started.attempt.id } })).rejects.toMatchObject({ code: 'forbidden' })
  await expect(other.opencodeSignIn({ action: 'cancel', request: { attemptId: started.attempt.id } })).rejects.toMatchObject({ code: 'forbidden' })
  expect(await desktop.opencodeSignIn({ action: 'page', request: { attemptId: started.attempt.id } }))
    .toEqual({ status: 'ok', address: 'https://sign-in.fixture.invalid/xai/device?user_code=QX7M-4LRT' })
  expect(await desktop.opencodeSignIn({ action: 'cancel', request: { attemptId: started.attempt.id } })).toEqual({ status: 'ok' })

  // A host where OpenCode does not run, such as a stable one, offers no OpenCode sign-in, and the tile says so in words.
  const { hosts, forge } = await desktopWithForge('0.1.37', undefined)
  expect(await hosts.opencodeSignIn({ id: forge, call: { action: 'sources' } })).toEqual({ status: 'refused', message: opencodeHostNeedsUpdate('forge') })
})
