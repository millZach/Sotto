// @vitest-environment node
import { testCredentials } from '../fixtures/testCredentials'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { startFixtureHeadlessHost as startHeadlessHost, desktopHostStack } from '../fixtures/desktopHostStack'
import { HostCredentialEncryption } from '../../src/host/credentials'

import { e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { ensureFixtureDesktopAnswers } from '../fixtures/sshDesktopAnswers'

import { HostProviderJobs } from '../../src/main/hosts/hostProviderJob'
import type { HostSetupThreads } from '../../src/main/hosts/hostSetup'
import { agentJobTools, HostSetupToolServer } from '../../src/main/hosts/hostSetupTools'

import { SshHostLauncher, type SshCallbacks, type SshHostConfiguration, type SshHostConnection } from '../../src/main/hosts/sshLauncher'
import type { ThreadMcpServer } from '../../src/main/agents/threadToolServer'
import { signInProviders } from '../fixtures/signInProviders'

// A provider job over a real headless host (ADR-0035, amended for #461): the host's fake Devin is not installed until
// an agent's install would put it where the host looks (`devin.installed`). The job's tool reads that host's Devin,
// runs Check again (the host's refresh for Devin) and ends when the host finds Devin; the tool reaches no other host or
// provider, and nothing on the host is signed in by it.
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
type McpReply = { result: { content: { type: string; text: string }[]; isError?: boolean } }
async function callTool(server: Pick<ThreadMcpServer, 'url' | 'headers'>, name: string, args: unknown = {}): Promise<{ status: number; body?: McpReply }> {
  const response = await fetch(server.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...Object.fromEntries(server.headers.map(header => [header.name, header.value])) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
  return response.status === 200 ? { status: 200, body: await response.json() as McpReply } : { status: response.status }
}
const parsed = (reply: { body?: McpReply }): Record<string, unknown> => JSON.parse(reply.body!.result.content[0]!.text) as Record<string, unknown>

/** SSH that reaches the headless host running in this process, as the launch script would have started it. */
class LocalSsh extends SshHostLauncher {
  constructor(private readonly remote: Awaited<ReturnType<typeof startHeadlessHost>>, private readonly dataDirectory: string) { super() }
  override async connect(_configuration: SshHostConfiguration, callbacks: SshCallbacks = {}): Promise<SshHostConnection> {
    callbacks.onStep?.('sign-in'); callbacks.onStep?.('install'); callbacks.onStep?.('start')
    const hostId = this.remote.descriptor!.hostId
    return { url: 'http://127.0.0.1:' + this.remote.descriptor!.port, hostId, owned: true, route: { hostname: 'forge', identityFiles: [] }, close: async () => undefined,
      showHostPairingCode: async () => ({ ...this.remote.pairing.issuePairingCode(), hostId }), ensureDesktopAnswers: clientId => ensureFixtureDesktopAnswers(this.dataDirectory, hostId, clientId), revokeClient: async () => true, hostAdminToken: async () => { throw new Error("Nothing here administers phone access.") }, stopHost: async () => true, updateHost: async () => { throw new Error('Nothing here updates a host.') }, boot: async () => { throw new Error('Nothing here starts a host at boot.') } }
  }
  override async disconnect(): Promise<void> { /* nothing to close */ }
}

it('reads the host\'s provider, checks it again and ends the job once the host finds it, on that host and provider alone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-provider-job-'))
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const marks = join(root, 'marks')
  await mkdir(marks, { recursive: true })
  // forge as on September 28: Codex signed in, Claude Code and Grok Build signed out, Devin not installed.
  await writeFile(join(marks, 'codex.signed-in'), '')
  const remote = await startHeadlessHost({ dataDirectory: join(root, 'remote'), port: 0, providers: signInProviders(marks), reasoner: e2eAgentReasoner })
  cleanup.push(() => remote.close())
  const credentials = await testCredentials(join(root, 'desktop'), { encryption: new HostCredentialEncryption('synthetic-desktop-credential-key') });
  const { router, manager: hosts } = desktopHostStack({ directory: join(root, 'desktop'), credentials, localHostRunning: true, localHostEnabled: () => true, restart: () => undefined,
    launcher: () => new LocalSsh(remote, join(root, 'remote')) })
  cleanup.push(async () => router.dispose())
  await hosts.start(); cleanup.push(() => hosts.close())
  const forge = randomUUID()
  await hosts.command({ type: 'add', host: { id: forge, name: 'forge', target: 'zach@forge', identityFile: '', installPath: '/opt/sotto', dataDirectory: '/data/sotto' } })
  await vi.waitFor(() => expect(hosts.providerStatus(forge, 'devin')).toMatchObject({ connection: 'error', problem: 'not-installed' }), { timeout: 30_000 })
  await vi.waitFor(() => expect(hosts.providerStatus(forge, 'codex')?.connection).toBe('connected'), { timeout: 30_000 })

  const briefs: string[] = []
  const threads: HostSetupThreads = {
    choice: () => ({ models: [{ id: 'claude:opus', name: 'Claude Opus 5.5', provider: 'Claude Code' }], modelId: 'claude:opus' }),
    start: async request => { briefs.push(request.brief); request.created('job-thread') }, interrupt: async () => undefined,
    thread: () => ({ requestIds: [], archived: false }), windowId: id => `host:local:${id}`, subscribe: () => () => undefined,
  }
  const refreshes: [string, string][] = []
  const jobs = new HostProviderJobs({ threads, hosts: { host: id => hosts.jobHost(id), provider: (id, provider) => hosts.providerStatus(id, provider),
    refresh: (id, provider) => { refreshes.push([id, provider]); return hosts.refreshProvider(id, provider) },
    subscribe: listener => { const off = [router.subscribe(() => listener()), hosts.subscribe(() => listener())]; return () => { for (const item of off) item() } } } })
  cleanup.push(async () => jobs.close())
  const server = new HostSetupToolServer(agentJobTools({ admits: () => false, run: async () => ({ isError: true, result: {} }) }, jobs)); cleanup.push(() => server.close())
  jobs.useTools(threadId => server.revoke(threadId))
  hosts.useProviderJob(jobs)

  // Have my agent install it on Devin's tile: the brief names the host, Devin, the case, where the host looks and the install.
  const jobId = randomUUID()
  await hosts.command({ type: 'start-provider-job', id: jobId, hostId: forge, provider: 'devin', modelId: 'claude:opus' })
  expect(hosts.get().providerJob).toMatchObject({ id: jobId, hostId: forge, host: 'forge', provider: 'devin', case: 'install', threadTitle: 'Install Devin on forge', phase: 'running' })
  expect(briefs[0]).toMatch(/^Install Devin on forge, where Sotto's host can find it and start it\./u)
  expect(briefs[0]).toContain('`ssh zach@forge`')
  expect(briefs[0]).toContain('The host did not find Devin anywhere it looks.')
  expect(briefs[0]).toContain('~/.local/bin')
  expect(briefs[0]).toContain('https://cli.devin.ai/install.sh')
  expect(briefs[0]).not.toMatch(/synthetic-desktop-credential-key|remote-host:|Bearer/u)

  expect(await server.mcpServer('another-thread')).toBeUndefined()
  const endpoint = (await server.mcpServer('job-thread'))!
  expect(parsed(await callTool(endpoint, 'provider_status'))).toMatchObject({ host: 'forge', provider: 'Devin', job: 'install', found: false, problem: 'not-installed', hostConnected: true })
  // No argument can point it at another provider, and the host setup's tools are not this thread's.
  expect((await callTool(endpoint, 'provider_check', { provider: 'grok' })).body!.result.isError).toBe(true)
  expect((await callTool(endpoint, 'host_check')).body!.result.isError).toBe(true)
  expect(refreshes).toEqual([])

  // Check again before the install: the host looked again for Devin and still did not find it.
  const before = await callTool(endpoint, 'provider_check')
  expect(before.body!.result.isError).toBe(true)
  expect(parsed(before)).toMatchObject({ found: false, problem: 'not-installed' })
  expect(jobs.state()?.phase).toBe('running')

  // The agent installs Devin where the host looks; the next check finds it, and the job ends there, before any sign-in.
  await writeFile(join(marks, 'devin.installed'), '')
  const after = await callTool(endpoint, 'provider_check')
  expect(parsed(after)).toMatchObject({ found: true })
  expect(hosts.get().providerJob).toMatchObject({ phase: 'found' })
  expect(hosts.providerStatus(forge, 'devin')).toMatchObject({ connection: 'error', problem: 'signed-out' })
  // Only forge's Devin was checked: Codex is still connected, and Grok Build and Claude Code are still signed out.
  expect(refreshes).toEqual([[forge, 'devin'], [forge, 'devin']])
  expect(hosts.providerStatus(forge, 'codex')?.connection).toBe('connected')
  expect(hosts.providerStatus(forge, 'grok')).toMatchObject({ problem: 'signed-out' })
  expect(hosts.providerStatus(forge, 'claude')).toMatchObject({ problem: 'signed-out' })
  // The job is over, so its tool is gone.
  expect((await callTool(endpoint, 'provider_status')).status).toBe(401)
})
