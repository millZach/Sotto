// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { WatcherService } from '../../src/main/agents/watcher'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import { watcherToolSchemas } from '../../src/shared/watcher'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { workspaceFixture } from '../fixtures/workspaceFixture'

// October 23, 2026: a thread settled after an earlier turn took a day of Watcher's new work while it stayed settled, then
// Watcher's queued GO MERGE sat at "working" for good. New work in a settled thread restores it first.
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture() {
  const workspace = await workspaceFixture(undefined, { history: true })
  cleanups.push(workspace.remove)
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host,
    credentialOptions: { mode: 'unavailable' }, control: { historyEnabled: () => true, watcherEnabled: true } })
  const service = new WatcherService({ directory: f.root, host: workspace.host, control: f.control, historyEnabled: () => true })
  const tools = new WatcherToolServer(service)
  workspace.host.useWatcherTools(tools)
  cleanups.push(async () => { service.close(); await tools.close(); f.control.dispose(); await f.control.closed(); await workspace.stop() })
  await f.control.start()
  await f.control.commandShell({ type: 'connect', provider: 'codex' })
  await service.recover()
  const model = f.control.shell().host.models.find(item => item.providerId === 'codex')!
  const project = f.control.shell().host.projects.find(item => item.providerId === 'codex')!
  expect(await service.open({ provider: 'codex', modelId: model.id })).toMatchObject({ status: 'ok' })
  const watcherId = service.state().current!.target.threadId
  expect((await f.control.commandShell({ type: 'manual-send', threadId: watcherId, draftId: randomUUID(), text: 'Synthetic Watcher user request' })).error).toBeNull()
  const requestId = service.state().requests.at(-1)!.id
  const call = async <N extends keyof typeof watcherToolSchemas>(name: N, input: unknown) =>
    watcherToolSchemas[name].output.parse((await tools.call(watcherId, name, input)).structuredContent)
  const started = await call('start_thread', { requestId, retryKey: randomUUID(), project: { hostId: f.control.hostId()!, projectId: project.id },
    modelId: model.id, title: 'Synthetic worker', workingCopy: { kind: 'shared' }, firstPrompt: 'Synthetic first prompt' })
  if (started.status !== 'ok' || !('target' in started)) throw new Error('start refused')
  const target = started.target
  const native = () => workspace.adapters.codex.state.threads.find(item => item.id === workspace.registry.byThread(target.threadId)!.sessionId)!
  const finish = async () => {
    const thread = native()
    thread.status = 'idle'; thread.lastTurn = { id: randomUUID(), status: 'completed' }
    workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  }
  const sent = (text: string) => workspace.adapters.codex.commands.filter(item => item.type === 'send' && item.text.includes(text)).length
  const send = (delivery: 'now' | 'queue', text: string) => call('send_to_thread', { requestId, retryKey: randomUUID(), target, delivery, text })
  const settled = () => Boolean(f.control.watcherSnapshot().threads.find(item => item.id === target.threadId)!.workspaceSettledAt)
  await finish()
  // Settled after its first turn, as Settle finished threads or the user settles a thread that is done.
  expect((await f.control.commandShell({ type: 'settle-thread', threadId: target.threadId })).error).toBeNull()
  expect(settled()).toBe(true)
  return { ...f, workspace, service, target, call, send, sent, settled, finish, native }
}

it('restores a settled thread that Watcher sends new work now, so it never works while settled', async () => {
  const f = await fixture()
  expect(await f.send('now', 'Synthetic new work')).toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' } })
  expect(f.sent('Synthetic new work')).toBe(1)
  expect(f.settled()).toBe(false)
})

it('restores a settled thread that Watcher queues new work for, and the prompt goes instead of waiting for good', async () => {
  const f = await fixture()
  const queued = await f.send('queue', 'Synthetic GO MERGE')
  expect(queued).toMatchObject({ status: 'ok' })
  await vi.waitFor(() => expect(f.sent('Synthetic GO MERGE')).toBe(1), { timeout: 10_000 })
  expect(f.settled()).toBe(false)
})

