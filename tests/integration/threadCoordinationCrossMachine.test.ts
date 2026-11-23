// @vitest-environment node
// ADR-0216 Slice 3 cross-machine parent-to-parent coordination integration tests over real socket servers & fake providers.
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startHeadlessHost } from '../../src/host'
import { startSocketServer } from '../../src/host/socketServer'
import { desktopWindowClient, LocalHostService } from '../../src/main/agents/hostService'
import { PairedClients } from '../../src/main/agents/pairing'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { DesktopCoordinationRelay, HostCoordinationRelay } from '../../src/main/agents/threadCoordinationRelay'
import { ThreadCoordinationService } from '../../src/main/agents/threadCoordination'
import { CoordinationToolServer } from '../../src/main/agents/threadCoordinationTools'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import type { AgentControl } from '../../src/main/agents/control'
import type { AgentRuntimeMode, AgentThread, ProviderId } from '../../src/shared/agents'
import { hostEntityKey } from '../../src/shared/clientIdentity'
import { DESKTOP_CLIENTS_FILE } from '../../src/shared/desktopClients'
import { COORDINATE_LIST_THREADS_TOOL, COORDINATE_READ_EXCHANGE_TOOL, COORDINATE_READ_THREAD_TOOL, COORDINATE_SEND_TOOL, COORDINATION_HOP_MAX } from '../../src/shared/threadCoordination'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { workspaceFixture } from '../fixtures/workspaceFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function waitFor<T>(predicate: () => T | Promise<T>, timeoutMs = 10_000, stepMs = 20): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    last = await predicate()
    if (last) return last as NonNullable<T>
    await new Promise(resolve => setTimeout(resolve, stepMs))
  }
  throw new Error(`Timed out waiting for condition (last=${JSON.stringify(last)})`)
}

function makeFakeProvider(projectPath: string): FakeProviderHost {
  const adapter = new FakeProviderHost()
  adapter.state.models[0]!.runtimeModes = ['approval-required', 'auto-accept-edits', 'auto', 'full-access']
  for (const project of adapter.state.projects) project.path = projectPath
  const origExecute = adapter.execute.bind(adapter)
  adapter.execute = async command => {
    const result = await origExecute(command)
    if (command.type === 'create-thread') {
      const created = adapter.state.threads.find(item => item.id === command.threadId)
      if (created) {
        if (command.runtimeMode) created.runtimeMode = command.runtimeMode
        created.updatedAt = new Date().toISOString()
        adapter.emit()
      }
    }
    return result
  }
  return adapter
}

function finishFakeTurn(adapter: FakeProviderHost, threadPredicate: (thread: AgentThread) => boolean, replyText: string): void {
  const thread = adapter.state.threads.find(threadPredicate)
  if (!thread) throw new Error('Fake provider thread not found')
  const lastUser = [...thread.messages].reverse().find(message => message.role === 'user')
  const stamp = new Date().toISOString()
  thread.messages.push({ id: randomUUID(), role: 'assistant', text: replyText, createdAt: stamp })
  thread.lastTurn = { id: lastUser?.id ?? randomUUID(), status: 'completed' }
  thread.status = 'idle'
  thread.updatedAt = stamp
  adapter.emit()
}

