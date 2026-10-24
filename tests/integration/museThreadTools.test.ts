// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { BrowserAgentServer, type BrowserAgentTools } from '../../src/main/agents/browserAgentServer'
import { museToolName } from '../../src/main/agents/museRequests'
import { MuseRejected, MuseRpc } from '../../src/main/agents/museRpc'
import { ThreadToolServer, type ScopedThreadTools } from '../../src/main/agents/threadToolServer'
import { VISUAL_MCP_SERVER, visualizeDefinition } from '../../src/main/agents/visualTools'
import { browserToolDefinitions } from '../../src/main/tools/browserAgentTools'
import { parseProviderRecords } from '../fixtures/providerRecords'
import type { RecordedRpc } from '../fixtures/adapterFixture'
import { museFixture } from '../fixtures/museFixture'

type Fixture = Awaited<ReturnType<typeof museFixture>>
const closing: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closing.splice(0).reverse()) await close() })

/** Sotto's tool servers as main hands them to every adapter: the browser's, and a scoped one that answers every thread. */
function sottoTools() {
  const browser = new BrowserAgentServer(browserToolDefinitions, async () => ({ content: [] }))
  const visualServer = new ThreadToolServer({ name: VISUAL_MCP_SERVER, serverName: 'sotto-visual', instructions: 'Draw a visual.', unavailable: 'Unavailable.', failed: 'Failed.' },
    [visualizeDefinition], async () => ({ content: [] }))
  const visual: ScopedThreadTools = { name: VISUAL_MCP_SERVER, definitions: [visualizeDefinition], mcpServer: id => visualServer.mcpServer(id) }
  closing.push(async () => { await browser.close(); await visualServer.close() })
  const tools: BrowserAgentTools = { definitions: browserToolDefinitions, call: browser.call.bind(browser), mcpServer: id => browser.mcpServer(id) }
  return { tools, scoped: [visual] }
}
function equip(f: Fixture): void {
  const { tools, scoped } = sottoTools()
  f.adapter.useBrowserTools(tools); f.adapter.useThreadTools(scoped)
}
async function open(script?: Record<string, unknown>) {
  const f = await museFixture()
  closing.push(() => f.cleanup())
  if (script) await f.script(script)
  equip(f)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
  const id = randomUUID()
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Muse thread' })
  return { f, id }
}
const thread = async (f: Fixture, id: string) => (await f.host.snapshot()).threads.find(candidate => candidate.id === id)!
const records = async (f: Fixture, method: string) => (await f.driver.requests()).filter(record => record.method === method)
const servers = (record: RecordedRpc | undefined) => (record?.params?.config as { mcpServers?: Record<string, Record<string, unknown>> } | undefined)?.mcpServers
const browserTools = browserToolDefinitions.map(tool => tool.name)
/** A server of Sotto's as a Muse session names it: its own name and the thread's suffix (ADR-0079). */
const SUFFIX = /_[0-9a-f]{10}$/u
const keyOf = (given: Record<string, unknown> | undefined, server: string): string => {
  const key = Object.keys(given ?? {}).find(name => SUFFIX.test(name) && name.replace(SUFFIX, '') === server)
  if (!key) throw new Error(`No ${server} server was given.`)
  return key
}
/** The name Muse shows for one of Sotto's tools in the thread its first start gave servers to. */
const ownTool = async (f: Fixture, server: string, tool: string): Promise<string> => museToolName(keyOf(servers((await records(f, 'session/start'))[0]), server), tool)

