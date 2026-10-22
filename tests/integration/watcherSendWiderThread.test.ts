// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentRuntimeMode } from '../../src/shared/agents'
import { WatcherService } from '../../src/main/agents/watcher'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import { watcherToolSchemas } from '../../src/shared/watcher'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { workspaceFixture } from '../fixtures/workspaceFixture'

// #1145: the new-thread default holds what Watcher starts, never what it sends. A send gives a thread no permission; the
// thread already runs on what the user gave it, so Watcher may send, queue and steer there whatever the default says.
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const TOO_WIDE = 'Watcher cannot give a thread more permission than your new-thread default. Nothing was sent or started. To give it more, widen New threads start with in Settings → Agents first.'

async function fixture(newThread: AgentRuntimeMode) {
  const workspace = await workspaceFixture(undefined, { history: true })
  cleanups.push(workspace.remove)
  workspace.adapters.codex.state.models[0]!.runtimeModes = ['approval-required', 'auto-accept-edits', 'auto', 'full-access']
  workspace.adapters.codex.state.capabilities.steer = true
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host,
    credentialOptions: { mode: 'unavailable' }, control: { historyEnabled: () => true, watcherEnabled: true } })
  const service = new WatcherService({ directory: f.root, host: workspace.host, control: f.control, historyEnabled: () => true })
  const tools = new WatcherToolServer(service)
  workspace.host.useWatcherTools(tools)
  cleanups.push(async () => { service.close(); await tools.close(); f.control.dispose(); await f.control.closed(); await workspace.stop() })
  await f.control.start()
  await f.control.commandShell({ type: 'connect', provider: 'codex' })
  await f.control.commandShell({ type: 'configure', patch: { newThreadRuntimeMode: newThread } })
  await service.recover()
  const model = f.control.shell().host.models.find(item => item.providerId === 'codex')!
  const project = f.control.shell().host.projects.find(item => item.providerId === 'codex')!
  expect(await service.open({ provider: 'codex', modelId: model.id })).toMatchObject({ status: 'ok' })
  const id = service.state().current!.target.threadId
  await tools.call(id, 'read_state', {})
  expect((await f.control.commandShell({ type: 'manual-send', threadId: id, draftId: randomUUID(), text: 'Synthetic Watcher user request' })).error).toBeNull()
  const requestId = service.state().requests.at(-1)!.id
  const hostId = f.control.hostId()!
  const call = async <N extends keyof typeof watcherToolSchemas>(name: N, input: unknown) =>
    watcherToolSchemas[name].output.parse((await tools.call(id, name, input)).structuredContent)
  /** A thread the user opened on `mode` themselves, which Watcher did not start. */
  const userThread = async (mode: AgentRuntimeMode) => {
    const threadId = randomUUID()
    expect((await f.control.commandShell({ type: 'create-thread', threadId, projectId: project.id, title: 'Synthetic user thread',
      titleSource: 'user', modelId: model.id, runtimeMode: mode })).error).toBeNull()
    expect(f.control.shell().host.threads.find(thread => thread.id === threadId)?.runtimeMode).toBe(mode)
    return { hostId, threadId }
  }
  const native = (threadId: string) => {
    const binding = workspace.registry.byThread(threadId)!
    return workspace.adapters.codex.state.threads.find(item => item.id === binding.sessionId)!
  }
  /** The provider reports the thread's turn running, or over. */
  const turn = async (threadId: string, state: 'running' | 'finished') => {
    const thread = native(threadId)
    thread.status = state === 'running' ? 'running' : 'idle'
    thread.lastTurn = { id: randomUUID(), status: state === 'running' ? 'running' : 'completed' }
    workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  }
  /** The mode Watcher's start asked the provider for: the fake provider keeps only the model. */
  const startedOn = (threadId: string) => {
    const sessionId = workspace.registry.byThread(threadId)!.sessionId
    const command = workspace.adapters.codex.commands.find(item => item.type === 'create-thread' && item.threadId === sessionId)
    return command?.type === 'create-thread' ? command.runtimeMode : undefined
  }
  const sent = (text: string) => workspace.adapters.codex.commands.filter(item => (item.type === 'send' || item.type === 'steer') && item.text.includes(text)).length
  const send = (target: { hostId: string; threadId: string }, delivery: 'now' | 'queue' | 'steer', text: string, extra: Record<string, unknown> = {}) =>
    call('send_to_thread', { requestId, retryKey: randomUUID(), target, delivery, text, ...extra })
  const start = (permission?: AgentRuntimeMode) => call('start_thread', { requestId, retryKey: randomUUID(), project: { hostId, projectId: project.id },
    modelId: model.id, title: 'Synthetic worker', workingCopy: { kind: 'shared' }, firstPrompt: 'Synthetic first prompt',
    ...(permission ? { permission: { kind: 'runtime', mode: permission } } : {}) })
  const threads = () => f.control.shell().host.threads.length
  return { ...f, workspace, service, userThread, native, turn, startedOn, sent, send, start, threads }
}