async function startPairedHost(options: {
  readonly name: string
  readonly parentCoordination?: boolean
  readonly allowAnswers?: boolean
  readonly recordDesktop?: boolean
} = { name: 'Forge' }) {
  const dir = await mkdtemp(join(tmpdir(), 'sotto-coord-host-'))
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }) })
  const codex = makeFakeProvider(dir)
  const claude = makeFakeProvider(dir)
  const host = await startHeadlessHost({
    dataDirectory: dir,
    port: 0,
    sottoVersion: '0.1.43-owl.1',
    owlFeatures: { 'parent-thread-coordination': options.parentCoordination ?? true },
    providers: {
      codex,
      claude,
      grok: new E2EAgentHost(),
      devin: new E2EAgentHost(),
      muse: new E2EAgentHost(),
      opencode: new E2EAgentHost(),
      hermes: new E2EAgentHost(),
      cursor: new E2EAgentHost(),
      antigravity: new E2EAgentHost(),
    },
    reasoner: e2eAgentReasoner,
  })
  cleanups.push(async () => { await host.close() })

  const port = host.descriptor!.port
  const hostId = host.descriptor!.hostId
  const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, options.name)
  if (!paired) throw new Error('Pairing failed')
  const clientId = paired.clientId

  if (options.recordDesktop !== false) {
    await writeFile(join(dir, DESKTOP_CLIENTS_FILE), JSON.stringify([clientId]), 'utf8')
  }

  // Configure remote-answer grant via admin endpoint (default true, or false for --deny-answers).
  const descriptor = JSON.parse(await readFile(join(dir, 'host-listener.json'), 'utf8')) as { adminToken: string }
  const route = options.allowAnswers !== false ? 'allow-answers' : 'deny-answers'
  const grantRes = await fetch(`http://127.0.0.1:${port}/v1/admin/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${descriptor.adminToken}` },
    body: JSON.stringify({ clientId }),
  })
  expect(grantRes.ok).toBe(true)

  const localUser = desktopWindowClient()
  await host.service.command({ type: 'connect', provider: 'codex' }, localUser)
  await host.service.command({ type: 'connect', provider: 'claude' }, localUser)

  const createParent = async (provider: 'codex' | 'claude', title: string, runtimeMode: AgentRuntimeMode = 'auto-accept-edits') => {
    const state = host.service.shell()
    const project = state.host.projects.find(item => item.providerId === provider) ?? state.host.projects[0]!
    const model = state.host.models.find(item => item.providerId === provider)!
    const threadId = randomUUID()
    const created = await host.service.command({ type: 'create-thread', threadId, projectId: project.id, title, modelId: model.id, runtimeMode }, localUser)
    expect(created.error).toBeNull()
    const seedText = `Seed user prompt for ${title}`
    const sent = await host.service.command({ type: 'manual-send', threadId, draftId: randomUUID(), text: seedText }, localUser)
    expect(sent.error).toBeNull()
    const adapter = provider === 'codex' ? codex : claude
    const match = (item: AgentThread) => item.messages.some(m => m.text.includes(seedText))
    finishFakeTurn(adapter, match, `Initial reply from ${title}`)
    await host.service.command({ type: 'refresh', provider }, localUser)
    await host.service.command({ type: 'rename-thread', threadId, title }, localUser)
    await waitFor(() => host.service.shell().host.threads.find(item => item.id === threadId)?.status === 'idle')
    return {
      threadId,
      reply: async (text: string) => {
        finishFakeTurn(adapter, match, text)
        await host.service.command({ type: 'refresh', provider }, localUser)
        await waitFor(() => host.service.shell().host.threads.find(item => item.id === threadId)?.status === 'idle')
      },
      waitForIncomingMessage: async (contains: string) => waitFor(() => {
        const detail = host.service.threadDetail(threadId)
        return detail?.messages.find(m => m.role === 'user' && m.text.includes(contains))
      }),
    }
  }

  const connectDesktop = async (opts: { parentCoordinationEnabled?: boolean } = {}) => {
    const socket = new SocketHostService({
      url: `http://127.0.0.1:${port}`,
      token: paired.token,
      clientVersion: '0.1.43-owl.1',
      parentCoordinationEnabled: opts.parentCoordinationEnabled ?? true,
    })
    cleanups.push(async () => { socket.close() })
    await socket.connect()
    return socket
  }

  return { dir, host, hostId, port, clientId, paired, codex, claude, createParent, connectDesktop }
}

