// @vitest-environment node
/**
 * Babysitting through the whole local stack on each fake provider (ADR-0061, #824): the runtime both the desktop and a
 * headless host run, the provider adapter, Sotto's thread IDs and the pull request tool server wired as the desktop
 * wires it. The agent calls `babysit_pull_request` on the endpoint its provider was given at launch, a scripted gh
 * reports a check failing, and the thread is woken with exactly one message, marked as Sotto's. Then Stop, settling and
 * the switch each end or refuse babysitting as decided.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/shared/settings'
import type { AgentCommand, AgentState, ProviderId } from '../../src/shared/agents'
import { createAgentRuntime } from '../../src/main/agents/runtime'
import { AgentCredentials } from '../../src/main/agents/credentials'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { BABYSITTING_SWITCHED_OFF, PULL_REQUEST_MCP_SERVER, PullRequestToolServer } from '../../src/main/agents/pullRequestTools'
import type { ThreadMcpServer } from '../../src/main/agents/threadToolServer'
import { codexFixture, type RecordedRpc } from '../fixtures/codexFixture'
import { claudeFixture } from '../fixtures/claudeFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'
import { scriptedGitHub, type ScriptedPull } from '../fixtures/babysitGitHub'
import type { McpReply } from '../fixtures/visualToolCall'
import type { AdapterFixture } from './adapterContract'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

const pullUrl = (number: number) => `https://github.com/o/r/pull/${number}`

/** The endpoint the provider was given for Sotto's pull request tools, read from what the adapter sent it at launch. */
async function given(provider: ProviderId, records: readonly RecordedRpc[]): Promise<Pick<ThreadMcpServer, 'url' | 'headers'>> {
  if (provider === 'codex') {
    const start = records.find(record => record.method === 'thread/start')?.params as { config: { mcp_servers: Record<string, { url: string; http_headers: Record<string, string>; default_tools_approval_mode: string }> } }
    const entry = start.config.mcp_servers[PULL_REQUEST_MCP_SERVER]!
    // Codex is told to approve Sotto's own server's calls, so the provider's own prompt is suppressed (decision 4).
    expect(entry.default_tools_approval_mode).toBe('approve')
    return { url: entry.url, headers: Object.entries(entry.http_headers).map(([name, value]) => ({ name, value })) }
  }
  if (provider === 'claude') {
    const launch = records.findLast(record => ['launch', 'resume'].includes(record.method ?? '') && (record.params?.frame as { args: string[] }).args.includes('--mcp-config'))
    const args = (launch!.params!.frame as { args: string[] }).args
    // Claude Code is told each of the server's tools is allowed, so it does not ask (decision 4).
    for (const tool of ['babysit_pull_request', 'stop_babysitting', 'list_babysitting']) expect(args).toContain(`mcp__${PULL_REQUEST_MCP_SERVER}__${tool}`)
    const config = JSON.parse(await readFile(args[args.indexOf('--mcp-config') + 1]!, 'utf8')) as { mcpServers: Record<string, { url: string; headers: Record<string, string> }> }
    const entry = config.mcpServers[PULL_REQUEST_MCP_SERVER]!
    return { url: entry.url, headers: Object.entries(entry.headers).map(([name, value]) => ({ name, value })) }
  }
  const servers = records.filter(record => ['session/new', 'session/load'].includes(record.method ?? '')).map(record => record.params?.mcpServers as { name: string; url: string; headers: { name: string; value: string }[] }[]).find(value => value?.length)!
  return servers.find(server => server.name === PULL_REQUEST_MCP_SERVER)!
}

