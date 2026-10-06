// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserAgentServer, type BrowserAgentTools } from '../../src/main/agents/browserAgentServer'
import { browserToolDefinitions } from '../../src/main/tools/browserAgentTools'
import { SottoThreadHost, ThreadRegistry } from '../../src/main/agents/threads'
import { codexFixture } from '../fixtures/codexFixture'
import { claudeFixture } from '../fixtures/claudeFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'
import { devinFixture } from '../fixtures/devinFixture'
import type { AdapterFixture } from './adapterContract'
import type { ProviderId } from '../../src/shared/agents'
import { VISUAL_MCP_SERVER, VisualToolServer, type VisualToolHandlers } from '../../src/main/agents/visualTools'
import type { ThreadMcpServer } from '../../src/main/agents/threadToolServer'
import type { PersonalCreateCommand } from '../../src/main/agents/personalConversation'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const factories: [ProviderId, () => Promise<AdapterFixture>][] = [['codex', codexFixture], ['claude', claudeFixture], ['grok', grokFixture], ['devin', devinFixture]]
describe.each(factories)('%s shared browser transport', (provider, factory) => {
  it('injects browser tools into the native thread and binds admission to the Sotto ID', async () => {
    const fixture = await factory(); cleanup.push(fixture.cleanup)
    const server = new BrowserAgentServer(browserToolDefinitions, async () => ({ content: [] })); cleanup.push(() => server.close())
    const mcpServer = vi.fn(server.mcpServer.bind(server))
    const tools: BrowserAgentTools = { definitions: browserToolDefinitions, call: server.call.bind(server), mcpServer }
    const registry = new ThreadRegistry(fixture.root)
    const host = new SottoThreadHost(provider, fixture.host, registry)
    host.useBrowserTools(tools)
    await host.connect()
    await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: fixture.projectId, title: 'Project', path: fixture.root })
    const threadId = randomUUID()
    expect(await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: fixture.projectId, title: 'Browser check', modelId: fixture.modelId })).toMatchObject({ accepted: true })
    if (provider === 'devin') {
      // The pinned native client ignores ACP-supplied MCP servers. Never mint credentials
      // or relax its native integration policy based only on a passing fixture.
      expect(mcpServer).not.toHaveBeenCalled()
      const sessions = (await fixture.driver.requests()).filter(record => record.method === 'session/new')
      expect(sessions.length).toBeGreaterThan(0)
      expect(sessions.every(record => JSON.stringify(record.params?.mcpServers) === '[]')).toBe(true)
      await registry.flush()
      return
    }
    expect(mcpServer).toHaveBeenCalledWith(threadId)
    const endpoint = await server.mcpServer(threadId)
    const records = await fixture.driver.requests()
    let claudeConfig: string | undefined
    if (provider === 'codex') {
      // The browser's own tools carry no native prompt; page actions are Tools' to decide (ADR-0029).
      expect(records.find(record => record.method === 'thread/start')?.params).toMatchObject({ config: { mcp_servers: { sotto_browser: { url: endpoint.url, default_tools_approval_mode: 'approve', http_headers: { Authorization: endpoint.headers[0]!.value } } } } })
    } else if (provider === 'claude') {
      const launch = records.find(record => record.method === 'launch' && (record.params?.frame as { args: string[] }).args.includes('--mcp-config'))
      const args = (launch?.params?.frame as { args: string[] }).args
      claudeConfig = args[args.indexOf('--mcp-config') + 1]!
      expect(dirname(claudeConfig)).toBe(fixture.root)
      expect(JSON.parse(await readFile(claudeConfig, 'utf8'))).toMatchObject({ mcpServers: { sotto_browser: { url: endpoint.url, headers: { Authorization: endpoint.headers[0]!.value } } } })
      if (process.platform !== 'win32') expect((await stat(claudeConfig)).mode & 0o777).toBe(0o600)
      // The browser's own tools carry no native prompt; page actions are Tools' to decide (ADR-0029).
      const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--print'))
      expect(allowed).toEqual(browserToolDefinitions.map(tool => `mcp__sotto_browser__${tool.name}`))
    } else {
      const servers = records.filter(record => record.method === 'session/new').map(record => record.params?.mcpServers).find(value => Array.isArray(value) && value.length) as unknown[]
      expect(servers).toHaveLength(1)
      expect(servers[0]).toMatchObject({ name: 'sotto_browser', type: 'http', url: endpoint.url })
    }
    const alias = registry.byThread(threadId)!
    expect(alias.sessionId).not.toBe(threadId)
    await registry.flush()
    const callsBeforeReconnect = mcpServer.mock.calls.length
    host.disconnect(); server.revoke(threadId)
    host.observeThreads([threadId])
    await host.connect()
    if (claudeConfig) await expect(stat(claudeConfig)).rejects.toMatchObject({ code: 'ENOENT' })
    await host.refreshThread(threadId)
    expect(mcpServer.mock.calls.length).toBeGreaterThan(callsBeforeReconnect)
    const renewed = await server.mcpServer(threadId)
    expect(renewed.headers).not.toEqual(endpoint.headers)
    const nextRecords = await fixture.driver.requests()
    if (provider === 'claude') {
      const launch = nextRecords.slice(records.length).find(record => ['launch', 'resume'].includes(record.method ?? '') && (record.params?.frame as { args: string[] }).args.includes('--mcp-config'))!
      const args = (launch.params!.frame as { args: string[] }).args
      const path = args[args.indexOf('--mcp-config') + 1]!
      expect(path).not.toBe(claudeConfig)
      expect(await readFile(path, 'utf8')).toContain(renewed.headers[0]!.value)
      host.disconnect(); await (fixture as Awaited<ReturnType<typeof claudeFixture>>).adapter.closed()
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    } else expect(JSON.stringify(nextRecords.slice(records.length))).toContain(renewed.headers[0]!.value)
  })
})