async function startDesktopStack() {
  const workspace = await workspaceFixture(undefined, { history: true, watcherEnabled: false })
  cleanups.push(workspace.remove)
  workspace.adapters.codex.state.models[0]!.runtimeModes = ['approval-required', 'auto-accept-edits', 'auto', 'full-access']
  workspace.adapters.claude.state.models[0]!.runtimeModes = ['approval-required', 'auto-accept-edits', 'auto', 'full-access']
  for (const adapter of [workspace.adapters.codex, workspace.adapters.claude]) {
    const origExecute = adapter.execute.bind(adapter)
    adapter.execute = async command => {
      const result = await origExecute(command)
      if (command.type === 'create-thread' && command.runtimeMode) {
        const created = adapter.state.threads.find(item => item.id === command.threadId)
        if (created) { created.runtimeMode = command.runtimeMode; adapter.emit() }
      }
      return result
    }
  }
  const control: AgentControl = (await agentControlFixture({
    directory: workspace.root,
    host: workspace.host,
    credentialOptions: { mode: 'unavailable' },
    control: { historyEnabled: () => true, watcherEnabled: false },
  })).control
  const service = new ThreadCoordinationService({
    directory: workspace.root,
    control,
    host: workspace.host,
    historyEnabled: () => true,
  })
  const tools = new CoordinationToolServer(service)
  workspace.host.useThreadTools([tools])
  const router = new DesktopHostRouter(emptyDesktopState)
  const relay = new DesktopCoordinationRelay({
    service,
    localHostId: () => control.hostId(),
    localMachineName: () => 'This computer',
  })
  relay.useHosts(router)

  cleanups.push(async () => {
    relay.close()
    service.close()
    await tools.close()
    control.dispose()
    await control.closed()
    await workspace.stop()
  })

  await control.start()
  await control.commandShell({ type: 'connect', provider: 'claude' })
  await control.commandShell({ type: 'connect', provider: 'codex' })
  await service.recover()

  const native = (threadId: string): AgentThread => {
    const binding = workspace.registry.byThread(threadId)!
    return workspace.adapters[binding.provider as keyof typeof workspace.adapters].state.threads.find(item => item.id === binding.sessionId)!
  }
  const reply = async (threadId: string, text: string) => {
    const thread = native(threadId)
    thread.messages.push({ id: randomUUID(), role: 'assistant', text, createdAt: new Date().toISOString() })
    thread.lastTurn = { id: thread.messages.findLast(m => m.role === 'user')!.id, status: 'completed' }
    thread.status = 'idle'
    const binding = workspace.registry.byThread(threadId)!
    workspace.adapters[binding.provider as keyof typeof workspace.adapters].emit()
    await control.commandShell({ type: 'refresh', provider: binding.provider as ProviderId })
  }
  const createParent = async (provider: 'claude' | 'codex', title: string, runtimeMode: AgentRuntimeMode = 'auto-accept-edits') => {
    const project = control.shell().host.projects.find(item => item.providerId === provider) ?? control.shell().host.projects[0]!
    const model = control.shell().host.models.find(item => item.providerId === provider)!
    const threadId = randomUUID()
    expect((await control.commandShell({ type: 'create-thread', threadId, projectId: project.id, title, modelId: model.id, runtimeMode })).error).toBeNull()
    expect((await control.commandShell({ type: 'manual-send', threadId, draftId: randomUUID(), text: `Seed user prompt for ${title}` })).error).toBeNull()
    await reply(threadId, `Initial reply from ${title}`)
    await control.commandShell({ type: 'rename-thread', threadId, title })
    return {
      threadId,
      reply: (text: string) => reply(threadId, text),
      messages: () => control.watcherSnapshot().threads.find(item => item.id === threadId)?.messages ?? [],
    }
  }
  const callTool = async (threadId: string, name: string, args: unknown) => {
    const result = await tools.call(threadId, name, args)
    return result.structuredContent as Record<string, unknown>
  }
  const attachHost = (hostId: string, name: string, socket: SocketHostService) => {
    router.add({
      hostId,
      name,
      kind: 'remote',
      service: socket,
      detail: id => socket.threadDetail(id),
      preview: req => socket.attachmentPreview(req),
      available: () => socket.connected(),
    })
  }

  return { workspace, control, service, tools, router, relay, createParent, callTool, attachHost, hostId: () => control.hostId()! }
}

