// @vitest-environment node
// A thread on another machine delegates on its own machine (#1310): the headless host runs delegation and `sotto_delegate`
// for its own threads, held to the desktop defaults a desktop sends it, over its real socket listener and its real
// loopback tool server, with fake providers standing in for the providers' own processes.
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { startFixtureHeadlessHost } from '../fixtures/desktopHostStack'
import { codexFixture } from '../fixtures/codexFixture'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import { DesktopDefaultsPush, followDesktopDefaults } from '../../src/main/hosts/desktopDefaults'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import { DESKTOP_CLIENTS_FILE } from '../../src/shared/desktopClients'
import { HOST_CEILING_HOLD_WORDS } from '../../src/shared/desktopDefaults'
import type { ScopedThreadTools } from '../../src/main/agents/threadToolServer'
import type { AgentRuntimeMode } from '../../src/shared/agents'
import { rawPeer } from '../fixtures/rawHostPeer'
import { hostEntityKey } from '../../src/shared/clientIdentity'
import { DesktopDelegationRelay, type RelayHostConnection } from '../../src/main/agents/delegationRelayDesktop'

const OWL = '0.1.38-owl.20261013.1'
const STABLE = '0.1.38'
/** The window on the host machine itself, which may give any permission, as the user at that machine may. */
const LOCAL = { clientId: 'host-window', user: 'Synthetic user at the host', transport: 'ipc' } as const

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function hostFixture(version = OWL) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-host-delegation-'))
  // Codex's own app server, faked as a child process, which takes Sotto's tool servers at each launch as the real one does.
  const provider = { tools: [] as readonly ScopedThreadTools[] }
  const launch = async () => {
    const native = await codexFixture(undefined, false, 10_000); cleanups.push(native.cleanup)
    const useThreadTools = native.adapter.useThreadTools.bind(native.adapter)
    native.adapter.useThreadTools = tools => { provider.tools = tools; useThreadTools(tools) }
    return { native, host: await startFixtureHeadlessHost({ dataDirectory: root, port: 0, sottoVersion: version, providers: { codex: native.adapter } }) }
  }
  let { native, host } = await launch()
  let url = 'http://127.0.0.1:' + host.descriptor!.port
  const clients: SocketHostService[] = []
  cleanups.push(async () => {
    await Promise.all(clients.map(client => client.close()))
    await host.close()
    if (dirname(root) === tmpdir() && root.includes('sotto-host-delegation-')) await rm(root, { recursive: true, force: true })
  })
  const command = async (value: Parameters<typeof host.service.command>[0]) => {
    const state = await host.service.command(value, LOCAL)
    expect(state.error).toBeNull()
    return state
  }
  await command({ type: 'connect', provider: 'codex' })
  const path = join(root, 'project'); await mkdir(path, { recursive: true })
  const project = (await command({ type: 'create-project', provider: 'codex', title: 'Synthetic host project', path, useExisting: true })).host.projects.find(item => item.path === path)!
  const model = host.service.shell().host.models.find(item => item.providerId === 'codex' && item.ready)!
  /** A desktop the launch script recorded, paired and connected over the host's socket. */
  const recorded: string[] = []
  const desktop = async (record = true, crossMachineEnabled = false, relaysDelegation = false) => {
    const pairing = await SocketHostService.pair(url, host.pairing.issuePairingCode().code, 'Synthetic desktop')
    if (record) { recorded.push(pairing.clientId); await writeFile(join(root, DESKTOP_CLIENTS_FILE), JSON.stringify(recorded)) }
    const socket = new SocketHostService({ url, token: pairing.token, expectedHostId: pairing.hostId, crossMachineEnabled, relaysDelegation })
    clients.push(socket)
    const hello = await socket.connect()
    return { socket, pairing, hello }
  }
  const descriptor = async () => JSON.parse(await readFile(join(root, 'host-listener.json'), 'utf8')) as { adminToken: string; port: number }
  /** The host's own owner lets a desktop answer here, or stops it, as `--allow-answers` and `--deny-answers` do. */
  const answers = async (clientId: string, allowed: boolean) => {
    const response = await fetch(url + '/v1/admin/' + (allowed ? 'allow-answers' : 'deny-answers'), { method: 'POST',
      headers: { Authorization: 'Bearer ' + (await descriptor()).adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId }) })
    expect(response.status).toBe(200)
  }
  /** The provider's own session behind a Sotto thread, as the host's thread registry binds it. */
  const session = async (threadId: string) => {
    let sessionId: string | undefined
    await expect.poll(async () => {
      const registry = JSON.parse(await readFile(join(root, 'threads.json'), 'utf8').catch(() => '{"bindings":[]}')) as { bindings: { threadId: string; sessionId: string }[] }
      sessionId = registry.bindings.find(binding => binding.threadId === threadId)?.sessionId
      return sessionId
    }).toBeDefined()
    return sessionId!
  }
  /** A thread the user started at the host with `permission`, and their message to it, its turn still running. */
  const parentThread = async (permission: AgentRuntimeMode = 'full-access') => {
    const threadId = randomUUID(), title = `Synthetic parent ${threadId.slice(0, 8)}`
    await command({ type: 'create-thread', threadId, projectId: project.id, title, modelId: model.id, runtimeMode: permission, workingCopy: 'shared' })
    await command({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'Synthetic user request' })
    return { threadId, title }
  }
  /** A tool call as the provider makes it: through the thread's own loopback server, with its own token. */
  const call = async (threadId: string, name: string, args: Record<string, unknown>) => {
    const server = await provider.tools.find(tools => tools.name === 'sotto_delegate')?.mcpServer(await session(threadId))
    if (!server) return undefined
    const response = await fetch(server.url, { method: 'POST', headers: { 'Content-Type': 'application/json', [server.headers[0]!.name]: server.headers[0]!.value },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
    expect(response.status).toBe(200)
    return ((await response.json()) as { result: { structuredContent: Record<string, unknown> } }).result.structuredContent
  }
  const start = (threadId: string, permission: AgentRuntimeMode, extra: Record<string, unknown> = {}) =>
    call(threadId, 'delegate', { work: 'code-review', brief: 'Synthetic brief', provider: 'codex', model: model.id, effort: 'low', permission, wait_seconds: 0, ...extra })
  /** The provider ends a thread's running turn with a reply, as the thread's own words, and the host has seen it end. */
  const reply = async (threadId: string, text: string) => {
    await native.driver.completeTurn(await session(threadId), text)
    await expect.poll(() => host.service.shell().host.threads.find(item => item.id === threadId)?.lastTurn?.status).toBe('completed')
  }
  const thread = (threadId: string) => host.service.shell().host.threads.find(item => item.id === threadId)
  /** `desktop-defaults` sent as it is on the wire, after hello, whatever the client was offered: the host's own answer. */
  const raw = async (clientId: string, defaults: Record<string, unknown>) => {
    const peer = await rawPeer(host.descriptor!.port, host.pairing.signSession(clientId, Date.now()))
    cleanups.push(async () => peer.frames.close())
    await peer.call('hello', { op: 'hello' })
    return await peer.call('defaults', { op: 'desktop-defaults', defaults })
  }
  /** Any request sent as it is on the wire, after hello, whatever the client was offered: the host's own answer. */
  const rawCall = async (clientId: string, operation: Record<string, unknown>) => {
    const peer = await rawPeer(host.descriptor!.port, host.pairing.signSession(clientId, Date.now()))
    cleanups.push(async () => peer.frames.close())
    await peer.call('hello', { op: 'hello' })
    return await peer.call('request', operation)
  }
  /** The host's own owner forgets a paired desktop, as `--revoke-client` does. Its answers grant stays on record. */
  const revoke = async (clientId: string) => {
    const response = await fetch(url + '/v1/admin/revoke-client', { method: 'POST',
      headers: { Authorization: 'Bearer ' + (await descriptor()).adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId }) })
    expect(response.status).toBe(200)
  }
  /** The host stops and starts again on the same records, with its provider launched afresh. */
  const restart = async () => {
    await host.close()
    ;({ native, host } = await launch())
    url = 'http://127.0.0.1:' + host.descriptor!.port
    await command({ type: 'connect', provider: 'codex' })
  }
  return { root, get host() { return host }, get url() { return url }, provider, get native() { return native }, command, desktop, answers, revoke, restart,
    session, parentThread, call, start, reply, thread, model, project, descriptor, raw, rawCall }
}

