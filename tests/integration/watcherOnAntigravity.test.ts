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

it('lets Watcher read a thread twice on Full access without a permission card', async () => {
  const f = await fixture()
  expect(await f.service.setPermission({ runtimeMode: 'full-access' })).toMatchObject({ status: 'ok' })
  expect(await f.service.open({ provider: 'antigravity', modelId: f.model.id })).toMatchObject({ status: 'ok' })
  const id = f.service.state().current!.target.threadId
  expect((await f.control.commandShell({ type: 'manual-send', threadId: id, draftId: randomUUID(), text: 'Check the worker.' })).error).toBeNull()
  const adapterId = f.registry.byThread(id)!.sessionId
  for (const count of [1, 2]) {
    await f.antigravity.action(adapterId, { type: 'mcp-permission', tool: 'mcp_sotto_threads_read_thread' })
    await expect.poll(() => answers(f)).toEqual(Array.from({ length: count }, () => ({ outcome: 'selected', optionId: 'allow' })))
  }
  const thread = async () => (await f.antigravity.host.snapshot()).threads.find(item => item.id === adapterId)!
  expect((await thread()).requests).toEqual([])
  await f.antigravity.action(adapterId, { type: 'question', text: 'Run mcp_sotto_threads_read_thread' })
  await expect.poll(async () => (await thread()).requests.map(request => request.kind)).toEqual(['question'])
  await f.antigravity.action(adapterId, { type: 'mcp-permission', tool: 'mcp_sotto_threads_read_thread_extra' })
  await expect.poll(async () => (await thread()).requests.map(request => request.kind)).toEqual(['question', 'permission'])
  expect(await answers(f)).toHaveLength(2)
}, 90_000)
