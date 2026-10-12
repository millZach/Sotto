// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createAgentRuntime } from '../../src/main/agents/runtime'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { testCredentials } from '../fixtures/testCredentials'
import { codexFixture } from '../fixtures/codexFixture'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { heldOperation } from '../fixtures/deferred'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture(requestTimeout = 10_000) {
  const native = await codexFixture(undefined, false, requestTimeout)
  cleanups.push(native.cleanup)
  const directory = join(native.root, 'sotto'), projectPath = join(native.root, 'worker-project')
  await mkdir(projectPath)
  const credentials = await testCredentials(join(directory, 'vault'), { mode: 'unavailable' })
  const settings = { ...DEFAULT_SETTINGS, threadTitles: false }
  const runtime = await createAgentRuntime({ directory, credentials, watcherEnabled: true, settings: () => settings,
    writingSettings: async () => settings, historyEnabled: () => true, openExternal: async () => undefined, reasoner: {},
    providers: { codex: native.adapter, claude: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost() } })
  cleanups.push(runtime.close)
  const control = runtime.agentControl, service = runtime.watcher!, tools = runtime.watcherTools!
  await control.commandShell({ type: 'connect', provider: 'codex' })
  await control.commandShell({ type: 'create-project', provider: 'codex', title: 'Synthetic project', path: projectPath, useExisting: true })
  const project = control.shell().host.projects.find(item => item.path === projectPath)!, model = control.shell().host.models.find(item => item.providerId === 'codex' && item.ready)!
  expect(await service.open({ provider: 'codex', modelId: model.id })).toMatchObject({ status: 'ok' })
  const id = service.state().current!.target.threadId
  await control.commandShell({ type: 'manual-send', threadId: id, draftId: randomUUID(), text: 'Synthetic root request' })
  const requestId = service.state().requests.at(-1)!.id
  const result = (await tools.call(id, 'start_thread', { requestId, retryKey: randomUUID(), project: { hostId: control.hostId()!, projectId: project.id },
    modelId: model.id, title: 'Synthetic worker', workingCopy: { kind: 'shared' }, firstPrompt: 'Synthetic first prompt' })).structuredContent!
  expect(result.status).toBe('ok')
  const target = result.target as { hostId: string; threadId: string }, binding = runtime.threadRegistry!.byThread(target.threadId)!
  return { ...runtime, native, control, service, tools, id, requestId, target, binding, settings, project, model }
}