it('lets a thread on a host start a child on its own machine under the desktop defaults, and tells it the outcome there', async () => {
  const f = await hostFixture()
  const { socket, pairing, hello } = await f.desktop()
  expect(hello.features).toContain('host-delegation')
  expect(socket.supportsHostDelegation).toBe(true)
  await f.answers(pairing.clientId, true)
  expect(await socket.desktopDefaults({ newThreadRuntimeMode: 'auto' })).toMatchObject({ receivedAt: expect.any(String) })
  const parent = await f.parentThread()
  // The thread is offered `sotto_delegate` on this machine's loopback, with this machine's words.
  const server = f.provider.tools.find(tools => tools.name === 'sotto_delegate')!
  expect(server.definitions.find(tool => tool.name === 'delegate')!.description).toContain('on this machine')
  expect(await f.call(parent.threadId, 'list_machines', {})).toMatchObject({ status: 'ok', machines: [{ name: 'This machine', thisComputer: true }] })

  const started = await f.start(parent.threadId, 'auto') as { status: string; delegation: { id: string; thread: string; outcome: string }; placement?: unknown }
  expect(started).toMatchObject({ status: 'ok', delegation: { outcome: 'working' } })
  const child = started.delegation.thread
  // The child is an ordinary thread on the same machine, linked to its parent, at the desktop's default.
  await expect.poll(() => f.thread(child)?.delegatedBy).toBe(parent.threadId)
  expect(f.thread(child)).toMatchObject({ runtimeMode: 'auto', projectId: f.project.id })
  // The desktop already joins every host's threads, so the link reaches it with the child (the roster's data).
  await expect.poll(() => socket.shell().host.threads.find(item => item.id === child)?.delegatedBy).toBe(parent.threadId)
  // The child is asked on its own; another machine goes through a desktop that relays (#1316), and with none connected,
  // as this test's desktop does not accept the relay, it is refused by name, recorded, and nothing is queued.
  expect(await f.start(parent.threadId, 'auto', { machine: randomUUID() })).toMatchObject({ status: 'refused', code: 'MACHINE_UNAVAILABLE',
    message: expect.stringMatching(/^This computer isn't connected to .+, so nothing was started there\. Start it on .+ instead, or try again when this computer is back\.$/u) })

  // The parent's turn ends, then the child answers: the outcome and the reply come back to the parent on this machine,
  // as its hidden wake-up, with the child's words.
  await f.reply(parent.threadId, 'Synthetic parent reply')
  await f.reply(child, 'Synthetic child finding')
  // The provider is sent the news as the parent's next turn on this machine, with the child's words in it, and the host
  // records it as a wake-up no one is shown. The parent did not ask, so the news is what tells it.
  await expect.poll(async () => (await f.native.driver.requests()).some(request => request.method === 'turn/start'
    && JSON.stringify(request.params).includes('Synthetic child finding')), { timeout: 30_000 }).toBe(true)
  await expect.poll(() => f.thread(parent.threadId)?.wakeUpMessageIds?.length ?? 0).toBeGreaterThan(0)
  expect(await f.call(parent.threadId, 'read_delegation', { delegation: started.delegation.id })).toMatchObject({ delegation: { outcome: 'answered' } })
}, 60_000)

it('relays a host thread\'s start to This computer over the socket, and reads it again exactly after a reconnect (#1316)', async () => {
  const f = await hostFixture()
  const { socket, pairing, hello } = await f.desktop(true, true, true)
  expect(hello.features).toContain('delegation-relay')
  await f.answers(pairing.clientId, true)
  await socket.desktopDefaults({ newThreadRuntimeMode: 'auto' })
  // This computer's side: placed here, and admitted by a stand-in for its own delegation, which keeps the record.
  const desktopRoot = await mkdtemp(join(tmpdir(), 'sotto-host-delegation-desktop-'))
  cleanups.push(async () => { if (dirname(desktopRoot) === tmpdir()) await rm(desktopRoot, { recursive: true, force: true }) })
  const THIS_COMPUTER = randomUUID(), DELEGATION = randomUUID()
  const asked: { threadId: string; args: unknown }[] = []
  let outcome: 'working' | 'answered' = 'working'
  const relay = new DesktopDelegationRelay(desktopRoot, { localHostId: () => THIS_COMPUTER, placement: {
    machines: async () => ({ status: 'ok', machines: [{ hostId: THIS_COMPUTER, name: 'This computer' }] }),
    placement: async () => ({ hostId: THIS_COMPUTER, projectId: 'desktop-project', receipt: { hostId: THIS_COMPUTER, name: 'This computer', awayFromDefault: false } }),
    machineName: () => 'forge' } })
  relay.useDelegation({ delegate: async (threadId, args) => { asked.push({ threadId, args }); return { status: 'ok', delegation: { id: DELEGATION, thread: 'desktop-child', outcome: 'working' } } },
    read: async () => ({ status: 'ok', delegation: { id: DELEGATION, thread: 'desktop-child', outcome,
      ...outcome === 'answered' ? { reply: { from: 'delegated-thread', thread: 'desktop-child', messageId: 'reply-1', text: 'Synthetic finding from This computer', truncated: false } } : {} } }),
    cancel: async () => ({ status: 'ok' }), retriedDelegation: () => DELEGATION, isOpen: () => outcome === 'working', hasOpen: () => outcome === 'working' })
  const connections: RelayHostConnection[] = [{ hostId: pairing.hostId, name: 'forge', kind: 'remote', service: socket }]
  relay.useHosts({ subscribeConnected: () => () => undefined, remoteConnections: () => connections })

  const parent = await f.parentThread()
  const started = await f.start(parent.threadId, 'auto', { machine: THIS_COMPUTER })
  expect(started).toMatchObject({ status: 'ok', delegation: { id: DELEGATION, outcome: 'working' }, placement: { hostId: THIS_COMPUTER, name: 'This computer' } })
  expect(asked).toEqual([{ threadId: hostEntityKey(pairing.hostId, parent.threadId), args: expect.objectContaining({ brief: 'Synthetic brief', permission: 'auto' }) }])
  expect(asked[0]!.args).not.toHaveProperty('machine')
  await f.reply(parent.threadId, 'Synthetic parent reply')

  // The connection drops while the child works, and the child answers meanwhile. A new connection from the same desktop is
  // read exactly by the host, after its hello, and the parent is woken with the child's words.
  await socket.close()
  outcome = 'answered'
  const again = new SocketHostService({ url: f.url, token: pairing.token, expectedHostId: pairing.hostId, crossMachineEnabled: true, relaysDelegation: true })
  cleanups.push(() => again.close())
  await again.connect()
  connections.splice(0, 1, { hostId: pairing.hostId, name: 'forge', kind: 'remote', service: again })
  relay.useHosts({ subscribeConnected: () => () => undefined, remoteConnections: () => connections })
  await expect.poll(async () => (await f.native.driver.requests()).some(request => request.method === 'turn/start'
    && JSON.stringify(request.params).includes('Synthetic finding from This computer')), { timeout: 30_000 }).toBe(true)
  expect(await f.call(parent.threadId, 'read_delegation', { delegation: DELEGATION })).toMatchObject({ delegation: { id: DELEGATION, outcome: 'answered' } })
  expect(asked).toHaveLength(1)
}, 60_000)

it('starts a desktop\'s remote delegation over the real socket for an Owl desktop only, tells it the outcome, and follows its standing (#1316 part 2)', async () => {
  const f = await hostFixture()
  const a = await f.desktop(true, true, true)
  expect(a.hello.features).toEqual(expect.arrayContaining(['delegation-remote', 'delegation-relay-send']))
  expect(a.socket.supportsDelegationRemote).toBe(true)
  await f.answers(a.pairing.clientId, true)
  await a.socket.desktopDefaults({ newThreadRuntimeMode: 'auto' })
  const news: { caller: string; outcome: string; reply?: string }[] = []
  a.socket.subscribeDelegationRemoteNews!((caller, given, replies) => { for (const item of given.items) news.push({ caller, outcome: item.outcome, ...replies[0] ? { reply: replies[0].text } : {} }) })
  const ask = (permission: AgentRuntimeMode, caller = 'desktop-parent') => ({ type: 'delegate' as const, caller, levels: 0, rootUserMessageId: 'root-1', runtimeMode: 'auto' as const,
    projectId: f.project.id, input: { work: 'code-review', brief: 'Synthetic brief', provider: 'codex', model: f.model.id, effort: 'low', permission, retry_key: randomUUID(), wait_seconds: 0 }, waitMs: 0 })
  const started = await a.socket.delegationRemoteAsk!(ask('auto'), 30_000) as { status: string; delegation: { id: string; thread: string } }
  expect(started).toMatchObject({ status: 'ok', delegation: { outcome: 'working' } })
  await expect.poll(() => f.thread(started.delegation.thread)?.runtimeMode).toBe('auto')
  await f.reply(started.delegation.thread, 'Synthetic finding on the host')
  await expect.poll(() => news).toEqual([{ caller: 'desktop-parent', outcome: 'answered', reply: 'Synthetic finding on the host' }])
  expect(await a.socket.delegationRemoteAsk!({ type: 'read', caller: 'desktop-parent', delegation: started.delegation.id }, 10_000)).toMatchObject({ delegation: { outcome: 'answered' } })
  // Another desktop's caller of the same name is not this one's.
  const stable = await f.desktop(true, false, false)
  expect(stable.hello.features).toContain('delegation-remote')
  expect(stable.socket.supportsDelegationRemote).toBe(false)
  await expect(stable.socket.delegationRemoteAsk!(ask('auto'), 10_000)).rejects.toMatchObject({ code: 'version_mismatch' })
  expect(await f.rawCall(stable.pairing.clientId, { op: 'delegation-remote-ask', ask: ask('auto') })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  // A client the launch script never recorded is offered nothing, and its ask is refused.
  const unrecorded = await f.desktop(false, true, true)
  expect(unrecorded.hello.features).not.toContain('delegation-remote')
  expect(await f.rawCall(unrecorded.pairing.clientId, { op: 'delegation-remote-ask', ask: ask('auto') })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  // Its answers grant taken away after hello, the same desktop is held to Ask for approval, whatever another desktop's
  // defaults allow: here desktop B, which may answer, sent Full access.
  const b = await f.desktop(true, true, true)
  await f.answers(b.pairing.clientId, true)
  await b.socket.desktopDefaults({ newThreadRuntimeMode: 'full-access' })
  await f.answers(a.pairing.clientId, false)
  expect(await a.socket.delegationRemoteAsk!(ask('auto'), 30_000)).toMatchObject({ status: 'refused', code: 'PERMISSION_TOO_WIDE' })
  // No longer recorded as a desktop after hello, it is refused outright.
  expect(await b.socket.delegationRemoteAsk!(ask('auto', 'desktop-b-parent'), 30_000)).toMatchObject({ status: 'ok' })
  await writeFile(join(f.root, DESKTOP_CLIENTS_FILE), JSON.stringify([stable.pairing.clientId, b.pairing.clientId]))
  await expect(a.socket.delegationRemoteAsk!(ask('approval-required'), 30_000)).rejects.toMatchObject({ code: 'forbidden' })
}, 60_000)

it('starts nothing for a desktop on a stable host: no feature, and the ask is refused', async () => {
  const f = await hostFixture(STABLE)
  const { hello, pairing, socket } = await f.desktop(true, true, true)
  expect(hello.features).not.toContain('delegation-remote')
  expect(hello.features).not.toContain('delegation-relay-send')
  expect(socket.supportsDelegationRemote).toBe(false)
  expect(await f.rawCall(pairing.clientId, { op: 'delegation-remote-ask', ask: { type: 'read', caller: 'desktop-parent', delegation: randomUUID() } }))
    .toMatchObject({ ok: false, error: { code: 'invalid_request' } })
})

it('holds every delegated start to Ask for approval on a host no desktop has told, and says why', async () => {
  const f = await hostFixture()
  const parent = await f.parentThread()
  const refused = await f.start(parent.threadId, 'auto') as { status: string; code: string; message: string }
  expect(refused).toMatchObject({ status: 'refused', code: 'PERMISSION_TOO_WIDE' })
  expect(refused.message).toContain(HOST_CEILING_HOLD_WORDS['not-told'])
  // Its own stored new-thread default never applies: set wide here, it changes nothing.
  await f.command({ type: 'configure', patch: { newThreadRuntimeMode: 'full-access' } })
  expect(await f.start(parent.threadId, 'auto')).toMatchObject({ status: 'refused', code: 'PERMISSION_TOO_WIDE' })
  expect(await f.call(parent.threadId, 'read_delegation', {})).toMatchObject({ newThreadDefault: { permission: 'approval-required', note: HOST_CEILING_HOLD_WORDS['not-told'] } })
  const asked = await f.start(parent.threadId, 'approval-required') as { status: string; delegation: { thread: string } }
  expect(asked.status).toBe('ok')
  await expect.poll(() => f.thread(asked.delegation.thread)?.runtimeMode).toBe('approval-required')
  // Nothing was kept, since nothing was sent.
  await expect(stat(join(f.root, 'desktop-defaults.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('holds starts to Ask for approval without the desktop\'s answers grant, and follows the desktop defaults as they change', async () => {
  const f = await hostFixture()
  const { socket, pairing } = await f.desktop()
  const router = new DesktopHostRouter(emptyDesktopState)
  cleanups.push(async () => router.dispose())
  const push = new DesktopDefaultsPush({ connections: () => router.remoteConnections() })
  router.subscribeConnected(connection => push.connected(connection))
  push.update('auto', undefined)
  // Told on connecting, as the desktop tells each host it connects to.
  router.add({ hostId: pairing.hostId, name: 'Synthetic host', kind: 'remote', service: socket, detail: id => socket.readThreadDetail(id), preview: () => null })
  await push.settled()
  expect(JSON.parse(await readFile(join(f.root, 'desktop-defaults.json'), 'utf8'))).toMatchObject({ desktops: [{ clientId: pairing.clientId, newThreadRuntimeMode: 'auto' }] })
  const parent = await f.parentThread()
  // Without the grant, the desktop's wider default is held to Ask for approval.
  const held = await f.start(parent.threadId, 'auto') as { status: string; code: string; message: string }
  expect(held).toMatchObject({ status: 'refused', code: 'PERMISSION_TOO_WIDE' })
  expect(held.message).toContain(HOST_CEILING_HOLD_WORDS['no-answer-grant'])
  await f.answers(pairing.clientId, true)
  expect(await f.start(parent.threadId, 'auto')).toMatchObject({ status: 'ok' })
  // Mid-session, the desktop narrows its default: the next start is held to it at once.
  push.update('approval-required', undefined)
  await push.settled()
  expect(await f.start(parent.threadId, 'auto')).toMatchObject({ status: 'refused', code: 'PERMISSION_TOO_WIDE' })
  // And widens it again; a grant taken away holds the next start, read afresh.
  push.update('full-access', undefined)
  await push.settled()
  expect(await f.start(parent.threadId, 'full-access')).toMatchObject({ status: 'ok' })
  // A grant taken away is said as such (#1310): setting the desktop up again would not restore it.
  await f.answers(pairing.clientId, false)
  expect(await f.start(parent.threadId, 'auto')).toMatchObject({ status: 'refused', code: 'PERMISSION_TOO_WIDE',
    message: expect.stringContaining(HOST_CEILING_HOLD_WORDS['answers-revoked']) })
  // A reconnect tells the host again, so a host that missed a change catches up.
  router.replace({ hostId: pairing.hostId, name: 'Synthetic host', kind: 'remote', service: socket, detail: id => socket.readThreadDetail(id), preview: () => null })
  await push.settled()
  expect(JSON.parse(await readFile(join(f.root, 'desktop-defaults.json'), 'utf8'))).toMatchObject({ desktops: [{ newThreadRuntimeMode: 'full-access' }] })
})

it('applies the last defaults from a desktop still paired with an answers grant, and none from one forgotten, after a restart too', async () => {
  const f = await hostFixture()
  const first = await f.desktop(), second = await f.desktop()
  await f.answers(first.pairing.clientId, true); await f.answers(second.pairing.clientId, true)
  await first.socket.desktopDefaults({ newThreadRuntimeMode: 'full-access' })
  await second.socket.desktopDefaults({ newThreadRuntimeMode: 'auto' })
  const parent = await f.parentThread('full-access')
  // The last one sent applies.
  expect(await f.start(parent.threadId, 'full-access')).toMatchObject({ status: 'refused', code: 'PERMISSION_TOO_WIDE' })
  expect(await f.start(parent.threadId, 'auto')).toMatchObject({ status: 'ok' })
  // Forgetting the second falls back to the most recent defaults from a desktop that still counts: the first's.
  await f.revoke(second.pairing.clientId)
  expect(await f.start(parent.threadId, 'full-access')).toMatchObject({ status: 'ok' })
  // Forgetting the first leaves none. Its grant is still on record, but a desktop no longer paired here counts for nothing.
  await f.revoke(first.pairing.clientId)
  expect(await f.start(parent.threadId, 'auto')).toMatchObject({ status: 'refused', code: 'PERMISSION_TOO_WIDE',
    message: expect.stringContaining(HOST_CEILING_HOLD_WORDS['no-answer-grant']) })
  expect(await f.call(parent.threadId, 'read_delegation', {})).toMatchObject({ newThreadDefault: { permission: 'approval-required', note: HOST_CEILING_HOLD_WORDS['no-answer-grant'] } })
  const asked = await f.start(parent.threadId, 'approval-required') as { status: string; delegation: { thread: string } }
  expect(asked.status).toBe('ok')
  await expect.poll(() => f.thread(asked.delegation.thread)?.runtimeMode).toBe('approval-required')
  // The kept defaults survive a restart, and still do not count.
  expect((JSON.parse(await readFile(join(f.root, 'desktop-defaults.json'), 'utf8')) as { desktops: unknown[] }).desktops).toHaveLength(2)
  await f.restart()
  const after = await f.parentThread('full-access')
  expect(await f.start(after.threadId, 'auto')).toMatchObject({ status: 'refused', code: 'PERMISSION_TOO_WIDE',
    message: expect.stringContaining(HOST_CEILING_HOLD_WORDS['no-answer-grant']) })
  const again = await f.start(after.threadId, 'approval-required') as { status: string; delegation: { thread: string } }
  expect(again.status).toBe('ok')
  await expect.poll(() => f.thread(again.delegation.thread)?.runtimeMode).toBe('approval-required')
}, 60_000)

it('sends the selected host\'s new-thread default when this computer\'s own host is off, and follows Settings there', async () => {
  const f = await hostFixture()
  const { socket, pairing } = await f.desktop()
  await f.answers(pairing.clientId, true)
  // A desktop whose own host is off: the router holds the remote host alone, as main builds it, and the push follows it.
  const router = new DesktopHostRouter(emptyDesktopState)
  cleanups.push(async () => router.dispose())
  const push = new DesktopDefaultsPush({ connections: () => router.remoteConnections() })
  const follow = followDesktopDefaults(push, router, () => undefined)
  cleanups.push(async () => follow.dispose())
  router.add({ hostId: pairing.hostId, name: 'Synthetic host', kind: 'remote', service: socket, detail: id => socket.readThreadDetail(id), preview: () => null })
  await push.settled()
  // Settings shows the selected host's own default here, Ask for approval until chosen, and that is what the host is told.
  expect(JSON.parse(await readFile(join(f.root, 'desktop-defaults.json'), 'utf8'))).toMatchObject({ desktops: [{ clientId: pairing.clientId, newThreadRuntimeMode: null }] })
  // The user chooses Full access in Settings, which saves to the selected host; the host is told it.
  await router.command({ type: 'configure', patch: { newThreadRuntimeMode: 'full-access' } }, { clientId: 'desktop-window', user: 'Synthetic user', transport: 'ipc' })
  await expect.poll(async () => { await push.settled(); return (JSON.parse(await readFile(join(f.root, 'desktop-defaults.json'), 'utf8')) as { desktops: { newThreadRuntimeMode: unknown }[] }).desktops[0]?.newThreadRuntimeMode }).toBe('full-access')
  const parent = await f.parentThread('full-access')
  expect(await f.start(parent.threadId, 'full-access')).toMatchObject({ status: 'ok' })
})

it('starts a kind of work on the desktop\'s worker roles, held to the desktop\'s new-thread default', async () => {
  const f = await hostFixture()
  const { socket, pairing } = await f.desktop()
  await f.answers(pairing.clientId, true)
  // The desktop's role wants Full access; its new-thread default is Auto. The host's own stored roles never apply.
  await socket.desktopDefaults({ newThreadRuntimeMode: 'auto', workerRoles: { 'code-review': { modelId: f.model.id, reasoningEffort: 'low', runtimeMode: 'full-access' } } })
  const parent = await f.parentThread()
  const started = await f.call(parent.threadId, 'delegate', { work: 'code-review', brief: 'Synthetic brief', wait_seconds: 0 }) as { status: string; delegation: { thread: string }; role: { note: string } }
  expect(started).toMatchObject({ status: 'ok', role: { work: 'code-review' } })
  expect(started.role.note).toContain('was held to the user\'s new-thread default')
  await expect.poll(() => f.thread(started.delegation.thread)).toMatchObject({ modelId: f.model.id, runtimeMode: 'auto' })
})

it('gives each child four briefs per turn of its parent on the parent\'s own machine', async () => {
  const f = await hostFixture()
  const parent = await f.parentThread('approval-required')
  const first = await f.start(parent.threadId, 'approval-required') as { status: string; delegation: { id: string; thread: string } }
  expect(first.status).toBe('ok')
  const child = first.delegation.thread
  let last = first.delegation.id
  for (let brief = 2; brief <= 4; brief++) {
    await f.reply(child, `Synthetic reply ${brief - 1}`)
    await expect.poll(async () => ((await f.call(parent.threadId, 'read_delegation', { delegation: last })) as { delegation: { outcome: string } }).delegation.outcome).toBe('answered')
    const sent = await f.call(parent.threadId, 'delegate', { work: 'code-review', thread: child, brief: `Synthetic brief ${brief}`, wait_seconds: 0 }) as { status: string; delegation: { id: string }; limits: { prompts: number } }
    expect(sent).toMatchObject({ status: 'ok', limits: { prompts: brief } })
    last = sent.delegation.id
  }
  await f.reply(child, 'Synthetic reply 4')
  await expect.poll(async () => ((await f.call(parent.threadId, 'read_delegation', { delegation: last })) as { delegation: { outcome: string } }).delegation.outcome).toBe('answered')
  expect(await f.call(parent.threadId, 'delegate', { work: 'code-review', thread: child, brief: 'Synthetic brief 5', wait_seconds: 0 })).toMatchObject({ status: 'refused', code: 'PROMPT_LIMIT' })
})

it('starts nothing on a stable host: no tool, no feature, and desktop defaults are refused', async () => {
  const f = await hostFixture(STABLE)
  const { socket, hello, pairing } = await f.desktop()
  expect(hello.features).not.toContain('host-delegation')
  expect(socket.supportsHostDelegation).toBe(false)
  await expect(socket.desktopDefaults({ newThreadRuntimeMode: 'auto' })).rejects.toMatchObject({ code: 'version_mismatch' })
  // The request itself, sent anyway, is refused, and nothing is kept.
  expect(await f.raw(pairing.clientId, { newThreadRuntimeMode: 'auto' })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  const parent = await f.parentThread()
  expect(f.provider.tools.some(tools => tools.name === 'sotto_delegate')).toBe(false)
  expect(await f.call(parent.threadId, 'delegate', {})).toBeUndefined()
  await expect(stat(join(f.root, 'desktop-defaults.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  // Nor does it answer a desktop's read of its threads' delegations (#1310).
  expect(hello.features).not.toContain('delegation-views')
  expect(await f.rawCall(pairing.clientId, { op: 'delegation-views', threadId: parent.threadId })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
})

it('offers desktop defaults to a recorded desktop only, and a phone\'s request is refused', async () => {
  const f = await hostFixture()
  const { socket, hello, pairing } = await f.desktop(false)
  // Paired but not recorded as a desktop by the launch script: the host neither lists nor takes them.
  expect(hello.features).not.toContain('host-delegation')
  await expect(socket.desktopDefaults({ newThreadRuntimeMode: 'full-access' })).rejects.toMatchObject({ code: 'version_mismatch' })
  expect(await f.raw(pairing.clientId, { newThreadRuntimeMode: 'full-access' })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  await expect(stat(join(f.root, 'desktop-defaults.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  // Nor its threads' delegations (#1310).
  expect(hello.features).not.toContain('delegation-views')
  expect(await f.rawCall(pairing.clientId, { op: 'delegation-brief', threadId: randomUUID() })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
})

it('answers a recorded desktop\'s read of its threads\' delegations, names those that changed, and the desktop keeps the last read while the host is away', async () => {
  const f = await hostFixture()
  const { socket, pairing, hello } = await f.desktop(true, true)
  expect(hello.features).toContain('delegation-views')
  expect(socket.supportsDelegationViews).toBe(true)
  const router = new DesktopHostRouter(emptyDesktopState)
  cleanups.push(async () => router.dispose())
  const connection = (service: SocketHostService) => ({ hostId: pairing.hostId, name: 'Synthetic host', kind: 'remote' as const, service, detail: (id: string) => service.readThreadDetail(id), preview: () => null })
  router.add(connection(socket))
  const changed: string[] = []
  router.subscribeDelegationViews(threadIds => { changed.push(...threadIds) })
  const key = (id: string): string => hostEntityKey(pairing.hostId, id)
  const parent = await f.parentThread()

  // A host never told holds a role's permission to Ask for approval, and its record says why, for the roster's line.
  const started = await f.call(parent.threadId, 'delegate', { work: 'building', brief: 'Synthetic brief for the roster', provider: 'codex', model: f.model.id, effort: 'low', wait_seconds: 0 }) as
    { status: string; delegation: { id: string; thread: string } }
  expect(started.status).toBe('ok')
  const child = started.delegation.thread
  await expect.poll(() => changed).toEqual(expect.arrayContaining([key(parent.threadId), key(child)]))
  const read = await router.delegationViews(key(parent.threadId))
  expect(read).toMatchObject({ threadId: key(parent.threadId), received: [] })
  expect(read.lastRead).toBeUndefined()
  expect(read.delegations).toEqual([expect.objectContaining({ id: started.delegation.id, thread: key(child), work: 'building', outcome: 'working', held: 'not-told' })])
  expect((await router.delegationViews(key(child))).received).toEqual([expect.objectContaining({ id: started.delegation.id, thread: key(child) })])
  expect(await router.delegationBrief(key(child))).toEqual({ threadId: key(child), text: 'Synthetic brief for the roster' })
  // Another machine is refused before #1316, and the refusal is read as recorded.
  const elsewhere = randomUUID()
  await f.start(parent.threadId, 'approval-required', { machine: elsewhere })
  await expect.poll(async () => (await router.delegationViews(key(parent.threadId))).delegations.find(view => view.outcome === 'refused' && view.refusal === 'MACHINE_UNAVAILABLE'))
    .toMatchObject({ asked: { machine: elsewhere } })

  // Told by a desktop that may not answer there, the next start says so; once a grant is given and taken away, it says that.
  const building = async () => ((await f.call(parent.threadId, 'delegate', { work: 'building', brief: 'Synthetic brief', provider: 'codex', model: f.model.id, effort: 'low', wait_seconds: 0 })) as
    { delegation: { id: string } }).delegation.id
  await socket.desktopDefaults({ newThreadRuntimeMode: 'auto' })
  const ungranted = await building()
  await f.answers(pairing.clientId, true)
  await f.answers(pairing.clientId, false)
  const revoked = await building()
  await expect.poll(async () => (await router.delegationViews(key(parent.threadId))).delegations.filter(view => view.id === ungranted || view.id === revoked).map(view => 'held' in view ? view.held : undefined))
    .toEqual(['no-answer-grant', 'answers-revoked'])

  // The child answers: the host names the parent again, and its outcome reads answered, never with the child's words.
  changed.length = 0
  await f.reply(child, 'Synthetic child finding')
  await expect.poll(() => changed).toContain(key(parent.threadId))
  await expect.poll(async () => (await router.delegationViews(key(parent.threadId))).delegations.find(view => view.id === started.delegation.id)?.outcome).toBe('answered')
  expect(JSON.stringify(await router.delegationViews(key(parent.threadId)))).not.toContain('Synthetic child finding')

  // The host goes away: the window is told, and is given what Sotto last read there, as of then; no brief is read.
  changed.length = 0
  router.setReconnecting(pairing.hostId, true)
  await socket.close()
  expect(changed).toEqual(expect.arrayContaining([key(parent.threadId), key(child)]))
  const away = await router.delegationViews(key(parent.threadId))
  expect(away.lastRead).toEqual(expect.any(String))
  expect(away.delegations.find(view => view.id === started.delegation.id)).toMatchObject({ outcome: 'answered' })
  expect(await router.delegationBrief(key(child))).toBeNull()

  // It connects again: told again, and read afresh from the host's own record.
  changed.length = 0
  const again = new SocketHostService({ url: f.url, token: pairing.token, expectedHostId: pairing.hostId, crossMachineEnabled: true })
  cleanups.push(async () => again.close())
  await again.connect()
  router.replace(connection(again))
  expect(changed).toEqual(expect.arrayContaining([key(parent.threadId)]))
  const back = await router.delegationViews(key(parent.threadId))
  expect(back.lastRead).toBeUndefined()
  expect(back.delegations.find(view => view.id === started.delegation.id)).toMatchObject({ outcome: 'answered' })
}, 60_000)

it('tells a desktop that does not accept it nothing, and its router says the host does not offer the read', async () => {
  const f = await hostFixture()
  const { socket, pairing, hello } = await f.desktop(true, false)
  // The host lists it to a recorded desktop; this desktop, without Work across machines, neither reads nor hears it.
  expect(hello.features).toContain('delegation-views')
  expect(socket.supportsDelegationViews).toBe(false)
  await expect(socket.delegationViews(randomUUID())).rejects.toMatchObject({ code: 'version_mismatch' })
  const router = new DesktopHostRouter(emptyDesktopState)
  cleanups.push(async () => router.dispose())
  router.add({ hostId: pairing.hostId, name: 'Synthetic host', kind: 'remote', service: socket, detail: id => socket.readThreadDetail(id), preview: () => null })
  expect((await router.delegationViews(hostEntityKey(pairing.hostId, randomUUID()))).unread).toBe('older-host')
})
