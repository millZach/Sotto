// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startHeadlessHost } from '../../src/host'
import { HostCredentialEncryption } from '../../src/host/credentials'
import { AgentCredentials } from '../../src/main/agents/credentials'
import { SottoThreadHost, ThreadRegistry } from '../../src/main/agents/threads'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { DesktopHosts } from '../../src/main/hosts/desktopHosts'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import { HostSetup, type HostSetupThreads } from '../../src/main/hosts/hostSetup'
import { HOST_SETUP_MCP_SERVER, HostSetupToolServer, type HostSetupToolHandlers } from '../../src/main/hosts/hostSetupTools'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import { ensureFixtureDesktopAnswers } from '../fixtures/sshDesktopAnswers'
import { SshFailure, SshHostLauncher, type SshCallbacks, type SshHostConfiguration, type SshHostConnection } from '../../src/main/hosts/sshLauncher'
import type { ThreadMcpServer } from '../../src/main/agents/threadToolServer'
import type { ProviderId } from '../../src/shared/agents'
import { codexFixture } from '../fixtures/codexFixture'
import { claudeFixture } from '../fixtures/claudeFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'
import type { AdapterFixture } from './adapterContract'

// The host setup tools (ADR-0035, issue #431): the fake providers are given `sotto_host_setup` for the setup thread
// and no other, the endpoint a provider was given reaches the tool as that Sotto thread, and the tool checks and
// adds the one device through Add host's own code, with the add waiting for the user's answer in the thread.
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
type McpReply = { result: { content: { type: string; text: string }[]; isError?: boolean } }
async function callTool(server: Pick<ThreadMcpServer, 'url' | 'headers'>, name: string, args: unknown = {}): Promise<{ status: number; body?: McpReply }> {
  const response = await fetch(server.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...Object.fromEntries(server.headers.map(header => [header.name, header.value])) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
  return response.status === 200 ? { status: 200, body: await response.json() as McpReply } : { status: response.status }
}
const parsed = (reply: { body?: McpReply }): Record<string, unknown> => JSON.parse(reply.body!.result.content[0]!.text) as Record<string, unknown>

const factories: [ProviderId, () => Promise<AdapterFixture>][] = [['codex', codexFixture], ['claude', claudeFixture], ['grok', grokFixture]]
describe.each(factories)('%s host setup tools', (provider, factory) => {
  it('gives the setup thread the tool and no other thread, and its endpoint reaches the tool as that Sotto thread', async () => {
    const fixture = await factory(); cleanup.push(fixture.cleanup)
    let setupThread = ''
    const run = vi.fn<HostSetupToolHandlers['run']>(async () => ({ result: { device: 'forge' } }))
    const server = new HostSetupToolServer({ admits: threadId => threadId === setupThread, run }); cleanup.push(() => server.close())
    const registry = new ThreadRegistry(fixture.root)
    const host = new SottoThreadHost(provider, fixture.host, registry)
    host.useThreadTools([server])
    await host.connect()
    await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: fixture.projectId, title: 'Host setup', path: fixture.root })
    const create = async (threadId: string): Promise<void> => {
      expect(await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: fixture.projectId, title: threadId === setupThread ? 'Set up forge' : 'Other work', modelId: fixture.modelId })).toMatchObject({ accepted: true })
    }
    // Another thread first: it is given nothing.
    await create(randomUUID())
    const before = await fixture.driver.requests()
    expect(JSON.stringify(before)).not.toContain(HOST_SETUP_MCP_SERVER)
    setupThread = randomUUID()
    await create(setupThread)
    const records = (await fixture.driver.requests()).slice(before.length)
    let given: { url: string; headers: { name: string; value: string }[] }
    if (provider === 'codex') {
      const start = records.find(record => record.method === 'thread/start')?.params as { config: { mcp_servers: Record<string, { url: string; default_tools_approval_mode: string; tool_timeout_sec: number; http_headers: Record<string, string> }> } }
      const entry = start.config.mcp_servers[HOST_SETUP_MCP_SERVER]!
      expect(entry).toMatchObject({ default_tools_approval_mode: 'approve', tool_timeout_sec: 600 })
      given = { url: entry.url, headers: Object.entries(entry.http_headers).map(([name, value]) => ({ name, value })) }
    } else if (provider === 'claude') {
      const launch = records.find(record => record.method === 'launch' && (record.params?.frame as { args: string[] }).args.includes('--mcp-config'))
      const args = (launch!.params!.frame as { args: string[] }).args
      const config = JSON.parse(await readFile(args[args.indexOf('--mcp-config') + 1]!, 'utf8')) as { mcpServers: Record<string, { url: string; headers: Record<string, string> }> }
      const entry = config.mcpServers[HOST_SETUP_MCP_SERVER]!
      // Sotto's own tools carry no native prompt; adding asks in the thread itself.
      const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--print'))
      expect(allowed).toEqual(expect.arrayContaining(['host_status', 'host_check', 'host_add'].map(tool => `mcp__${HOST_SETUP_MCP_SERVER}__${tool}`)))
      given = { url: entry.url, headers: Object.entries(entry.headers).map(([name, value]) => ({ name, value })) }
    } else {
      const servers = records.filter(record => record.method === 'session/new').map(record => record.params?.mcpServers as { name: string; url: string; headers: { name: string; value: string }[] }[]).find(value => value?.length)!
      const entry = servers.find(server => server.name === HOST_SETUP_MCP_SERVER)!
      expect(entry).toMatchObject({ type: 'http' })
      given = entry
    }
    // The provider calls the tool with what it was given; the tool hears the Sotto thread, never the native session.
    expect(parsed(await callTool(given, 'host_status'))).toEqual({ device: 'forge' })
    expect(run).toHaveBeenCalledWith(setupThread, 'host_status')
    expect(registry.byThread(setupThread)!.sessionId).not.toBe(setupThread)
    // The setup ends: the token is revoked and the next call is refused before it reaches the tool.
    setupThread = 'ended'
    server.revoke(run.mock.calls[0]![0])
    expect((await callTool(given, 'host_check')).status).toBe(401)
    expect(run).toHaveBeenCalledTimes(1)
    await registry.flush()
  })
})