it('sends now, queues and steers to a Full access thread while the new-thread default is Ask for approval', async () => {
  const f = await fixture('approval-required')
  const target = await f.userThread('full-access')
  expect(await f.send(target, 'now', 'Synthetic follow-up')).toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' } })
  expect(f.sent('Synthetic follow-up')).toBe(1)
  // A queued prompt is admitted now and checked again when it goes, once the turn ends.
  await f.turn(target.threadId, 'running')
  expect(await f.send(target, 'queue', 'Synthetic queued prompt')).toMatchObject({ status: 'ok', receipt: { deliveryState: 'queued' } })
  expect(f.sent('Synthetic queued prompt')).toBe(0)
  await f.turn(target.threadId, 'finished')
  const receipts = () => JSON.stringify(f.service.state().receipts.map(item => `${item.action}:${item.deliveryState}:${item.refusalCode ?? '-'}`))
  await vi.waitFor(() => expect(f.sent('Synthetic queued prompt'), receipts()).toBe(1), { timeout: 10_000 })
  await f.turn(target.threadId, 'running')
  const turnId = f.control.shell().host.threads.find(thread => thread.id === target.threadId)!.lastTurn!.id
  const steered = await f.send(target, 'steer', 'Synthetic steer', { expectedTurnId: turnId })
  expect(steered, JSON.stringify(steered)).toMatchObject({ status: 'ok' })
  expect(f.sent('Synthetic steer')).toBe(1)
  // Nothing asked the provider to change the thread: it still runs on what the user gave it.
  expect(f.workspace.adapters.codex.commands.filter(item => item.type === 'configure-thread')).toEqual([])
})

it('still refuses a start wider than the new-thread default, in the same words, and starts nothing', async () => {
  const f = await fixture('approval-required')
  const before = f.threads()
  expect(await f.start('full-access')).toEqual({ status: 'refused', code: 'PERMISSION_TOO_WIDE', message: TOO_WIDE, retryable: false })
  expect(f.threads()).toBe(before)
  expect(f.sent('Synthetic first prompt')).toBe(0)
})

it('starts at or below the new-thread default and sends to threads at or below it, as before', async () => {
  const f = await fixture('auto-accept-edits')
  for (const mode of ['auto-accept-edits', 'approval-required'] as const) {
    const started = await f.start(mode)
    if (started.status !== 'ok' || !('target' in started)) throw new Error(`start refused: ${started.status === 'refused' ? started.code : ''}`)
    expect(f.startedOn(started.target.threadId)).toBe(mode)
  }
  for (const mode of ['auto-accept-edits', 'approval-required'] as const) {
    const target = await f.userThread(mode)
    expect(await f.send(target, 'now', `Synthetic send at ${mode}`)).toMatchObject({ status: 'ok' })
    expect(f.sent(`Synthetic send at ${mode}`)).toBe(1)
  }
})