/** Calls one of Sotto's pull request tools the way a provider does: a JSON-RPC `tools/call` to the endpoint it was given. */
async function call(server: Pick<ThreadMcpServer, 'url' | 'headers'>, name: string, args: unknown = {}): Promise<McpReply['result']> {
  const response = await fetch(server.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...Object.fromEntries(server.headers.map(header => [header.name, header.value])) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
  return (await response.json() as McpReply).result
}

/** The runtime over one fake provider, with the tool server wired as `src/main/index.ts` wires it and a scripted GitHub. */
async function stack(provider: 'codex' | 'claude' | 'grok', fixture: AdapterFixture, pulls: ScriptedPull[]) {
  const github = scriptedGitHub(pulls)
  let settings: AppSettings = { ...DEFAULT_SETTINGS }
  const credentials = new AgentCredentials(join(fixture.root, 'vault'), { isEncryptionAvailable: () => false, encryptString: value => Buffer.from(value), decryptString: value => value.toString() })
  await credentials.load()
  const directory = join(fixture.root, 'sotto')
  await mkdir(directory, { recursive: true })
  const runtime = await createAgentRuntime({
    directory, credentials, settings: () => settings, writingSettings: async () => settings,
    historyEnabled: () => true, openExternal: async () => undefined, reasoner: e2eAgentReasoner,
    providers: { codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost(), [provider]: fixture.host },
    gitStatus: { fetchIntervalMs: () => 3_600_000, foreground: () => false },
    babysitting: { agentTool: () => settings.babysitPullRequests, run: github.run },
  })
  const tools = new PullRequestToolServer({ enabled: () => settings.babysitPullRequests, host: runtime.agentHost, babysitter: runtime.babysitter })
  runtime.agentHost.useThreadTools([tools])
  cleanup.push(async () => { await tools.close(); await runtime.close().catch(() => undefined) })
  // Link pull request reads the pull request through gh first; here the scripted GitHub answers for it.
  runtime.agentHost.setGitPullRequests({ view: async (_cwd: string, reference: string) => {
    const number = Number(/(\d+)$/u.exec(reference)?.[1])
    return { number, url: pullUrl(number), title: `Pull ${number}`, body: '', state: 'open', draft: false }
  } } as never)
  const client = desktopWindowClient('babysit-test')
  const command = async (value: AgentCommand): Promise<AgentState> => runtime.hostService.command(value, client)
  await command({ type: 'configure', patch: { provider, enabledProviders: [provider] } })
  await command({ type: 'connect', provider })
  const folder = join(fixture.root, 'project')
  await mkdir(folder, { recursive: true })
  const project = (await command({ type: 'create-project', provider, title: 'Project', path: folder, useExisting: true })).host.projects.find(item => item.path === folder)!
  const modelId = runtime.agentControl.get().host.models.find(model => model.providerId === provider)!.id
  const threadId = randomUUID()
  expect((await command({ type: 'create-thread', threadId, projectId: project.id, title: 'Babysat', modelId, workingCopy: 'shared', managed: false })).error).toBeNull()
  await command({ type: 'observe-threads', threadIds: [threadId] })
  const thread = () => runtime.agentControl.get().host.threads.find(item => item.id === threadId)!
  const sessionId = () => runtime.threadRegistry!.byThread(threadId)!.sessionId
  return { runtime, tools, github, command, threadId, thread, sessionId, setSettings: (patch: Partial<AppSettings>) => { settings = { ...settings, ...patch } } }
}
type Stack = Awaited<ReturnType<typeof stack>>

/** A first prompt and its reply, which launches the provider session with Sotto's tool servers. */
async function firstTurn(s: Stack, fixture: AdapterFixture): Promise<void> {
  expect((await s.command({ type: 'manual-send', threadId: s.threadId, text: 'Open the pull request and get it green.' })).error).toBeNull()
  await expect.poll(() => s.thread().messages.some(message => message.role === 'user'), { timeout: 20_000 }).toBe(true)
  await fixture.driver.completeTurn(s.sessionId(), 'Opened pull request #7.')
  await expect.poll(() => s.thread().status === 'idle' && s.thread().messages.some(message => message.text === 'Opened pull request #7.'), { timeout: 20_000 }).toBe(true)
}

const factories: ['codex' | 'claude' | 'grok', () => Promise<AdapterFixture>][] = [['codex', codexFixture], ['claude', claudeFixture], ['grok', grokFixture]]
describe.each(factories)('%s babysitting a pull request', (provider, factory) => {
  it('starts with the agent\'s tool call, linking the pull request first, and wakes the thread with one message when a check fails', async () => {
    const fixture = await factory(); cleanup.push(fixture.cleanup)
    const pull: ScriptedPull = { number: 7, checks: [{ name: 'build', state: 'IN_PROGRESS' }] }
    const s = await stack(provider, fixture, [pull])
    await firstTurn(s, fixture)
    const endpoint = await given(provider, await fixture.driver.requests())

    const started = await call(endpoint, 'babysit_pull_request', { pull_request: '#7' })
    expect(started.isError).toBeUndefined()
    expect(started.content[0]!.text).toContain('Sotto is babysitting pull request #7 for this thread.')
    expect(s.thread().pullRequests?.map(link => link.url)).toEqual([pullUrl(7)])
    expect(s.thread().babysitting).toEqual([expect.objectContaining({ url: pullUrl(7), number: 7, startedBy: 'agent' })])
    expect((await call(endpoint, 'list_babysitting')).content[0]!.text).toContain(`#7 ${pullUrl(7)}: you started it`)

    // The first look: the check is still running, which is no news.
    await s.runtime.babysitter!.pass()
    expect(s.thread().messages.filter(message => message.role === 'user')).toHaveLength(1)
    pull.checks = [{ name: 'build', state: 'FAILURE', url: 'https://github.com/o/r/actions/runs/1' }]
    await s.runtime.babysitter!.pass()
    await expect.poll(() => s.thread().messages.filter(message => message.wakeUp).length, { timeout: 20_000 }).toBe(1)
    const wakeUp = s.thread().messages.find(message => message.wakeUp)!
    expect(wakeUp.role).toBe('user')
    expect(wakeUp.text).toContain('Pull request #7 "Pull 7": https://github.com/o/r/pull/7')
    expect(wakeUp.text).toContain('- Check build failed: https://github.com/o/r/actions/runs/1')
    expect(wakeUp.text).toContain('call stop_babysitting')
    expect(s.thread().wakeUpMessageIds).toEqual([wakeUp.id])
    await fixture.driver.completeTurn(s.sessionId(), 'Fixed the build.')
    await expect.poll(async () => (await s.runtime.turns.recent(10)).some(record => record.source === 'wake-up' && record.threadId === s.threadId), { timeout: 20_000 }).toBe(true)

    // The same failure on the same head is told once: another pass sends nothing more.
    await s.runtime.babysitter!.pass()
    expect(s.thread().messages.filter(message => message.role === 'user')).toHaveLength(2)
    expect(s.runtime.agentControl.get().followups).toEqual([])
  })
})

describe('ending babysitting', () => {
  it('stops on the agent\'s Stop and sends nothing after it', async () => {
    const fixture = await codexFixture(); cleanup.push(fixture.cleanup)
    const pull: ScriptedPull = { number: 7 }
    const s = await stack('codex', fixture, [pull])
    await firstTurn(s, fixture)
    const endpoint = await given('codex', await fixture.driver.requests())
    await call(endpoint, 'babysit_pull_request', { pull_request: pullUrl(7) })
    const stopped = await call(endpoint, 'stop_babysitting', { pull_request: '7' })
    expect(stopped.content[0]!.text).toBe('Sotto stopped babysitting pull request #7. It sends no more wake-ups about it.')
    expect(s.thread().babysitting).toBeUndefined()
    pull.checks = [{ name: 'build', state: 'FAILURE' }]
    await s.runtime.babysitter!.pass()
    expect(s.github.questions).toHaveLength(0)
    expect(s.thread().messages.filter(message => message.role === 'user')).toHaveLength(1)
  })

  it('ends at once and quietly when the thread is settled, taking back a wake-up still waiting', async () => {
    const fixture = await codexFixture(); cleanup.push(fixture.cleanup)
    const pull: ScriptedPull = { number: 7 }
    const s = await stack('codex', fixture, [pull])
    await firstTurn(s, fixture)
    const endpoint = await given('codex', await fixture.driver.requests())
    await call(endpoint, 'babysit_pull_request', { pull_request: '#7' })
    // A turn is running, so the news waits in the queue as Sotto's own item.
    expect((await s.command({ type: 'manual-send', threadId: s.threadId, text: 'Keep going.' })).error).toBeNull()
    await expect.poll(() => s.thread().status, { timeout: 20_000 }).toBe('running')
    pull.checks = [{ name: 'build', state: 'FAILURE' }]
    await s.runtime.babysitter!.pass()
    expect(s.runtime.agentControl.get().followups).toEqual([expect.objectContaining({ wakeUp: true, threadId: s.threadId })])

    expect((await s.command({ type: 'settle-thread', threadId: s.threadId })).error).toBeNull()
    await expect.poll(() => s.thread().babysitting).toBeUndefined()
    await expect.poll(() => s.runtime.agentControl.get().followups).toEqual([])
    await fixture.driver.completeTurn(s.sessionId(), 'Done for now.')
    await s.command({ type: 'restore-thread', threadId: s.threadId })
    await expect.poll(() => s.thread().status, { timeout: 20_000 }).toBe('idle')
    await s.runtime.babysitter!.pass()
    expect(s.thread().messages.filter(message => message.role === 'user').map(message => message.wakeUp ?? false)).toEqual([false, false])
    // Settling a thread refuses a new start until it is restored; restored, it can be babysat again.
    expect((await s.command({ type: 'settle-thread', threadId: s.threadId })).error).toBeNull()
    expect((await call(endpoint, 'babysit_pull_request', { pull_request: '#7' })).content[0]!.text).toBe('This thread is settled or archived. Restore it to babysit its pull request. Nothing was started.')
  })

  it('turned off, ends what agents started, keeps what the user started, refuses the agent\'s call and offers new launches nothing', async () => {
    const fixture = await codexFixture(); cleanup.push(fixture.cleanup)
    const s = await stack('codex', fixture, [{ number: 7 }, { number: 8 }])
    await firstTurn(s, fixture)
    const endpoint = await given('codex', await fixture.driver.requests())
    await call(endpoint, 'babysit_pull_request', { pull_request: '#7' })
    await s.command({ type: 'git-link-pull-request', threadId: s.threadId, reference: '#8' })
    expect((await s.command({ type: 'babysit-pull-request', threadId: s.threadId, url: pullUrl(8) })).notice).toBe('Babysitting PR #8.')
    expect(s.thread().babysitting?.map(item => [item.number, item.startedBy])).toEqual([[7, 'agent'], [8, 'user']])

    s.setSettings({ babysitPullRequests: false })
    await expect(s.tools.settingChanged()).resolves.toBe(1)
    expect(s.thread().babysitting?.map(item => [item.number, item.startedBy])).toEqual([[8, 'user']])
    const refused = await call(endpoint, 'babysit_pull_request', { pull_request: '#7' })
    expect(refused).toMatchObject({ isError: true, content: [{ text: BABYSITTING_SWITCHED_OFF }] })
    expect(s.thread().babysitting).toHaveLength(1)
    await expect(s.tools.mcpServer(s.threadId)).resolves.toBeUndefined()
    // The user's own control stays.
    expect((await s.command({ type: 'stop-babysitting', threadId: s.threadId, url: pullUrl(8) })).notice).toBe('Stopped babysitting PR #8.')
    expect(s.thread().babysitting).toBeUndefined()
  })
})
