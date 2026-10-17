// @vitest-environment node
/**
 * Sotto's tools and side writing on OpenCode (#1106, ADR-0087), over the scripted OpenCode server: each thread's own
 * server is given Sotto's tool servers as remote MCP servers with the thread's token, and side text comes from OpenCode's
 * stateless generation route on that server. `opencodeLive.test.ts` checks the same on OpenCode itself.
 */
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { afterEach, expect, it } from 'vitest'
import { BrowserAgentServer } from '../../src/main/agents/browserAgentServer'
import { opencodeRules } from '../../src/main/agents/opencode'
import { VISUAL_MCP_SERVER, VisualToolServer } from '../../src/main/agents/visualTools'
import { browserToolDefinitions } from '../../src/main/tools/browserAgentTools'
import { threadTakesSottoTools } from '../../src/shared/agents'
import type { RecordedRpc } from '../fixtures/adapterFixture'
import { opencodeFixture } from '../fixtures/fakeOpenCodeFixture'

type Fixture = Awaited<ReturnType<typeof opencodeFixture>>
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

/** A fixture whose host has Sotto's browser server and, unless left out, the visual tool, as `src/main/index.ts` wires them. */
async function withTools(options: { visuals?: boolean; idle?: boolean } = {}) {
  const f = await opencodeFixture(undefined, undefined, options.idle ? { reaperSweepMs: 50, sessionIdleMs: 300 } : {})
  cleanup.push(f.cleanup)
  const browser = new BrowserAgentServer(browserToolDefinitions, async () => ({ content: [] })); cleanup.push(() => browser.close())
  f.host.useBrowserTools(browser)
  if (options.visuals !== false) {
    const visuals = new VisualToolServer({ enabled: () => true, admits: () => true, add: async () => ({ added: false, reason: 'unknown-thread' }) }); cleanup.push(() => visuals.close())
    f.host.useThreadTools([visuals])
  }
  return { f, browser }
}
async function open(f: Fixture) {
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
  const id = randomUUID()
  expect(await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'OpenCode tools' })).toEqual({ accepted: true })
  f.host.observeThreads([id])
  return id
}
const thread = async (f: Fixture, id: string) => (await f.host.snapshot()).threads.find(candidate => candidate.id === id)!
const of = (records: readonly RecordedRpc[], method: string) => records.filter(record => record.method === method)
const PROMPT = { instruction: 'Name this coding conversation in a few words.', material: 'First message:\nSide-writing marker 41b9' }

