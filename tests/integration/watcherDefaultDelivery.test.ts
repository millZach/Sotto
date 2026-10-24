// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WatcherService } from '../../src/main/agents/watcher'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import { NO_TURN_TO_STEER } from '../../src/main/agents/watcherSendHolds'
import { watcherToolSchemas } from '../../src/shared/watcher'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { workspaceFixture } from '../fixtures/workspaceFixture'

// ADR-0130: a Watcher send that names no delivery steers a running turn, goes now to an idle thread, and queues only where
// the provider cannot steer. A thread waiting on the user's card still takes nothing, and a named delivery still wins.
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

type Provider = 'codex' | 'claude' | 'grok'

async function fixture(provider: Provider) {
  const workspace = await workspaceFixture(undefined, { history: true })
  cleanups.push(workspace.remove)
  // Codex and Claude Code steer; Grok Build does not, as its adapter says.
  for (const [id, adapter] of Object.entries(workspace.adapters)) adapter.state.capabilities.steer = id !== 'grok'
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
  expect((await f.control.commandShell({ type: 'manual-send', threadId: id, draftId: randomUUID(), text: 'Synthetic Watcher user request' })).error).toBeNull()
  const requestId = service.state().requests.at(-1)!.id
  const call = async <N extends keyof typeof watcherToolSchemas>(name: N, input: unknown) =>
    watcherToolSchemas[name].output.parse((await tools.call(id, name, input)).structuredContent)
  const model = f.control.shell().host.models.find(item => item.providerId === provider)!
  const project = f.control.shell().host.projects.find(item => item.providerId === provider)!
  const started = await call('start_thread', { requestId, retryKey: randomUUID(), project: { hostId: f.control.hostId()!, projectId: project.id },
    modelId: model.id, title: 'Synthetic worker', workingCopy: { kind: 'shared' }, firstPrompt: 'Synthetic first prompt' })
  if (started.status !== 'ok' || !('target' in started)) throw new Error('start refused')
  const target = started.target
  const native = () => {
    const binding = workspace.registry.byThread(target.threadId)!
    const adapter = workspace.adapters[binding.provider as Provider]
    return { adapter, thread: adapter.state.threads.find(item => item.id === binding.sessionId)! }
  }
  const refresh = async () => { native().adapter.emit(); await f.control.commandShell({ type: 'refresh', provider }) }
  /** The provider reports the thread's turn running, with a new turn identity, or over. */
  const turn = async (state: 'finished' | 'running') => {
    const { thread } = native()
    thread.status = state === 'running' ? 'running' : 'idle'
    thread.lastTurn = { id: randomUUID(), status: state === 'running' ? 'running' : 'completed' }
    await refresh()
    return thread.lastTurn.id
  }
  const commands = (type: 'send' | 'steer', text: string) => native().adapter.commands.filter(item => item.type === type && item.text === text).length
  const send = (text: string, extra: Record<string, unknown> = {}) => call('send_to_thread', { requestId, retryKey: randomUUID(), target, text, ...extra })
  return { ...f, workspace, service, target, call, turn, refresh, native, commands, send, requestId }
}

describe.each(['codex', 'claude'] as const)('a Watcher send that names no delivery, to a %s thread', provider => {
  it('steers a running turn, into the turn it reads as running', async () => {
    const f = await fixture(provider)
    const turnId = await f.turn('running')
    // The fake provider does not show a steer in the thread, so its receipt stays unconfirmed; the steer itself went.
    expect(await f.send('Synthetic default steer')).toMatchObject({ status: 'ok', delivery: 'steer' })
    expect(f.commands('steer', 'Synthetic default steer')).toBe(1)
    expect(f.commands('send', 'Synthetic default steer')).toBe(0)
    expect(f.control.watcherRecord().operations.find(item => item.action === 'send')).toMatchObject({ delivery: 'steer', expectedTurnId: turnId })
  })

  it('steers a running turn Sotto never confirmed, as one resumed after the user answered its card (#1490)', async () => {
    const f = await fixture(provider)
    await f.turn('finished')
    // The turn runs again, but the newest turn Sotto knows is still the finished one.
    f.native().thread.status = 'running'
    await f.refresh()
    // A named steer still needs a confirmed turn to name, and a send now still waits for the turn.
    expect(await f.send('Synthetic named steer', { delivery: 'steer' })).toMatchObject({ status: 'refused', code: 'STEER_UNAVAILABLE' })
    expect(await f.send('Synthetic named now', { delivery: 'now' })).toMatchObject({ status: 'refused', code: 'THREAD_BUSY' })
    expect(await f.send('Synthetic unconfirmed steer')).toMatchObject({ status: 'ok', delivery: 'steer' })
    expect(f.commands('steer', 'Synthetic unconfirmed steer')).toBe(1)
    expect(f.control.watcherRecord().operations.find(item => item.action === 'send' && item.delivery === 'steer')).not.toHaveProperty('expectedTurnId')
  })

  it('goes now to a thread whose turn is over, rather than failing as a steer', async () => {
    const f = await fixture(provider)
    await f.turn('finished')
    expect(await f.send('Synthetic default now')).toMatchObject({ status: 'ok', delivery: 'now', receipt: { deliveryState: 'accepted' } })
    expect(f.commands('send', 'Synthetic default now')).toBe(1)
    expect(f.native().thread.status).toBe('running')
  })

  it('sends nothing and holds nothing for a thread waiting on the user’s card', async () => {
    const f = await fixture(provider)
    await f.turn('running')
    f.native().thread.requests = [{ id: 'synthetic-question', kind: 'question', text: 'Synthetic question', options: [] }]
    await f.refresh()
    const operations = f.control.watcherRecord().operations.length
    expect(await f.send('Synthetic blocked')).toMatchObject({ status: 'refused', code: 'PENDING_USER_REQUEST' })
    expect(f.control.watcherRecord().operations).toHaveLength(operations)
    expect(f.commands('steer', 'Synthetic blocked') + f.commands('send', 'Synthetic blocked')).toBe(0)
    expect(f.control.hasPendingThreadWork(f.target.threadId)).toBe(false)
  })
})

