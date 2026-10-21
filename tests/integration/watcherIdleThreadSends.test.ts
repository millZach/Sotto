// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WatcherService } from '../../src/main/agents/watcher'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import { NO_TURN_TO_STEER, RUNNING_TURN_HOLD } from '../../src/main/agents/watcherSendHolds'
import type { AgentBackgroundWork } from '../../src/shared/agentMonitoring'
import { watcherToolSchemas } from '../../src/shared/watcher'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { workspaceFixture } from '../fixtures/workspaceFixture'

// #1203: a thread whose own turn is over takes Watcher's send, whatever background work that turn left running. Only the
// foreground turn and the thread's own queue hold a send, and a refusal says which.
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

type Provider = 'codex' | 'claude' | 'grok'
const job: AgentBackgroundWork[] = [{ id: randomUUID(), type: 'command', label: 'Synthetic test run' }]

async function fixture(provider: Provider) {
  const workspace = await workspaceFixture(undefined, { history: true })
  cleanups.push(workspace.remove)
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host,
    credentialOptions: { mode: 'unavailable' }, control: { historyEnabled: () => true, watcherEnabled: true } })
  const service = new WatcherService({ directory: f.root, host: workspace.host, control: f.control, historyEnabled: () => true })
  const tools = new WatcherToolServer(service)
  workspace.host.useWatcherTools(tools)
  cleanups.push(async () => { service.close(); await tools.close(); f.control.dispose(); await f.control.closed(); await workspace.stop() })
  await f.control.start()
  for (const id of new Set<Provider>(['codex', provider])) await f.control.commandShell({ type: 'connect', provider: id })
  await service.recover()
  const watcherModel = f.control.shell().host.models.find(item => item.providerId === 'codex')!
  expect(await service.open({ provider: 'codex', modelId: watcherModel.id })).toMatchObject({ status: 'ok' })
  const id = service.state().current!.target.threadId
  const ask = async (text: string) => {
    expect((await f.control.commandShell({ type: 'manual-send', threadId: id, draftId: randomUUID(), text })).error).toBeNull()
    return service.state().requests.at(-1)!.id
  }
  let requestId = await ask('Synthetic Watcher user request')
  const call = async <N extends keyof typeof watcherToolSchemas>(name: N, input: unknown) =>
    watcherToolSchemas[name].output.parse((await tools.call(id, name, input)).structuredContent)
  const model = f.control.shell().host.models.find(item => item.providerId === provider)!
  const project = f.control.shell().host.projects.find(item => item.providerId === provider)!
  const started = await call('start_thread', { requestId, retryKey: randomUUID(), project: { hostId: f.control.hostId()!, projectId: project.id },
    modelId: model.id, title: 'Synthetic worker', workingCopy: { kind: 'shared' }, firstPrompt: 'Synthetic first prompt' })
  if (started.status !== 'ok' || !('target' in started)) throw new Error('start refused')
  const target = started.target
  const native = (threadId = target.threadId) => {
    const binding = workspace.registry.byThread(threadId)!
    const adapter = workspace.adapters[binding.provider as Provider]
    return { adapter, provider: binding.provider as Provider, thread: adapter.state.threads.find(item => item.id === binding.sessionId)! }
  }
  /** The provider reports the thread's foreground turn over, with `background` still running, or its turn running again. */
  const turn = async (state: 'finished' | 'running', background?: AgentBackgroundWork[], threadId = target.threadId) => {
    const { adapter, provider: owner, thread } = native(threadId)
    thread.status = state === 'running' ? 'running' : 'idle'
    thread.lastTurn = { id: randomUUID(), status: state === 'running' ? 'running' : 'completed' }
    if (background) thread.backgroundWork = background; else delete thread.backgroundWork
    adapter.emit(); await f.control.commandShell({ type: 'refresh', provider: owner })
  }
  const sent = (text: string) => native().adapter.commands.filter(item => item.type === 'send' && item.text.includes(text)).length
  const send = (delivery: 'now' | 'queue' | 'steer', text: string, extra: Record<string, unknown> = {}) =>
    call('send_to_thread', { requestId, retryKey: randomUUID(), target, delivery, text, ...extra })
  return { ...f, workspace, service, target, call, turn, sent, send, native,
    /** A new message from the user to Watcher, which opens a new request. */
    newRequest: async (text: string) => { await turn('finished', undefined, id); requestId = await ask(text); return requestId } }
}

