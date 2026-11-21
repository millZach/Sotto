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
  return { antigravity, control, service, model }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
const records = async (f: Fixture, method: string): Promise<RecordedRpc[]> => (await f.antigravity.requests()).filter(record => record.method === method)

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
