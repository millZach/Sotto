// @vitest-environment node
/**
 * Sotto's tools and side writing on OpenCode (#1106, ADR-0087), over the scripted OpenCode server: each thread's own
 * server is given Sotto's tool servers as remote MCP servers with the thread's token, and side text comes from OpenCode's
 * stateless generation route on that server. `opencodeLive.test.ts` checks the same on OpenCode itself.
 */
import { randomUUID } from 'node:crypto'
import { realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
async function withTools(options: { visuals?: boolean; idle?: boolean; admitsVisuals?: (threadId: string) => boolean } = {}) {
  const f = await opencodeFixture(undefined, undefined, options.idle ? { reaperSweepMs: 50, sessionIdleMs: 300 } : {})
  cleanup.push(f.cleanup)
  const browser = new BrowserAgentServer(browserToolDefinitions, async () => ({ content: [] })); cleanup.push(() => browser.close())
  f.host.useBrowserTools(browser)
  if (options.visuals !== false) {
    const visuals = new VisualToolServer({ enabled: () => true, admits: options.admitsVisuals ?? (() => true), add: async () => ({ added: false, reason: 'unknown-thread' }) }); cleanup.push(() => visuals.close())
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
/** The rule set OpenCode was last given for a thread's provider session: at its creation, or by a change since. */
const rulesSent = (records: readonly RecordedRpc[]) => [...of(records, 'session.create'), ...of(records, 'session.update')].filter(record => record.params?.permissions).at(-1)?.params?.permissions
/** The effect of the last of `rules` that matches `action`, as OpenCode reads a rule set; none leaves it to OpenCode's own config. */
function effectOf(rules: readonly { action: string; effect: string }[], action: string): string | undefined {
  const matches = (pattern: string) => new RegExp('^' + pattern.split('*').map(part => part.replace(/[.+?^$()|[\]\\{}]/gu, '\\$&')).join('.*') + '$', 'u').test(action)
  return rules.filter(candidate => matches(candidate.action)).at(-1)?.effect
}
const browserAllows = browserToolDefinitions.map(tool => ({ action: `sotto_browser_${tool.name}`, resource: '*', effect: 'allow' }))
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

it('allows only the tools of the servers this thread was given, so a project server named like an absent one is still asked about', async () => {
  // Visuals are on, but this thread may not draw one: Sotto's visual server is not given to it.
  const { f } = await withTools({ admitsVisuals: () => false })
  await open(f)
  await expect.poll(async () => of(await f.driver.requests(), 'fixture/mcp-connected').map(record => record.params)).toEqual([{ server: 'sotto_browser', status: 'connected' }])
  await expect.poll(async () => rulesSent(await f.driver.requests())).toEqual([...opencodeRules('approval-required'), ...browserAllows])
  const rules = rulesSent(await f.driver.requests()) as { action: string; effect: string }[]
  // A project's own MCP server called `sotto_visual` with a `visualize` tool falls through the session's rules to the
  // project's config and OpenCode's own prompt; the browser the thread was given is Sotto's to answer.
  expect(effectOf(rules, `${VISUAL_MCP_SERVER}_visualize`)).toBeUndefined()
  expect(effectOf(rules, 'sotto_browser_browser_open')).toBe('allow')
})

it('allows Sotto’s tools on a provider session made before the thread had them, when that session is opened again', async () => {
  const f = await opencodeFixture(); cleanup.push(f.cleanup)
  const id = await open(f)
  expect(of(await f.driver.requests(), 'session.create')[0]!.params?.permissions).toEqual(opencodeRules('approval-required'))
  f.host.disconnect(); await f.adapter.closed()
  const browser = new BrowserAgentServer(browserToolDefinitions, async () => ({ content: [] })); cleanup.push(() => browser.close())
  f.host.useBrowserTools(browser)
  f.host.observeThreads([id]); await f.host.connect(); await f.host.refreshThread!(id)
  await expect.poll(async () => of(await f.driver.requests(), 'fixture/mcp-connected').length).toBe(1)
  // Its rule set keeps its mode and gains the allows, by a change to the live provider session; no session is made.
  await expect.poll(async () => of(await f.driver.requests(), 'session.update').at(-1)?.params?.permissions).toEqual([...opencodeRules('approval-required'), ...browserAllows])
  expect(of(await f.driver.requests(), 'session.create')).toHaveLength(1)
  expect((await thread(f, id)).runtimeMode).toBe('approval-required')
})

it('gives every one of Sotto’s servers again when a thread’s server starts after one that could not connect them', { timeout: 60_000 }, async () => {
  // Visuals admit a thread as the workspace does: one its host marks as without Sotto's tools is refused, and the mark
  // reaches it a moment after the host says so.
  let shown = new Map<string, boolean>()
  const { f } = await withTools({ idle: true, admitsVisuals: threadId => shown.get(threadId) !== true })
  f.host.subscribe(snapshot => { const next = new Map(snapshot.threads.map(item => [item.id, item.sottoToolsWithheld === true])); setTimeout(() => { shown = next }, 0) })
  await f.script({ mcp: { fail: true } })
  const id = await open(f)
  await expect.poll(async () => (await thread(f, id)).sottoToolsWithheld).toBe(true)
  await expect.poll(() => shown.get(id)).toBe(true)
  const first = (await f.driver.requests()).length
  // The thread sits idle, its server ends, and the next read starts a new one that can connect them.
  await f.script({})
  f.host.observeThreads([])
  await expect.poll(() => f.sessions.stopped(id), { timeout: 20_000 }).toBe(true)
  f.host.observeThreads([id]); await f.host.refreshThread!(id)
  await expect.poll(async () => of((await f.driver.requests()).slice(first), 'fixture/mcp-connected').map(record => record.params), { timeout: 20_000 })
    .toEqual(expect.arrayContaining([{ server: 'sotto_browser', status: 'connected' }, { server: VISUAL_MCP_SERVER, status: 'connected' }]))
  await expect.poll(async () => (await thread(f, id)).sottoToolsWithheld).toBeUndefined()
  await expect.poll(async () => rulesSent(await f.driver.requests())).toEqual([...opencodeRules('approval-required'), ...browserAllows,
    { action: `${VISUAL_MCP_SERVER}_visualize`, resource: '*', effect: 'allow' }])
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

it('stops a thread’s server within moments when OpenCode keeps saying it is not ready to take its tool servers off', { timeout: 60_000 }, async () => {
  const { f } = await withTools({ visuals: false, idle: true })
  const id = await open(f)
  await expect.poll(async () => of(await f.driver.requests(), 'fixture/mcp-connected').length).toBe(1)
  await f.scriptAlso({ mcp: { removeUnavailable: true } })
  f.host.observeThreads([])
  await expect.poll(async () => of(await f.driver.requests(), 'experimental.mcp.remove').length, { timeout: 20_000 }).toBeGreaterThan(0)
  // The whole removal is held to its few seconds, retries included, and the server stops whatever OpenCode said.
  await expect.poll(() => f.sessions.stopped(id), { timeout: 10_000 }).toBe(true)
})

it('keeps a thread’s new server’s answer about its tools when the server before it hears back about its own late', { timeout: 60_000 }, async () => {
  const { f, browser } = await withTools({ visuals: false, idle: true })
  // The first server's add waits until the test lets it go, and then finds the thread's old token refused.
  await f.script({ mcp: { hold: 'release-first-add' } })
  const id = await open(f)
  const first = (await f.holder(id))!
  await expect.poll(async () => of(await f.driver.requests(), 'experimental.mcp.add').length).toBe(1)
  // Its idle session ends, and OpenCode holds the removal of its tool servers as the thread's next server starts.
  await f.scriptAlso({ delay: { 'experimental.mcp.remove': 2_500 } })
  f.host.observeThreads([])
  await expect.poll(async () => of(await f.driver.requests(), 'experimental.mcp.remove').length, { timeout: 20_000 }).toBe(1)
  browser.revoke(id)
  f.host.observeThreads([id]); void f.host.refreshThread!(id)
  await expect.poll(async () => of(await f.driver.requests(), 'fixture/mcp-connected').map(record => [(record as { process?: number }).process === first, (record.params as { status: string }).status]))
    .toEqual([[false, 'connected']])
  await writeFile(join(f.root, 'release-first-add'), '')
  await expect.poll(() => f.running(first), { timeout: 20_000 }).toBe(false)
  // What the first server heard is not the thread's any more: the new server's tools stand.
  expect((await thread(f, id)).sottoToolsWithheld).toBeUndefined()
  await expect.poll(async () => rulesSent(await f.driver.requests())).toEqual([...opencodeRules('approval-required'), ...browserAllows])
})

for (const [what, mcp, withheld] of [['connects', { pendingMs: 1_500 }, undefined], ['cannot connect', { pendingMs: 1_500, fail: true }, true]] as const) {
  it(`waits for OpenCode to finish connecting a tool server it lists as pending, and then ${withheld ? 'marks the thread as without Sotto’s tools when it' : 'allows its tools when it'} ${what}`, async () => {
    const { f } = await withTools({ visuals: false })
    await f.script({ mcp })
    const shown: boolean[] = []
    f.host.subscribe(snapshot => { for (const item of snapshot.threads) shown.push(item.sottoToolsWithheld === true) })
    const id = await open(f)
    await expect.poll(async () => of(await f.driver.requests(), 'fixture/mcp-connected').map(record => record.params)).toEqual([{ server: 'sotto_browser', status: withheld ? 'failed' : 'connected' }])
    await expect.poll(async () => rulesSent(await f.driver.requests())).toEqual([...opencodeRules('approval-required'), ...withheld ? [] : browserAllows])
    await expect.poll(async () => (await thread(f, id)).sottoToolsWithheld).toBe(withheld)
    if (!withheld) {
      // It was never shown as without them while OpenCode was still connecting.
      expect(shown).not.toContain(true)
      expect(threadTakesSottoTools({ ...await thread(f, id), providerId: 'opencode' })).toBe(true)
    }
  })
}