it('gives a thread’s own server Sotto’s tool servers with its token, allows their tools by name, and takes them off when its session ends', { timeout: 60_000 }, async () => {
  const { f, browser } = await withTools({ idle: true })
  const id = await open(f)
  const endpoint = await browser.mcpServer(id)
  const token = endpoint.headers[0]!.value
  await expect.poll(async () => of(await f.driver.requests(), 'fixture/mcp-connected').map(record => record.params)).toEqual(expect.arrayContaining([
    { server: 'sotto_browser', status: 'connected' }, { server: VISUAL_MCP_SERVER, status: 'connected' }]))
  const records = await f.driver.requests()
  const folder = (of(records, 'session.create')[0]!.params as { location: { directory: string } }).location.directory
  expect(folder.toLowerCase()).toBe((await realpath(f.root)).toLowerCase())
  const added = of(records, 'experimental.mcp.add').map(record => record.params as { server: string; config: Record<string, unknown>; query: Record<string, string> })
  expect(added.map(item => item.server).sort()).toEqual(['sotto_browser', VISUAL_MCP_SERVER])
  for (const item of added) expect(item.query).toEqual({ 'location[directory]': folder })
  // Loopback HTTP with the thread's own bearer token, each tool under its own name, and the browser's long wait.
  expect(added.find(item => item.server === 'sotto_browser')!.config).toEqual({ type: 'remote', url: endpoint.url, headers: { Authorization: token },
    oauth: false, codemode: false, timeout: { execution: 360_000 } })
  expect(added.find(item => item.server === VISUAL_MCP_SERVER)!.config).toMatchObject({ type: 'remote', oauth: false, codemode: false, headers: { Authorization: expect.stringMatching(/^Bearer /u) } })
  // The rule set allows exactly Sotto's own tools after the mode's rules, by the names OpenCode gives them, and nothing else.
  expect(of(records, 'session.create')[0]!.params?.permissions).toEqual([...opencodeRules('approval-required'),
    ...browserToolDefinitions.map(tool => ({ action: `sotto_browser_${tool.name}`, resource: '*', effect: 'allow' })),
    { action: `${VISUAL_MCP_SERVER}_visualize`, resource: '*', effect: 'allow' }])
  const shown = await thread(f, id)
  expect(shown.sottoToolsWithheld).toBeUndefined()
  expect(threadTakesSottoTools({ ...shown, providerId: 'opencode' })).toBe(true)
  // A change of mode keeps the allows, and the thread still reads as Ask for approval when its session reports the rules.
  await f.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: id, runtimeMode: 'full-access' })
  expect(of(await f.driver.requests(), 'session.update').at(-1)!.params?.permissions).toEqual([...opencodeRules('full-access'),
    ...browserToolDefinitions.map(tool => ({ action: `sotto_browser_${tool.name}`, resource: '*', effect: 'allow' })), { action: `${VISUAL_MCP_SERVER}_visualize`, resource: '*', effect: 'allow' }])
  await expect.poll(async () => (await thread(f, id)).runtimeMode).toBe('full-access')
  // Nobody watches the thread now: its idle session ends, and its tool servers are taken off before its server stops.
  f.host.observeThreads([])
  await expect.poll(async () => of(await f.driver.requests(), 'experimental.mcp.remove').map(record => (record.params as { server: string }).server).sort(), { timeout: 20_000 })
    .toEqual(['sotto_browser', VISUAL_MCP_SERVER])
  for (const record of of(await f.driver.requests(), 'experimental.mcp.remove')) expect(record.params?.query).toEqual({ 'location[directory]': folder })
  await expect.poll(() => f.sessions.stopped(id), { timeout: 20_000 }).toBe(true)
  // Only stable event names were logged: no token, and nothing the servers were given.
  expect(f.events.every(event => /^opencode-server-[a-z-]+$/u.test(event))).toBe(true)
  expect(JSON.stringify(f.events)).not.toContain(token.slice(7))
})

it('gives a server that starts again the thread’s current token', async () => {
  const { f, browser } = await withTools({ visuals: false })
  const id = await open(f)
  await expect.poll(async () => of(await f.driver.requests(), 'fixture/mcp-connected').length).toBe(1)
  const first = (await browser.mcpServer(id)).headers[0]!.value
  f.host.disconnect(); await f.adapter.closed(); browser.revoke(id)
  f.host.observeThreads([id]); await f.host.connect(); await f.host.refreshThread!(id)
  const renewed = (await browser.mcpServer(id)).headers[0]!.value
  expect(renewed).not.toBe(first)
  await expect.poll(async () => of(await f.driver.requests(), 'experimental.mcp.add').map(record => (record.params as { config: { headers: Record<string, string> } }).config.headers.Authorization))
    .toEqual([first, renewed])
  await expect.poll(async () => of(await f.driver.requests(), 'fixture/mcp-connected').map(record => (record.params as { status: string }).status)).toEqual(['connected', 'connected'])
})

it('sends a prompt without waiting on a tool server OpenCode is still connecting', { timeout: 60_000 }, async () => {
  const { f } = await withTools({ visuals: false })
  // OpenCode holds the add while it connects, about 30 seconds against a server that never answers (2.0.31).
  await f.script({ delay: { 'experimental.mcp.add': 30_000 } })
  const id = await open(f)
  expect(await f.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: 'first', text: 'Synthetic prompt' })).toEqual({ accepted: true })
  const records = await f.driver.requests()
  expect(of(records, 'session.prompt')).toHaveLength(1)
  // The prompt went while the tool server was still connecting.
  expect(of(records, 'experimental.mcp.add')).toHaveLength(1)
  expect(of(records, 'fixture/mcp-connected')).toEqual([])
})