// Grok's leader ignores `--allow` rules, so its prompt for Sotto's own tool servers is answered by the adapter,
// the host setup tools as the browser's (ADR-0020, ADR-0035). The same tool name elsewhere still reaches the user.
describe('grok host setup admission', () => {
  it('answers Grok\'s prompt for the host setup tool without showing it, and shows one for the same name elsewhere', async () => {
    const fixture = await grokFixture(); cleanup.push(fixture.cleanup)
    const threadId = randomUUID()
    const server = new HostSetupToolServer({ admits: id => id === threadId, run: async () => ({ result: {} }) }); cleanup.push(() => server.close())
    fixture.host.useThreadTools!([server])
    await fixture.host.connect()
    await fixture.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: fixture.projectId, title: 'Host setup', path: fixture.root })
    await fixture.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: fixture.projectId, title: 'Set up forge', modelId: fixture.modelId })
    fixture.host.observeThreads?.([threadId])
    await fixture.host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: 'setup-admission', text: 'Synthetic brief' })
    const thread = async () => (await fixture.host.snapshot()).threads.find(item => item.id === threadId)!
    const decisions = async () => (await fixture.driver.requests()).map(record => fixture.protocol!.permissionDecision(record)).filter(decision => decision !== undefined)
    await fixture.action(threadId, { type: 'permission', text: 'use_tool', rawInput: { tool_name: `${HOST_SETUP_MCP_SERVER}__host_add`, tool_input: {} } })
    await expect.poll(decisions).toEqual([true])
    expect((await thread()).requests).toEqual([])
    await fixture.action(threadId, { type: 'permission', text: 'use_tool', rawInput: { tool_name: 'other_server__host_add', tool_input: {} } })
    await expect.poll(async () => (await thread()).requests.length).toBe(1)
  })
})

