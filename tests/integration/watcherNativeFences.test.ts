// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
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
async function fixture() {
  const native = await codexFixture(undefined, false, 10_000)
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
  return { ...runtime, native, control, service, tools, id, requestId, target, binding }
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
