// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { MUSE_WATCHER_INSTRUCTIONS } from '../../src/main/agents/muse'
import { museToolName } from '../../src/main/agents/museRequests'
import { createAgentRuntime } from '../../src/main/agents/runtime'
import { watcherRequestLine, watcherRequestNote } from '../../src/main/agents/watcherRequestNote'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import type { RecordedRpc } from '../fixtures/adapterFixture'
import { codexFixture } from '../fixtures/codexFixture'
import { heldOperation } from '../fixtures/deferred'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { museFixture } from '../fixtures/museFixture'
import { testCredentials } from '../fixtures/testCredentials'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/**
 * Muse waits this long for one tool call here, standing in for its 300 seconds. Sotto answers five seconds before it,
 * as it answers by 295 on Muse; anything a worker holds longer than that comes back as a receipt to read.
 */
const TOOL_WAIT_SECONDS = 10
const SUFFIX = /_[0-9a-f]{10}$/u

async function fixture(script?: Record<string, unknown>) {
  const muse = await museFixture(undefined, 10_000, {}, { toolWaitSeconds: TOOL_WAIT_SECONDS })
  cleanups.push(muse.cleanup)
  if (script) await muse.script(script)
  const directory = join(muse.root, 'sotto'), projectPath = join(muse.root, 'worker-project')
  await mkdir(projectPath, { recursive: true })
  const worker = await codexFixture(undefined, false, 10_000)
  cleanups.push(worker.cleanup)
  const credentials = await testCredentials(join(directory, 'vault'), { mode: 'unavailable' })
  const settings = { ...DEFAULT_SETTINGS, threadTitles: false }
  const runtime = await createAgentRuntime({ directory, credentials, watcherEnabled: true, museEnabled: true, settings: () => settings,
    writingSettings: async () => settings, historyEnabled: () => true, openExternal: async () => undefined, reasoner: {},
    providers: { muse: muse.adapter, codex: worker.adapter, claude: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost() } })
  cleanups.push(runtime.close)
  const control = runtime.agentControl, service = runtime.watcher!
  await control.commandShell({ type: 'connect', provider: 'muse' })
  await control.commandShell({ type: 'connect', provider: 'codex' })
  await control.commandShell({ type: 'create-project', provider: 'codex', title: 'Synthetic project', path: projectPath, useExisting: true })
  const project = control.shell().host.projects.find(item => item.path === projectPath)!
  const museModel = control.shell().host.models.find(item => item.providerId === 'muse' && item.ready)!
  const workerModel = control.shell().host.models.find(item => item.providerId === 'codex' && item.ready)!
  return { muse, runtime, control, service, worker, project, museModel, workerModel }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

async function openWatcher(f: Fixture) {
  expect(await f.service.open({ provider: 'muse', modelId: f.museModel.id })).toMatchObject({ status: 'ok' })
  return f.service.state().current!.target.threadId
}
/** The Muse adapter's own ID for a Sotto thread, once its first send has created it there. */
const sessionOf = (f: Fixture, id: string): string => f.runtime.threadRegistry!.byThread(id)!.sessionId
const records = async (f: Fixture, method: string): Promise<RecordedRpc[]> => (await f.muse.driver.requests()).filter(record => record.method === method)
const servers = (record: RecordedRpc | undefined) => (record?.params?.config as { mcpServers?: Record<string, Record<string, unknown>> } | undefined)?.mcpServers ?? {}

/** The Muse model calls one of Watcher's tools, as Muse would on its turn, and Sotto's answer is read back. */
async function call(f: Fixture, session: string, tool: string, args: Record<string, unknown>) {
  const callId = randomUUID()
  await f.muse.action(session, { type: 'mcp-call', server: 'sotto_threads', tool, arguments: args, callId })
  let found: RecordedRpc | undefined
  await expect.poll(async () => (found = (await records(f, 'fixture/mcp-call')).find(record => record.params?.callId === callId)) !== undefined, { timeout: 20_000 }).toBe(true)
  return found!.params as { elapsedMs: number; limitMs: number; timedOut?: boolean; result: Record<string, unknown> | null }
}

it('runs Watcher on Muse with its own tools: lists, reads, starts a worker, and answers a long start before Muse gives up', async () => {
  const f = await fixture()
  const id = await openWatcher(f)
  // The user's first message creates Watcher in Muse. It goes with Watcher's instructions ahead of it and the request note
  // after it, and is shown as typed.
  const typed = 'Synthetic instruction to Watcher on Muse'
  expect((await f.control.commandShell({ type: 'manual-send', threadId: id, draftId: randomUUID(), text: typed })).error).toBeNull()
  const session = sessionOf(f, id)
  // Watcher's session starts on Muse's Ask me profile, with its own server under the thread's suffix and never the browser.
  const start = (await records(f, 'session/start')).at(-1)!
  expect(start.params).toMatchObject({ permissionProfile: ':ask-me' })
  const given = Object.keys(servers(start))
  expect(given.every(name => SUFFIX.test(name))).toBe(true)
  expect(given.map(name => name.replace(SUFFIX, ''))).toContain('sotto_threads')
  expect(given.map(name => name.replace(SUFFIX, ''))).not.toContain('sotto_browser')
  expect(servers(start)[given.find(name => name.startsWith('sotto_threads_'))!]).toMatchObject({ headers: { 'Sotto-Tool-Wait': String(TOOL_WAIT_SECONDS) } })

  const requestId = f.service.state().requests.at(-1)!.id
  const turn = (await records(f, 'turn/start')).at(-1)!
  expect(turn.params!.input).toEqual([{ type: 'text', text: MUSE_WATCHER_INSTRUCTIONS },
    { type: 'text', text: typed + watcherRequestLine(watcherRequestNote(requestId, f.control.hostId()!)) }])
  expect(turn.params!.displayText).toBe(typed)
  await f.control.commandShell({ type: 'observe-threads', threadIds: [id] })
  await expect.poll(() => f.control.threadDetail(id)?.messages.find(message => message.role === 'user')?.text).toBe(typed)

  // A Muse prompt before a call to Watcher's own tool is admitted once; the same tool name from a folded user server is not.
  const ownServer = given.find(name => name.startsWith('sotto_threads_'))!
  await f.muse.action(session, { type: 'tool-permission', toolName: museToolName(ownServer, 'list_threads') })
  await expect.poll(async () => (await records(f, 'approval/decide')).length).toBe(1)
  expect((await records(f, 'approval/decide'))[0]!.params).toMatchObject({ choiceId: 'yes' })
  await f.muse.action(session, { type: 'tool-permission', toolName: museToolName('sotto-threads', 'list_threads') })
  await expect.poll(() => f.control.watcherSnapshot().threads.find(thread => thread.id === id)?.requests.length).toBe(1)
  expect(await records(f, 'approval/decide')).toHaveLength(1)

  const listed = await call(f, session, 'list_threads', {})
  expect(listed.result).toMatchObject({ status: 'ok' })
  const projects = await call(f, session, 'list_projects', {})
  expect(projects.result).toMatchObject({ status: 'ok' })

  // A start whose worker is slow to take its prompt answers before Muse's limit, with the receipt to read.
  const gate = heldOperation()
  const prepare = f.worker.adapter.prepareSkillInput.bind(f.worker.adapter)
  vi.spyOn(f.worker.adapter, 'prepareSkillInput').mockImplementation(async (...input) => {
    const prepared = await prepare(...input)
    if (input[1] === 'Synthetic first prompt') await gate.wait()
    return prepared
  })
  const retryKey = randomUUID()
  const args = { requestId, retryKey, project: { hostId: f.control.hostId()!, projectId: f.project.id }, modelId: f.workerModel.id,
    title: 'Synthetic worker', workingCopy: { kind: 'shared' }, firstPrompt: 'Synthetic first prompt' }
  const late = await call(f, session, 'start_thread', args)
  await gate.entered
  try {
    expect(late.timedOut).toBeUndefined()
    expect(late.elapsedMs).toBeLessThan(late.limitMs)
    expect(late.result).toMatchObject({ status: 'refused', code: 'DELIVERY_UNCERTAIN', retryable: true, receipt: { deliveryState: expect.any(String) } })
    expect(String(late.result!.message)).toMatch(/not be sent twice/u)
  } finally { gate.release() }
  const operationId = (late.result!.receipt as { operationId: string }).operationId
  await expect.poll(() => f.service.state().receipts.find(receipt => receipt.id === operationId)?.deliveryState).toBe('accepted')

  // It resumes from the receipt: the outcome reads, and the same call again returns that receipt and sends nothing more.
  const read = await call(f, session, 'read_operation', { operationId })
  expect(read.result).toMatchObject({ status: 'ok', receipt: { operationId, deliveryState: 'accepted' } })
  const again = await call(f, session, 'start_thread', args)
  expect(again.result).toMatchObject({ status: 'ok', receipt: { operationId, deliveryState: 'accepted' } })
  const sent = (await f.worker.driver.requests()).filter(record => record.method === 'turn/start')
  expect(sent).toHaveLength(1)
  expect(JSON.stringify(sent[0]!.params)).toContain('Synthetic first prompt')
  const target = again.result!.target as { hostId: string; threadId: string }
  const thread = await call(f, session, 'read_thread', { target })
  expect(thread.result).toMatchObject({ status: 'ok' })
}, 90_000)

it('refuses Watcher on a Muse that cannot take session tool servers, in words that say what to do', async () => {
  const f = await fixture({ sessionMcp: false })
  const id = await openWatcher(f)
  const sent = await f.control.commandShell({ type: 'manual-send', threadId: id, draftId: randomUUID(), text: 'Synthetic first message' })
  expect(sent.error).toMatch(/Update Muse to 1\.4\.7 or newer/u)
  // Nothing was started in Muse for it.
  expect(await records(f, 'session/start')).toHaveLength(0)
  expect(await records(f, 'turn/start')).toHaveLength(0)
}, 60_000)

it('refuses Watcher on a Muse that cannot leave its approvals to the user', async () => {
  for (const script of [{ permissionProfiles: false }, { reviewerAuthority: 'autoReview' }]) {
    const f = await fixture(script)
    const id = await openWatcher(f)
    const sent = await f.control.commandShell({ type: 'manual-send', threadId: id, draftId: randomUUID(), text: 'Synthetic first message' })
    expect(sent.error).toMatch(/its own reviewer decide Watcher’s approvals/u)
    expect(await records(f, 'turn/start')).toHaveLength(0)
  }
}, 90_000)