/** Starts a lightweight socket-backed paired host whose `ThreadCoordinationService` is directly callable by tests for host-originated asks. */
async function startCallableSocketHost(name: string) {
  const workspace = await workspaceFixture(undefined, { history: true, watcherEnabled: false })
  cleanups.push(workspace.remove)
  workspace.adapters.codex.state.models[0]!.runtimeModes = ['approval-required', 'auto-accept-edits', 'auto', 'full-access']
  workspace.adapters.claude.state.models[0]!.runtimeModes = ['approval-required', 'auto-accept-edits', 'auto', 'full-access']
  for (const adapter of [workspace.adapters.codex, workspace.adapters.claude]) {
    const origExecute = adapter.execute.bind(adapter)
    adapter.execute = async command => {
      const result = await origExecute(command)
      if (command.type === 'create-thread' && command.runtimeMode) {
        const created = adapter.state.threads.find(item => item.id === command.threadId)
        if (created) { created.runtimeMode = command.runtimeMode; adapter.emit() }
      }
      return result
    }
  }
  const control: AgentControl = (await agentControlFixture({
    directory: workspace.root,
    host: workspace.host,
    credentialOptions: { mode: 'unavailable' },
    control: { historyEnabled: () => true, watcherEnabled: false },
  })).control
  const service = new ThreadCoordinationService({
    directory: workspace.root,
    control,
    host: workspace.host,
    historyEnabled: () => true,
  })
  const hostRelay = new HostCoordinationRelay({ recorded: () => true, mayAnswer: () => true, localMachineName: () => name })
  hostRelay.useService(service)
  const tools = new CoordinationToolServer(service)
  workspace.host.useThreadTools([tools])

  await control.start()
  await control.commandShell({ type: 'connect', provider: 'codex' })
  await service.recover()

  const hostService = new LocalHostService({ control, events: workspace.host, coordinationViews: service })
  const pairing = new PairedClients(workspace.root)
  await pairing.load()
  const paired = await pairing.redeem(pairing.issuePairingCode().code, name)
  if (!paired) throw new Error('Pairing failed')
  const server = await startSocketServer({
    service: hostService,
    pairing,
    port: 0,
    sottoVersion: '0.1.43-owl.1',
    watcherDesktops: { refresh: async () => undefined, has: id => id === paired.clientId },
    coordinationRelay: hostRelay,
    mayAnswer: () => true,
  })
  const socket = new SocketHostService({
    url: `http://127.0.0.1:${server.descriptor.port}`,
    token: paired.token,
    clientVersion: '0.1.43-owl.1',
    parentCoordinationEnabled: true,
  })
  await socket.connect()

  cleanups.push(async () => {
    socket.close()
    await server.close()
    hostRelay.close()
    service.close()
    await tools.close()
    control.dispose()
    await control.closed()
    await workspace.stop()
  })

  const createParent = async (title: string, runtimeMode: AgentRuntimeMode = 'auto-accept-edits') => {
    const project = control.shell().host.projects.find(item => item.providerId === 'codex') ?? control.shell().host.projects[0]!
    const model = control.shell().host.models.find(item => item.providerId === 'codex')!
    const threadId = randomUUID()
    expect((await control.commandShell({ type: 'create-thread', threadId, projectId: project.id, title, modelId: model.id, runtimeMode })).error).toBeNull()
    expect((await control.commandShell({ type: 'manual-send', threadId, draftId: randomUUID(), text: `Seed user prompt for ${title}` })).error).toBeNull()
    const binding = workspace.registry.byThread(threadId)!
    const thread = workspace.adapters.codex.state.threads.find(item => item.id === binding.sessionId)!
    thread.messages.push({ id: randomUUID(), role: 'assistant', text: `Initial reply from ${title}`, createdAt: new Date().toISOString() })
    thread.lastTurn = { id: thread.messages.findLast(m => m.role === 'user')!.id, status: 'completed' }
    thread.status = 'idle'
    workspace.adapters.codex.emit()
    await control.commandShell({ type: 'refresh', provider: 'codex' })
    await control.commandShell({ type: 'rename-thread', threadId, title })
    await waitFor(() => socket.shell().host.threads.some(item => item.id === threadId && item.status === 'idle' && item.title === title))
    return {
      threadId,
      reply: async (text: string) => {
        const b = workspace.registry.byThread(threadId)!
        const t = workspace.adapters.codex.state.threads.find(item => item.id === b.sessionId)!
        const stamp = new Date().toISOString()
        t.messages.push({ id: randomUUID(), role: 'assistant', text, createdAt: stamp })
        t.lastTurn = { id: t.messages.findLast(m => m.role === 'user')!.id, status: 'completed' }
        t.status = 'idle'
        t.updatedAt = stamp
        workspace.adapters.codex.emit()
        await control.commandShell({ type: 'refresh', provider: 'codex' })
      },
      messages: () => control.watcherSnapshot().threads.find(item => item.id === threadId)?.messages ?? [],
    }
  }

  return {
    hostId: control.hostId()!,
    service,
    tools,
    socket,
    createParent,
    callTool: async (threadId: string, toolName: string, args: unknown) =>
      (await tools.call(threadId, toolName, args)).structuredContent as Record<string, unknown>,
  }
}

