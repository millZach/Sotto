// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostSetup, hostSetupRequests, type HostSetupHosts, type HostSetupThreads } from '../../../src/main/hosts/hostSetup'
import { hostSetupBrief } from '../../../src/main/hosts/hostSetupBrief'
import { HOST_SETUP_MCP_SERVER, HostSetupToolServer, hostSetupToolDefinitions } from '../../../src/main/hosts/hostSetupTools'
import type { HostSetupChoice, HostsCommand, HostStatus, RemoteHost } from '../../../src/shared/hosts'

// The host setup (ADR-0035): one device, one thread, a brief with no secret in it, a tool only that thread gets,
// and an add that waits for the user's answer in the thread.
const HOST_ID = '44444444-4444-4444-8444-444444444444'
const SETUP_ID = '55555555-5555-4555-8555-555555555555'
const AFTER_ID = '66666666-6666-4666-8666-666666666666'
const CHOICE: HostSetupChoice = { models: [{ id: 'claude:opus', name: 'Claude Opus 5.5', provider: 'Claude Code' }], modelId: 'claude:opus' }
const host: Omit<RemoteHost, 'enabled'> = { id: HOST_ID, name: 'forge', target: 'zach@forge', identityFile: process.platform === 'win32' ? 'C:/Users/zache/.ssh/id_forge' : '/Users/zache/.ssh/id_forge', installPath: '~/.local/share/sotto-host', dataDirectory: '~/.sotto' }
const start = (patch: Partial<Extract<HostsCommand, { type: 'start-setup' }>> = {}): Extract<HostsCommand, { type: 'start-setup' }> => ({ type: 'start-setup', id: SETUP_ID, host, modelId: 'claude:opus', ...patch })

function fixture(busy?: () => string | undefined) {
  const statuses = new Map<string, HostStatus>()
  const saved: string[] = []
  const checks: ((status: Partial<HostStatus>) => void)[] = []
  const status = (id: string, patch: Partial<HostStatus>): HostStatus => ({ ...host, id, enabled: true, phase: 'connecting', ...patch })
  const hosts = {
    check: vi.fn(async (connection: Omit<RemoteHost, 'enabled'>) => {
      statuses.set(connection.id, status(connection.id, { phase: 'connecting', step: 'reach' }))
      const result = await new Promise<Partial<HostStatus>>(resolve => checks.push(resolve))
      statuses.set(connection.id, status(connection.id, result))
      return statuses.get(connection.id)
    }),
    add: vi.fn(async (connection: Omit<RemoteHost, 'enabled'>) => { saved.push(connection.id); statuses.set(connection.id, status(connection.id, { phase: 'connected' })) }),
    attempt: vi.fn((id: string) => statuses.get(id)),
    cancelAttempt: vi.fn(async (id: string) => { statuses.delete(id) }),
    savedAs: vi.fn((): string | undefined => undefined),
    forget: vi.fn(async (id: string) => { const index = saved.indexOf(id); if (index < 0) return false; saved.splice(index, 1); return true }),
  } satisfies HostSetupHosts
  const events: string[] = []
  let listener: () => void = () => undefined
  const requestIds: string[] = []
  const threads = {
    choice: vi.fn((): HostSetupChoice => CHOICE),
    start: vi.fn(async (request: Parameters<HostSetupThreads['start']>[0]) => { events.push('create'); request.created('thread-1'); events.push('send') }),
    interrupt: vi.fn(async () => { events.push('interrupt') }),
    thread: vi.fn(() => ({ requestIds, archived: false })),
    windowId: (threadId: string) => `host:local:${threadId}`,
    subscribe: (next: () => void) => { listener = next; return () => undefined },
  } satisfies HostSetupThreads
  const setup = new HostSetup({ hosts, threads, version: '0.1.21', ...(busy ? { busy } : {}) })
  const revoked: string[] = []
  setup.useTools(threadId => { revoked.push(threadId); events.push('revoke') })
  const onRequests = vi.fn()
  hostSetupRequests(setup).subscribe(onRequests)
  const finishCheck = async (result: Partial<HostStatus>): Promise<void> => { await vi.waitFor(() => expect(checks.length).toBeGreaterThan(0)); checks.shift()!(result) }
  return { setup, hosts, threads, events, revoked, saved, statuses, finishCheck, onRequests, requestIds, threadsChanged: () => listener() }
}

afterEach(() => vi.restoreAllMocks())