// Grok's leader ignores `--allow` rules, so its prompt for Sotto's own browser server is answered by the
// adapter (ADR-0020). Only that one: the same tool name on any other server still reaches the user.
describe('grok browser admission', () => {
  const setUp = async () => {
    const fixture = await grokFixture(); cleanup.push(fixture.cleanup)
    const server = new BrowserAgentServer(browserToolDefinitions, async () => ({ content: [] })); cleanup.push(() => server.close())
    fixture.host.useBrowserTools(server)
    await fixture.host.connect()
    await fixture.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: fixture.projectId, title: 'Project', path: fixture.root })
    const threadId = randomUUID()
    await fixture.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: fixture.projectId, title: 'Browser admission', modelId: fixture.modelId })
    fixture.host.observeThreads?.([threadId])
    await fixture.host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: 'browser-admission', text: 'Synthetic prompt' })
    const thread = async () => (await fixture.host.snapshot()).threads.find(thread => thread.id === threadId)!
    const decisions = async () => (await fixture.driver.requests()).map(record => fixture.protocol!.permissionDecision(record)).filter(decision => decision !== undefined)
    return { fixture, threadId, thread, decisions }
  }

  it('answers Grok\'s prompt for this thread\'s own browser tool once, without showing it', async () => {
    const { fixture, threadId, thread, decisions } = await setUp()
    await fixture.action(threadId, { type: 'permission', text: 'use_tool', rawInput: { tool_name: 'sotto_browser__browser_status', tool_input: {} } })
    await expect.poll(decisions).toEqual([true])
    expect((await thread()).requests).toEqual([])
  })

  it('shows the user a prompt for the same tool name on another server', async () => {
    const { fixture, threadId, thread, decisions } = await setUp()
    await fixture.action(threadId, { type: 'permission', text: 'use_tool', rawInput: { tool_name: 'other_server__browser_status', tool_input: {} } })
    await expect.poll(async () => (await thread()).requests.length).toBe(1)
    expect(await decisions()).toEqual([])
  })
})

