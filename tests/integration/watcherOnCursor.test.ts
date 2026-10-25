// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { cursorWatcherInstructions } from '../../src/main/agents/cursor'
import { createAgentRuntime } from '../../src/main/agents/runtime'
import { watcherRequestLine, watcherRequestNote } from '../../src/main/agents/watcherRequestNote'
import { heldProvidersOf } from '../../src/shared/heldProviders'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import type { RecordedRpc } from '../fixtures/adapterFixture'
import { codexFixture } from '../fixtures/codexFixture'
import { cursorFixture } from '../fixtures/fakeCursorFixture'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { testCredentials } from '../fixtures/testCredentials'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** Sotto's runtime with Watcher on, Cursor's Owl gate open, a fake Cursor and a fake Codex for Watcher's workers. */
async function fixture() {
  const cursor = await cursorFixture(undefined, 10_000)
  cleanups.push(cursor.cleanup)
  const directory = join(cursor.root, 'sotto'), projectPath = join(cursor.root, 'worker-project')
  await mkdir(projectPath, { recursive: true })
  const worker = await codexFixture(undefined, false, 10_000)
  cleanups.push(worker.cleanup)
  const credentials = await testCredentials(join(directory, 'vault'), { mode: 'unavailable' })
  const settings = { ...DEFAULT_SETTINGS, threadTitles: false }
  const runtime = await createAgentRuntime({ directory, credentials, watcherEnabled: true, heldProviders: heldProvidersOf({ cursor: true }), settings: () => settings,
    writingSettings: async () => settings, historyEnabled: () => true, openExternal: async () => undefined, reasoner: {},
    providers: { cursor: cursor.adapter, codex: worker.adapter, claude: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost() } })
  cleanups.push(runtime.close)
  const control = runtime.agentControl, service = runtime.watcher!
  await control.commandShell({ type: 'connect', provider: 'cursor' })
  await control.commandShell({ type: 'connect', provider: 'codex' })
  await control.commandShell({ type: 'create-project', provider: 'codex', title: 'Synthetic project', path: projectPath, useExisting: true })
  const project = control.shell().host.projects.find(item => item.path === projectPath)!
  const cursorModel = control.shell().host.models.find(item => item.providerId === 'cursor' && item.ready)!
  const workerModel = control.shell().host.models.find(item => item.providerId === 'codex' && item.ready)!
  return { cursor, runtime, control, service, worker, project, cursorModel, workerModel }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

/** The Cursor adapter's own ID for a Sotto thread, once its first send has created it there. */
const sessionOf = (f: Fixture, id: string): string => f.runtime.threadRegistry!.byThread(id)!.sessionId
const records = async (f: Fixture, method: string): Promise<RecordedRpc[]> => (await f.cursor.requests()).filter(record => record.method === method)

/** Cursor's model calls one of Watcher's tools on its session's server, as Cursor would on its turn, and Sotto's answer is read back. */
async function call(f: Fixture, id: string, tool: string, args: Record<string, unknown>) {
  const callId = randomUUID()
  await f.cursor.action(sessionOf(f, id), { type: 'mcp-call', server: 'sotto_threads', tool, arguments: args, callId })
  let found: RecordedRpc | undefined
  await expect.poll(async () => (found = (await records(f, 'fixture/mcp-call')).find(record => record.params?.callId === callId)) !== undefined, { timeout: 20_000 }).toBe(true)
  return found!.params as { status?: number; missing?: boolean; failed?: string; result: Record<string, unknown> | null }
}

it('runs Watcher on Cursor with its own tools: lists, starts a worker and reads it, and shows the user’s words as typed', async () => {
  const f = await fixture()
  expect(await f.service.open({ provider: 'cursor', modelId: f.cursorModel.id })).toMatchObject({ status: 'ok' })
  const id = f.service.state().current!.target.threadId
  expect(f.service.state().current!.provider).toBe('cursor')

  // The user's first message makes Watcher's session in Cursor, with Watcher's own server and never the browser.
  const typed = 'Synthetic instruction to Watcher on Cursor'
  expect((await f.control.commandShell({ type: 'manual-send', threadId: id, draftId: randomUUID(), text: typed })).error).toBeNull()
  const made = (await records(f, 'session/new')).at(-1)!
  const servers = made.params!.mcpServers as { name: string }[]
  expect(servers.map(server => server.name)).toContain('sotto_threads')
  expect(servers.map(server => server.name)).not.toContain('sotto_browser')
  const config = JSON.parse(await readFile(join(f.cursor.root, 'cursor-config', 'cli-config.json'), 'utf8')) as { permissions: { allow: string[] } }
  expect(config.permissions.allow).toContain('Mcp(sotto_threads:*)')

  // Watcher's instructions ahead of the words, the request note after them; a new Watcher is asked to read its state first.
  const requestId = f.service.state().requests.at(-1)!.id
  const prompt = (await records(f, 'session/prompt')).at(-1)!
  expect((prompt.params!.prompt as { text: string }[])[0]!.text)
    .toBe(cursorWatcherInstructions() + typed + watcherRequestLine(watcherRequestNote(requestId, f.control.hostId()!, true)))
  await f.control.commandShell({ type: 'observe-threads', threadIds: [id] })
  await expect.poll(() => f.control.threadDetail(id)?.messages.find(message => message.role === 'user')?.text).toBe(typed)

  // Watcher's tools answer Cursor's calls through the thread's own bearer token.
  const listed = await call(f, id, 'list_threads', {})
  expect(listed).toMatchObject({ status: 200, result: { status: 'ok' } })
  const projects = await call(f, id, 'list_projects', {})
  expect(projects.result).toMatchObject({ status: 'ok' })
  const started = await call(f, id, 'start_thread', { requestId, retryKey: randomUUID(), project: { hostId: f.control.hostId()!, projectId: f.project.id },
    modelId: f.workerModel.id, title: 'Synthetic worker', workingCopy: { kind: 'shared' }, firstPrompt: 'Synthetic first prompt' })
  expect(started.result).toMatchObject({ status: 'ok', receipt: { deliveryState: expect.any(String) } })
  const sent = (await f.worker.driver.requests()).filter(record => record.method === 'turn/start')
  expect(sent).toHaveLength(1)
  expect(JSON.stringify(sent[0]!.params)).toContain('Synthetic first prompt')
  const target = started.result!.target as { hostId: string; threadId: string }
  expect((await call(f, id, 'read_thread', { target })).result).toMatchObject({ status: 'ok' })
}, 90_000)

it('keeps an ordinary Cursor thread off Watcher’s server', async () => {
  const f = await fixture()
  await f.control.commandShell({ type: 'create-project', provider: 'cursor', title: 'Cursor project', path: f.cursor.root, useExisting: true })
  const project = f.control.shell().host.projects.find(item => item.path === f.cursor.root && item.providerId === 'cursor')
    ?? f.control.shell().host.projects.find(item => item.path === f.cursor.root)!
  const created = await f.control.commandShell({ type: 'create-thread', projectId: project.id, modelId: f.cursorModel.id, title: 'Ordinary' })
  expect(created.error).toBeNull()
  const id = f.control.shell().host.threads.find(thread => thread.title === 'Ordinary')!.id
  expect((await f.control.commandShell({ type: 'manual-send', threadId: id, draftId: randomUUID(), text: 'Synthetic ordinary prompt' })).error).toBeNull()
  const made = (await records(f, 'session/new')).at(-1)!
  expect((made.params!.mcpServers as { name: string }[]).map(server => server.name)).not.toContain('sotto_threads')
  expect((await call(f, id, 'list_threads', {})).missing).toBe(true)
}, 60_000)
