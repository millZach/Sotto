// @vitest-environment node
import { randomUUID } from 'node:crypto'
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
    if (provider === 'codex') {
      // The browser's own tools carry no native prompt; page actions are Tools' to decide (ADR-0029).
      expect(records.find(record => record.method === 'thread/start')?.params).toMatchObject({ config: { mcp_servers: { sotto_browser: { url: endpoint.url, default_tools_approval_mode: 'approve', http_headers: { Authorization: endpoint.headers[0]!.value } } } } })
    } else if (provider === 'claude') {
      const launch = records.find(record => record.method === 'launch' && (record.params?.frame as { args: string[] }).args.includes('--mcp-config'))
      const args = (launch?.params?.frame as { args: string[] }).args
      expect(JSON.parse(args[args.indexOf('--mcp-config') + 1]!)).toMatchObject({ mcpServers: { sotto_browser: { url: endpoint.url } } })
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
    await host.refreshThread(threadId)
    expect(mcpServer.mock.calls.length).toBeGreaterThan(callsBeforeReconnect)
    const renewed = await server.mcpServer(threadId)
    expect(renewed.headers).not.toEqual(endpoint.headers)
    const nextRecords = await fixture.driver.requests()
    expect(JSON.stringify(nextRecords.slice(records.length))).toContain(renewed.headers[0]!.value)
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
