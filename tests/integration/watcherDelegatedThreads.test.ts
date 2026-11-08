// @vitest-environment node
// Watcher talks only to parent threads (#1217; Zach's rule of October 20, 2026, and his picks of November 7, ADR-0081):
// a thread another thread delegated to is that thread's to brief, stop and settle. Watcher refuses each for it before
// anything is sent, naming the thread to direct instead, watches it from no path, lets go of a watch an older build gave
// it, and marks it in list_threads. It may still read it, and the thread that delegated stays Watcher's.
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { WatcherService } from '../../src/main/agents/watcher'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import { watcherToolSchemas, type WatcherThreadTarget, type WatcherToolName, type WatcherToolOutput } from '../../src/shared/watcher'
import type { AgentControl } from '../../src/main/agents/control'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture(settleWithoutAsking = false) {
  const workspace = await workspaceFixture()
  cleanups.push(workspace.remove)
  workspace.adapters.codex.state.capabilities.steer = true
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' },
    control: { watcherEnabled: true, historyEnabled: () => true } })
  let control: AgentControl = f.control
  const make = (settledLookAfterMs: number) => new WatcherService({ directory: f.root, host: workspace.host, control, historyEnabled: () => true,
    settleWithoutAsking: () => settleWithoutAsking, settledLookAfterMs })
  let service = make(0), tools = new WatcherToolServer(service)
  workspace.host.useWatcherTools(tools)
  cleanups.push(async () => { service.close(); await tools.close(); await f.dispose(); await control.closed(); await workspace.stop() })
  await control.start(); await control.commandShell({ type: 'connect', provider: 'codex' }); await service.recover()
  const model = control.watcherSnapshot().models.find(item => item.providerId === 'codex')!
  const project = control.watcherSnapshot().projects.find(item => item.providerId === 'codex')!
  expect(await service.open({ provider: 'codex', modelId: model.id })).toMatchObject({ status: 'ok' })
  const watcherId = () => service.state().current!.target.threadId
  const call = async <N extends WatcherToolName>(name: N, input: unknown) => watcherToolSchemas[name].output.parse(await service.invoke(watcherId(), name, input)) as WatcherToolOutput<N>
  const emit = async () => { workspace.adapters.codex.emit(); await control.commandShell({ type: 'refresh', provider: 'codex' }) }
  const create = async (title: string): Promise<WatcherThreadTarget> => {
    const threadId = randomUUID()
    expect((await control.commandShell({ type: 'create-thread', threadId, projectId: project.id, modelId: model.id,
      title, runtimeMode: 'approval-required', workingCopy: 'shared' })).error).toBeNull()
    expect((await control.commandShell({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'Synthetic work' })).error).toBeNull()
    const thread = workspace.adapters.codex.state.threads.find(item => item.id === workspace.registry.byThread(threadId)!.sessionId)!
    thread.status = 'idle'; thread.lastTurn = { id: thread.lastTurn?.id ?? randomUUID(), status: 'completed' }
    await emit()
    return { hostId: control.hostId()!, threadId }
  }
  /** A parent the user started and a thread it delegated to, linked as delegation links them. */
  const family = async () => {
    const parent = await create('Synthetic parent'), child = await create('Synthetic delegated worker')
    await workspace.host.setDelegatedBy(child.threadId, parent.threadId)
    await vi.waitFor(() => expect(control.watcherSnapshot().threads.find(item => item.id === child.threadId)?.delegatedBy).toBe(parent.threadId))
    return { parent, child }
  }
  const request = async () => {
    expect((await control.commandShell({ type: 'manual-send', threadId: watcherId(), draftId: randomUUID(), text: 'Synthetic Watcher user request' })).error).toBeNull()
    return service.state().requests.at(-1)!.id
  }
  const sends = () => workspace.adapters.codex.commands.filter(command => ['send', 'steer', 'interrupt'].includes(command.type) && 'threadId' in command && command.threadId !== undefined).length
  const watching = (threadId: string) => (control.watcherRecord().watches ?? []).some(watch => watch.target.threadId === threadId)
  return { workspace, project, model, call, emit, create, family, request, sends, watching, watcherId,
    get control() { return control }, get service() { return service },
    /** Sotto starting again on the same record, with Watcher's look at its watches held off for `lookAfterMs`. */
    restart: async (lookAfterMs: number) => {
      service.close(); await tools.close(); control.dispose(); await control.closed()
      control = f.create(); service = make(lookAfterMs); tools = new WatcherToolServer(service); workspace.host.useWatcherTools(tools)
      await control.start(); await control.commandShell({ type: 'connect', provider: 'codex' }); await service.recover()
    } }
}