it('asks for session tool servers and gives a new Muse session Sotto’s tools, which Muse lists before any turn', async () => {
  const { f, id } = await open()
  expect((await records(f, 'initialize'))[0]?.params?.capabilities).toEqual({ requestedCapabilities: ['sessionMcp'] })
  const given = servers((await records(f, 'session/start'))[0])
  expect(Object.keys(given ?? {}).every(name => SUFFIX.test(name))).toBe(true)
  expect(Object.keys(given!).map(name => name.replace(SUFFIX, ''))).toEqual(['sotto_browser', VISUAL_MCP_SERVER])
  for (const server of Object.values(given!)) {
    expect(server).toMatchObject({ transport: 'streamableHttp', mode: 'required', headers: { 'Sotto-Tool-Wait': '300' } })
    expect(String(server.url)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/u)
    expect(String((server.headers as Record<string, string>).Authorization)).toMatch(/^Bearer \S+$/u)
  }
  await expect.poll(async () => (await records(f, 'fixture/mcp-tools')).length).toBe(2)
  const listed: Record<string, { name: string; readOnly: boolean }[]> = Object.fromEntries((await records(f, 'fixture/mcp-tools'))
    .map(record => [String(record.params!.server), record.params!.tools as { name: string; readOnly: boolean }[]]))
  expect(listed[keyOf(given, 'sotto_browser')]!.map(tool => tool.name)).toEqual(browserTools)
  expect(listed[keyOf(given, 'sotto_browser')]!.filter(tool => tool.readOnly).map(tool => tool.name)).toEqual(['browser_pages', 'browser_status', 'iphone_cloud_status'])
  expect(listed[keyOf(given, VISUAL_MCP_SERVER)]!.map(tool => tool.name)).toEqual(['visualize'])
  // A later resume on the same host leaves the servers out, and Muse keeps the ones the session was built with.
  await f.action(id, { type: 'gap' })
  await expect.poll(async () => (await records(f, 'session/resume')).length).toBe(1)
  expect(servers((await records(f, 'session/resume'))[0])).toBeUndefined()
  expect((await thread(f, id)).status).toBe('idle')
  expect((await thread(f, id)).sottoToolsWithheld).toBeUndefined()
})

it('attaches nothing, and starts the session as before, when the client does not grant session tool servers', async () => {
  const { f, id } = await open({ sessionMcp: false })
  expect((await records(f, 'session/start')).map(record => servers(record))).toEqual([undefined])
  expect((await thread(f, id)).status).toBe('idle')
  // The thread says so, and Sotto offers it no visual, babysitting or browser sharing that would need the tools.
  expect((await thread(f, id)).sottoToolsWithheld).toBe(true)
  // Without tools there is nothing of Sotto's to admit: a prompt naming one is the user's.
  await f.action(id, { type: 'tool-permission', toolName: 'mcp__sotto_browser__browser_open' })
  await expect.poll(async () => (await thread(f, id)).requests.length).toBe(1)
  expect(await records(f, 'approval/decide')).toHaveLength(0)
  expect(await records(f, 'fixture/mcp-tools')).toHaveLength(0)
})

it('keeps the connect probe and its mode probes bare', async () => {
  const { f } = await open()
  const probe = parseProviderRecords<RecordedRpc>(await readFile(join(f.root, 'oneshot.jsonl'), 'utf8'))
  expect(probe.filter(record => record.method === 'session/start').length).toBeGreaterThan(0)
  expect(probe.filter(record => record.method === 'session/start' || record.method === 'session/resume').every(record => servers(record) === undefined)).toBe(true)
})

it('gives a session its servers again on a new host, with that run’s address and token', async () => {
  const { f, id } = await open()
  const first = servers((await records(f, 'session/start'))[0])!
  await expect.poll(async () => (await records(f, 'fixture/mcp-tools')).length).toBe(2)
  const g = await f.driver.restart() as unknown as Fixture
  closing.push(async () => { g.adapter.disconnect(); await g.adapter.closed() })
  equip(g)
  await g.host.connect()
  g.host.observeThreads?.([id])
  await expect.poll(async () => (await records(g, 'session/resume')).length).toBe(1)
  const again = servers((await records(g, 'session/resume'))[0])!
  expect(Object.keys(again).map(name => name.replace(SUFFIX, ''))).toEqual(['sotto_browser', VISUAL_MCP_SERVER])
  // A new run names the servers afresh, as well as giving them a new address and token.
  expect(keyOf(again, 'sotto_browser')).not.toBe(keyOf(first, 'sotto_browser'))
  const browserNow = again[keyOf(again, 'sotto_browser')]!, browserThen = first[keyOf(first, 'sotto_browser')]!
  expect(browserNow.url).not.toBe(browserThen.url)
  expect((browserNow.headers as Record<string, string>).Authorization).not.toBe((browserThen.headers as Record<string, string>).Authorization)
  await expect.poll(async () => (await records(g, 'fixture/mcp-tools')).length).toBe(4)
  expect((await thread(g, id)).status).toBe('idle')
})