describe.each(['codex', 'claude', 'grok'] as const)('Watcher reaches a %s thread whose own turn is over', provider => {
  it('takes a now send while one background job runs, and starts a new turn', async () => {
    const f = await fixture(provider)
    await f.turn('finished', job)
    expect(f.service.state().watchedThreads.find(row => row.target.threadId === f.target.threadId)).toMatchObject({ status: 'idle', backgroundWorkCount: 1 })
    expect(await f.send('now', 'Synthetic stop the test run')).toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' } })
    expect(f.sent('Synthetic stop the test run')).toBe(1)
    expect(f.native().thread.status).toBe('running')
  })

  it('delivers a queued prompt as soon as the foreground turn is free, not when background work ends', async () => {
    const f = await fixture(provider)
    await f.turn('running')
    expect(await f.send('now', 'Synthetic refused now')).toMatchObject({ status: 'refused', code: 'THREAD_BUSY', message: RUNNING_TURN_HOLD })
    expect(await f.send('queue', 'Synthetic queued note')).toMatchObject({ status: 'ok', receipt: { deliveryState: 'queued' } })
    expect(f.sent('Synthetic queued note')).toBe(0)
    await f.turn('finished', job)
    await vi.waitFor(() => expect(f.sent('Synthetic queued note')).toBe(1), { timeout: 10_000 })
    expect(f.native().thread.backgroundWork).toEqual(job)
  })

  it('still steers only a running turn: background work is not one', async () => {
    const f = await fixture(provider)
    await f.turn('finished', job)
    expect(await f.send('steer', 'Synthetic steer', { expectedTurnId: f.native().thread.lastTurn!.id }))
      .toMatchObject({ status: 'refused', code: 'STEER_UNAVAILABLE', message: NO_TURN_TO_STEER })
    expect(f.sent('Synthetic steer')).toBe(0)
  })
})

it('says a turn that began during preparation is what held the send, here and on a retry', async () => {
  const f = await fixture('codex')
  await f.turn('finished', job)
  const original = f.control.commandFromWatcher.bind(f.control)
  vi.spyOn(f.control, 'commandFromWatcher').mockImplementationOnce(async (command, origin) => { await f.turn('running', job); return original(command, origin) })
  const input = { requestId: f.service.state().requests.at(-1)!.id, retryKey: randomUUID(), target: f.target, delivery: 'now', text: 'Synthetic late send' }
  expect(await f.call('send_to_thread', input)).toMatchObject({ status: 'refused', code: 'THREAD_BUSY', message: RUNNING_TURN_HOLD })
  expect(await f.call('send_to_thread', input)).toMatchObject({ status: 'refused', code: 'THREAD_BUSY', message: RUNNING_TURN_HOLD })
  expect(f.sent('Synthetic late send')).toBe(0)
})

it('holds Watcher’s sends while the user’s own turn runs, background work or not', async () => {
  const f = await fixture('codex')
  await f.turn('finished', job)
  expect((await f.control.commandShell({ type: 'manual-send', threadId: f.target.threadId, draftId: randomUUID(), text: 'Synthetic user turn' })).error).toBeNull()
  expect(f.native().thread.status).toBe('running')
  // The code is the takeover rules' to choose; what this asserts is that Watcher's send never lands on the user's turn.
  for (const delivery of ['now', 'queue'] as const) expect(await f.send(delivery, `Synthetic held ${delivery}`)).toMatchObject({ status: 'refused' })
  await f.turn('finished', job)
  expect(f.sent('Synthetic held')).toBe(0)
})

it('delivers a later request’s queued prompt to a thread Stop all held, and keeps holding the user’s own queue', async () => {
  const f = await fixture('codex')
  await f.turn('finished')
  const preview = f.service.prepareStopAll()
  if (preview.status !== 'ok') throw new Error('preview refused')
  expect(await f.service.stopAll(preview.confirmationId)).toMatchObject({ status: 'ok', results: [{ target: f.target, status: 'stopped' }] })
  // The user asks Watcher again: a new request takes part in the thread Stop all stopped.
  await f.newRequest('Synthetic second Watcher request')
  await f.turn('running', job)
  expect(await f.send('queue', 'Synthetic note after Stop all')).toMatchObject({ status: 'ok', receipt: { deliveryState: 'queued' } })
  await f.turn('finished', job)
  await vi.waitFor(() => expect(f.sent('Synthetic note after Stop all')).toBe(1), { timeout: 10_000 })
  // Its queue settled and its turn over again, the thread takes a send at once.
  await vi.waitFor(() => expect(f.control.hasPendingThreadWork(f.target.threadId)).toBe(false), { timeout: 10_000 })
  await f.turn('finished', job)
  const now = await f.send('now', 'Synthetic now after Stop all')
  expect(now, JSON.stringify(now)).toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' } })
  // The machine Stop still holds what it held: prompts saved by the user and Sotto's news.
  expect(f.service.preserveUserQueue(f.target.threadId)).toBe(true)
})