describe('the host setup brief', () => {
  it('names the device, its route, its folders and the failure, and carries no key, token or password', () => {
    const brief = hostSetupBrief({ name: 'forge', target: 'zach@forge', sshPort: 2222, installPath: '~/.local/share/sotto-host', dataDirectory: '~/.sotto', version: '0.1.21',
      failure: { step: 'install', reason: 'node-too-new' } })
    for (const text of ['forge', 'zach@forge', 'port 2222', '`ssh -p 2222 zach@forge`', '~/.local/share/sotto-host', '~/.sotto', 'Sotto 0.1.21', 'Sotto-host-0.1.21-linux-x64.tar.gz',
      'stopped at the host installation (reason code node-too-new)', 'Node 24', 'host_check', 'host_add', 'never touch this computer\'s credential store']) expect(brief).toContain(text)
    expect(brief).not.toMatch(/id_forge|identity file|BEGIN|password:/iu)
  })
})

describe('HostSetup', () => {
  it('starts one thread named for the device, admits its tool before the brief is sent, and gives no other thread the tool', async () => {
    const f = fixture()
    let admittedAtSend = false
    f.threads.start.mockImplementation(async request => { request.created('thread-1'); admittedAtSend = f.setup.admits('thread-1') })
    await f.setup.command(start())
    expect(admittedAtSend).toBe(true)
    const request = f.threads.start.mock.calls[0]![0]
    expect(request).toMatchObject({ title: 'Set up forge', modelId: 'claude:opus' })
    expect(request.brief).toContain('zach@forge')
    expect(request.brief).not.toContain('id_forge')
    expect(f.setup.state()).toMatchObject({ id: SETUP_ID, name: 'forge', phase: 'running', threadId: 'host:local:thread-1', threadTitle: 'Set up forge', modelName: 'Claude Opus 5.5' })
    expect(f.setup.admits('thread-2')).toBe(false)
    expect(await f.setup.run('thread-2', 'host_check')).toMatchObject({ isError: true })
    expect(f.hosts.check).not.toHaveBeenCalled()
    await expect(f.setup.command(start({ id: '77777777-7777-4777-8777-777777777777' }))).rejects.toThrow('already setting up forge')
  })

  it('refuses a device already saved, and a model that is not ready, before anything starts', async () => {
    const f = fixture()
    f.hosts.savedAs.mockReturnValueOnce('forge')
    await expect(f.setup.command(start())).rejects.toThrow('already saved as forge. Nothing was started.')
    await expect(f.setup.command(start({ modelId: 'codex:missing' }))).rejects.toThrow('not ready')
    f.threads.choice.mockReturnValueOnce({ models: [], unavailable: 'The local host is off.' })
    await expect(f.setup.command(start())).rejects.toThrow('The local host is off.')
    expect(f.threads.start).not.toHaveBeenCalled()
    expect(f.setup.state()).toBeUndefined()
  })

  it('takes the failed Add it attempt\'s step and reason into the brief, and drops that attempt', async () => {
    const f = fixture()
    f.statuses.set(AFTER_ID, { ...host, id: AFTER_ID, enabled: true, phase: 'error', step: 'install', reason: 'node-missing' })
    await f.setup.command(start({ after: AFTER_ID }))
    expect(f.hosts.cancelAttempt).toHaveBeenCalledWith(AFTER_ID)
    expect(f.threads.start.mock.calls[0]![0].brief).toContain('(reason code node-missing)')
  })

  it('checks the one device, reports the step and reason, and marks a step the agent fixed', async () => {
    const f = fixture()
    await f.setup.command(start())
    const first = f.setup.run('thread-1', 'host_check')
    await f.finishCheck({ phase: 'error', step: 'install', reason: 'node-missing', error: 'Node was not found on the SSH host. Nothing was saved.' })
    expect(await first).toEqual({ isError: true, result: { ok: false, step: 'install', reason: 'node-missing', message: 'Node was not found on the SSH host. Nothing was saved.' } })
    expect(f.hosts.check.mock.calls[0]![0]).toMatchObject({ target: 'zach@forge', installPath: '~/.local/share/sotto-host' })
    expect(f.hosts.check.mock.calls[0]![0].id).not.toBe(HOST_ID)
    const second = f.setup.run('thread-1', 'host_check')
    await f.finishCheck({ phase: 'disconnected', step: 'pair', checked: true })
    expect(await second).toMatchObject({ result: { ok: true } })
    expect(f.setup.state()).toMatchObject({ byAgent: ['install'], attempt: { purpose: 'check', checked: true } })
    expect(f.saved).toEqual([])
  })

  it('adds only after the user answers the request in the thread, and ends the setup once connected', async () => {
    const f = fixture()
    await f.setup.command(start())
    const adding = f.setup.run('thread-1', 'host_add')
    await vi.waitFor(() => expect(f.setup.requests().get('thread-1')).toHaveLength(1))
    const [request] = f.setup.requests().get('thread-1')!
    expect(request).toMatchObject({ kind: 'permission', text: expect.stringMatching(/^Add forge as a host\?/u), permissionChoices: [{ id: 'add', label: 'Add forge', kind: 'allow-once' }, { id: 'decline', kind: 'deny' }] })
    expect(request!.id.startsWith('sotto:')).toBe(true)
    expect(f.onRequests).toHaveBeenCalled()
    expect(f.setup.state()?.waiting).toBe('add')
    expect(f.hosts.add).not.toHaveBeenCalled()
    // A repeated call, as after a client timeout, waits on the same answer rather than asking twice.
    const repeated = f.setup.run('thread-1', 'host_add')
    expect(() => f.setup.answer('thread-2', request!.id, true)).toThrow('no longer pending')
    f.setup.answer('thread-1', request!.id, true)
    expect(await adding).toMatchObject({ result: { added: true } })
    expect(await repeated).toMatchObject({ result: { added: true } })
    expect(f.hosts.add).toHaveBeenCalledTimes(1)
    expect(f.hosts.add.mock.calls[0]![0]).toMatchObject({ id: HOST_ID, name: 'forge', target: 'zach@forge' })
    expect(f.setup.state()).toMatchObject({ phase: 'connected' })
    expect(f.revoked).toEqual(['thread-1'])
    expect(f.setup.admits('thread-1')).toBe(false)
  })

  it('ends the setup when the add saves a host that answers with another Sotto version, rather than saying nothing was saved', async () => {
    const f = fixture()
    f.hosts.add.mockImplementationOnce(async connection => { f.saved.push(connection.id); f.statuses.set(connection.id, { ...host, id: connection.id, enabled: true, phase: 'error', step: 'pair', error: 'This host is running a different version of Sotto.' }) })
    f.hosts.savedAs.mockImplementation(() => (f.saved.length ? 'forge' : undefined))
    await f.setup.command(start())
    const adding = f.setup.run('thread-1', 'host_add')
    await vi.waitFor(() => expect(f.setup.requests().size).toBe(1))
    f.setup.answer('thread-1', f.setup.requests().get('thread-1')![0]!.id, true)
    expect(await adding).toMatchObject({ isError: true, result: { added: true, connected: false } })
    expect(f.setup.state()).toMatchObject({ phase: 'failed', error: expect.stringContaining('forge was saved as a host but is not connected. This host is running a different version of Sotto.') })
    expect(f.revoked).toEqual(['thread-1'])
  })

  it('adds nothing when the user declines', async () => {
    const f = fixture()
    await f.setup.command(start())
    const adding = f.setup.run('thread-1', 'host_add')
    await vi.waitFor(() => expect(f.setup.requests().size).toBe(1))
    f.setup.answer('thread-1', f.setup.requests().get('thread-1')![0]!.id, false)
    expect(await adding).toMatchObject({ result: { added: false, declined: true } })
    expect(f.hosts.add).not.toHaveBeenCalled()
    expect(f.setup.requests().size).toBe(0)
    expect(f.setup.state()?.phase).toBe('running')
  })

  it('Stop setup withdraws the question, drops a check in flight, stops the thread and saves nothing', async () => {
    const f = fixture()
    await f.setup.command(start())
    const checking = f.setup.run('thread-1', 'host_check')
    await vi.waitFor(() => expect(f.hosts.check).toHaveBeenCalled())
    const attemptId = f.hosts.check.mock.calls[0]![0].id
    await f.setup.command({ type: 'stop-setup', id: SETUP_ID })
    expect(f.hosts.cancelAttempt).toHaveBeenCalledWith(attemptId)
    expect(f.events).toContain('interrupt')
    expect(f.revoked).toEqual(['thread-1'])
    await f.finishCheck({ phase: 'error', step: 'reach' })
    expect(await checking).toMatchObject({ isError: true, result: { message: 'The setup was stopped. Nothing was saved.' } })
    expect(f.setup.state()).toMatchObject({ phase: 'stopped' })
    expect(await f.setup.run('thread-1', 'host_add')).toMatchObject({ isError: true })
    expect(f.saved).toEqual([])
    await f.setup.command({ type: 'dismiss-setup', id: SETUP_ID })
    expect(f.setup.state()).toBeUndefined()
  })

  it('forgets a host the add saved just as Stop setup landed, so the stop saves nothing', async () => {
    const f = fixture()
    let release: () => void = () => undefined
    // Past pairing: the host is saved, and the add is still writing it when the user presses Stop setup.
    f.hosts.add.mockImplementationOnce(async connection => {
      f.saved.push(connection.id); f.statuses.set(connection.id, { ...host, id: connection.id, enabled: true, phase: 'connected' })
      await new Promise<void>(resolve => { release = resolve })
    })
    await f.setup.command(start())
    const adding = f.setup.run('thread-1', 'host_add')
    await vi.waitFor(() => expect(f.setup.requests().size).toBe(1))
    f.setup.answer('thread-1', f.setup.requests().get('thread-1')![0]!.id, true)
    await vi.waitFor(() => expect(f.saved).toEqual([HOST_ID]))
    const stopping = f.setup.command({ type: 'stop-setup', id: SETUP_ID })
    release()
    await stopping
    expect(f.hosts.forget).toHaveBeenCalledWith(HOST_ID)
    expect(f.saved).toEqual([])
    expect(await adding).toMatchObject({ isError: true, result: { added: false, message: expect.stringContaining('forgot it again') } })
    expect(f.setup.state()).toMatchObject({ phase: 'stopped' })
    expect(f.setup.state()?.error).toBeUndefined()
  })

  it('says the host is saved when a stop lands after the add saved it and forgetting it fails', async () => {
    const f = fixture()
    let release: () => void = () => undefined
    f.hosts.add.mockImplementationOnce(async connection => { f.saved.push(connection.id); await new Promise<void>(resolve => { release = resolve }) })
    f.hosts.forget.mockRejectedValueOnce(new Error('The host could not be reached.'))
    await f.setup.command(start())
    const adding = f.setup.run('thread-1', 'host_add')
    await vi.waitFor(() => expect(f.setup.requests().size).toBe(1))
    f.setup.answer('thread-1', f.setup.requests().get('thread-1')![0]!.id, true)
    await vi.waitFor(() => expect(f.saved).toEqual([HOST_ID]))
    const stopping = f.setup.command({ type: 'stop-setup', id: SETUP_ID })
    release()
    await stopping
    expect(await adding).toMatchObject({ isError: true, result: { added: true } })
    expect(f.setup.state()).toMatchObject({ phase: 'stopped', error: expect.stringContaining('forge was saved as a host just as the setup stopped') })
  })

  it('stops a pending add question when the setup stops', async () => {
    const f = fixture()
    await f.setup.command(start())
    const adding = f.setup.run('thread-1', 'host_add')
    await vi.waitFor(() => expect(f.setup.requests().size).toBe(1))
    await f.setup.command({ type: 'stop-setup', id: SETUP_ID })
    expect(await adding).toMatchObject({ result: { added: false, message: 'The setup was stopped. Nothing was saved.' } })
    expect(f.setup.requests().size).toBe(0)
    expect(f.hosts.add).not.toHaveBeenCalled()
    expect(f.hosts.forget).not.toHaveBeenCalled()
  })

  it('says the setup waits on the user while SSH asks a question or Tailscale holds its check', async () => {
    const f = fixture()
    await f.setup.command(start())
    const checking = f.setup.run('thread-1', 'host_check')
    await vi.waitFor(() => expect(f.hosts.check).toHaveBeenCalled())
    const id = f.hosts.check.mock.calls[0]![0].id
    f.statuses.set(id, { ...f.statuses.get(id)!, step: 'sign-in', prompt: { id: 'prompt-1', kind: 'password', text: 'zach@forge password:' } })
    expect(f.setup.state()?.waiting).toBe('connection')
    const signedIn = { ...f.statuses.get(id)! }
    delete signedIn.prompt
    f.statuses.set(id, { ...signedIn, step: 'tailscale', tailscale: { waiting: true, url: 'https://login.tailscale.com/a/synthetic' } })
    expect(f.setup.state()?.waiting).toBe('connection')
    await f.finishCheck({ phase: 'disconnected', step: 'pair', checked: true })
    await checking
    expect(f.setup.state()?.waiting).toBeUndefined()
  })

  it('says the thread waits for a command while the provider asks, and stops when the thread is archived', async () => {
    const f = fixture()
    await f.setup.command(start())
    f.requestIds.push('codex-request-1')
    f.threadsChanged()
    expect(f.setup.state()?.waiting).toBe('command')
    f.threads.thread.mockReturnValue({ requestIds: [], archived: true })
    f.threadsChanged()
    await vi.waitFor(() => expect(f.setup.state()?.phase).toBe('stopped'))
  })

  it('interrupts the thread when Stop setup lands before the brief was sent', async () => {
    const f = fixture()
    let release: () => void = () => undefined
    // Stop lands after the thread exists but before its brief is sent: the stop has no turn to interrupt yet.
    f.threads.start.mockImplementationOnce(async request => {
      f.events.push('create'); request.created('thread-1')
      await new Promise<void>(resolve => { release = resolve })
      f.events.push('send')
    })
    const starting = f.setup.command(start())
    await vi.waitFor(() => expect(f.events).toContain('create'))
    await f.setup.command({ type: 'stop-setup', id: SETUP_ID })
    release()
    await starting
    // The brief went after the first interrupt; the second one stops the turn it began.
    expect(f.events.slice(f.events.indexOf('send'))).toContain('interrupt')
    expect(f.setup.state()?.phase).toBe('stopped')
    expect(await f.setup.run('thread-1', 'host_check')).toMatchObject({ isError: true })
  })

  it('does not start beside a provider job: one agent job at a time', async () => {
    const f = fixture(() => 'An agent is installing Devin on forge now. Stop it on its tile in Settings > Hosts first. Nothing was started.')
    await expect(f.setup.command(start())).rejects.toThrow('An agent is installing Devin on forge now.')
    expect(f.threads.start).not.toHaveBeenCalled()
    expect(f.setup.state()).toBeUndefined()
  })

  it('keeps a thread that did not take its brief open to look at, and gives back the form when none was made', async () => {
    const f = fixture()
    f.threads.start.mockImplementationOnce(async () => { throw new Error('Connect Claude Code before creating a project.') })
    await expect(f.setup.command(start())).rejects.toThrow('Connect Claude Code before creating a project. Nothing was started.')
    expect(f.setup.state()).toBeUndefined()
    f.threads.start.mockImplementationOnce(async request => { request.created('thread-9'); throw new Error('The provider rejected thread creation.') })
    await f.setup.command(start())
    expect(f.setup.state()).toMatchObject({ phase: 'failed', threadId: 'host:local:thread-9', error: expect.stringContaining('Nothing was saved as a host.') })
    expect(f.revoked).toEqual(['thread-9'])
  })
})