for (const [what, mcp] of [['refuses them', { refuse: true }], ['cannot connect them', { fail: true }]] as const) {
  it(`marks a thread as without Sotto’s tools when OpenCode ${what}`, async () => {
    const { f } = await withTools({ visuals: false })
    await f.script({ mcp })
    const id = await open(f)
    await expect.poll(async () => (await thread(f, id)).sottoToolsWithheld).toBe(true)
    expect(threadTakesSottoTools({ ...await thread(f, id), providerId: 'opencode' })).toBe(false)
  })
}

it('writes side text on the stateless generation route of the thread’s own server, with its model at its least effort, and makes no provider session', async () => {
  const { f } = await withTools({ visuals: false })
  const id = await open(f)
  await f.scriptAlso({ generate: { text: 'Fixture title' } })
  const before = await f.driver.requests()
  await expect(f.host.writeShortText!(id, PROMPT)).resolves.toBe('Fixture title')
  const calls = await f.sideCalls()
  expect(calls).toHaveLength(1)
  expect(calls[0]!.model).toEqual({ id: 'fixture-model', providerID: 'opencode', variant: 'low' })
  expect(calls[0]!.prompt).toBe(`${PROMPT.instruction}\n\n${PROMPT.material}`)
  expect(calls[0]!.process).toBe(await f.holder(id))
  const after = (await f.driver.requests()).slice(before.length)
  // One generation and the session reads around it: no provider session made, nothing sent on the thread's own.
  expect(after.map(record => record.method).filter(method => method !== 'session.list')).toEqual(['experimental.generate.text'])
  expect((await f.nativeSessions()).map(session => session.title)).toEqual(['OpenCode tools'])
  expect(JSON.stringify(await f.driver.requests())).not.toContain('Side-writing marker 41b9')
  expect(JSON.stringify(f.events)).not.toContain('marker')
})

it('writes nothing where the model source refuses the route, as OpenCode Zen’s free models do, and asks it once', async () => {
  const { f } = await withTools({ visuals: false })
  const id = await open(f)
  await f.scriptAlso({ generate: { refuse: 'zen' } })
  await expect(f.host.writeShortText!(id, PROMPT)).resolves.toBeNull()
  // A refusal that names a model source is its answer, not a wait: asked once, never again, and never as a turn.
  expect(await f.sideCalls()).toHaveLength(1)
  const records = await f.driver.requests()
  expect(of(records, 'session.prompt')).toEqual([])
  expect(of(records, 'session.create')).toHaveLength(1)
})

it('writes nothing when a provider session appears beside the side call', async () => {
  const { f } = await withTools({ visuals: false })
  const id = await open(f)
  await f.scriptAlso({ generate: { text: 'Fixture title', session: true } })
  await expect(f.host.writeShortText!(id, PROMPT)).resolves.toBeNull()
})

it('waits for a thread’s server to stop when Sotto disconnects while its tool servers are being taken off', { timeout: 60_000 }, async () => {
  const { f } = await withTools({ visuals: false, idle: true })
  const id = await open(f)
  await expect.poll(async () => of(await f.driver.requests(), 'fixture/mcp-connected').length).toBe(1)
  const pid = (await f.holder(id))!
  expect(f.running(pid)).toBe(true)
  // OpenCode holds the removal: the idle session's end is still taking its tool servers off when Sotto disconnects.
  await f.scriptAlso({ delay: { 'experimental.mcp.remove': 10_000 } })
  f.host.observeThreads([])
  await expect.poll(async () => of(await f.driver.requests(), 'experimental.mcp.remove').length, { timeout: 20_000 }).toBe(1)
  f.host.disconnect(); await f.adapter.closed()
  expect(f.running(pid)).toBe(false)
})