it('says a queued send waits on the user once the thread’s queue pauses, and refuses the next one with why', async () => {
  const f = await fixture()
  expect(await f.send('now', 'Synthetic new work')).toMatchObject({ status: 'ok' })
  const queued = await f.send('queue', 'Synthetic GO MERGE')
  if (queued.status !== 'ok' || !('receipt' in queued)) throw new Error('queue refused')
  // The turn ends without confirming it finished, so the queue waits for the user to review the thread.
  const thread = f.native()
  thread.status = 'idle'; thread.lastTurn = { id: thread.lastTurn?.id ?? randomUUID(), status: 'interrupted' }
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  await vi.waitFor(() => expect(f.control.shell().followups?.find(item => item.text === 'Synthetic GO MERGE')?.status).toBe('paused'))
  expect(f.sent('Synthetic GO MERGE')).toBe(0)
  expect(await f.call('read_operation', { operationId: queued.receipt.operationId })).toMatchObject({ status: 'ok', outcome: 'working',
    outcomeNote: expect.stringContaining('paused until the user reviews') })
  expect(await f.send('queue', 'Synthetic second GO MERGE')).toMatchObject({ status: 'refused', code: 'THREAD_BUSY',
    message: expect.stringContaining('paused until the user reviews') })
})

it('restores a settled thread the user sends to, and from a settled project brings back that thread alone', async () => {
  const f = await fixture()
  expect((await f.control.commandShell({ type: 'manual-send', threadId: f.target.threadId, draftId: randomUUID(), text: 'Synthetic user work' })).error).toBeNull()
  expect(f.sent('Synthetic user work')).toBe(1)
  expect(f.settled()).toBe(false)
  await f.finish()
  // A second thread in the same project, then the whole project settled.
  const other = randomUUID(), projectId = f.control.watcherSnapshot().threads.find(item => item.id === f.target.threadId)!.projectId
  const model = f.control.watcherSnapshot().threads.find(item => item.id === f.target.threadId)!.modelId
  expect((await f.control.commandShell({ type: 'create-thread', threadId: other, projectId, modelId: model, title: 'Synthetic other', workingCopy: 'shared' })).error).toBeNull()
  expect((await f.control.commandShell({ type: 'settle-project', projectId })).error).toBeNull()
  expect(f.settled()).toBe(false)
  expect(f.control.watcherSnapshot().projects.find(item => item.id === projectId)!.workspaceSettledAt).toBeTruthy()
  expect((await f.control.commandShell({ type: 'manual-send', threadId: f.target.threadId, draftId: randomUUID(), text: 'Synthetic project work' })).error).toBeNull()
  expect(f.sent('Synthetic project work')).toBe(1)
  const snapshot = f.control.watcherSnapshot()
  expect(snapshot.projects.find(item => item.id === projectId)!.workspaceSettledAt ?? null).toBeNull()
  expect(snapshot.threads.find(item => item.id === f.target.threadId)!.workspaceSettledAt ?? null).toBeNull()
  expect(snapshot.threads.find(item => item.id === other)!.workspaceSettledAt).toBeTruthy()
})

it('unsettles a settled thread whose background work still runs, keeping its watch and sending nothing, and again safely', async () => {
  const f = await fixture()
  // Its turn is over, but agents it started still work: no prompt is coming that would restore it.
  const native = f.native()
  native.backgroundWork = [{ id: randomUUID(), type: 'subagent', label: 'Synthetic agent' }]
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  const watches = () => (f.control.watcherRecord().watches ?? []).filter(watch => watch.target.threadId === f.target.threadId).map(watch => watch.id)
  const watched = watches(), sends = f.workspace.adapters.codex.commands.filter(command => command.type === 'send').length
  expect(watched).toHaveLength(1)
  const requestId = f.service.state().requests.at(-1)!.id
  const unsettle = () => f.call('unsettle_thread', { requestId, retryKey: randomUUID(), target: f.target })
  expect(await unsettle()).toEqual({ status: 'ok', target: f.target, settled: false })
  expect(f.settled()).toBe(false)
  expect(watches()).toEqual(watched)
  expect(f.workspace.adapters.codex.commands.filter(command => command.type === 'send').length).toBe(sends)
  // Again: nothing more to restore, and nothing else changes.
  expect(await unsettle()).toEqual({ status: 'ok', target: f.target, settled: false })
  expect(watches()).toEqual(watched)
})