it('refuses to send to, stop, settle or restore a delegated thread before anything goes, naming the thread that delegated it', async () => {
  const f = await fixture(), { parent, child } = await f.family(), requestId = await f.request()
  const before = f.sends(), operations = f.control.watcherRecord().operations.length
  const words = (nothing: string) => ({ status: 'refused', code: 'RESERVED_THREAD',
    message: `This thread is another thread’s delegated worker, and only the thread that delegated it directs it. Direct that thread instead: “Synthetic parent”, threadId ${parent.threadId}, hostId ${parent.hostId}. You can still read this one. ${nothing}` })
  for (const delivery of ['now', 'queue', 'steer'] as const) {
    expect(await f.call('send_to_thread', { requestId, retryKey: randomUUID(), target: child, text: 'Synthetic brief for the child', delivery })).toEqual(expect.objectContaining(words('Nothing was sent.')))
  }
  // A send that names no delivery, which would steer, is refused the same way.
  expect(await f.call('send_to_thread', { requestId, retryKey: randomUUID(), target: child, text: 'Synthetic brief for the child' })).toMatchObject(words('Nothing was sent.'))
  expect(await f.call('stop_thread', { requestId, retryKey: randomUUID(), target: child })).toMatchObject(words('Nothing was stopped.'))
  // Refused before the user's agreement is asked for, which Settle without asking, off here, would ask first.
  expect(await f.call('settle_thread', { requestId, retryKey: randomUUID(), target: child })).toMatchObject(words('Nothing was settled.'))
  expect(await f.call('unsettle_thread', { requestId, retryKey: randomUUID(), target: child })).toMatchObject(words('Nothing was changed.'))
  expect(f.sends()).toBe(before)
  expect(f.control.watcherRecord().operations).toHaveLength(operations)
  // Reading changes nothing in the thread, so Watcher may still read it to report on it.
  expect(await f.call('read_thread', { target: child })).toMatchObject({ status: 'ok', target: child })
  // The thread that delegated stays Watcher's to direct.
  expect(await f.call('send_to_thread', { requestId, retryKey: randomUUID(), target: parent, text: 'Synthetic brief for the parent', delivery: 'now' })).toMatchObject({ status: 'ok' })
  expect(f.sends()).toBe(before + 1)
})

it('watches no delegated thread from any path, and lists it with the thread that delegated it', async () => {
  const f = await fixture(), { parent, child } = await f.family()
  await f.request()
  expect(await f.call('watch_thread', { target: child })).toMatchObject({ status: 'refused', code: 'RESERVED_THREAD', message: expect.stringContaining('Nothing was watched.') })
  // The user's own Watch, from the room, a thread's page or the iPhone, comes through the same setter, so an older
  // client offering Watch there cannot add one either.
  expect(await f.service.watchThread({ target: child })).toMatchObject({ status: 'refused', code: 'RESERVED_THREAD', message: expect.stringContaining(parent.threadId) })
  expect(f.watching(child.threadId)).toBe(false)
  // The thread that delegated is the one to watch.
  expect(await f.service.watchThread({ target: parent })).toMatchObject({ status: 'ok' })
  expect(f.watching(parent.threadId)).toBe(true)
  const delegatedBy = { hostId: parent.hostId, threadId: parent.threadId, title: 'Synthetic parent' }
  const slim = await f.call('list_threads', {})
  if (slim.status !== 'ok') throw new Error('roster-refused')
  expect(slim.rows.find(row => row.target.threadId === child.threadId)).toMatchObject({ watched: false, delegatedBy })
  expect(slim.rows.find(row => row.target.threadId === parent.threadId)).not.toHaveProperty('delegatedBy')
  const full = await f.call('list_threads', { detail: 'full' })
  if (full.status !== 'ok') throw new Error('roster-refused')
  expect(full.rows.find(row => row.target.threadId === child.threadId)).toMatchObject({ delegatedBy })
})

it('lets go quietly of a watch an older build gave a delegated thread, and takes none for it at recovery', async () => {
  const f = await fixture(), { parent, child } = await f.family(), other = await f.create('Synthetic second delegated worker')
  await f.workspace.host.setDelegatedBy(other.threadId, parent.threadId)
  const requestId = await f.request(), at = new Date().toISOString()
  // What an older build left: a standing watch on one delegated thread, and the other taking part in the user's request,
  // which recovery once turned into a watch of its own.
  await f.control.updateWatcher(record => {
    (record.watches ??= []).push({ id: randomUUID(), target: child, createdAt: at, generation: 0, pausedByUserMessageId: null, lastUserMessageId: null })
    const request = record.requests.find(item => item.id === requestId)!
    request.state = 'active'; request.closedAt = null
    request.participants.push({ requestId, target: other, startedBy: 'user', generation: 0, state: 'participating', promptCount: 0, lastUserMessageId: null })
  })
  await f.restart(60_000)
  expect(f.watching(other.threadId)).toBe(false)
  expect(f.watching(child.threadId)).toBe(true)
  // Watcher's first look once it starts lets the delegated thread's watch go, as its own unwatch_thread does: no news of
  // it, and not the user's Stop watching, which would keep Watcher from the thread until the user handed it back.
  await f.restart(0)
  await f.emit()
  await vi.waitFor(() => expect(f.watching(child.threadId)).toBe(false))
  expect(f.control.watcherRecord().userUnwatches ?? []).toEqual([])
  expect((f.service.state().news ?? []).some(event => event.target.threadId === child.threadId)).toBe(false)
})