describe('the host setup tool over Add host', () => {
  /** A scripted SSH launcher: each connect fails with the next failure, or reaches the real headless host. */
  class ScriptedSsh extends SshHostLauncher {
    constructor(private readonly remote: Awaited<ReturnType<typeof startHeadlessHost>>, private readonly failures: Error[], private readonly connects: SshHostConfiguration[], private readonly dataDirectory: string) { super() }
    override async connect(configuration: SshHostConfiguration, callbacks: SshCallbacks = {}): Promise<SshHostConnection> {
      this.connects.push(configuration)
      callbacks.onStep?.('sign-in'); callbacks.onStep?.('install')
      const failure = this.failures.shift()
      if (failure) throw failure
      callbacks.onStep?.('start')
      const hostId = this.remote.descriptor!.hostId
      return { url: 'http://127.0.0.1:' + this.remote.descriptor!.port, hostId, owned: true, route: { hostname: 'forge', identityFiles: [] }, close: async () => undefined,
        showHostPairingCode: async () => ({ ...this.remote.pairing.issuePairingCode(), hostId }), ensureDesktopAnswers: clientId => ensureFixtureDesktopAnswers(this.dataDirectory, hostId, clientId), revokeClient: async () => true, hostAdminToken: async () => { throw new Error("Nothing here administers phone access.") }, stopHost: async () => true, updateHost: async () => { throw new Error('Nothing here updates a host.') }, boot: async () => { throw new Error('Nothing here starts a host at boot.') } }
    }
    override async disconnect(): Promise<void> { /* nothing to close */ }
  }

  it('checks the one device, reports the missing Node, adds it only after the user answers, and pairs once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-host-setup-tools-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const remote = await startHeadlessHost({ dataDirectory: join(root, 'remote'), port: 0, providers: { codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost() }, reasoner: e2eAgentReasoner })
    cleanup.push(() => remote.close())
    const credentials = new AgentCredentials(join(root, 'desktop'), new HostCredentialEncryption('synthetic-desktop-credential-key')); await credentials.load()
    const router = new DesktopHostRouter(emptyDesktopState); cleanup.push(async () => router.dispose())
    // The first connect is the user's own Add it on another machine, which fails; the setup's first check follows.
    const failures: Error[] = [new SshFailure('auth-failed'), new SshFailure('node-missing')], connects: SshHostConfiguration[] = []
    const hosts = new DesktopHosts({ directory: join(root, 'desktop'), credentials, router, localHostRunning: true, localHostEnabled: () => true, restart: () => undefined,
      launcher: () => new ScriptedSsh(remote, failures, connects, join(root, 'remote')) })
    await hosts.start(); cleanup.push(() => hosts.close())
    const threads: HostSetupThreads = {
      choice: () => ({ models: [{ id: 'claude:opus', name: 'Claude Opus 5.5', provider: 'Claude Code' }], modelId: 'claude:opus' }),
      start: async request => { request.created('setup-thread') }, interrupt: async () => undefined,
      thread: () => ({ requestIds: [], archived: false }), windowId: id => id, subscribe: () => () => undefined,
    }
    const setup = new HostSetup({ version: '0.1.21', threads, hosts: { check: connection => hosts.check(connection), add: connection => hosts.setupAdd(connection), forget: id => hosts.forgetSaved(id),
      attempt: id => hosts.attempt(id), cancelAttempt: id => hosts.cancelAttempt(id), savedAs: (target, port) => hosts.savedAs(target, port) } })
    const server = new HostSetupToolServer(setup); cleanup.push(() => server.close())
    setup.useTools(threadId => server.revoke(threadId))
    hosts.useSetup(setup)
    const hostId = randomUUID()
    await hosts.command({ type: 'start-setup', id: randomUUID(), host: { id: hostId, name: 'forge', target: 'zach@forge', identityFile: '', installPath: '/opt/sotto', dataDirectory: '/data/sotto' }, modelId: 'claude:opus' })
    expect(await server.mcpServer('another-thread')).toBeUndefined()
    const endpoint = (await server.mcpServer('setup-thread'))!
    const other = { name: 'other', target: 'zach@other', identityFile: '', installPath: '/opt/sotto', dataDirectory: '/data/sotto' }
    const otherId = randomUUID()
    await hosts.command({ type: 'add', host: { id: otherId, ...other } })
    expect(hosts.get().adding).toMatchObject({ id: otherId, phase: 'error', reason: 'auth-failed' })

    const missing = await callTool(endpoint, 'host_check')
    expect(missing.body!.result.isError).toBe(true)
    expect(parsed(missing)).toMatchObject({ ok: false, step: 'install', reason: 'node-missing', message: expect.stringContaining('Node was not found on the SSH host.') })
    expect(hosts.get().setup).toMatchObject({ attempt: { purpose: 'check', phase: 'error', step: 'install' } })
    const passed = await callTool(endpoint, 'host_check')
    expect(parsed(passed)).toMatchObject({ ok: true })
    expect(hosts.get()).toMatchObject({ hosts: [], setup: { byAgent: ['install'], attempt: { checked: true } } })
    expect(connects.slice(1).every(item => item.target === 'zach@forge')).toBe(true)
    // The setup's checks and Add host's own attempt keep apart: the dialog still shows its failure on another machine,
    // and the user's next Add it there leaves the setup's finished check where it was.
    expect(hosts.get().adding).toMatchObject({ id: otherId, phase: 'error', reason: 'auth-failed' })
    failures.push(new SshFailure('auth-failed'))
    await hosts.command({ type: 'add', host: { id: randomUUID(), ...other } })
    expect(hosts.get().adding).toMatchObject({ target: 'zach@other', phase: 'error' })
    expect(hosts.get().setup).toMatchObject({ attempt: { purpose: 'check', checked: true } })
    expect(parsed(await callTool(endpoint, 'host_status'))).toMatchObject({ last: { kind: 'check', ok: true } })
    // A check pairs nothing: no credential is kept for it, and nothing is saved.
    expect(credentials.has('remote-host:' + hosts.get().setup!.attempt!.id)).toBe(false)
    expect(credentials.has('remote-host:' + hostId)).toBe(false)

    const adding = callTool(endpoint, 'host_add')
    await vi.waitFor(() => expect(setup.requests().get('setup-thread')).toHaveLength(1))
    expect(hosts.get().setup?.waiting).toBe('add')
    expect(hosts.get().hosts).toEqual([])
    const request = setup.requests().get('setup-thread')![0]!
    setup.answer('setup-thread', request.id, true)
    expect(parsed(await adding)).toMatchObject({ added: true })
    expect(hosts.get().hosts).toMatchObject([{ id: hostId, name: 'forge', target: 'zach@forge', phase: 'connected' }])
    expect(hosts.get().setup).toMatchObject({ phase: 'connected' })
    expect(credentials.has('remote-host:' + hostId)).toBe(true)
    expect((await callTool(endpoint, 'host_status')).status).toBe(401)
  })

  it('Stop setup during a check leaves no saved host and no credential', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-host-setup-stop-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const remote = await startHeadlessHost({ dataDirectory: join(root, 'remote'), port: 0, providers: { codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost() }, reasoner: e2eAgentReasoner })
    cleanup.push(() => remote.close())
    const credentials = new AgentCredentials(join(root, 'desktop'), new HostCredentialEncryption('synthetic-desktop-credential-key')); await credentials.load()
    const router = new DesktopHostRouter(emptyDesktopState); cleanup.push(async () => router.dispose())
    let release: () => void = () => undefined
    const held = new Promise<void>(resolve => { release = resolve })
    class HeldSsh extends SshHostLauncher {
      override async connect(): Promise<SshHostConnection> { await held; throw new SshFailure('cancelled') }
      override async disconnect(): Promise<void> { release() }
    }
    const hosts = new DesktopHosts({ directory: join(root, 'desktop'), credentials, router, localHostRunning: true, localHostEnabled: () => true, restart: () => undefined, launcher: () => new HeldSsh() })
    await hosts.start(); cleanup.push(() => hosts.close())
    const interrupted: string[] = []
    const setup = new HostSetup({ version: '0.1.21', hosts: { check: connection => hosts.check(connection), add: connection => hosts.setupAdd(connection), forget: id => hosts.forgetSaved(id),
      attempt: id => hosts.attempt(id), cancelAttempt: id => hosts.cancelAttempt(id), savedAs: (target, port) => hosts.savedAs(target, port) },
    threads: { choice: () => ({ models: [{ id: 'm', name: 'Model', provider: 'Provider' }], modelId: 'm' }), start: async request => { request.created('setup-thread') },
      interrupt: async threadId => { interrupted.push(threadId) }, thread: () => ({ requestIds: [], archived: false }), windowId: id => id, subscribe: () => () => undefined } })
    const server = new HostSetupToolServer(setup); cleanup.push(() => server.close())
    setup.useTools(threadId => server.revoke(threadId))
    hosts.useSetup(setup)
    const setupId = randomUUID()
    await hosts.command({ type: 'start-setup', id: setupId, host: { id: randomUUID(), name: 'forge', target: 'forge', identityFile: '', installPath: '/opt/sotto', dataDirectory: '/data/sotto' }, modelId: 'm' })
    const endpoint = (await server.mcpServer('setup-thread'))!
    const checking = callTool(endpoint, 'host_check')
    await vi.waitFor(() => expect(hosts.get().setup?.attempt?.phase).toBe('connecting'))
    await hosts.command({ type: 'stop-setup', id: setupId })
    expect(parsed(await checking)).toMatchObject({ ok: false, message: 'The setup was stopped. Nothing was saved.' })
    expect(interrupted).toEqual(['setup-thread'])
    expect(hosts.get()).toMatchObject({ hosts: [], setup: { phase: 'stopped' } })
    expect(hosts.get().adding).toBeUndefined()
    expect(hosts.get().setup?.attempt).toBeUndefined()
  })
})
