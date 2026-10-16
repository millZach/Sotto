// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserAgentServer } from '../../src/main/agents/browserAgentServer'
import { VISUAL_MCP_SERVER, VisualToolServer } from '../../src/main/agents/visualTools'
import { browserToolDefinitions } from '../../src/main/tools/browserAgentTools'
import { devinFixture } from '../fixtures/devinFixture'

// Devin CLI 3000.11.1 and later attach the MCP servers a session is opened with (#1040), so a Devin thread is given
// Sotto's own servers as Claude Code, Codex, Grok Build and Muse threads are (ADR-0056). Its owned profiles let those
// servers through by name; a prompt for one that arrives anyway is the user's to answer, like any other (ADR-0004).
type Fixture = Awaited<ReturnType<typeof devinFixture>>
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const browser = (): BrowserAgentServer => {
  const server = new BrowserAgentServer(browserToolDefinitions, async () => ({ content: [] })); cleanup.push(() => server.close()); return server
}
const visuals = (): VisualToolServer => {
  const server = new VisualToolServer({ enabled: () => true, admits: () => true, add: async () => ({ added: false, reason: 'unknown-thread' }) })
  cleanup.push(() => server.close()); return server
}
const withTools = (f: Fixture): Fixture => { f.host.useBrowserTools(browser()); f.host.useThreadTools([visuals()]); return f }