// The visual tool (ADR-0055) rides the same list as the host setup tools: each provider that takes Sotto's tools is given
// `sotto_visual` beside the browser on a project thread, with no native prompt, while the switch is on. Devin's client
// ignores supplied servers and a personal chat is given none, and a switch turned off gives new launches nothing.
type McpReply = { result: { content: { type: string; text: string }[]; isError?: boolean } }
async function callVisualize(server: Pick<ThreadMcpServer, 'url' | 'headers'>, args: unknown): Promise<McpReply['result']> {
  const response = await fetch(server.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...Object.fromEntries(server.headers.map(header => [header.name, header.value])) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'visualize', arguments: args } }) })
  return (await response.json() as McpReply).result
}
const DIAGRAM = { title: 'How a send moves', kind: 'diagram', source: 'flowchart LR\n  A[Draft] --> B[Sent]', steps: [{ text: 'A draft is sent.', highlight: ['A->B'] }] }

describe.each(factories)('%s visual tool', (provider, factory) => {
  it('is offered on a project thread with no native prompt, reaches the tool as the Sotto thread, and goes when the switch is off', async () => {
    const fixture = await factory(); cleanup.push(fixture.cleanup)
    let enabled = true
    const add = vi.fn<VisualToolHandlers['add']>(async (_threadId, input) => ({ added: true, visual: { id: 'v1', title: input.title, kind: input.kind, source: input.source, ...(input.steps ? { steps: input.steps } : {}) }, anchor: 'assistant' }))
    const visuals = new VisualToolServer({ enabled: () => enabled, admits: () => true, add }); cleanup.push(() => visuals.close())
    const browser = new BrowserAgentServer(browserToolDefinitions, async () => ({ content: [] })); cleanup.push(() => browser.close())
    const registry = new ThreadRegistry(fixture.root)
    const host = new SottoThreadHost(provider, fixture.host, registry)
    host.useBrowserTools(browser)
    host.useThreadTools([visuals])
    await host.connect()
    await host.execute({ type: 'create-project', commandId: randomUUID(), projectId: fixture.projectId, title: 'Project', path: fixture.root })
    const create = async (title: string): Promise<string> => {
      const threadId = randomUUID()
      expect(await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: fixture.projectId, title, modelId: fixture.modelId })).toMatchObject({ accepted: true })
      return threadId
    }
    const threadId = await create('Visual check')
    const records = await fixture.driver.requests()
    if (provider === 'devin') {
      expect(JSON.stringify(records)).not.toContain(VISUAL_MCP_SERVER)
      await registry.flush()
      return
    }
    let given: Pick<ThreadMcpServer, 'url' | 'headers'>
    if (provider === 'codex') {
      const start = records.find(record => record.method === 'thread/start')?.params as { config: { mcp_servers: Record<string, { url: string; default_tools_approval_mode: string; tool_timeout_sec?: number; http_headers: Record<string, string> }> } }
      const entry = start.config.mcp_servers[VISUAL_MCP_SERVER]!
      expect(entry.default_tools_approval_mode).toBe('approve')
      expect(entry.tool_timeout_sec).toBeUndefined()
      expect(Object.keys(start.config.mcp_servers).sort()).toEqual(['sotto_browser', VISUAL_MCP_SERVER])
      given = { url: entry.url, headers: Object.entries(entry.http_headers).map(([name, value]) => ({ name, value })) }
    } else if (provider === 'claude') {
      const launch = records.find(record => record.method === 'launch' && (record.params?.frame as { args: string[] }).args.includes('--mcp-config'))
      const args = (launch!.params!.frame as { args: string[] }).args
      const config = JSON.parse(await readFile(args[args.indexOf('--mcp-config') + 1]!, 'utf8')) as { mcpServers: Record<string, { url: string; headers: Record<string, string> }> }
      const entry = config.mcpServers[VISUAL_MCP_SERVER]!
      const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--print'))
      expect(allowed).toEqual([...browserToolDefinitions.map(tool => `mcp__sotto_browser__${tool.name}`), `mcp__${VISUAL_MCP_SERVER}__visualize`])
      given = { url: entry.url, headers: Object.entries(entry.headers).map(([name, value]) => ({ name, value })) }
    } else {
      const servers = records.filter(record => record.method === 'session/new').map(record => record.params?.mcpServers as { name: string; type: string; url: string; headers: { name: string; value: string }[] }[]).find(value => value?.length)!
      expect(servers.map(server => server.name)).toEqual(['sotto_browser', VISUAL_MCP_SERVER])
      given = servers.find(server => server.name === VISUAL_MCP_SERVER)!
    }
    // The provider calls with what it was given; the tool hears the Sotto thread, never the native session.
    const shown = await callVisualize(given, DIAGRAM)
    expect(shown.isError).toBeUndefined()
    expect(shown.content[0]!.text).toBe('Shown in the thread as "How a send moves": a flowchart with 1 step, under your last message. Do not repeat the steps in your reply.')
    expect(add).toHaveBeenCalledWith(threadId, expect.objectContaining({ title: 'How a send moves' }))
    expect(registry.byThread(threadId)!.sessionId).not.toBe(threadId)

    // Off: the running session's call is refused, and a new launch is given no server.
    enabled = false
    const refused = await callVisualize(given, DIAGRAM)
    expect(refused).toMatchObject({ isError: true, content: [{ text: 'Visuals are turned off in Sotto\'s settings. Nothing was drawn. Explain in text instead.' }] })
    expect(add).toHaveBeenCalledTimes(1)
    const before = (await fixture.driver.requests()).length
    await create('Visuals off')
    expect(JSON.stringify((await fixture.driver.requests()).slice(before))).not.toContain(VISUAL_MCP_SERVER)
    await registry.flush()
  })
})

