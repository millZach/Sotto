// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createAgentRuntime } from '../../src/main/agents/runtime'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { testCredentials } from '../fixtures/testCredentials'
import { codexFixture } from '../fixtures/codexFixture'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'

it('recovers the same durable Watcher and worker receipts through real fake-provider child processes', async () => {
  let native = await codexFixture(undefined, false, 10_000)
  const directory = join(native.root, 'sotto'), projectPath = join(native.root, 'worker-project')
  await mkdir(projectPath)
  const credentials = await testCredentials(join(directory, 'vault'), { mode: 'unavailable' })
  const settings = { ...DEFAULT_SETTINGS, threadTitles: false }
  const makeRuntime = () => createAgentRuntime({ directory, credentials, watcherEnabled: true,
    settings: () => settings, writingSettings: async () => settings, historyEnabled: () => true, openExternal: async () => undefined,
    reasoner: {}, providers: { codex: native.adapter, claude: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost() } })
  let runtime = await makeRuntime()
  try {
    await runtime.agentControl.commandShell({ type: 'connect', provider: 'codex' })
    await runtime.agentControl.commandShell({ type: 'create-project', provider: 'codex', title: 'Synthetic project', path: projectPath, useExisting: true })
    const project = runtime.agentControl.shell().host.projects.find(item => item.path === projectPath)!
    const model = runtime.agentControl.shell().host.models.find(item => item.providerId === 'codex' && item.ready)!
    expect(await runtime.watcher!.open({ provider: 'codex', modelId: model.id })).toMatchObject({ status: 'ok' })
    const id = runtime.watcher!.state().current!.target.threadId
    expect((await runtime.agentControl.commandShell({ type: 'manual-send', threadId: id, draftId: randomUUID(), text: 'Synthetic root request' })).error).toBeNull()
    const requestId = runtime.watcher!.state().requests.at(-1)!.id
    const input = { requestId, retryKey: randomUUID(), project: { hostId: runtime.agentControl.hostId()!, projectId: project.id }, modelId: model.id,
      title: 'Synthetic worker', workingCopy: { kind: 'shared' }, firstPrompt: 'Synthetic child process prompt' }
    const result = (await runtime.watcherTools!.call(id, 'start_thread', input)).structuredContent!
    expect(result).toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' } })
    const target = result.target as { hostId: string; threadId: string }
    expect((await runtime.watcherTools!.call(id, 'read_thread', { target })).structuredContent).toMatchObject({ status: 'ok' })
    const binding = runtime.threadRegistry!.byThread(target.threadId)!
    await native.driver.raiseQuestion(binding.sessionId, 'Synthetic pending question')
    await expect.poll(() => runtime.agentControl.shell().host.threads.find(item => item.id === target.threadId)?.requests.length).toBe(1)
    expect((await runtime.watcherTools!.call(id, 'send_to_thread', { requestId, retryKey: randomUUID(), target, delivery: 'queue', text: 'Synthetic forbidden answer' })).structuredContent)
      .toMatchObject({ status: 'refused', code: 'PENDING_USER_REQUEST' })
    const sendsBefore = (await native.driver.requests()).filter(item => item.method === 'turn/start').length
    await runtime.close()
    native = await codexFixture(native.root, false, 10_000)
    runtime = await makeRuntime()
    await runtime.agentControl.commandShell({ type: 'connect', provider: 'codex' })
    expect(runtime.watcher!.state().current!.target.threadId).toBe(id)
    expect((await runtime.watcherTools!.call(id, 'start_thread', input)).structuredContent).toMatchObject({ status: 'ok', target })
    expect((await native.driver.requests()).filter(item => item.method === 'turn/start')).toHaveLength(sendsBefore)
    expect((await native.driver.requests()).some(item => item.method === 'request/answer')).toBe(false)
  } finally { await runtime.close(); await native.cleanup() }
}, 60_000)