async function setUp(script?: Record<string, unknown>) {
  // The adapter's own read pace: a send that finds no sign of its prompt reads the replay again every second and a half
  // until its deadline. A configured pace replaces that cadence, and a long one left a send a single read (#1086).
  const f = withTools(await devinFixture(undefined, 5000, undefined, {}, new Map(), { productionPace: true }))
  cleanup.push(() => f.cleanup())
  if (script) await f.script(script)
  expect((await f.host.connect()).connected).toBe(true)
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
  const id = randomUUID()
  expect(await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Synthetic tools' })).toEqual({ accepted: true })
  f.host.observeThreads([id])
  return { f, id }
}
const thread = async (f: Fixture, id: string) => (await f.host.snapshot()).threads.find(item => item.id === id)!
/** The server names each `session/new` or `session/load` carried, in order. */
const given = async (f: Fixture, method: string): Promise<string[][]> => (await f.driver.requests())
  .filter(record => record.method === method).map(record => (record.params?.mcpServers as { name: string }[]).map(server => server.name))
const decisions = async (f: Fixture) => (await f.driver.requests()).map(record => f.protocol.permissionDecision(record)).filter(value => value !== undefined)
const send = (f: Fixture, id: string) => f.host.execute({ type: 'send', commandId: randomUUID(), messageId: randomUUID(), threadId: id, text: 'Synthetic tool turn' })

describe('Devin thread tools', () => {
  it('gives the session Sotto’s servers when it is made and when it is loaded, and none to the catalog or a history read', async () => {
    const { f, id } = await setUp()
    // The catalog session first, then the thread's own.
    expect(await given(f, 'session/new')).toEqual([[], ['sotto_browser', VISUAL_MCP_SERVER]])
    expect((await thread(f, id)).sottoToolsWithheld).toBeUndefined()
    expect(await send(f, id)).toEqual({ accepted: true })
    await f.driver.completeTurn(id, 'Finished')
    await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
    // The replay read that confirms the turn loads the session in a process of its own, which never prompts.
    await expect.poll(async () => (await given(f, 'session/load')).length).toBeGreaterThan(0)
    expect((await given(f, 'session/load')).every(names => names.length === 0)).toBe(true)

    const restarted = withTools(await f.driver.restart())
    cleanup.push(async () => { restarted.host.disconnect(); await restarted.host.closed() })
    await restarted.host.connect()
    const before = (await given(restarted, 'session/load')).length
    await restarted.host.startThreadSession(id)
    expect((await given(restarted, 'session/load')).slice(before)).toEqual([['sotto_browser', VISUAL_MCP_SERVER]])
    expect((await restarted.driver.requests()).filter(record => record.method === 'session/prompt')).toHaveLength(1)
  })

  it('accepts a send whose prompt the first replay read does not show yet, by reading it again', async () => {
    const { f, id } = await setUp()
    // A busy Devin saves the prompt after the first read has replayed the session, as a loaded runner can.
    await f.script({ delayPrompt: 1_000 })
    expect(await send(f, id)).toEqual({ accepted: true })
  })

  it('gives no servers to a Devin that does not take HTTP servers, and says so on the thread', async () => {
    const { f, id } = await setUp({ noHttpMcp: true })
    expect(await given(f, 'session/new')).toEqual([[], []])
    expect((await thread(f, id)).sottoToolsWithheld).toBe(true)
  })

  it.each(['meta', 'title'])('shows Devin’s prompt for one of the thread’s Sotto tools, named in its %s, with the whole input, for the user to answer', async nameIn => {
    const { f, id } = await setUp()
    expect(await send(f, id)).toEqual({ accepted: true })
    const input = { title: 'How a send moves', kind: 'diagram', source: 'flowchart LR\n  A --> B' }
    await f.action(id, { type: 'mcp-permission', tool: `mcp__${VISUAL_MCP_SERVER}__visualize`, nameIn, input })
    await expect.poll(async () => (await thread(f, id)).requests.length).toBe(1)
    const request = (await thread(f, id)).requests[0]!
    expect(request).toMatchObject({ kind: 'permission', text: 'Use Sotto’s visualize tool', context: { details: JSON.stringify(input) } })
    // Devin's own server-wide grant is not offered: each call is answered once.
    expect(request.permissionChoices?.map(choice => choice.id)).toEqual(['allow-once', 'deny-once'])
    expect(await decisions(f)).toEqual([])
    expect(await f.host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: request.id, answer: '', approved: true })).toEqual({ accepted: true })
    await expect.poll(() => decisions(f)).toEqual([true])
  })

  it('refuses an answer once the tool Devin asked about names another tool, and sends no allow', async () => {
    const { f, id } = await setUp()
    expect(await send(f, id)).toEqual({ accepted: true })
    const input = { title: 'Synthetic', kind: 'diagram', source: 'flowchart LR\n  A --> B' }
    await f.action(id, { type: 'mcp-permission', tool: `mcp__${VISUAL_MCP_SERVER}__visualize`, nameIn: 'meta', input })
    await expect.poll(async () => (await thread(f, id)).requests.length).toBe(1)
    const request = (await thread(f, id)).requests[0]!
    const toolCallId = request.context!.toolCallId!
    // The same call and input, now naming a tool that is not the thread's own.
    await f.action(id, { type: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId, title: 'Renamed tool', _meta: { 'cognition.ai/toolName': 'mcp__other_server__visualize' } } })
    await expect.poll(async () => (await thread(f, id)).activities?.some(activity => activity.title === 'Renamed tool')).toBe(true)
    await expect(f.host.execute({ type: 'answer', commandId: randomUUID(), threadId: id, requestId: request.id, answer: '', approved: true }))
      .rejects.toThrow('Devin changed this action after asking. Nothing was approved. Reconnect and review the new request.')
    expect(await decisions(f)).toEqual([])
  })

  it.each([
    ['a Sotto tool call whose input Devin cut short', { tool: `mcp__${VISUAL_MCP_SERVER}__visualize`, nameIn: 'meta', truncated: true }],
    ['a call to a tool that is not one of the thread’s own', { tool: 'mcp__other_server__visualize', nameIn: 'meta' }],
    ['another tool’s call that looks like a command', { tool: 'mcp__other_server__run', nameIn: 'title', input: { command: 'git status' } }],
    ['a command whose input Devin cut short', { tool: 'Run command', nameIn: 'title', input: { command: 'git status' }, truncated: true }],
  ])('refuses to present %s, and answers nothing for the user', async (_label, call) => {
    const { f, id } = await setUp()
    expect(await send(f, id)).toEqual({ accepted: true })
    await f.action(id, { type: 'mcp-permission', input: { title: 'Synthetic' }, ...call })
    // Refused as unpresentable, and the process that asked is stopped, as for any request Sotto cannot show whole.
    await expect.poll(async () => (await f.driver.requests()).some(record => (record as { error?: { code?: number } }).error?.code === -32602)).toBe(true)
    expect((await thread(f, id)).requests).toEqual([])
    expect(await decisions(f)).toEqual([])
  })
})
