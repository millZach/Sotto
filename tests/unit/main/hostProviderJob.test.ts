// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { HostProviderJobs, type ProviderJobHosts } from '../../../src/main/hosts/hostProviderJob'
import { hostProviderBrief } from '../../../src/main/hosts/hostProviderBrief'
import type { HostSetupThreads } from '../../../src/main/hosts/hostSetup'
import { agentJobTools, HOST_SETUP_MCP_SERVER, HostSetupToolServer, providerJobToolDefinitions, type HostSetupToolHandlers } from '../../../src/main/hosts/hostSetupTools'
import type { AgentProviderStatus, ProviderId } from '../../../src/shared/agents'
import type { HostSetupChoice, HostsCommand } from '../../../src/shared/hosts'
import { deferred } from '../../fixtures/deferred'

// A provider job (ADR-0035, amended for #461): one provider on one saved host, a brief with no secret in it, a tool only
// that thread gets and that reaches only that host's provider, and the job ending once the host finds the provider.
const FORGE = '44444444-4444-4444-8444-444444444444'
const LAB = '77777777-7777-4777-8777-777777777777'
const JOB = '55555555-5555-4555-8555-555555555555'
const CHOICE: HostSetupChoice = { models: [{ id: 'claude:opus', name: 'Claude Opus 5.5', provider: 'Claude Code' }], modelId: 'claude:opus' }
const capabilities = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true }
const status = (id: ProviderId, patch: Partial<AgentProviderStatus>): AgentProviderStatus => ({ id, name: id, version: '', connection: 'error', capabilities, ...patch })
const start = (patch: Partial<Extract<HostsCommand, { type: 'start-provider-job' }>> = {}): Extract<HostsCommand, { type: 'start-provider-job' }> =>
  ({ type: 'start-provider-job', id: JOB, hostId: FORGE, provider: 'devin', modelId: 'claude:opus', ...patch })

function fixture(busy?: () => string | undefined) {
  const providers = new Map<string, AgentProviderStatus>([
    [`${FORGE}:devin`, status('devin', { problem: 'not-installed', error: 'Install Devin CLI and run devin auth login, then connect again.' })],
    [`${FORGE}:grok`, status('grok', { problem: 'too-old', version: '0.9.12 / ACP 1', requiredVersion: '1.0.5', error: 'Could not connect Grok. Grok CLI 1.0.5 or newer is required.' })],
    [`${FORGE}:codex`, status('codex', { connection: 'connected', version: '0.155.1', account: 'ChatGPT' })],
    [`${LAB}:devin`, status('devin', { problem: 'not-installed' })],
  ])
  let hostsListener: () => void = () => undefined
  let threadsListener: () => void = () => undefined
  const hosts = {
    host: vi.fn((id: string) => id === FORGE ? { name: 'forge', target: 'zach@forge', sshPort: 2222, connected: true } : id === LAB ? { name: 'lab', target: 'lab', connected: true } : undefined),
    provider: vi.fn((id: string, provider: ProviderId) => providers.get(`${id}:${provider}`)),
    refresh: vi.fn(async (id: string, provider: ProviderId) => ({ status: providers.get(`${id}:${provider}`) })),
    subscribe: (listener: () => void) => { hostsListener = listener; return () => undefined },
  } satisfies ProviderJobHosts
  let archived = false
  const threads = {
    choice: vi.fn((): HostSetupChoice => CHOICE),
    start: vi.fn(async (request: Parameters<HostSetupThreads['start']>[0]) => { request.created('thread-1') }),
    interrupt: vi.fn(async () => undefined),
    thread: vi.fn(() => ({ requestIds: [], archived })),
    windowId: (threadId: string) => `host:local:${threadId}`,
    subscribe: (listener: () => void) => { threadsListener = listener; return () => undefined },
  } satisfies HostSetupThreads
  const jobs = new HostProviderJobs({ hosts, threads, ...(busy ? { busy } : {}) })
  const revoked: string[] = []
  jobs.useTools(threadId => revoked.push(threadId))
  return { jobs, hosts, threads, providers, revoked, hostsChanged: () => hostsListener(), archive: () => { archived = true; threadsListener() } }
}