// Devin keeps no personal chats on its client, so only the three providers that take Sotto's tools are asked.
describe.each(factories.filter(([provider]) => provider !== 'devin'))('%s personal chat', (_provider, factory) => {
  it('gives a personal chat no visual tool', async () => {
    const fixture = await factory(); cleanup.push(fixture.cleanup)
    const mcpServer = vi.fn(async () => ({ name: VISUAL_MCP_SERVER, type: 'http' as const, url: 'http://127.0.0.1:1/mcp', headers: [] }))
    fixture.host.useThreadTools!([{ name: VISUAL_MCP_SERVER, definitions: [{ name: 'visualize', description: '', inputSchema: {} }], mcpServer }])
    await fixture.host.connect()
    const personal = fixture.host as unknown as { createPersonalConversation(command: PersonalCreateCommand): Promise<{ accepted: boolean }> }
    expect(await personal.createPersonalConversation({ commandId: randomUUID(), threadId: randomUUID(), title: 'Personal', modelId: fixture.modelId, workingDirectory: fixture.root })).toMatchObject({ accepted: true })
    expect(mcpServer).not.toHaveBeenCalled()
    expect(JSON.stringify(await fixture.driver.requests())).not.toContain(VISUAL_MCP_SERVER)
  })
})

describe('grok visual admission', () => {
  it('answers Grok\'s prompt for the visual tool without showing it, and shows one for the same name elsewhere', async () => {
    const fixture = await grokFixture(); cleanup.push(fixture.cleanup)
    const visuals = new VisualToolServer({ enabled: () => true, admits: () => true, add: async () => ({ added: false, reason: 'unknown-thread' }) }); cleanup.push(() => visuals.close())
    fixture.host.useThreadTools!([visuals])
    await fixture.host.connect()
    await fixture.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: fixture.projectId, title: 'Project', path: fixture.root })
    const threadId = randomUUID()
    await fixture.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: fixture.projectId, title: 'Visual admission', modelId: fixture.modelId })
    fixture.host.observeThreads?.([threadId])
    await fixture.host.execute({ type: 'send', commandId: randomUUID(), threadId, messageId: 'visual-admission', text: 'Synthetic prompt' })
    const thread = async () => (await fixture.host.snapshot()).threads.find(item => item.id === threadId)!
    const decisions = async () => (await fixture.driver.requests()).map(record => fixture.protocol!.permissionDecision(record)).filter(decision => decision !== undefined)
    await fixture.action(threadId, { type: 'permission', text: 'use_tool', rawInput: { tool_name: `${VISUAL_MCP_SERVER}__visualize`, tool_input: {} } })
    await expect.poll(decisions).toEqual([true])
    expect((await thread()).requests).toEqual([])
    await fixture.action(threadId, { type: 'permission', text: 'use_tool', rawInput: { tool_name: 'other_server__visualize', tool_input: {} } })
    await expect.poll(async () => (await thread()).requests.length).toBe(1)
  })
})