describe('the host setup tool server', () => {
  it('offers its three tools to the setup thread alone, over loopback with a token, and refuses arguments', async () => {
    const f = fixture()
    const server = new HostSetupToolServer(f.setup)
    try {
      expect(hostSetupToolDefinitions.map(tool => tool.name)).toEqual(['host_status', 'host_check', 'host_add'])
      expect(await server.mcpServer('thread-1')).toBeUndefined()
      await f.setup.command(start())
      expect(await server.mcpServer('thread-2')).toBeUndefined()
      const endpoint = (await server.mcpServer('thread-1'))!
      expect(endpoint).toMatchObject({ name: HOST_SETUP_MCP_SERVER, type: 'http' })
      expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/u)
      const post = (body: unknown) => fetch(endpoint.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: endpoint.headers[0]!.value }, body: JSON.stringify(body) })
      expect(await (await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()).toMatchObject({ result: { tools: hostSetupToolDefinitions } })
      const status = await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'host_status', arguments: {} } })).json() as { result: { content: { text: string }[] } }
      expect(JSON.parse(status.result.content[0]!.text)).toMatchObject({ device: 'forge', target: 'zach@forge', installationFolder: '~/.local/share/sotto-host', dataFolder: '~/.sotto' })
      expect(status.result.content[0]!.text).not.toContain('id_forge')
      const forged = await (await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'host_check', arguments: { target: 'root@elsewhere' } } })).json() as { result: { isError: boolean } }
      expect(forged.result.isError).toBe(true)
      expect(f.hosts.check).not.toHaveBeenCalled()
      await f.setup.command({ type: 'stop-setup', id: SETUP_ID })
      server.revoke('thread-1')
      expect((await post({ jsonrpc: '2.0', id: 4, method: 'tools/list' })).status).toBe(401)
    } finally { await server.close() }
  })
})