it('queues for a running thread whose provider cannot steer, says so, and goes now once its turn is over', async () => {
  const f = await fixture('grok')
  await f.turn('running')
  expect(await f.send('Synthetic default queue')).toMatchObject({ status: 'ok', delivery: 'queue', receipt: { deliveryState: 'queued' } })
  expect(f.commands('steer', 'Synthetic default queue')).toBe(0)
  await f.turn('finished')
  await vi.waitFor(() => expect(f.commands('send', 'Synthetic default queue')).toBe(1), { timeout: 10_000 })
  await vi.waitFor(() => expect(f.control.hasPendingThreadWork(f.target.threadId)).toBe(false), { timeout: 10_000 })
  await f.turn('finished')
  expect(await f.send('Synthetic default now')).toMatchObject({ status: 'ok', delivery: 'now', receipt: { deliveryState: 'accepted' } })
})

it('queues for a turn still ending after its thread reads idle, rather than start a second turn', async () => {
  const f = await fixture('codex')
  await f.turn('running')
  f.native().thread.status = 'idle'
  await f.refresh()
  expect(await f.send('Synthetic ending turn')).toMatchObject({ status: 'ok', delivery: 'queue' })
  expect(f.commands('send', 'Synthetic ending turn') + f.commands('steer', 'Synthetic ending turn')).toBe(0)
})

it('lets a named delivery win over the default', async () => {
  const f = await fixture('codex')
  await f.turn('running')
  expect(await f.send('Synthetic named queue', { delivery: 'queue' })).toMatchObject({ status: 'ok', delivery: 'queue', receipt: { deliveryState: 'queued' } })
  expect(f.commands('steer', 'Synthetic named queue')).toBe(0)
  // A named steer to a thread whose turn is over is still refused: only the default turns into a send now.
  const g = await fixture('codex')
  await g.turn('finished')
  expect(await g.send('Synthetic named steer', { delivery: 'steer', expectedTurnId: g.native().thread.lastTurn!.id }))
    .toMatchObject({ status: 'refused', code: 'STEER_UNAVAILABLE', message: NO_TURN_TO_STEER })
  expect(g.commands('send', 'Synthetic named steer')).toBe(0)
})

it('refuses a default steer into a turn other than the one the send names', async () => {
  const f = await fixture('codex')
  const first = await f.turn('running')
  await f.turn('running')
  expect(await f.send('Synthetic stale steer', { expectedTurnId: first })).toMatchObject({ status: 'refused', code: 'STEER_UNAVAILABLE' })
  expect(f.commands('steer', 'Synthetic stale steer')).toBe(0)
})

it('answers a retry of a default send with its first receipt, whatever the thread does since', async () => {
  const f = await fixture('codex')
  await f.turn('running')
  const input = { requestId: f.requestId, retryKey: randomUUID(), target: f.target, text: 'Synthetic retried steer' }
  const first = await f.call('send_to_thread', input)
  expect(first).toMatchObject({ status: 'ok', delivery: 'steer' })
  await f.turn('finished')
  const again = await f.call('send_to_thread', input)
  expect(again).toMatchObject({ status: 'ok', delivery: 'steer' })
  if (first.status !== 'ok' || !('receipt' in first)) throw new Error('send refused')
  expect(again).toMatchObject({ receipt: { operationId: first.receipt.operationId } })
  expect(f.commands('steer', 'Synthetic retried steer') + f.commands('send', 'Synthetic retried steer')).toBe(1)
  // The same key with a named delivery is another call.
  expect(await f.call('send_to_thread', { ...input, delivery: 'steer' })).toMatchObject({ status: 'refused', code: 'RETRY_KEY_CONFLICT' })
})