describe('parent-to-parent cross-machine coordination (ADR-0216, Slice 3)', () => {
  it('discovers, reads, sends, receives reply wake-ups, and serves UI views across desktop <-> paired host', async () => {
    const desktop = await startDesktopStack()
    const forge = await startPairedHost({ name: 'Forge' })
    const socket = await forge.connectDesktop()
    expect(socket.supportsCoordinationViews).toBe(true)
    expect(socket.supportsCoordinationRelay).toBe(true)
    desktop.attachHost(forge.hostId, 'Forge', socket)

    const localA = await desktop.createParent('claude', 'Desktop UI', 'auto-accept-edits')
    const remoteB = await forge.createParent('codex', 'Forge Backend', 'auto-accept-edits')

    // 1. list_threads(hostId: "all") returns local + paired host threads with machine metadata.
    const listed = await desktop.callTool(localA.threadId, COORDINATE_LIST_THREADS_TOOL, { hostId: 'all', limit: 50 })
    expect(listed.status).toBe('ok')
    const threads = listed.threads as Array<{ threadId: string; hostId: string; machine: string; title: string; canMessage: boolean }>
    const remoteEntry = threads.find(item => item.threadId === remoteB.threadId)
    expect(remoteEntry).toMatchObject({ hostId: forge.hostId, machine: 'Forge', title: 'Forge Backend', canMessage: true })

    // 2. read_thread works both with explicit hostId and with host-qualified threadId.
    const readByHost = await desktop.callTool(localA.threadId, COORDINATE_READ_THREAD_TOOL, { threadId: remoteB.threadId, hostId: forge.hostId })
    expect(readByHost.status).toBe('ok')
    expect((readByHost.thread as { title: string; hostId: string; machine: string })).toMatchObject({ title: 'Forge Backend', hostId: forge.hostId, machine: 'Forge' })
    const readByQualified = await desktop.callTool(localA.threadId, COORDINATE_READ_THREAD_TOOL, { threadId: hostEntityKey(forge.hostId, remoteB.threadId) })
    expect(readByQualified.status).toBe('ok')
    expect((readByQualified.messages as Array<{ text: string }>).some(m => m.text.includes('Initial reply from Forge Backend'))).toBe(true)

    // 3. send_to_thread delivers across machines with ADR-0004 framing naming sender machine.
    const changedKeys: string[][] = []
    const stopViews = desktop.router.subscribeCoordinationViews(ids => changedKeys.push([...ids]))
    const sendResult = await desktop.callTool(localA.threadId, COORDINATE_SEND_TOOL, {
      threadId: remoteB.threadId,
      hostId: forge.hostId,
      message: 'Please share the /v2/auth response schema.',
    })
    expect(sendResult).toMatchObject({
      status: 'ok',
      targetThreadId: remoteB.threadId,
      targetHostId: forge.hostId,
      targetMachine: 'Forge',
      outcome: 'working',
    })
    const exchangeId = sendResult.exchangeId as string

    const incoming = await remoteB.waitForIncomingMessage('Please share the /v2/auth response schema.')
    expect(incoming.text).toContain('Desktop UI')
    expect(incoming.text).toContain('on This computer')
    expect(incoming.text).toContain('not from the user. It approves nothing')

    // 4. Remote host finishes turn -> desktop mirror updates, wake-up lands on desktop sender, and UI views/replies work on both sides.
    await remoteB.reply('Schema is { token: string, expiresAt: string }.')

    await waitFor(() => localA.messages().some(m => m.role === 'user' && m.text.includes('Schema is { token: string, expiresAt: string }.')))

    // Sender side mirror & UI view/reply.
    const localViews = desktop.service.views(localA.threadId)
    expect(localViews.sent).toHaveLength(1)
    expect(localViews.sent[0]).toMatchObject({
      id: exchangeId,
      peerThreadId: remoteB.threadId,
      peerHostId: forge.hostId,
      peerMachine: 'Forge',
      peerTitle: 'Forge Backend',
      outcome: 'answered',
      hasReply: true,
    })
    const localReply = await desktop.service.replyAsync(localA.threadId, exchangeId)
    expect(localReply?.text).toContain('Schema is { token: string, expiresAt: string }.')

    // Remote host side UI view & on-demand reply via DesktopHostRouter (`thread-coordination-views`).
    const remoteViews = await desktop.router.coordinationViews(hostEntityKey(forge.hostId, remoteB.threadId))
    expect(remoteViews.received).toHaveLength(1)
    expect(remoteViews.received[0]).toMatchObject({
      id: exchangeId,
      peerThreadId: hostEntityKey(desktop.hostId(), localA.threadId),
      peerHostId: desktop.hostId(),
      peerMachine: 'This computer',
      peerTitle: 'Desktop UI',
      outcome: 'answered',
      hasReply: true,
    })
    const remoteReply = await desktop.router.coordinationReply(hostEntityKey(forge.hostId, remoteB.threadId), exchangeId)
    expect(remoteReply).toMatchObject({ exchangeId, text: 'Schema is { token: string, expiresAt: string }.', truncated: false })
    expect(changedKeys.some(ids => ids.includes(hostEntityKey(forge.hostId, remoteB.threadId)))).toBe(true)
    stopViews()
  })

  it('routes paired-host -> desktop and paired-host A -> paired-host B exchanges over real coordination-relay-ask sockets', async () => {
    const desktop = await startDesktopStack()
    const hostA = await startCallableSocketHost('Forge-A')
    const hostB = await startPairedHost({ name: 'Forge-B' })
    const socketB = await hostB.connectDesktop()
    desktop.attachHost(hostA.hostId, 'Forge-A', hostA.socket)
    desktop.attachHost(hostB.hostId, 'Forge-B', socketB)

    const desktopThread = await desktop.createParent('claude', 'Desktop Coordinator', 'auto-accept-edits')
    const threadA = await hostA.createParent('Forge A Worker', 'auto-accept-edits')
    const threadB = await hostB.createParent('codex', 'Forge B Worker', 'auto-accept-edits')

    // 1. Host A parent thread lists threads across ALL connected machines via coordination-relay-ask -> desktop -> Host B + Desktop!
    const listedAll = await hostA.callTool(threadA.threadId, COORDINATE_LIST_THREADS_TOOL, { hostId: 'all', limit: 50 })
    expect(listedAll.status).toBe('ok')
    const listedThreads = listedAll.threads as Array<{ threadId: string; hostId: string; machine: string }>
    expect(listedThreads.some(t => t.threadId === desktopThread.threadId && t.hostId === desktop.hostId())).toBe(true)
    expect(listedThreads.some(t => t.threadId === threadB.threadId && t.hostId === hostB.hostId)).toBe(true)

    // 2. Host A sends to Desktop parent thread over coordination-relay-ask; Desktop replies -> coordination-relay-news wakes Host A!
    const sendAtoDesktop = await hostA.callTool(threadA.threadId, COORDINATE_SEND_TOOL, {
      threadId: desktopThread.threadId,
      hostId: desktop.hostId(),
      message: 'Status check for desktop from Forge-A.',
    })
    expect(sendAtoDesktop).toMatchObject({ status: 'ok', targetHostId: desktop.hostId(), targetMachine: 'This computer', outcome: 'working' })
    expect(desktopThread.messages().some(m => m.role === 'user' && m.text.includes('Status check for desktop from Forge-A.'))).toBe(true)
    expect(desktopThread.messages().some(m => m.role === 'user' && m.text.includes('on Forge-A'))).toBe(true)

    await desktopThread.reply('Desktop is green and ready.')
    await waitFor(() => threadA.messages().some(m => m.role === 'user' && m.text.includes('Desktop is green and ready.')))

    // 3. During that wake-up turn, Host A sends to Host B via Desktop relay (continuing the chain at hop 2!), then finishes its turn so Host B's reply wake-up lands!
    const sendAtoB = await hostA.callTool(threadA.threadId, COORDINATE_SEND_TOOL, {
      threadId: threadB.threadId,
      hostId: hostB.hostId,
      message: 'Hello Forge B from Forge A!',
    })
    expect(sendAtoB).toMatchObject({ status: 'ok', targetHostId: hostB.hostId, targetMachine: 'Forge-B', hopCount: 2, outcome: 'working' })
    await threadA.reply('Handed off to Forge B.')
    const incomingB = await threadB.waitForIncomingMessage('Hello Forge B from Forge A!')
    expect(incomingB.text).toContain('Forge A Worker')
    expect(incomingB.text).toContain('on Forge-A')

    await threadB.reply('Forge B completed the build.')
    await waitFor(() => threadA.messages().some(m => m.role === 'user' && m.text.includes('Forge B completed the build.')))
    const readExchangeA = await hostA.callTool(threadA.threadId, COORDINATE_READ_EXCHANGE_TOOL, { exchangeId: sendAtoB.exchangeId })
    expect(readExchangeA).toMatchObject({
      status: 'ok',
      outcome: 'answered',
      reply: { text: 'Forge B completed the build.' },
    })
  })

  it('enforces ADR-0004 permission ceiling, mayAnswer clamp, hop limit, and slash command ban across machines', async () => {
    const desktop = await startDesktopStack()
    const restrictedHost = await startPairedHost({ name: 'Restricted', allowAnswers: false })
    const fullHost = await startPairedHost({ name: 'Full', allowAnswers: true })
    const restrictedSocket = await restrictedHost.connectDesktop()
    const fullSocket = await fullHost.connectDesktop()
    desktop.attachHost(restrictedHost.hostId, 'Restricted', restrictedSocket)
    desktop.attachHost(fullHost.hostId, 'Full', fullSocket)

    const localFull = await desktop.createParent('claude', 'Desktop Full', 'full-access')
    const localEdit = await desktop.createParent('claude', 'Desktop Edit', 'auto-accept-edits')
    const fullHostFull = await fullHost.createParent('codex', 'Full Host Full', 'full-access')
    const restrictedEdit = await restrictedHost.createParent('codex', 'Restricted Edit', 'auto-accept-edits')
    const restrictedApproval = await restrictedHost.createParent('codex', 'Restricted Approval', 'approval-required')

    // 1. Permission ceiling: auto-accept-edits caller cannot message full-access remote target.
    expect(await desktop.callTool(localEdit.threadId, COORDINATE_SEND_TOOL, {
      threadId: fullHostFull.threadId,
      hostId: fullHost.hostId,
      message: 'Attempt privilege escalation',
    })).toMatchObject({ status: 'refused', code: 'PERMISSION_TOO_WIDE' })

    // 2. mayAnswer === false clamps even a full-access desktop caller to approval-required on that host.
    expect(await desktop.callTool(localFull.threadId, COORDINATE_SEND_TOOL, {
      threadId: restrictedEdit.threadId,
      hostId: restrictedHost.hostId,
      message: 'Should be clamped to approval-required',
    })).toMatchObject({ status: 'refused', code: 'PERMISSION_TOO_WIDE' })

    // Same clamped caller CAN message an approval-required target on that host.
    expect(await desktop.callTool(localFull.threadId, COORDINATE_SEND_TOOL, {
      threadId: restrictedApproval.threadId,
      hostId: restrictedHost.hostId,
      message: 'Allowed at approval-required',
      expect_reply: false,
    })).toMatchObject({ status: 'ok', outcome: 'working' })

    // 3. Slash command forbidden across machines.
    expect(await desktop.callTool(localFull.threadId, COORDINATE_SEND_TOOL, {
      threadId: fullHostFull.threadId,
      hostId: fullHost.hostId,
      message: '/compact',
    })).toMatchObject({ status: 'refused', code: 'SLASH_COMMAND_FORBIDDEN' })

    // 4. Hop limit enforced on target host even if caller claims hopCount > COORDINATION_HOP_MAX.
    const hopRefusal = await desktop.relay.ask({
      type: 'send',
      targetHostId: fullHost.hostId,
      exchangeId: randomUUID(),
      caller: {
        threadId: localFull.threadId,
        hostId: desktop.hostId(),
        title: 'Desktop Full',
        projectId: 'p1',
        runtimeMode: 'full-access',
        chainId: randomUUID(),
        hopCount: COORDINATION_HOP_MAX + 1,
        rootUserMessageId: 'r1',
      },
      input: { threadId: fullHostFull.threadId, message: 'Hop 7' },
    }, 15_000)
    expect(hopRefusal).toMatchObject({ status: 'refused', code: 'LOOP_LIMIT' })
  })

  it('fails cleanly with HOST_UNAVAILABLE when paired host is unreachable or has coordination off, and hides features from stable/phones', async () => {
    const desktop = await startDesktopStack()
    const localA = await desktop.createParent('claude', 'Desktop Solo', 'auto-accept-edits')

    // 1. Unknown/disconnected host returns HOST_UNAVAILABLE cleanly without charging rate limit.
    const missingHostId = randomUUID()
    expect(await desktop.callTool(localA.threadId, COORDINATE_LIST_THREADS_TOOL, { hostId: missingHostId }))
      .toMatchObject({ status: 'refused', code: 'HOST_UNAVAILABLE' })
    expect(await desktop.callTool(localA.threadId, COORDINATE_READ_THREAD_TOOL, { threadId: 't1', hostId: missingHostId }))
      .toMatchObject({ status: 'refused', code: 'HOST_UNAVAILABLE' })
    expect(await desktop.callTool(localA.threadId, COORDINATE_SEND_TOOL, { threadId: 't1', hostId: missingHostId, message: 'Hello?' }))
      .toMatchObject({ status: 'refused', code: 'HOST_UNAVAILABLE' })
    const summary = await desktop.callTool(localA.threadId, COORDINATE_READ_EXCHANGE_TOOL, {})
    expect((summary.limits as { recentSentInWindow: number }).recentSentInWindow).toBe(0)

    // 2. Paired host with Owl flag off advertises neither feature and returns empty UI views / HOST_UNAVAILABLE on send.
    const disabledHost = await startPairedHost({ name: 'StableHost', parentCoordination: false })
    const disabledSocket = await disabledHost.connectDesktop({ parentCoordinationEnabled: true })
    expect(disabledSocket.supportsCoordinationViews).toBe(false)
    expect(disabledSocket.supportsCoordinationRelay).toBe(false)
    desktop.attachHost(disabledHost.hostId, 'StableHost', disabledSocket)

    const disabledList = await desktop.callTool(localA.threadId, COORDINATE_LIST_THREADS_TOOL, { hostId: 'all' })
    expect(disabledList.status).toBe('ok')
    expect((disabledList.unavailableHosts as Array<{ hostId: string; reason: string }>)).toContainEqual({
      hostId: disabledHost.hostId,
      machine: 'StableHost',
      reason: 'unsupported',
    })
    expect(await desktop.callTool(localA.threadId, COORDINATE_SEND_TOOL, {
      threadId: 'any',
      hostId: disabledHost.hostId,
      message: 'Should fail cleanly',
    })).toMatchObject({ status: 'refused', code: 'HOST_UNAVAILABLE' })
    expect(await desktop.router.coordinationViews(hostEntityKey(disabledHost.hostId, 'any'))).toEqual({
      threadId: hostEntityKey(disabledHost.hostId, 'any'),
      sent: [],
      received: [],
    })

    // 3. Stable desktop (parentCoordinationEnabled: false) does not negotiate coordination features even against an Owl host.
    const owlHost = await startPairedHost({ name: 'OwlHost', parentCoordination: true })
    const stableDesktopSocket = await owlHost.connectDesktop({ parentCoordinationEnabled: false })
    expect(stableDesktopSocket.supportsCoordinationViews).toBe(false)
    expect(stableDesktopSocket.supportsCoordinationRelay).toBe(false)

    // 4. Unrecorded client (phone / non-desktop) is never offered coordination features.
    const unrecordedHost = await startPairedHost({ name: 'PhoneCheck', parentCoordination: true, recordDesktop: false })
    const phoneSocket = await unrecordedHost.connectDesktop({ parentCoordinationEnabled: true })
    expect(phoneSocket.supportsCoordinationViews).toBe(false)
    expect(phoneSocket.supportsCoordinationRelay).toBe(false)
  })
})