it('rechecks takeover after native Codex preparation, before turn/start', async () => {
  const f = await fixture(), gate = heldOperation()
  await f.native.driver.completeTurn(f.binding.sessionId, 'Synthetic completion')
  await expect.poll(() => f.control.watcherSnapshot().threads.find(item => item.id === f.target.threadId)?.status).toBe('idle')
  const prepare = f.native.adapter.prepareSkillInput.bind(f.native.adapter)
  vi.spyOn(f.native.adapter, 'prepareSkillInput').mockImplementation(async (...args) => {
    const result = await prepare(...args)
    if (args[1] === 'Synthetic held machine prompt') await gate.wait()
    return result
  })
  const machine = f.tools.call(f.id, 'send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: f.target, delivery: 'now', text: 'Synthetic held machine prompt' })
  try {
    await gate.entered
    const messageId = f.service.state().receipts.at(-1)!.messageId
    await f.control.commandShell({ type: 'queue-followup', threadId: f.target.threadId, draftId: randomUUID(), text: 'Synthetic direct user continuation' })
    gate.release()
    expect((await machine).structuredContent).toMatchObject({ status: 'refused', code: 'THREAD_TAKEN_OVER' })
    expect((await f.native.driver.requests()).some(item => item.method === 'turn/start' && item.params?.clientUserMessageId === messageId)).toBe(false)
  } finally { gate.release(); await machine }
}, 60_000)

it('a machine stop cancels a native turn without answering its pending question', async () => {
  const f = await fixture()
  await f.native.driver.raiseQuestion(f.binding.sessionId, 'Synthetic pending question')
  await expect.poll(() => f.control.watcherSnapshot().threads.find(item => item.id === f.target.threadId)?.requests.length).toBe(1)
  const before = await f.native.driver.requests()
  expect((await f.tools.call(f.id, 'stop_thread', { requestId: f.requestId, retryKey: randomUUID(), target: f.target })).structuredContent).toMatchObject({ status: 'ok' })
  const after = await f.native.driver.requests()
  expect(after.filter(item => item.method === 'turn/interrupt').length).toBeGreaterThan(before.filter(item => item.method === 'turn/interrupt').length)
  expect(after.filter(item => item.method === 'request/answer')).toEqual(before.filter(item => item.method === 'request/answer'))
}, 60_000)


it('refunds a native question appearing during preparation before any writer dispatch', async () => {
  const f = await fixture(), gate = heldOperation()
  await f.native.driver.completeTurn(f.binding.sessionId, 'Synthetic completion')
  await expect.poll(() => f.control.watcherSnapshot().threads.find(item => item.id === f.target.threadId)?.status).toBe('idle')
  const prepare = f.native.adapter.prepareSkillInput.bind(f.native.adapter)
  vi.spyOn(f.native.adapter, 'prepareSkillInput').mockImplementation(async (...args) => {
    const result = await prepare(...args)
    if (args[1] === 'Synthetic pending preparation') await gate.wait()
    return result
  })
  const machine = f.tools.call(f.id, 'send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: f.target, delivery: 'now', text: 'Synthetic pending preparation' })
  try {
    await gate.entered
    const messageId = f.service.state().receipts.at(-1)!.messageId
    await f.native.driver.raiseQuestion(f.binding.sessionId, 'Synthetic late question')
    await expect.poll(() => f.control.watcherSnapshot().threads.find(item => item.id === f.target.threadId)?.requests.length).toBe(1)
    gate.release()
    expect((await machine).structuredContent).toMatchObject({ status: 'refused', code: 'PENDING_USER_REQUEST' })
    expect(f.service.state().requests[0]!.participants[0]!.promptCount).toBe(1)
    expect((await f.native.driver.requests()).some(item => item.method === 'turn/start' && item.params?.clientUserMessageId === messageId)).toBe(false)
  } finally { gate.release(); await machine }
}, 60_000)

it('holds capacity for a lost native creation acknowledgement and never creates it twice', async () => {
  const f = await fixture(2_000); f.settings.watcherInFlightLimit = 2
  await writeFile(join(f.native.root, 'script.json'), JSON.stringify({ delay: { method: 'thread/start', ms: 3000 }, suppressNotifications: true }))
  const input = { requestId: f.requestId, retryKey: randomUUID(), project: { hostId: f.control.hostId()!, projectId: f.project.id },
    modelId: f.model.id, title: 'Synthetic uncertain creation', workingCopy: { kind: 'shared' }, firstPrompt: 'Synthetic unsent first prompt' }
  const result = (await f.tools.call(f.id, 'start_thread', input)).structuredContent!
  expect(result).toMatchObject({ status: 'refused', code: 'DELIVERY_UNCERTAIN', receipt: { deliveryState: 'uncertain' } })
  expect(f.service.state().inFlight).toBe(2)
  const count = (await f.native.driver.requests()).filter(item => item.method === 'thread/start').length
  expect((await f.tools.call(f.id, 'start_thread', input)).structuredContent).toEqual(result)
  expect((await f.native.driver.requests()).filter(item => item.method === 'thread/start')).toHaveLength(count)
  expect((await f.tools.call(f.id, 'start_thread', { ...input, retryKey: randomUUID() })).structuredContent).toMatchObject({ status: 'refused', code: 'IN_FLIGHT_LIMIT' })
}, 60_000)

it('fences a saved user queue at the native writer when machine Stop arrives during preparation', async () => {
  const f = await fixture(), gate = heldOperation()
  const threadId = randomUUID()
  expect((await f.control.commandShell({ type: 'create-thread', threadId, projectId: f.project.id, title: 'Synthetic user worker', modelId: f.model.id })).error).toBeNull()
  expect((await f.control.commandShell({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'Synthetic user work' })).error).toBeNull()
  const binding = f.threadRegistry!.byThread(threadId)!
  const draftId = randomUUID()
  await f.control.commandShell({ type: 'queue-followup', threadId, draftId, text: 'Synthetic held saved user prompt' })
  const prepare = f.native.adapter.prepareSkillInput.bind(f.native.adapter)
  vi.spyOn(f.native.adapter, 'prepareSkillInput').mockImplementation(async (...args) => {
    const result = await prepare(...args)
    if (args[1] === 'Synthetic held saved user prompt') await gate.wait()
    return result
  })
  try {
    await f.native.driver.completeTurn(binding.sessionId, 'Synthetic completed user work')
    await gate.entered
    const messageId = f.control.shell().followups!.find(item => item.draftId === draftId)!.messageId
    expect(messageId).toBeTruthy()
    expect((await f.tools.call(f.id, 'stop_thread', { requestId: f.requestId, retryKey: randomUUID(),
      target: { hostId: f.control.hostId()!, threadId } })).structuredContent).toMatchObject({ status: 'ok' })
    expect(f.control.watcherSnapshot().threads.find(item => item.id === threadId)?.lastTurn?.status).toBe('completed')
    gate.release()
    await expect.poll(() => f.control.shell().followups!.find(item => item.draftId === draftId)?.status).not.toBe('dispatching')
    expect((await f.native.driver.requests()).some(item => item.method === 'turn/start' && item.params?.clientUserMessageId === messageId)).toBe(false)
    expect(f.control.shell().followups!.find(item => item.draftId === draftId)).toMatchObject({ status: 'failed', text: 'Synthetic held saved user prompt' })
  } finally { gate.release() }
}, 60_000)


it('fences a wake-up at the native writer when Watcher stops its worker during preparation', async () => {
  const f = await fixture(), gate = heldOperation()
  const prepare = f.native.adapter.prepareSkillInput.bind(f.native.adapter)
  vi.spyOn(f.native.adapter, 'prepareSkillInput').mockImplementation(async (...args) => {
    const result = await prepare(...args)
    if (args[1].includes('https://github.com/synthetic/project/pull/4')) await gate.wait()
    return result
  })
  try {
    await f.control.deliverWakeUp(f.target.threadId, { pullRequest: { url: 'https://github.com/synthetic/project/pull/4', number: 4, title: 'Synthetic pull request' },
      startedBy: 'user', head: null, ended: null, changes: [{ kind: 'checks-passed', count: 1, required: true }] }, { tool: false })
    await f.native.driver.completeTurn(f.binding.sessionId, 'Synthetic completion before the wake-up')
    await gate.entered
    const messageId = f.control.shell().followups!.find(item => item.threadId === f.target.threadId && item.wakeUp)!.messageId
    expect(messageId).toBeTruthy()
    expect((await f.tools.call(f.id, 'stop_thread', { requestId: f.requestId, retryKey: randomUUID(), target: f.target })).structuredContent).toMatchObject({ status: 'ok' })
    expect(f.service.preserveUserQueue(f.target.threadId)).toBe(true)
    expect(f.control.watcherSnapshot().threads.find(item => item.id === f.target.threadId)?.lastTurn?.status).toBe('completed')
    gate.release()
    await expect.poll(() => f.control.shell().followups!.find(item => item.threadId === f.target.threadId && item.wakeUp)?.status).not.toBe('dispatching')
    const requests = await f.native.driver.requests()
    expect(requests.some(item => item.method === 'turn/start' && item.params?.clientUserMessageId === messageId)).toBe(false)
    expect(requests.some(item => item.method === 'request/answer')).toBe(false)
    expect(f.control.shell().followups!.find(item => item.threadId === f.target.threadId && item.wakeUp)).toMatchObject({ status: 'failed', wakeUp: true })
  } finally { gate.release() }
}, 60_000)