it('starts afresh when a lost start cannot be replayed because a restart moved its servers', async () => {
  const f = await museFixture(), id = randomUUID()
  closing.push(() => f.cleanup())
  equip(f)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
  await f.script({ loseStartAckOnce: true })
  await expect(f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Replay thread' }))
    .resolves.toEqual({ accepted: false, uncertain: true })
  const g = await f.driver.restart() as unknown as Fixture
  closing.push(async () => { g.adapter.disconnect(); await g.adapter.closed() })
  equip(g)
  await g.host.connect()
  await g.host.refreshThread!(id)
  const starts = await records(g, 'session/start')
  expect(starts).toHaveLength(3)
  expect(starts[1]!.params!.commandId).toBe(starts[0]!.params!.commandId)
  expect(starts[2]!.params!.commandId).not.toBe(starts[0]!.params!.commandId)
  expect(servers(starts[2])).toEqual(servers(starts[1]))
  expect((await thread(g, id)).status).toBe('idle')
})

it('admits a call to the thread’s own Sotto tool once, and leaves every other prompt to the user', async () => {
  const { f, id } = await open()
  await f.action(id, { type: 'tool-permission', toolName: await ownTool(f, 'sotto_browser', 'browser_open') })
  await expect.poll(async () => (await records(f, 'approval/decide')).length).toBe(1)
  expect((await records(f, 'approval/decide'))[0]?.params).toMatchObject({ choiceId: 'yes' })
  await expect.poll(async () => (await thread(f, id)).requests).toEqual([])
  // A user's own server named `sotto-browser` lists `mcp__sotto_browser__browser_open`, because Muse folds `-` to `_`.
  // It is shown, never admitted, as is a tool Sotto's own server was not given.
  const others = ['mcp__someone_else__browser_open', museToolName('sotto-browser', 'browser_open'), await ownTool(f, 'sotto_browser', 'run_anything')]
  for (const toolName of others) {
    await f.action(id, { type: 'tool-permission', toolName })
    await expect.poll(async () => (await thread(f, id)).requests.map(request => request.context?.toolName)).toContain(toolName)
  }
  await f.driver.raisePermission(id, 'rm -rf build')
  await expect.poll(async () => (await thread(f, id)).requests.length).toBe(4)
  expect(await records(f, 'approval/decide')).toHaveLength(1)
})

it('admits a Sotto tool prompt the stream missed when the thread reads Muse again', async () => {
  const { f, id } = await open()
  await f.script({ suppressApproval: true })
  await f.action(id, { type: 'tool-permission', toolName: await ownTool(f, VISUAL_MCP_SERVER, 'visualize') })
  await expect.poll(async () => {
    const saved = JSON.parse(await readFile(join(f.root, 'native-sessions.json'), 'utf8')) as { sessions: Record<string, { pendingApprovals?: unknown[] }> }
    return saved.sessions[await f.realId(id)]?.pendingApprovals?.length
  }).toBe(1)
  expect(await records(f, 'approval/decide')).toHaveLength(0)
  await f.action(id, { type: 'gap' })
  await expect.poll(async () => (await records(f, 'approval/decide')).length).toBe(1)
  expect((await thread(f, id)).requests).toEqual([])
})

it('shows nothing for an admitted prompt Muse resolved before its unreadable acknowledgement', async () => {
  const { f, id } = await open()
  await f.script({ unreadableApprovalAck: true })
  await f.action(id, { type: 'tool-permission', toolName: await ownTool(f, 'sotto_browser', 'browser_open') })
  await expect.poll(async () => (await records(f, 'approval/decide')).length).toBe(1)
  // A later prompt the user must answer proves the acknowledgement before it was read.
  await f.driver.raisePermission(id, 'rm -rf build')
  await expect.poll(async () => (await thread(f, id)).requests.map(request => request.text)).toEqual(['Run a command: rm -rf build'])
})

it('reads Muse again when an admitted stage went stale, and admits the stage it holds now', async () => {
  const { f, id } = await open()
  await f.script({ suppressApproval: true })
  await f.action(id, { type: 'tool-permission', toolName: await ownTool(f, 'sotto_browser', 'browser_open') })
  await expect.poll(async () => {
    const saved = JSON.parse(await readFile(join(f.root, 'native-sessions.json'), 'utf8')) as { sessions: Record<string, { pendingApprovals?: unknown[] }> }
    return saved.sessions[await f.realId(id)]?.pendingApprovals?.length
  }).toBe(1)
  // The read Sotto makes moves the approval to its next stage before answering with the stage it had.
  await f.script({ pendingListRace: 'stage' })
  await f.action(id, { type: 'gap' })
  await expect.poll(async () => (await records(f, 'approval/decide')).map(record => (record.params!.requirementId as { sourceIndex: number }).sourceIndex)).toEqual([0, 1])
  expect((await thread(f, id)).requests).toEqual([])
})

it('answers capabilityRequired when a client sends servers it never asked to attach', async () => {
  const f = await museFixture()
  closing.push(() => f.cleanup())
  const rpc = new MuseRpc(process.execPath, [resolve('tests/fixtures/fakeMuseAgent.mjs'), f.root, 'serve'], f.root, process.env, 5000, () => undefined, () => undefined)
  closing.push(async () => { rpc.close(); await rpc.closed })
  await rpc.request('initialize', { clientInfo: { name: 'sotto', version: '0' } })
  const refused = await rpc.request('session/start', { commandId: randomUUID(), workspaceRoot: f.root,
    config: { mcpServers: { sotto_browser: { transport: 'streamableHttp', url: 'http://127.0.0.1:9/mcp' } } } }).catch((error: unknown) => error)
  expect(refused).toBeInstanceOf(MuseRejected)
  expect((refused as MuseRejected).kind).toBe('capabilityRequired')
})

// Muse 1.4.12 fails every turn of a compacted session whose runtime a new host builds with tool servers; a fork of it
// builds cleanly. Sotto moves the thread onto the fork, and the history Muse rebuilt for it stays out of the transcript.
it('moves a compacted thread onto a copy of its conversation when a new host cannot give it Sotto’s tools', async () => {
  const { f, id } = await open({ compactedToolsBug: true })
  const send = (g: Fixture, text: string) => g.host.execute({ type: 'send', threadId: id, commandId: randomUUID(), messageId: randomUUID(), text })
  const texts = async (g: Fixture) => (await thread(g, id)).messages.map(message => message.text)
  await send(f, 'Before the compaction')
  await f.driver.completeTurn(id, 'First reply')
  await expect.poll(async () => (await thread(f, id)).status).toBe('idle')
  expect(await f.host.execute({ type: 'compact-thread', commandId: randomUUID(), threadId: id })).toMatchObject({ accepted: true })
  const before = await f.realId(id)
  const g = await f.driver.restart() as unknown as Fixture
  closing.push(async () => { g.adapter.disconnect(); await g.adapter.closed() })
  equip(g)
  await g.host.connect()
  g.host.observeThreads?.([id])
  await send(g, 'After the restart')
  await expect.poll(async () => (await records(g, 'session/fork')).length).toBe(1)
  await expect.poll(async () => g.realId(id)).not.toBe(before)
  const forked = await g.realId(id)
  await expect.poll(async () => (await thread(g, id)).status).toBe('error')
  expect((await thread(g, id)).activities?.find(record => record.kind === 'turn' && record.status === 'failed')?.error).toMatch(/copy of its conversation/u)
  // The next send runs on the copy, which a new host built with the thread's servers.
  await send(g, 'Sent again')
  await g.driver.completeTurn(id, 'Second reply')
  await expect.poll(async () => (await thread(g, id)).status).toBe('idle')
  const resumes = (await records(g, 'session/resume')).filter(record => record.params?.sessionId === forked)
  expect(resumes.length).toBeGreaterThan(0)
  expect(Object.keys(servers(resumes[0]) ?? {}).map(name => name.replace(SUFFIX, ''))).toEqual(['sotto_browser', VISUAL_MCP_SERVER])
  expect(await texts(g)).toEqual(['Before the compaction', 'First reply', 'After the restart', 'Sent again', 'Second reply'])
  // Once per thread in a run: the copy is not copied again.
  expect(await records(g, 'session/fork')).toHaveLength(1)
})
