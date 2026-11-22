// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createAgentRuntime } from '../../src/main/agents/runtime'
import { watcherRequestLine, watcherRequestNote } from '../../src/main/agents/watcherRequestNote'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import type { RecordedRpc } from '../fixtures/adapterFixture'
import { codexFixture } from '../fixtures/codexFixture'
import { antigravityFixture } from '../fixtures/fakeAntigravityFixture'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { testCredentials } from '../fixtures/testCredentials'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** Sotto's runtime with Watcher on, a fake `agy` and a fake Codex for Watcher's workers (ADR-0212). */
async function fixture() {
  const antigravity = await antigravityFixture(undefined, 10_000)
  cleanups.push(antigravity.cleanup)
  const directory = join(antigravity.root, 'sotto'), projectPath = join(antigravity.root, 'worker-project')
  await mkdir(projectPath, { recursive: true })
  const worker = await codexFixture(undefined, false, 10_000)
  cleanups.push(worker.cleanup)
  const credentials = await testCredentials(join(directory, 'vault'), { mode: 'unavailable' })
  const settings = { ...DEFAULT_SETTINGS, threadTitles: false }
  const runtime = await createAgentRuntime({ directory, credentials, watcherEnabled: true, settings: () => settings,
    writingSettings: async () => settings, historyEnabled: () => true, openExternal: async () => undefined, reasoner: {},
    providers: { antigravity: antigravity.adapter, codex: worker.adapter, claude: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost() } })
  cleanups.push(runtime.close)
  const control = runtime.agentControl, service = runtime.watcher!
  await control.commandShell({ type: 'connect', provider: 'antigravity' })
  await control.commandShell({ type: 'connect', provider: 'codex' })
  const model = control.shell().host.models.find(item => item.providerId === 'antigravity' && item.ready)!
  return { antigravity, control, service, model, registry: runtime.threadRegistry!, host: runtime.agentHost }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
const records = async (f: Fixture, method: string): Promise<RecordedRpc[]> => (await f.antigravity.requests()).filter(record => record.method === method)
const answers = async (f: Fixture) => (await f.antigravity.requests()).filter(record => record.result?.outcome).map(record => record.result!.outcome)

it('runs Watcher on Antigravity with its own tools and its instructions in agy’s system prompt, never in the user’s words', async () => {
  const f = await fixture()
  expect(await f.service.open({ provider: 'antigravity', modelId: f.model.id })).toMatchObject({ status: 'ok' })
  const id = f.service.state().current!.target.threadId
  expect(f.service.state().current!.provider).toBe('antigravity')

  const typed = 'Synthetic instruction to Watcher on Antigravity'
  expect((await f.control.commandShell({ type: 'manual-send', threadId: id, draftId: randomUUID(), text: typed })).error).toBeNull()
  const made = (await records(f, 'session/new')).at(-1)!
  const servers = made.params!.mcpServers as { name: string }[]
  expect(servers.map(server => server.name)).toContain('sotto_threads')
  expect(servers.map(server => server.name)).not.toContain('sotto_browser')
  const append = (made.params!._meta as { antigravity: { systemPrompt: { append: string } } }).antigravity.systemPrompt.append
  expect(append).toContain('Watcher')
  // agy's own question tool is closed to Watcher (ADR-0073): its process is offered no forms, so it never asks with one.
  expect((await records(f, 'initialize')).map(record => (record.params!.clientCapabilities as { elicitation?: unknown }).elicitation)).not.toContainEqual({ form: {} })

  // The words go as typed, with only the request note's line after them.
  const requestId = f.service.state().requests.at(-1)!.id
  const prompt = (await records(f, 'session/prompt')).at(-1)!
  expect((prompt.params!.prompt as { text: string }[])[0]!.text).toBe(typed + watcherRequestLine(watcherRequestNote(requestId, f.control.hostId()!, true)))
  await f.control.commandShell({ type: 'observe-threads', threadIds: [id] })
  await expect.poll(() => f.control.threadDetail(id)?.messages.find(message => message.role === 'user')?.text).toBe(typed)
}, 90_000)

it('admits plugin reads on Ask for approval and shows a card for a tool outside Watcher’s plugin list', async () => {
  const f = await fixture()
  const definitions = ['plugin_read', 'mail_send'].map(name => ({ name, description: name, inputSchema: { type: 'object' } }))
  f.host.useThreadTools([{
    name: 'sotto_plugins', definitions,
    definitionsFor: threadId => f.service.isCurrent(threadId) ? definitions.slice(0, 1) : definitions,
    mcpServer: async () => ({ name: 'sotto_plugins', type: 'http', url: 'http://127.0.0.1:12345/mcp', headers: [] }),
  }])
  expect(await f.service.open({ provider: 'antigravity', modelId: f.model.id })).toMatchObject({ status: 'ok' })
  const id = f.service.state().current!.target.threadId
  expect((await f.control.commandShell({ type: 'manual-send', threadId: id, draftId: randomUUID(), text: 'Check the plugins.' })).error).toBeNull()
  const adapterId = f.registry.byThread(id)!.sessionId
  await f.antigravity.action(adapterId, { type: 'mcp-permission', tool: 'mcp_sotto_plugins_plugin_read' })
  await expect.poll(() => answers(f)).toEqual([{ outcome: 'selected', optionId: 'allow' }])
  await f.antigravity.action(adapterId, { type: 'mcp-permission', tool: 'mcp_sotto_plugins_mail_send' })
  await expect.poll(async () => (await f.antigravity.host.snapshot()).threads.find(item => item.id === adapterId)?.requests.map(request => request.text))
    .toEqual(['Run mcp_sotto_plugins_mail_send'])
}, 90_000)

it('leaves native execute and edit permissions on cards in Ask for approval, and admits only scoped MCP tools', async () => {
  const f = await fixture()
  expect(await f.service.open({ provider: 'antigravity', modelId: f.model.id })).toMatchObject({ status: 'ok' })
  const id = f.service.state().current!.target.threadId
  expect((await f.control.commandShell({ type: 'manual-send', threadId: id, draftId: randomUUID(), text: 'Check files.' })).error).toBeNull()
  const adapterId = f.registry.byThread(id)!.sessionId
  const thread = async () => (await f.antigravity.host.snapshot()).threads.find(item => item.id === adapterId)!

  await f.antigravity.action(adapterId, { type: 'mcp-permission', tool: 'mcp_sotto_threads_read_thread' })
  await expect.poll(() => answers(f)).toEqual([{ outcome: 'selected', optionId: 'allow' }])

  await f.antigravity.action(adapterId, { type: 'edit-permission' })
  await expect.poll(async () => (await thread()).requests.length).toBe(1)
  await f.antigravity.action(adapterId, { type: 'permission', text: 'pwd' })
  await expect.poll(async () => (await thread()).requests.length).toBe(2)
  expect(await answers(f)).toHaveLength(1)
}, 90_000)

it('allows Watcher native file edits once on Allow edits while keeping native commands on cards', async () => {
  const f = await fixture()
  expect(await f.service.setPermission({ runtimeMode: 'auto-accept-edits' })).toMatchObject({ status: 'ok' })
  expect(await f.service.open({ provider: 'antigravity', modelId: f.model.id })).toMatchObject({ status: 'ok' })
  const id = f.service.state().current!.target.threadId
  expect((await f.control.commandShell({ type: 'manual-send', threadId: id, draftId: randomUUID(), text: 'Check and edit.' })).error).toBeNull()
  const adapterId = f.registry.byThread(id)!.sessionId
  const thread = async () => (await f.antigravity.host.snapshot()).threads.find(item => item.id === adapterId)!

  await f.antigravity.action(adapterId, { type: 'mcp-permission', tool: 'mcp_sotto_threads_read_thread' })
  await expect.poll(() => answers(f)).toEqual([{ outcome: 'selected', optionId: 'allow' }])
  await f.antigravity.action(adapterId, { type: 'edit-permission' })
  await expect.poll(() => answers(f)).toEqual([{ outcome: 'selected', optionId: 'allow' }, { outcome: 'selected', optionId: 'allow-once' }])
  expect((await thread()).requests).toEqual([])

  await f.antigravity.action(adapterId, { type: 'permission', text: 'git status' })
  await expect.poll(async () => (await thread()).requests.length).toBe(1)
  await f.antigravity.action(adapterId, { type: 'mcp-permission', tool: 'mcp_sotto_threads_read_thread_extra' })
  await expect.poll(async () => (await thread()).requests.length).toBe(2)
  expect(await answers(f)).toHaveLength(2)
}, 90_000)

it('lets Watcher run native permissions once and scoped tools on Full access across resume while keeping questions and always-only asks on cards', async () => {
  const f = await fixture()
  expect(await f.service.setPermission({ runtimeMode: 'full-access' })).toMatchObject({ status: 'ok' })
  expect(await f.service.open({ provider: 'antigravity', modelId: f.model.id })).toMatchObject({ status: 'ok' })
  const id = f.service.state().current!.target.threadId
  expect((await f.control.commandShell({ type: 'manual-send', threadId: id, draftId: randomUUID(), text: 'Check the worker.' })).error).toBeNull()
  const adapterId = f.registry.byThread(id)!.sessionId
  const thread = async () => (await f.antigravity.host.snapshot()).threads.find(item => item.id === adapterId)!

  for (const count of [1, 2]) {
    await f.antigravity.action(adapterId, { type: 'mcp-permission', tool: 'mcp_sotto_threads_read_thread' })
    await expect.poll(() => answers(f)).toEqual(Array.from({ length: count }, () => ({ outcome: 'selected', optionId: 'allow' })))
  }
  await f.antigravity.action(adapterId, { type: 'permission', text: 'Get-ChildItem' })
  await expect.poll(() => answers(f)).toEqual([
    { outcome: 'selected', optionId: 'allow' },
    { outcome: 'selected', optionId: 'allow' },
    { outcome: 'selected', optionId: 'allow-once' },
  ])
  await f.antigravity.action(adapterId, { type: 'edit-permission' })
  await expect.poll(() => answers(f)).toEqual([
    { outcome: 'selected', optionId: 'allow' },
    { outcome: 'selected', optionId: 'allow' },
    { outcome: 'selected', optionId: 'allow-once' },
    { outcome: 'selected', optionId: 'allow-once' },
  ])
  // Unadvertised MCP tools fall through to Full access once (never allow_always) instead of blocking Watcher.
  await f.antigravity.action(adapterId, { type: 'mcp-permission', tool: 'mcp_sotto_threads_read_thread_extra' })
  await expect.poll(() => answers(f)).toEqual([
    { outcome: 'selected', optionId: 'allow' },
    { outcome: 'selected', optionId: 'allow' },
    { outcome: 'selected', optionId: 'allow-once' },
    { outcome: 'selected', optionId: 'allow-once' },
    { outcome: 'selected', optionId: 'allow' },
  ])
  expect((await thread()).requests).toEqual([])

  // Reconnect and resume Watcher on Full access: native permissions still answer once without a card.
  await f.antigravity.driver.completeTurn(adapterId, 'Checked once.')
  await expect.poll(async () => (await thread()).status).toBe('idle')
  f.antigravity.host.disconnect(); await f.antigravity.host.closed()
  await f.antigravity.host.connect()
  await f.control.commandShell({ type: 'observe-threads', threadIds: [id] })
  expect((await f.control.commandShell({ type: 'manual-send', threadId: id, draftId: randomUUID(), text: 'Check again after resume.' })).error).toBeNull()
  await f.antigravity.action(adapterId, { type: 'permission', text: 'git status' })
  await expect.poll(async () => (await answers(f)).length).toBe(6)
  expect((await answers(f)).at(-1)).toEqual({ outcome: 'selected', optionId: 'allow-once' })

  // Always-only options, interaction_* questions and forms never auto-allow on Full access.
  await f.antigravity.action(adapterId, { type: 'permission-always-only', text: 'rm -rf temp' })
  await expect.poll(async () => (await thread()).requests.map(request => request.kind)).toEqual(['permission'])
  await f.antigravity.action(adapterId, { type: 'question', text: 'Which worker?' })
  await expect.poll(async () => (await thread()).requests.map(request => request.kind)).toEqual(['permission', 'question'])
  // Watcher's initialize capability omits elicitation.form, so ask-question falls back to text and adds no card.
  await f.antigravity.action(adapterId, { type: 'ask-question', questions: [{ question: 'Pick a branch', options: ['main', 'dev'] }] })
  await expect.poll(async () => (await thread()).status).toBe('idle')
  expect((await thread()).requests.map(request => request.kind)).toEqual(['permission', 'question'])
  expect((await answers(f)).some(item => (item as { optionId?: string }).optionId === 'remember-this')).toBe(false)
}, 90_000)

it('takes a waiting permission off Watcher when moved to Full access and restores cards when narrowed back to Ask for approval', async () => {
  const f = await fixture()
  expect(await f.service.open({ provider: 'antigravity', modelId: f.model.id })).toMatchObject({ status: 'ok' })
  const id = f.service.state().current!.target.threadId
  expect((await f.control.commandShell({ type: 'manual-send', threadId: id, draftId: randomUUID(), text: 'Run check.' })).error).toBeNull()
  const adapterId = f.registry.byThread(id)!.sessionId
  const thread = async () => (await f.antigravity.host.snapshot()).threads.find(item => item.id === adapterId)!

  await f.antigravity.action(adapterId, { type: 'permission', text: 'git status' })
  await expect.poll(async () => (await thread()).requests.length).toBe(1)

  // Moving the Watcher session to Full access clears its waiting permission card once.
  expect(await f.antigravity.host.execute({ type: 'configure-thread', commandId: randomUUID(), threadId: adapterId, runtimeMode: 'full-access' })).toMatchObject({ accepted: true })
  await expect.poll(() => answers(f)).toEqual([{ outcome: 'selected', optionId: 'allow-once' }])
  expect((await thread()).requests).toEqual([])
  await f.antigravity.driver.completeTurn(adapterId, 'Done.')
  await expect.poll(async () => (await thread()).status).toBe('idle')

  // Narrowing back via WatcherService.setPermission makes the next native command prompt again.
  expect(await f.service.setPermission({ runtimeMode: 'full-access' })).toMatchObject({ status: 'ok' })
  expect(await f.service.setPermission({ runtimeMode: 'approval-required' })).toMatchObject({ status: 'ok' })
  expect((await f.control.commandShell({ type: 'manual-send', threadId: id, draftId: randomUUID(), text: 'Run again in ask mode.' })).error).toBeNull()
  await f.antigravity.action(adapterId, { type: 'permission', text: 'git status' })
  await expect.poll(async () => (await thread()).requests.length).toBe(1)
  expect(await answers(f)).toHaveLength(1)
}, 90_000)