it('unsettles a thread in a settled project alone, and refuses without an active request or for another computer', async () => {
  const f = await fixture()
  const thread = f.control.watcherSnapshot().threads.find(item => item.id === f.target.threadId)!
  const other = randomUUID()
  expect((await f.control.commandShell({ type: 'create-thread', threadId: other, projectId: thread.projectId, modelId: thread.modelId, title: 'Synthetic other', workingCopy: 'shared' })).error).toBeNull()
  expect((await f.control.commandShell({ type: 'restore-thread', threadId: f.target.threadId })).error).toBeNull()
  expect((await f.control.commandShell({ type: 'settle-project', projectId: thread.projectId })).error).toBeNull()
  expect(f.settled()).toBe(false)
  const requestId = f.service.state().requests.at(-1)!.id
  expect(await f.call('unsettle_thread', { requestId: randomUUID(), retryKey: randomUUID(), target: f.target })).toMatchObject({ status: 'refused', code: 'REQUEST_NOT_ACTIVE' })
  expect(await f.call('unsettle_thread', { requestId, retryKey: randomUUID(), target: { hostId: randomUUID(), threadId: f.target.threadId } }))
    .toMatchObject({ status: 'refused', code: 'HOST_FEATURE_UNAVAILABLE' })
  expect(await f.call('unsettle_thread', { requestId, retryKey: randomUUID(), target: f.target })).toMatchObject({ status: 'ok', settled: false })
  const snapshot = f.control.watcherSnapshot()
  expect(snapshot.projects.find(item => item.id === thread.projectId)!.workspaceSettledAt ?? null).toBeNull()
  expect(snapshot.threads.find(item => item.id === f.target.threadId)!.workspaceSettledAt ?? null).toBeNull()
  expect(snapshot.threads.find(item => item.id === other)!.workspaceSettledAt).toBeTruthy()
})

it('answers an unsettle_thread retry as the first call did, restoring nothing again, and refuses its key for another thread', async () => {
  const f = await fixture()
  const requestId = f.service.state().requests.at(-1)!.id, retryKey = randomUUID()
  expect(await f.call('unsettle_thread', { requestId, retryKey, target: f.target })).toEqual({ status: 'ok', target: f.target, settled: false })
  // The user settles it again; the first call's retry must not undo that.
  expect((await f.control.commandShell({ type: 'settle-thread', threadId: f.target.threadId })).error).toBeNull()
  expect(await f.call('unsettle_thread', { requestId, retryKey, target: f.target })).toEqual({ status: 'ok', target: f.target, settled: false })
  expect(f.settled()).toBe(true)
  expect(await f.call('unsettle_thread', { requestId, retryKey, target: { ...f.target, threadId: randomUUID() } })).toMatchObject({ status: 'refused', code: 'RETRY_KEY_CONFLICT' })
})

it('restores only under the user’s own active request: not a standing watch’s, nor a thread the user stopped watching', async () => {
  const f = await fixture()
  const watch = (f.control.watcherRecord().watches ?? []).find(item => item.target.threadId === f.target.threadId)!
  expect(await f.call('unsettle_thread', { requestId: watch.id, retryKey: randomUUID(), target: f.target })).toMatchObject({ status: 'refused', code: 'REQUEST_NOT_ACTIVE' })
  expect(await f.service.unwatchThread({ target: f.target })).toMatchObject({ status: 'ok' })
  const requestId = f.service.state().requests.at(-1)!.id
  expect(await f.call('unsettle_thread', { requestId, retryKey: randomUUID(), target: f.target })).toMatchObject({ status: 'refused', code: 'REQUEST_NOT_ACTIVE' })
  expect(f.settled()).toBe(true)
})

it('refuses to unsettle a thread with a special job or an archived one, as it refuses to settle them', async () => {
  const f = await fixture()
  const requestId = f.service.state().requests.at(-1)!.id
  const watcher = f.service.state().current!.target
  expect(await f.call('unsettle_thread', { requestId, retryKey: randomUUID(), target: watcher })).toMatchObject({ status: 'refused', code: 'RESERVED_THREAD' })
  // The settled worker is archived by its provider: it is kept for its history only, and stays settled.
  f.native().archivedAt = new Date().toISOString()
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  expect(f.control.watcherSnapshot().threads.find(item => item.id === f.target.threadId)!.archivedAt).toBeTruthy()
  expect(await f.call('unsettle_thread', { requestId, retryKey: randomUUID(), target: f.target })).toMatchObject({ status: 'refused', code: 'TARGET_CHANGED' })
  expect(f.settled()).toBe(true)
})
