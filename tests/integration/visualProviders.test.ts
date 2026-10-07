// @vitest-environment node
/**
 * A visualize call from each fake provider, through the whole local stack (ADR-0055): the adapter, Sotto's thread IDs,
 * the workspace and its store. The provider calls the endpoint it was given at launch, and the card lands live in the
 * open window after the words the provider wrote before the call and before the words it writes after.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SottoThreadHost, ThreadRegistry } from '../../src/main/agents/threads'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { VISUAL_MCP_SERVER, VisualToolServer } from '../../src/main/agents/visualTools'
import type { ThreadMcpServer } from '../../src/main/agents/threadToolServer'
import type { AgentMessage, ProviderId } from '../../src/shared/agents'
import { codexFixture } from '../fixtures/codexFixture'
import { claudeFixture } from '../fixtures/claudeFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'
import type { AdapterFixture } from './adapterContract'
import type { RecordedRpc } from '../fixtures/codexFixture'
import { callVisualize } from '../fixtures/visualToolCall'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

const visualize = (server: Pick<ThreadMcpServer, 'url' | 'headers'>, title: string): ReturnType<typeof callVisualize> =>
  callVisualize(server, { title, kind: 'diagram', source: 'flowchart LR\n  A[Draft] --> B[Sent]', steps: [{ text: 'A draft is sent.' }] })

/** The endpoint the provider was given for the visual tool, read from what the adapter sent it at launch. */
async function given(provider: ProviderId, records: readonly RecordedRpc[]): Promise<Pick<ThreadMcpServer, 'url' | 'headers'>> {
  if (provider === 'codex') {
    const start = records.find(record => record.method === 'thread/start')?.params as { config: { mcp_servers: Record<string, { url: string; http_headers: Record<string, string> }> } }
    const entry = start.config.mcp_servers[VISUAL_MCP_SERVER]!
    return { url: entry.url, headers: Object.entries(entry.http_headers).map(([name, value]) => ({ name, value })) }
  }
  if (provider === 'claude') {
    const launch = records.findLast(record => ['launch', 'resume'].includes(record.method ?? '') && (record.params?.frame as { args: string[] }).args.includes('--mcp-config'))
    const args = (launch!.params!.frame as { args: string[] }).args
    const config = JSON.parse(await readFile(args[args.indexOf('--mcp-config') + 1]!, 'utf8')) as { mcpServers: Record<string, { url: string; headers: Record<string, string> }> }
    const entry = config.mcpServers[VISUAL_MCP_SERVER]!
    return { url: entry.url, headers: Object.entries(entry.headers).map(([name, value]) => ({ name, value })) }
  }
  const servers = records.filter(record => ['session/new', 'session/load'].includes(record.method ?? '')).map(record => record.params?.mcpServers as { name: string; url: string; headers: { name: string; value: string }[] }[]).find(value => value?.length)!
  return servers.find(server => server.name === VISUAL_MCP_SERVER)!
}

const factories: [ProviderId, () => Promise<AdapterFixture>][] = [['codex', codexFixture], ['claude', claudeFixture], ['grok', grokFixture]]
describe.each(factories)('%s visualize call', (provider, factory) => {
  it('draws the card live between the words before the call and the words after it', async () => {
    const fixture = await factory(); cleanup.push(fixture.cleanup)
    const registry = new ThreadRegistry(fixture.root)
    const threads = new SottoThreadHost(provider, fixture.host, registry)
    const directory = join(fixture.root, 'workspace')
    await mkdir(directory, { recursive: true })
    const workspace = new WorkspaceHost(threads, directory)
    cleanup.push(async () => { workspace.disconnect(); await workspace.close().catch(() => undefined); await registry.flush() })
    // In the app the workspace holds a new thread before its provider starts it; here the thread is created beneath the
    // workspace, so the launch is admitted by the thread's own ID until the workspace has read it.
    let threadId = ''
    const visuals = new VisualToolServer({ enabled: () => true, admits: id => id === threadId || workspace.admitsVisuals(id), add: (id, input) => workspace.addVisual(id, input) })
    cleanup.push(() => visuals.close())
    threads.useThreadTools([visuals])
    await threads.connect()
    await threads.execute({ type: 'create-project', commandId: randomUUID(), projectId: fixture.projectId, title: 'Project', path: fixture.root })
    threadId = randomUUID()
    expect(await threads.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: fixture.projectId, title: 'Visual thread', modelId: fixture.modelId })).toMatchObject({ accepted: true })
    await workspace.initialize()
    await workspace.connect()
    workspace.observeThreads([threadId])
    const sessionId = registry.byThread(threadId)!.sessionId
    const window = (): AgentMessage[] => workspace.workspaceSnapshot().threads.find(thread => thread.id === threadId)?.messages ?? []
    const texts = (): string[] => window().map(message => message.visual ? `[${message.visual.title}]` : message.text)
    const send = async (messageId: string, text: string): Promise<void> => {
      expect(await threads.execute({ type: 'send', commandId: randomUUID(), threadId, messageId, text })).toMatchObject({ accepted: true })
      await expect.poll(() => window().some(message => message.id === messageId), { timeout: 20_000 }).toBe(true)
    }

    await send('first-prompt', 'Show me how a send moves.')
    await fixture.driver.completeTurn(sessionId, 'Before the visual.')
    await expect.poll(() => texts().includes('Before the visual.'), { timeout: 20_000 }).toBe(true)
    const endpoint = await given(provider, await fixture.driver.requests())
    // Called after the reply: the card goes under it.
    expect((await visualize(endpoint, 'After a reply')).content[0]!.text).toContain('under your last message')
    expect(texts()).toEqual(['Show me how a send moves.', 'Before the visual.', '[After a reply]'])

    // Called before the agent writes anything in a turn: the card goes under the prompt, and the reply after it.
    await send('second-prompt', 'And the reply?')
    expect((await visualize(endpoint, 'Before a reply')).content[0]!.text).toContain('under the user\'s message')
    await fixture.driver.completeTurn(sessionId, 'After the visual.')
    await expect.poll(() => texts(), { timeout: 20_000 }).toEqual(['Show me how a send moves.', 'Before the visual.', '[After a reply]', 'And the reply?', '[Before a reply]', 'After the visual.'])
  })
})