describe('the provider job brief', () => {
  it('names the host, the provider, the case, what the host reported, where it looks and the official install, and no secret', () => {
    const brief = hostProviderBrief({ host: 'forge', target: 'zach@forge', sshPort: 2222, provider: 'grok', case: 'update', version: '0.9.12 / ACP 1', requiredVersion: '1.0.5',
      message: 'Could not connect Grok. Grok CLI 1.0.5 or newer is required.' })
    expect(brief).toMatch(/^Update Grok Build on forge to a version Sotto supports/u)
    expect(brief).toContain('`ssh -p 2222 zach@forge`')
    expect(brief).toContain('The host found Grok Build 0.9.12 / ACP 1, which is too old. Sotto needs 1.0.5 or later.')
    expect(brief).toContain('The host said: "Could not connect Grok. Grok CLI 1.0.5 or newer is required."')
    // Where #459's lookup searches, so the install lands where the host finds it.
    expect(brief).toContain('~/.grok/bin (Grok Build\'s own folder), then the host\'s PATH')
    expect(brief).toContain('mise\'s installs/grok/latest')
    expect(brief).toContain('npm install -g @xai-official/grok')
    expect(brief).toContain('Update it with the channel that installed it')
    expect(brief).toContain('Never sign in, sign out or change Grok Build\'s account')
    expect(brief).toMatch(/Never read, print, copy or move a key, a token, a password or a sign-in code/u)
    expect(brief).not.toMatch(/sk-|api[_ ]?key\b|Bearer|OPENROUTER/iu)
  })
  it('says what each case found, with each provider\'s own install method', () => {
    const install = hostProviderBrief({ host: 'forge', target: 'forge', provider: 'devin', case: 'install' })
    expect(install).toMatch(/^Install Devin on forge, where Sotto's host can find it and start it\./u)
    expect(install).toContain('The host did not find Devin anywhere it looks.')
    expect(install).toContain('curl -fsSL https://cli.devin.ai/install.sh | bash')
    expect(install).not.toContain('Update it with the channel')
    const fix = hostProviderBrief({ host: 'forge', target: 'forge', provider: 'codex', case: 'fix', version: '0.155.1' })
    expect(fix).toContain('Codex is installed on forge (0.155.1), but the host could not find it or start it.')
    expect(fix).toContain('The host starts only Codex\'s native binary')
    expect(fix).toContain(', then ~/.codex/bin.')
    expect(hostProviderBrief({ host: 'forge', target: 'forge', provider: 'claude', case: 'update', version: '1.0.3' }))
      .toContain('Sotto needs a newer version (its floor is a set of flags, not a version number).')
  })
})

describe('a provider job', () => {
  it('starts a thread named for the job in the Host setup project with the brief, and says so on the tile', async () => {
    const f = fixture()
    await f.jobs.command(start({ provider: 'grok' }))
    expect(f.threads.start).toHaveBeenCalledWith(expect.objectContaining({ title: 'Update Grok Build on forge', modelId: 'claude:opus', brief: expect.stringContaining('Sotto needs 1.0.5 or later.') }))
    expect(f.jobs.state()).toEqual({ id: JOB, hostId: FORGE, host: 'forge', provider: 'grok', case: 'update', threadId: 'host:local:thread-1', threadTitle: 'Update Grok Build on forge',
      modelName: 'Claude Opus 5.5', phase: 'running' })
    expect(f.jobs.threadId()).toBe('thread-1')
    expect(f.jobs.busySentence()).toBe('An agent is updating Grok Build on forge now. Stop it on its tile in Settings > Hosts first. Nothing was started.')
  })

  it('runs one at a time, beside a host setup too, and refuses a provider the host can already use', async () => {
    const f = fixture(() => 'An agent is setting up lab now. Stop that setup first. Nothing was started.')
    await expect(f.jobs.command(start())).rejects.toThrow('An agent is setting up lab now.')
    const g = fixture()
    await expect(g.jobs.command(start({ provider: 'codex' }))).rejects.toThrow("forge's host can already use Codex, so there is nothing for an agent to install, update or fix. Nothing was started.")
    await expect(g.jobs.command(start({ hostId: '99999999-9999-4999-8999-999999999999' }))).rejects.toThrow('This host is not connected. Nothing was started.')
    await g.jobs.command(start())
    await expect(g.jobs.command(start({ id: '88888888-8888-4888-8888-888888888888', provider: 'grok' }))).rejects.toThrow('An agent is installing Devin on forge now. Stop it first. Nothing was started.')
    expect(g.threads.start).toHaveBeenCalledTimes(1)
  })

  it('gives its tools to its own thread only, fixed to its host and provider, and ends when the host finds the provider', async () => {
    const f = fixture()
    await f.jobs.command(start())
    const handlers: HostSetupToolHandlers = agentJobTools({ admits: () => false, run: async () => ({ result: {} }) }, f.jobs)
    expect(handlers.tools!('thread-1')).toEqual(['provider_status', 'provider_check'])
    expect(handlers.tools!('thread-2')).toEqual([])
    // Another thread, and the host setup's own tools, reach nothing.
    expect(await f.jobs.run('thread-2', 'provider_check')).toMatchObject({ isError: true })
    expect(await handlers.run('thread-1', 'host_add')).toMatchObject({ result: {} })
    expect(f.hosts.refresh).not.toHaveBeenCalled()
    const reading = await f.jobs.run('thread-1', 'provider_status')
    expect(reading.result).toMatchObject({ host: 'forge', target: 'zach@forge', sshPort: 2222, provider: 'Devin', command: 'devin', job: 'install', found: false, problem: 'not-installed' })
    // Check again is the host's refresh for forge's Devin, and nothing else.
    const missing = await f.jobs.run('thread-1', 'provider_check')
    expect(missing).toMatchObject({ isError: true, result: { found: false, problem: 'not-installed' } })
    expect(f.hosts.refresh).toHaveBeenCalledWith(FORGE, 'devin')
    f.providers.set(`${FORGE}:devin`, status('devin', { problem: 'signed-out', version: '2026.9.1 / ACP 1' }))
    const found = await f.jobs.run('thread-1', 'provider_check')
    expect(found).toMatchObject({ result: { found: true } })
    expect(String(found.result.message)).toContain('Do not sign in yourself.')
    expect(f.hosts.refresh.mock.calls.every(([id, provider]) => id === FORGE && provider === 'devin')).toBe(true)
    expect(f.jobs.state()?.phase).toBe('found')
    expect(f.revoked).toEqual(['thread-1'])
    expect(await f.jobs.run('thread-1', 'provider_status')).toMatchObject({ isError: true })
  })

  it('ends when the host reports the provider found without the tool, and stops on Stop or when its thread is archived', async () => {
    const f = fixture()
    await f.jobs.command(start())
    f.providers.set(`${FORGE}:devin`, status('devin', { connection: 'connected', version: '2026.9.1' }))
    f.hostsChanged()
    expect(f.jobs.state()?.phase).toBe('found')
    const g = fixture()
    await g.jobs.command(start())
    await g.jobs.command({ type: 'stop-provider-job', id: JOB })
    expect(g.jobs.state()?.phase).toBe('stopped')
    expect(g.threads.interrupt).toHaveBeenCalledWith('thread-1')
    expect(g.revoked).toEqual(['thread-1'])
    const h = fixture()
    await h.jobs.command(start())
    h.archive()
    await vi.waitFor(() => expect(h.jobs.state()?.phase).toBe('stopped'))
    // Forgetting the host stops its job: there is no tile to follow it and nothing its tool may reach.
    const k = fixture()
    await k.jobs.command(start())
    k.hosts.host.mockReturnValue(undefined)
    k.hostsChanged()
    await vi.waitFor(() => expect(k.jobs.state()?.phase).toBe('stopped'))
    expect(k.revoked).toEqual(['thread-1'])
  })

  it('fixes a provider in an error the adapter could not name, as its tile reads it: can\'t be started', async () => {
    const f = fixture()
    f.providers.set(`${FORGE}:codex`, status('codex', { version: '0.155.1', error: 'Codex did not confirm the connection.' }))
    await f.jobs.command(start({ provider: 'codex' }))
    expect(f.jobs.state()).toMatchObject({ case: 'fix', threadTitle: 'Fix Codex on forge', phase: 'running' })
    expect(f.threads.start).toHaveBeenCalledWith(expect.objectContaining({ brief: expect.stringContaining('Codex is installed on forge (0.155.1), but the host could not find it or start it.') }))
    // Turned off and not signed in stay refused, as connected does.
    for (const patch of [{ connection: 'disconnected' as const }, { problem: 'signed-out' as const }]) {
      const g = fixture()
      g.providers.set(`${FORGE}:codex`, status('codex', patch))
      await expect(g.jobs.command(start({ provider: 'codex' }))).rejects.toThrow("forge's host can already use Codex")
    }
  })

  it('interrupts its thread when Stop lands before the brief was sent', async () => {
    const f = fixture()
    const events: string[] = []
    let release: () => void = () => undefined
    f.threads.start.mockImplementationOnce(async request => {
      request.created('thread-1')
      const pending1 = deferred<void>();
      release = pending1.resolve;
      await pending1.promise
      events.push('send')
    })
    f.threads.interrupt.mockImplementation(async () => { events.push('interrupt') })
    const starting = f.jobs.command(start())
    await vi.waitFor(() => expect(f.jobs.state()?.threadId).toBe('host:local:thread-1'))
    await f.jobs.command({ type: 'stop-provider-job', id: JOB })
    release()
    await starting
    expect(events.slice(events.indexOf('send'))).toContain('interrupt')
    expect(f.jobs.state()?.phase).toBe('stopped')
    expect(f.revoked).toContain('thread-1')
    expect(await f.jobs.run('thread-1', 'provider_status')).toMatchObject({ isError: true })
  })

  it('tells a thread whose job was stopped during a check that it was stopped, even when the host then finds the provider', async () => {
    const f = fixture()
    await f.jobs.command(start())
    let answer: () => void = () => undefined
    f.hosts.refresh.mockImplementationOnce(async (id: string, provider: ProviderId) => {
      const pending2 = deferred<void>();
      answer = pending2.resolve;
      await pending2.promise
      return { status: f.providers.get(`${id}:${provider}`) }
    })
    const checking = f.jobs.run('thread-1', 'provider_check')
    await vi.waitFor(() => expect(f.hosts.refresh).toHaveBeenCalled())
    await f.jobs.command({ type: 'stop-provider-job', id: JOB })
    f.providers.set(`${FORGE}:devin`, status('devin', { problem: 'signed-out', version: '2026.9.1' }))
    answer()
    expect(await checking).toMatchObject({ isError: true, result: { found: false, message: 'This job was stopped. Nothing more was checked.' } })
    expect(f.jobs.state()?.phase).toBe('stopped')
  })

  it('gives back the tile when no thread was made, and keeps a thread that did not take its brief to look at', async () => {
    const f = fixture()
    f.threads.start.mockImplementationOnce(async () => { throw new Error('Connect Claude Code before creating a project.') })
    await expect(f.jobs.command(start())).rejects.toThrow('Connect Claude Code before creating a project. Nothing was started.')
    expect(f.jobs.state()).toBeUndefined()
    f.threads.start.mockImplementationOnce(async request => { request.created('thread-9'); throw new Error('The provider rejected thread creation.') })
    await f.jobs.command(start())
    expect(f.jobs.state()).toMatchObject({ phase: 'failed', error: 'The thread Install Devin on forge did not start working. The provider rejected thread creation. Nothing was changed on forge.' })
  })
})

describe('the tool server for both jobs', () => {
  it('lists each thread only its own job\'s tools and refuses arguments that name another host or provider', async () => {
    const f = fixture()
    await f.jobs.command(start())
    const server = new HostSetupToolServer(agentJobTools({ admits: () => false, run: async () => ({ result: {} }) }, f.jobs))
    try {
      expect(server.definitions.map(tool => tool.name)).toEqual(['host_status', 'host_check', 'host_add', 'provider_status', 'provider_check'])
      const endpoint = (await server.mcpServer('thread-1'))!
      expect(endpoint).toMatchObject({ name: HOST_SETUP_MCP_SERVER })
      expect(await server.mcpServer('thread-2')).toBeUndefined()
      const post = (body: unknown) => fetch(endpoint.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: endpoint.headers[0]!.value }, body: JSON.stringify(body) })
      expect(await (await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()).toMatchObject({ result: { tools: providerJobToolDefinitions } })
      const call = async (name: string, args: unknown) => JSON.parse(((await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })).json()) as { result: { content: { text: string }[] } }).result.content[0]!.text) as Record<string, unknown>
      expect(await call('provider_check', { host: 'lab' })).toMatchObject({ message: 'This tool takes no arguments. The host and the provider are fixed when the job starts.' })
      expect(await call('provider_check', { provider: 'grok' })).toMatchObject({ message: expect.stringContaining('takes no arguments') })
      expect(await call('host_add', {})).toMatchObject({ message: "This tool is not part of this thread's job. Nothing was checked, changed or added." })
      expect(f.hosts.refresh).not.toHaveBeenCalled()
      expect(await call('provider_check', {})).toMatchObject({ found: false })
      expect(f.hosts.refresh.mock.calls).toEqual([[FORGE, 'devin']])
    } finally { await server.close() }
  })
})
