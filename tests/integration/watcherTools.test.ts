// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { WatcherService } from '../../src/main/agents/watcher'
import { WATCHER_STOP_PAUSE } from '../../src/main/agents/followups'
import { watcherMessageRequests, watcherRequestLine, watcherRequestNote, watcherTextAsTyped } from '../../src/main/agents/watcherRequestNote'
import { watcherDisplayPrompt } from '../../src/main/agents/watcherMessageDisplay'
import { WATCHER_WAKE_UP_PROMPT, watcherNewsText } from '../../src/main/agents/watcherNews'
import { watcherWakeUpNote } from '../../src/main/agents/wakeUp'
import { WatcherPhoneService } from '../../src/main/agents/watcherPhone'
import { RESUME_NOTE } from '../../src/shared/restartResume'
import type { AgentThread, ProviderId } from '../../src/shared/agents'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import { watcherRecordSchema, watcherToolSchemas } from '../../src/shared/watcher'
import { countWorkingThreads } from '../../src/shared/workingThreads'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { deferred } from '../fixtures/deferred'
import { PIXEL_PNG } from '../fixtures/stagedImages'
import { initializeGitRepository } from '../fixtures/gitRepository'
import { followupStoreOf, storedFollowups } from '../fixtures/followupQueue'
import { FollowupStore } from '../../src/main/agents/followups'
import { watchRoomFixedPoint } from '../fixtures/watcherRoomFixedPoint'

/** These tests run on the real clock: ordinary news waits as long as a question does (#1190's timing has unit tests). */
const SHORT_BATCH = { quietMs: 2_000, maxMs: 5_000 }

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture(history = true) {
  const workspace = await workspaceFixture(undefined, { history })
  cleanups.push(workspace.remove)
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host,
    credentialOptions: { mode: 'unavailable' }, control: { historyEnabled: () => history, watcherEnabled: true } })
  const service = new WatcherService({ ordinaryBatch: SHORT_BATCH, directory: f.root, host: workspace.host, control: f.control,
    historyEnabled: () => history })
  const tools = new WatcherToolServer(service)
  workspace.host.useWatcherTools(tools)
  // The window passes the room update on unparsed (#1336), so every room this Watcher publishes must be what the parse gives.
  const room = watchRoomFixedPoint(service)
  cleanups.push(async () => {
    room.unsubscribe(); service.close(); await tools.close(); f.control.dispose(); await f.control.closed(); await workspace.stop()
    expect(room.published()).toBeGreaterThan(0); expect(room.failures()).toEqual([])
  })
  await f.control.start()
  await f.control.commandShell({ type: 'connect', provider: 'codex' })
  await service.recover()
  const model = f.control.shell().host.models.find(item => item.providerId === 'codex')!
  const project = f.control.shell().host.projects.find(item => item.providerId === 'codex')!
  const opened = await service.open({ provider: 'codex', modelId: model.id })
  expect(opened).toMatchObject({ status: 'ok' })
  const id = service.state().current!.target.threadId
  // A new Watcher is asked to read its state first (#1189); these tests start from one that has.
  await tools.call(id, 'read_state', {})
  const user = await f.control.commandShell({ type: 'manual-send', threadId: id, draftId: randomUUID(), text: 'Synthetic Watcher user request' })
  expect(user.error).toBeNull()
  const requestId = service.state().requests.at(-1)!.id
  const start = (retryKey = randomUUID()) => ({ requestId, retryKey, project: { hostId: f.control.hostId()!, projectId: project.id }, modelId: model.id,
    title: 'Synthetic worker', workingCopy: { kind: 'shared' as const }, firstPrompt: 'synthetic_worker_secret_64bd92' })
  const call = async (name: keyof typeof watcherToolSchemas, input: unknown) => {
    const result = await tools.call(id, name, input)
    return watcherToolSchemas[name].output.parse(result.structuredContent)
  }
  const native = (threadId: string) => {
    const binding = workspace.registry.byThread(threadId)!
    return workspace.adapters[binding.provider as keyof typeof workspace.adapters].state.threads.find(item => item.id === binding.sessionId)!
  }
  return { ...f, workspace, service, tools, id, requestId, model, project, start, call, native,
    finish: async (threadId: string) => {
      const binding = workspace.registry.byThread(threadId)!
      const native = workspace.adapters[binding.provider as keyof typeof workspace.adapters]
      const thread = native.state.threads.find(item => item.id === binding.sessionId)!
      thread.status = 'idle'; thread.lastTurn = { id: randomUUID(), status: 'completed' }; native.emit()
      await f.control.commandShell({ type: 'refresh', provider: binding.provider as ProviderId })
    } }
}

it('projects the local room and complete get without copying a coordinator shell', async () => {
  const f = await fixture()
  const started = await f.call('start_thread', f.start())
  if (started.status !== 'ok' || !('target' in started)) throw new Error('start refused')
  const before = f.service.state()
  const shell = vi.spyOn(f.control, 'shell').mockImplementation(() => { throw new Error('Room projection read a whole shell') })
  try {
    const room = f.service.state(), complete = f.service.get()
    expect(shell).not.toHaveBeenCalled()
    expect(room).toMatchObject({ current: before.current, currentOptions: before.currentOptions,
      watchedThreads: before.watchedThreads, requests: before.requests, receipts: before.receipts })
    expect(complete).toMatchObject({ status: 'ok', state: { current: before.current,
      currentOptions: before.currentOptions, requests: before.requests, receipts: before.receipts } })
  } finally { shell.mockRestore() }
})

it('creates one current master, attaches exact tools only there, starts and reads without changing selection or user marks', async () => {
  const f = await fixture()
  const selected = f.control.shell().activeThreadId, project = f.control.shell().activeProjectId
  expect(f.control.shell().host.projects.some(item => item.path.includes('watcher'))).toBe(false)
  const input = f.start(), result = await f.call('start_thread', input)
  expect(result).toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' }, limits: { promptCount: 1 } })
  if (result.status !== 'ok' || !('target' in result)) throw new Error('start refused')
  expect(f.control.shell().activeThreadId).toBe(selected)
  expect(f.control.shell().activeProjectId).toBe(project)
  const retry = await f.call('start_thread', input)
  expect(retry).toEqual(result)
  expect(f.workspace.adapters.codex.commands.filter(item => item.type === 'send' && item.text === input.firstPrompt)).toHaveLength(1)
  const before = f.control.shell().host.threads.map(thread => thread.finishedUnread)
  const read = await f.call('read_thread', { target: result.target })
  expect(read).toMatchObject({ status: 'ok', messages: [{ text: input.firstPrompt }] })
  expect(f.control.shell().host.threads.map(thread => thread.finishedUnread)).toEqual(before)
  expect(f.control.shell().activeThreadId).toBe(selected)
  expect(await f.tools.mcpServer(result.target.threadId)).toBeUndefined()
  expect(await f.tools.mcpServer(f.id)).toMatchObject({ name: 'sotto_threads' })
  expect(f.tools.definitions.map(item => item.name).sort()).toEqual(Object.keys(watcherToolSchemas).sort())
  expect((await f.tools.call(f.id, 'answer', { approved: true })).structuredContent).toMatchObject({ status: 'refused' })
})

it('lists host-setup jobs as protected and readable while refusing their mutations and master reads', async () => {
  const f = await fixture(), path = join(f.root, 'host-setup')
  expect((await f.control.commandForWatcherRoom({ type: 'create-project', provider: 'codex', title: 'Synthetic host setup', path })).error).toBeNull()
  const project = f.control.watcherSnapshot().projects.find(item => item.path === path)!
  const target = { hostId: f.control.hostId()!, threadId: randomUUID() }
  expect((await f.control.commandForWatcherRoom({ type: 'create-thread', threadId: target.threadId, projectId: project.id,
    title: 'Synthetic setup job', modelId: f.model.id })).error).toBeNull()
  expect((await f.control.commandShell({ type: 'manual-send', threadId: target.threadId, draftId: randomUUID(),
    text: 'Synthetic host setup progress' })).error).toBeNull()
  const selection = [f.control.shell().activeProjectId, f.control.shell().activeThreadId]
  const unread = f.control.watcherSnapshot().threads.find(item => item.id === target.threadId)!.finishedUnread
  expect(await f.call('list_threads', {})).toMatchObject({ status: 'ok', rows: expect.arrayContaining([expect.objectContaining({ target, protected: true })]) })
  expect(await f.call('list_threads', { detail: 'full' })).toMatchObject({ status: 'ok', rows: expect.arrayContaining([expect.objectContaining({ target, protected: true })]) })
  expect(await f.call('read_thread', { target })).toMatchObject({ status: 'ok', messages: [{ text: 'Synthetic host setup progress' }] })
  const record = f.control.watcherRecord(), commands = f.workspace.adapters.codex.commands.length
  for (const name of ['send_to_thread', 'stop_thread', 'settle_thread'] as const) {
    expect(await f.call(name, { requestId: f.requestId, retryKey: randomUUID(), target,
      ...(name === 'send_to_thread' ? { delivery: 'now', text: 'Synthetic forbidden setup instruction' } : {}) }))
      .toMatchObject({ status: 'refused', code: 'RESERVED_THREAD' })
  }
  expect(await f.call('start_thread', { ...f.start(), project: { hostId: target.hostId, projectId: project.id } }))
    .toMatchObject({ status: 'refused', code: 'RESERVED_THREAD' })
  expect(await f.call('read_thread', { target: f.service.state().current!.target })).toMatchObject({ status: 'refused', code: 'RESERVED_THREAD' })
  expect(f.control.watcherRecord()).toEqual(record)
  expect(f.workspace.adapters.codex.commands).toHaveLength(commands)
  expect([f.control.shell().activeProjectId, f.control.shell().activeThreadId]).toEqual(selection)
  expect(f.control.watcherSnapshot().threads.find(item => item.id === target.threadId)!.finishedUnread).toBe(unread)
})

it('starts past the old Threads in flight limit and keeps four prompts per target without replenishing retries (#1183)', async () => {
  const f = await fixture()
  const first = await f.call('start_thread', f.start())
  expect(first.status).toBe('ok')
  // The old limit was one to eight; nothing refuses a start now, whatever is working.
  for (let more = 0; more < 8; more++) expect(await f.call('start_thread', f.start())).toMatchObject({ status: 'ok' })
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start refused')
  await f.finish(first.target.threadId)
  for (let count = 2; count <= 4; count++) {
    const input = { requestId: f.requestId, retryKey: randomUUID(), target: first.target, delivery: 'now', text: `Synthetic follow-up ${count}` }
    expect(await f.call('send_to_thread', input)).toMatchObject({ status: 'ok', limits: { promptCount: count } })
    expect(await f.call('send_to_thread', input)).toMatchObject({ status: 'ok', limits: { promptCount: count } })
    await f.finish(first.target.threadId)
  }
  expect(await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target, delivery: 'now', text: 'Synthetic exhausted' }))
    .toMatchObject({ status: 'refused', code: 'PROMPT_LIMIT' })
})

it('says in a start’s result, and only there, once more than ten threads are working on this computer (#1183)', async () => {
  const f = await fixture()
  const working = () => countWorkingThreads(f.control.watcherSnapshot().threads)
  // Watcher's own thread is working on the user's request, and is not counted.
  expect(working()).toBe(0)
  for (let started = 1; started <= 10; started++) {
    const result = await f.call('start_thread', f.start())
    expect(result).toMatchObject({ status: 'ok' })
    expect(result).not.toHaveProperty('warning')
    expect(working()).toBe(started)
  }
  const input = f.start(), eleventh = await f.call('start_thread', input)
  expect(eleventh).toMatchObject({ status: 'ok', warning: '11 threads are working. This computer may slow down or use its battery faster.' })
  if (eleventh.status !== 'ok' || !('target' in eleventh)) throw new Error('start refused')
  expect((eleventh as unknown as { limits: object }).limits).toEqual({ promptCount: 1, promptLimit: 4 })
  // A retry reads the receipt again and says nothing of the count, even with ten others still working: its own thread
  // has finished, and counting it again would invent an eleventh.
  await f.finish(eleventh.target.threadId)
  expect(working()).toBe(10)
  const retried = await f.call('start_thread', input)
  expect(retried).toMatchObject({ status: 'ok', receipt: { operationId: (eleventh as unknown as { receipt: { operationId: string } }).receipt.operationId } })
  expect(retried).not.toHaveProperty('warning')
  // A send is not a start, and says nothing of it.
  expect(await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: eleventh.target, delivery: 'now', text: 'Synthetic follow-up' }))
    .not.toHaveProperty('warning')
})

it('saves at most eight reservations, so a build from before #1183 still reads the file, and rebuilds the rest on load', async () => {
  const f = await fixture()
  for (let started = 1; started <= 11; started++) expect(await f.call('start_thread', f.start())).toMatchObject({ status: 'ok' })
  expect(f.service.startsInFlight()).toBe(11)
  expect(f.control.watcherRecordView().reservations).toHaveLength(11)
  f.service.close(); f.control.dispose(); await f.control.closed()
  // The Watcher record schema before #1183 is this one with at most eight reservations. A record it could not read would
  // cost that build all of agents.json.
  const older = watcherRecordSchema.refine(record => record.reservations.length <= 8)
  const saved = JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')) as { watcher: unknown }
  expect(older.safeParse(saved.watcher).success).toBe(true)
  // This build puts back what the file left off, for the threads still working.
  const restored = f.create(), service = new WatcherService({ directory: f.root, control: restored, host: f.workspace.host, historyEnabled: () => true })
  cleanups.push(async () => { service.close(); restored.dispose(); await restored.closed() })
  await restored.start(); await restored.commandShell({ type: 'connect', provider: 'codex' }); await service.recover()
  expect(service.startsInFlight()).toBe(11)
}, 40_000)

it('rebuilds the reservations the file left off even when a saved one is pruned before Watcher recovers (#1183)', async () => {
  const f = await fixture()
  for (let started = 1; started <= 11; started++) expect(await f.call('start_thread', f.start())).toMatchObject({ status: 'ok' })
  f.service.close(); f.control.dispose(); await f.control.closed()
  const saved = JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')) as { watcher: { reservations: { target: { threadId: string } }[] } }
  expect(saved.watcher.reservations).toHaveLength(8)
  // While Sotto is closed, one thread the file kept finishes: the threads observed at start prune its reservation before
  // Watcher recovers, leaving seven in the record.
  const finished = f.workspace.registry.byThread(saved.watcher.reservations[0]!.target.threadId)!
  const native = f.workspace.adapters.codex.state.threads.find(item => item.id === finished.sessionId)!
  native.status = 'idle'; native.lastTurn = { id: native.lastTurn?.id ?? randomUUID(), status: 'completed' }
  const restored = f.create(), service = new WatcherService({ directory: f.root, control: restored, host: f.workspace.host, historyEnabled: () => true })
  cleanups.push(async () => { service.close(); restored.dispose(); await restored.closed() })
  await restored.start(); await restored.commandShell({ type: 'connect', provider: 'codex' }); await service.recover()
  expect(service.startsInFlight()).toBe(10)
}, 40_000)

it('opens an unchanged busy Watcher and keeps a queued user follow-up in its original request with a new turn budget', async () => {
  const f = await fixture(), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start refused')
  expect(await f.service.open({ provider: 'codex', modelId: f.model.id })).toMatchObject({ status: 'ok' })
  const draftId = randomUUID()
  await f.control.commandShell({ type: 'queue-followup', threadId: f.id, draftId, text: 'Synthetic user continuation' })
  expect(f.service.state().requests[0]?.userFollowups).toEqual([{ draftId }])
  await f.finish(f.id)
  await vi.waitFor(() => expect(f.workspace.adapters.codex.commands.some(item => item.type === 'send' && item.text.startsWith('Synthetic user continuation'))).toBe(true))
  expect(f.service.state().requests).toHaveLength(1)
  expect(f.service.state().requests[0]).toMatchObject({ id: f.requestId, userFollowups: [{ draftId, messageId: expect.any(String) }] })
  await f.finish(first.target.threadId)
  expect(await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target, delivery: 'now', text: 'Synthetic continuation to worker' }))
    .toMatchObject({ status: 'ok', limits: { promptCount: 1 } })
})

it('refuses pending requests for all delivery modes, refuses wider permissions and never offers answers', async () => {
  const f = await fixture(), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start refused')
  const binding = f.workspace.registry.byThread(first.target.threadId)!
  const native = f.workspace.adapters.codex.state.threads.find(item => item.id === binding.sessionId)!
  native.requests = [{ id: 'synthetic-permission', kind: 'permission', text: 'Synthetic permission', options: [] }]; f.workspace.adapters.codex.emit()
  await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  const operations = f.control.watcherRecord().operations.length
  for (const delivery of ['now', 'queue', 'steer']) expect(await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target, delivery, text: 'Synthetic blocked' }))
    .toMatchObject({ status: 'refused', code: 'PENDING_USER_REQUEST' })
  expect(f.control.watcherRecord().operations).toHaveLength(operations)
  expect(await f.call('start_thread', { ...f.start(), permission: { kind: 'runtime', mode: 'full-access' } })).toMatchObject({ status: 'refused' })
  expect(f.workspace.adapters.codex.commands.some(item => item.type === 'answer')).toBe(false)
})

it('fences a queued machine prompt before a direct user send, preserves user input and keeps the thread watched', async () => {
  const f = await fixture(), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start refused')
  expect(await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target, delivery: 'queue', text: 'synthetic_machine_queued' })).toMatchObject({ status: 'ok' })
  await f.control.commandShell({ type: 'manual-send', threadId: first.target.threadId, draftId: randomUUID(), text: 'synthetic_direct_user' })
  await f.finish(first.target.threadId)
  expect(f.service.state().watchedThreads[0]).toMatchObject({ watched: true, participation: [{ state: 'participating' }] })
  // The user's prompt goes from the queue once Watcher's turn ends; Watcher sends again once the user's own turn has ended.
  await f.finish(f.id)
  await vi.waitFor(async () => { await f.finish(first.target.threadId); expect(f.service.state().watchedThreads[0]!.paused).toBe(false) })
  await f.control.commandShell({ type: 'manual-send', threadId: f.id, draftId: randomUUID(), text: 'Synthetic new request' })
  const nextRequest = f.service.state().requests.at(-1)!.id
  expect(await f.call('send_to_thread', { requestId: nextRequest, retryKey: randomUUID(), target: first.target, delivery: 'queue', text: 'synthetic_after_user' })).toMatchObject({ status: 'ok' })
  expect(f.workspace.adapters.codex.commands.some(item => item.type === 'send' && item.text === 'synthetic_machine_queued')).toBe(false)
  expect(f.control.shell().followups?.some(item => item.text === 'synthetic_direct_user') || f.workspace.adapters.codex.commands.some(item => item.type === 'send' && item.text === 'synthetic_direct_user')).toBe(true)
})

it('rechecks takeover after the read before send without dispatching the machine text', async () => {
  const f = await fixture(), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start refused')
  await f.finish(first.target.threadId)
  const entered = deferred<void>(), release = deferred<void>(), original = f.workspace.host.refreshThread.bind(f.workspace.host)
  const spy = vi.spyOn(f.workspace.host, 'refreshThread').mockImplementation(async (id, purpose) => {
    if (id === first.target.threadId && purpose?.beforeSend) { entered.resolve(); await release.promise }
    return original(id, purpose)
  })
  const machine = f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target, delivery: 'now', text: 'synthetic_racing_machine' })
  await entered.promise
  const user = f.control.commandShell({ type: 'manual-send', threadId: first.target.threadId, draftId: randomUUID(), text: 'synthetic_racing_user' })
  release.resolve(); await machine; await user; spy.mockRestore()
  expect(f.workspace.adapters.codex.commands.some(item => item.type === 'send' && item.text === 'synthetic_racing_machine')).toBe(false)
  expect(f.service.state().watchedThreads[0]).toMatchObject({ watched: true, participation: [{ state: 'participating' }] })
})

it('writes no Watcher drafts, machine queues or worker message words with history off', async () => {
  const f = await fixture(false), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start refused')
  await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target, delivery: 'queue', text: 'synthetic_queue_secret_54badd' })
  await f.control.commandShell({ type: 'compose', threadId: f.id, text: 'synthetic_watcher_draft_secret_23bc7a' })
  await f.control.privacyChanged()
  const inspect = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const file = join(folder, entry.name)
      if (entry.isDirectory()) await inspect(file)
      else {
        const bytes = await readFile(file)
        for (const text of ['synthetic_worker_secret_64bd92', 'synthetic_queue_secret_54badd', 'synthetic_watcher_draft_secret_23bc7a', 'Synthetic Watcher user request']) expect(bytes.includes(Buffer.from(text))).toBe(false)
      }
    }
  }
  await inspect(f.root)
  expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).watcher.operations.length).toBe(2)
})

it('requires a main preview for Stop all, stops only started participants and refuses stale confirmations', async () => {
  const f = await fixture(), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start refused')
  const preview = f.service.prepareStopAll()
  expect(preview).toMatchObject({ status: 'ok', targets: [first.target] })
  if (preview.status !== 'ok') throw new Error('preview refused')
  const result = await f.service.stopAll(preview.confirmationId)
  expect(result).toMatchObject({ status: 'ok' })
  expect(f.workspace.adapters.codex.commands.filter(item => item.type === 'interrupt')).toHaveLength(1)
  expect(await f.service.stopAll(preview.confirmationId)).toMatchObject({ status: 'refused', code: 'TARGET_CHANGED' })
  expect(await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target, delivery: 'queue', text: 'Synthetic stopped request' })).toMatchObject({ status: 'refused', code: 'REQUEST_NOT_ACTIVE' })
})

it('refuses Stop all preview and confirmation after closing without coordinator effects', async () => {
  const f = await fixture(), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start refused')
  const preview = f.service.prepareStopAll()
  if (preview.status !== 'ok') throw new Error('preview refused')
  f.service.close()
  const record = f.control.watcherRecord(), commands = f.workspace.adapters.codex.commands.length
  const update = vi.spyOn(f.control, 'updateWatcher'), cancel = vi.spyOn(f.control, 'cancelWatcherQueue'), command = vi.spyOn(f.control, 'commandFromWatcher')
  const latePreview = f.service.prepareStopAll()
  const result = await f.service.stopAll(latePreview.status === 'ok' ? latePreview.confirmationId : preview.confirmationId)
  expect(result).toMatchObject({ status: 'refused', code: 'NOT_CURRENT_WATCHER' })
  expect(latePreview).toMatchObject({ status: 'refused', code: 'NOT_CURRENT_WATCHER' })
  expect(f.control.watcherRecord()).toEqual(record)
  expect(f.workspace.adapters.codex.commands).toHaveLength(commands)
  expect(update).not.toHaveBeenCalled()
  expect(cancel).not.toHaveBeenCalled()
  expect(command).not.toHaveBeenCalled()
  update.mockRestore(); cancel.mockRestore(); command.mockRestore()
})

it.each(['expiry', 'capacity'])('prunes unsubmitted Stop all previews by %s and keeps the newest confirmation usable', async reason => {
  const f = await fixture(), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start refused')
  const oldest = f.service.prepareStopAll()
  if (oldest.status !== 'ok') throw new Error('preview refused')
  // Retained previews are a memory budget; expiry alone is otherwise invisible until an ID is submitted.
  const retained = (f.service as unknown as { confirmations: ReadonlyMap<string, unknown> }).confirmations
  const clock = reason === 'expiry' ? vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001) : undefined
  try {
    let latest = oldest
    for (let count = 0; count < (reason === 'expiry' ? 1 : 16); count++) {
      const preview = f.service.prepareStopAll()
      if (preview.status !== 'ok') throw new Error('preview refused')
      latest = preview
    }
    expect(retained.has(oldest.confirmationId)).toBe(false)
    expect(retained.size).toBe(reason === 'expiry' ? 1 : 16)
    const record = f.control.watcherRecord()
    expect(await f.service.stopAll(oldest.confirmationId)).toMatchObject({ status: 'refused', code: 'TARGET_CHANGED' })
    expect(f.control.watcherRecord()).toEqual(record)
    expect(f.workspace.adapters.codex.commands.filter(item => item.type === 'interrupt')).toHaveLength(0)
    expect(await f.service.stopAll(latest.confirmationId)).toMatchObject({ status: 'ok', results: [{ target: first.target, status: 'stopped' }] })
    expect(f.workspace.adapters.codex.commands.filter(item => item.type === 'interrupt')).toHaveLength(1)
  } finally { clock?.mockRestore() }
})

it('keeps Stop all confirmation valid when a previewed worker receives another Watcher prompt', async () => {
  const f = await fixture(), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start refused')
  await f.finish(first.target.threadId)
  const selection = [f.control.shell().activeProjectId, f.control.shell().activeThreadId]
  const preview = f.service.prepareStopAll()
  if (preview.status !== 'ok') throw new Error('preview refused')
  expect(await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target,
    delivery: 'now', text: 'Synthetic follow-up during confirmation' })).toMatchObject({ status: 'ok', limits: { promptCount: 2 } })
  expect(await f.service.stopAll(preview.confirmationId)).toMatchObject({ status: 'ok', results: [{ target: first.target, status: 'stopped' }] })
  expect(f.workspace.adapters.codex.commands.filter(item => item.type === 'interrupt')).toHaveLength(1)
  expect([f.control.shell().activeProjectId, f.control.shell().activeThreadId]).toEqual(selection)
})

it('refuses a Stop all preview when its eligible ownership changes without stopping an unshown worker', async () => {
  const f = await fixture(), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start refused')
  const preview = f.service.prepareStopAll()
  if (preview.status !== 'ok') throw new Error('preview refused')
  expect(preview.targets).toEqual([first.target])
  expect(await f.call('start_thread', f.start())).toMatchObject({ status: 'ok' })
  const record = f.control.watcherRecord()
  expect(await f.service.stopAll(preview.confirmationId)).toMatchObject({ status: 'refused', code: 'TARGET_CHANGED' })
  expect(f.control.watcherRecord()).toEqual(record)
  expect(f.workspace.adapters.codex.commands.filter(item => item.type === 'interrupt')).toHaveLength(0)
})

it('refuses Stop all after the user sends to a previewed worker without changing its saved record', async () => {
  const f = await fixture(), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start refused')
  const preview = f.service.prepareStopAll()
  if (preview.status !== 'ok') throw new Error('preview refused')
  await f.control.commandShell({ type: 'manual-send', threadId: first.target.threadId, draftId: randomUUID(), text: 'Synthetic user takeover' })
  const record = f.control.watcherRecord()
  expect(await f.service.stopAll(preview.confirmationId)).toMatchObject({ status: 'refused', code: 'TARGET_CHANGED' })
  expect(f.control.watcherRecord()).toEqual(record)
  expect(f.workspace.adapters.codex.commands.filter(item => item.type === 'interrupt')).toHaveLength(0)
})

it('keeps an existing-thread acknowledgement uncertain without consuming start capacity or resending on a retry', async () => {
  const f = await fixture(), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start refused')
  await f.finish(first.target.threadId)
  const original = f.workspace.adapters.codex.execute.bind(f.workspace.adapters.codex)
  let written: Parameters<typeof original>[0] | undefined
  const spy = vi.spyOn(f.workspace.adapters.codex, 'execute').mockImplementation(async command => {
    if (command.type === 'send' && command.text === 'synthetic_lost_ack') { written = command; return { accepted: false, uncertain: true } }
    return original(command)
  })
  const input = { requestId: f.requestId, retryKey: randomUUID(), target: first.target, delivery: 'now', text: 'synthetic_lost_ack' }
  const result = await f.call('send_to_thread', input)
  expect(result).toMatchObject({ status: 'ok', receipt: { deliveryState: 'uncertain' } })
  expect(f.service.startsInFlight()).toBe(0)
  expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).watcher.operations.at(-1).deliveryState).toBe('uncertain')
  const count = spy.mock.calls.length
  expect(await f.call('send_to_thread', input)).toEqual(result)
  expect(spy.mock.calls).toHaveLength(count)
  expect(written).toBeDefined()
  await original(written!)
  await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  expect(await f.call('send_to_thread', input)).toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' } })
})

it('refuses a request appearing during the read without consuming new-thread start capacity', async () => {
  const f = await fixture(), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start refused')
  await f.finish(first.target.threadId)
  const original = f.workspace.host.refreshThread.bind(f.workspace.host)
  const spy = vi.spyOn(f.workspace.host, 'refreshThread').mockImplementation(async (id, purpose) => {
    if (id === first.target.threadId && purpose?.beforeSend) {
      const binding = f.workspace.registry.byThread(id)!
      f.workspace.adapters.codex.state.threads.find(thread => thread.id === binding.sessionId)!.requests = [
        { id: 'synthetic-race-question', kind: 'question', text: 'Synthetic question', options: [] },
      ]
      f.workspace.adapters.codex.emit()
    }
    return original(id, purpose)
  })
  expect(await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target, delivery: 'now', text: 'synthetic_request_race' }))
    .toMatchObject({ status: 'refused', code: 'PENDING_USER_REQUEST' })
  spy.mockRestore()
  expect(f.workspace.adapters.codex.commands.some(item => item.type === 'send' && item.text === 'synthetic_request_race')).toBe(false)
  expect(f.service.startsInFlight()).toBe(0)
})

it('fences an admitted send still waiting on a read before targeted Stop', async () => {
  const f = await fixture(), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start refused')
  await f.finish(first.target.threadId)
  const entered = deferred(), released = deferred(), read = f.workspace.host.refreshThread.bind(f.workspace.host)
  vi.spyOn(f.workspace.host, 'refreshThread').mockImplementation(async (id, purpose) => {
    if (id === first.target.threadId && purpose?.beforeSend) { entered.resolve(); await released.promise }
    return read(id, purpose)
  })
  const machine = f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target, delivery: 'now', text: 'Synthetic stopped preparation' })
  try {
    await entered.promise
    expect(await f.call('stop_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target })).toMatchObject({ status: 'ok' })
    released.resolve()
    expect(await machine).toMatchObject({ status: 'refused', code: 'REQUEST_NOT_ACTIVE' })
    expect(f.workspace.adapters.codex.commands.some(item => item.type === 'send' && item.text === 'Synthetic stopped preparation')).toBe(false)
    expect(await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target, delivery: 'queue', text: 'Synthetic stopped replenishment' }))
      .toMatchObject({ status: 'refused', code: 'REQUEST_NOT_ACTIVE' })
  } finally { released.resolve(); await machine }
})

it('reports the original reserved creation receipt after process loss before the target exists', async () => {
  const f = await fixture(), input = f.start(), target = { hostId: f.control.hostId()!, threadId: randomUUID() }, operationId = randomUUID(), time = new Date().toISOString()
  await f.control.updateWatcher(record => {
    record.requests.find(item => item.id === f.requestId)!.participants.push({ requestId: f.requestId, target, startedBy: 'watcher', generation: 0, state: 'participating', promptCount: 1 })
    record.operations.push({ id: operationId, requestId: f.requestId, retryKey: input.retryKey,
      digest: createHash('sha256').update(JSON.stringify(['start_thread', watcherToolSchemas.start_thread.input.parse(input)])).digest('hex'), target, action: 'start', generation: 0,
      delivery: 'now', deliveryState: 'queued', createdAt: time, updatedAt: time, receiptId: randomUUID(), cardId: randomUUID(),
      creationReceiptId: randomUUID(), firstPromptReceiptId: randomUUID(), draftId: randomUUID(), messageId: randomUUID(), anchorMessageId: record.requests[0]!.rootUserMessageId })
    record.reservations.push({ target, requestId: f.requestId, operationId, generation: 0, reason: 'creation' })
  })
  const before = f.workspace.adapters.codex.commands.length
  expect(await f.call('start_thread', input)).toMatchObject({ status: 'refused', code: 'DELIVERY_UNCERTAIN', receipt: { operationId, target, deliveryState: 'queued' } })
  expect(f.workspace.adapters.codex.commands).toHaveLength(before)
  expect(f.service.startsInFlight()).toBe(1)
})

it('serves structured MCP results through a thread-bound loopback token and revokes it', async () => {
  const f = await fixture(), server = await f.tools.mcpServer(f.id)
  const headers = { 'Content-Type': 'application/json', Authorization: server!.headers[0]!.value }
  const response = await fetch(server!.url, { method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_projects', arguments: {} } }) })
  const frame = await response.json() as { result: { structuredContent: unknown } }
  expect(watcherToolSchemas.list_projects.output.parse(frame.result.structuredContent).status).toBe('ok')
  f.tools.revoke(f.id)
  expect((await fetch(server!.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) })).status).toBe(401)
})


it('delivers a continuation queued before a stop under a request of its own, which may start threads (#1184)', async () => {
  const f = await fixture(), started = await f.call('start_thread', f.start())
  expect(started.status).toBe('ok')
  expect((await f.control.commandShell({ type: 'queue-followup', threadId: f.id, draftId: randomUUID(), text: 'Synthetic stopped continuation' })).error).toBeNull()
  const draftId = f.control.shell().followups!.find(item => item.threadId === f.id)!.draftId
  expect(f.service.state().requests[0]).toMatchObject({ id: f.requestId, userFollowups: [{ draftId }] })
  const preview = f.service.prepareStopAll()
  if (preview.status !== 'ok') throw new Error('preview refused')
  expect(await f.service.stopAll(preview.confirmationId)).toMatchObject({ status: 'ok' })
  await f.finish(f.id)
  await vi.waitFor(() => expect(f.workspace.adapters.codex.commands.some(item => item.type === 'send' && item.text.startsWith('Synthetic stopped continuation'))).toBe(true))
  // The stopped request stays stopped, and keeps nothing of the instruction; the instruction's own request is active.
  const stopped = f.service.state().requests.find(item => item.id === f.requestId), fresh = f.service.state().requests.find(item => item.id !== f.requestId)
  expect(f.service.state().requests).toHaveLength(2)
  expect(stopped).toMatchObject({ id: f.requestId, state: 'stopped', userFollowups: [] })
  expect(fresh).toMatchObject({ state: 'active', userFollowups: [{ draftId, messageId: expect.any(String) }] })
  expect(fresh!.rootUserMessageId).toBe(fresh!.userFollowups![0]!.messageId)
  const sent = f.workspace.adapters.codex.commands.find(item => item.type === 'send' && item.text.startsWith('Synthetic stopped continuation'))
  expect(sent).toMatchObject({ watcherRequestNote: expect.stringContaining(fresh!.id) })
  expect(await f.call('start_thread', f.start())).toMatchObject({ status: 'refused', code: 'REQUEST_NOT_ACTIVE' })
  expect(await f.call('start_thread', { ...f.start(), requestId: fresh!.id })).toMatchObject({ status: 'ok' })
})

it('delivers a continuation under its own request when the request it was queued for closed while it waited (#1184)', async () => {
  const f = await fixture()
  expect((await f.control.commandShell({ type: 'queue-followup', threadId: f.id, draftId: randomUUID(), text: 'Synthetic continuation of a closed request' })).error).toBeNull()
  await f.control.updateWatcher(record => { const request = record.requests.find(item => item.id === f.requestId)!; request.state = 'closed'; request.closedAt = new Date().toISOString() })
  await f.finish(f.id)
  await vi.waitFor(() => expect(f.workspace.adapters.codex.commands.some(item => item.type === 'send' && item.text.startsWith('Synthetic continuation of a closed request'))).toBe(true))
  const fresh = f.service.state().requests.find(item => item.id !== f.requestId)!
  expect(fresh).toMatchObject({ state: 'active' })
  expect(await f.call('start_thread', { ...f.start(), requestId: fresh.id })).toMatchObject({ status: 'ok' })
})

it('gives a continuation whose tries never reached the provider a request of its own, rooted in the message that went, after a Stop (#1184)', async () => {
  const f = await fixture(), text = 'Synthetic refused continuation'
  const codex = f.workspace.adapters.codex, execute = codex.execute.bind(codex)
  let refusals = 1
  vi.spyOn(codex, 'execute').mockImplementation(async command => command.type === 'send' && command.text.startsWith(text) && refusals-- > 0
    ? { accepted: false, error: 'Synthetic definite refusal.' } : execute(command))
  const failed = () => f.control.shell().followups!.find(item => item.text === text)?.status
  expect((await f.control.commandShell({ type: 'queue-followup', threadId: f.id, draftId: randomUUID(), text })).error).toBeNull()
  await f.finish(f.id)
  await vi.waitFor(() => expect(failed()).toBe('failed'), { timeout: 30_000 })
  // The user stops Watcher while the message waits for review: its request is over.
  expect((await f.control.commandShell({ type: 'interrupt', threadId: f.id })).error).toBeNull()
  expect(f.service.state().requests.find(item => item.id === f.requestId)?.state).toBe('stopped')
  // Resumed, the message starts a request of its own; that delivery is refused too, and the request goes with it.
  refusals = 1
  expect((await f.control.commandShell({ type: 'resume-followups', threadId: f.id })).error).toBeNull()
  await vi.waitFor(() => expect(failed()).toBe('failed'), { timeout: 30_000 })
  expect(f.service.state().requests.filter(item => item.id !== f.requestId)).toEqual([])
  expect((await f.control.commandShell({ type: 'resume-followups', threadId: f.id })).error).toBeNull()
  await vi.waitFor(() => expect(codex.commands.filter(command => command.type === 'send' && command.text.startsWith(text))).toHaveLength(1), { timeout: 30_000 })
  const sent = codex.commands.find(command => command.type === 'send' && command.text.startsWith(text))
  if (sent?.type !== 'send') throw new Error('The message was not sent')
  const fresh = f.service.state().requests.filter(item => item.id !== f.requestId)
  expect(fresh).toHaveLength(1)
  expect(fresh[0]).toMatchObject({ state: 'active', rootUserMessageId: sent.messageId })
  expect(sent).toMatchObject({ watcherRequestNote: expect.stringContaining(fresh[0]!.id) })
  expect(await f.call('start_thread', { ...f.start(), requestId: fresh[0]!.id })).toMatchObject({ status: 'ok' })
})

it('queues the next message under the request a resumed one started, though it sits before the stopped request (#1184)', async () => {
  const f = await fixture(), first = 'Synthetic continuation after a stop', second = 'Synthetic message while the new request works'
  expect((await f.call('start_thread', f.start())).status).toBe('ok')
  expect((await f.control.commandShell({ type: 'queue-followup', threadId: f.id, draftId: randomUUID(), text: first })).error).toBeNull()
  const preview = f.service.prepareStopAll()
  if (preview.status !== 'ok') throw new Error('preview refused')
  expect(await f.service.stopAll(preview.confirmationId)).toMatchObject({ status: 'ok' })
  await f.finish(f.id)
  await vi.waitFor(() => expect(f.workspace.adapters.codex.commands.some(item => item.type === 'send' && item.text.startsWith(first))).toBe(true))
  const fresh = f.service.state().requests.find(item => item.id !== f.requestId)!
  // It took the stopped request's place among takeovers, so it comes first in the record.
  const ids = f.service.state().requests.map(item => item.id)
  expect(ids.indexOf(fresh.id)).toBeLessThan(ids.indexOf(f.requestId))
  expect(await f.call('start_thread', { ...f.start(), requestId: fresh.id })).toMatchObject({ status: 'ok' })
  // While Watcher answers it, the user queues another message: it continues the newer request, not the stopped one.
  const draftId = randomUUID()
  expect((await f.control.commandShell({ type: 'queue-followup', threadId: f.id, draftId, text: second })).error).toBeNull()
  expect(f.service.state().requests.find(item => item.id === fresh.id)!.userFollowups).toContainEqual(expect.objectContaining({ draftId }))
  expect(f.service.state().requests.find(item => item.id === f.requestId)!.userFollowups ?? []).not.toContainEqual(expect.objectContaining({ draftId }))
  await f.finish(f.id)
  await vi.waitFor(() => expect(f.workspace.adapters.codex.commands.some(item => item.type === 'send' && item.text.startsWith(second))).toBe(true))
  const sent = f.workspace.adapters.codex.commands.find(item => item.type === 'send' && item.text.startsWith(second))
  expect(sent).toMatchObject({ watcherRequestNote: expect.stringContaining(fresh.id) })
  expect(f.service.state().requests).toHaveLength(2)
})

it('gives a continuation an older build left holding its refused message a request of its own after a Stop (#1184)', async () => {
  const f = await fixture(), text = 'Synthetic continuation an older build refused'
  const codex = f.workspace.adapters.codex, execute = codex.execute.bind(codex)
  let refusals = 1
  vi.spyOn(codex, 'execute').mockImplementation(async command => command.type === 'send' && command.text.startsWith(text) && refusals-- > 0
    ? { accepted: false, error: 'Synthetic definite refusal.' } : execute(command))
  const draftId = randomUUID()
  expect((await f.control.commandShell({ type: 'queue-followup', threadId: f.id, draftId, text })).error).toBeNull()
  await f.finish(f.id)
  await vi.waitFor(() => expect(f.control.shell().followups!.find(item => item.text === text)?.status).toBe('failed'), { timeout: 30_000 })
  // A build from before #1184 kept the refused message on the continuation; this one clears it, so it is put back.
  const refused = randomUUID()
  await f.control.updateWatcher(record => { record.requests.find(item => item.id === f.requestId)!.userFollowups!.find(item => item.draftId === draftId)!.messageId = refused })
  expect((await f.control.commandShell({ type: 'interrupt', threadId: f.id })).error).toBeNull()
  expect(f.service.state().requests.find(item => item.id === f.requestId)?.state).toBe('stopped')
  expect((await f.control.commandShell({ type: 'resume-followups', threadId: f.id })).error).toBeNull()
  await vi.waitFor(() => expect(codex.commands.some(command => command.type === 'send' && command.text.startsWith(text))).toBe(true), { timeout: 30_000 })
  const sent = codex.commands.find(command => command.type === 'send' && command.text.startsWith(text))
  if (sent?.type !== 'send') throw new Error('The message was not sent')
  expect(sent.messageId).not.toBe(refused)
  const fresh = f.service.state().requests.find(item => item.rootUserMessageId === sent.messageId)!
  expect(fresh).toMatchObject({ state: 'active' })
  expect(fresh.id).not.toBe(f.requestId)
  expect(sent).toMatchObject({ watcherRequestNote: expect.stringContaining(fresh.id) })
  expect(f.service.state().requests.find(item => item.id === f.requestId)!.userFollowups ?? []).not.toContainEqual(expect.objectContaining({ draftId }))
})

it('keeps a refused delivery’s request that a takeover took as its boundary meanwhile, so later requests are not fenced (#1184)', async () => {
  const f = await fixture(), text = 'Synthetic refused after a takeover'
  const codex = f.workspace.adapters.codex, execute = codex.execute.bind(codex)
  vi.spyOn(codex, 'execute').mockImplementation(async command => {
    if (command.type !== 'send' || !command.text.startsWith(text)) return execute(command)
    // While the send is on its way, a takeover of a watched thread records the newest request as its boundary.
    const newest = f.control.watcherRecord().requests.find(item => item.rootUserMessageId === command.messageId)!.id
    await f.control.updateWatcher(record => { record.localTakeovers = [...record.localTakeovers ?? [], { target: { hostId: f.control.hostId()!, threadId: randomUUID() }, at: new Date().toISOString(), lastRequestId: newest }] })
    return { accepted: false, error: 'Synthetic definite refusal.' }
  })
  await f.control.updateWatcher(record => { const request = record.requests.find(item => item.id === f.requestId)!; request.state = 'stopped'; request.closedAt = new Date().toISOString() })
  expect((await f.control.commandShell({ type: 'queue-followup', threadId: f.id, draftId: randomUUID(), text })).error).toBeNull()
  await f.finish(f.id)
  await vi.waitFor(() => expect(f.control.shell().followups!.find(item => item.text === text)?.status).toBe('failed'), { timeout: 30_000 })
  const anchored = f.control.watcherRecord().localTakeovers!.at(-1)!.lastRequestId
  expect(anchored).not.toBe(f.requestId)
  expect(f.control.watcherRecord().requests.some(item => item.id === anchored)).toBe(true)
})

it('keeps a continuation delivered while its request is active on that request', async () => {
  const f = await fixture()
  expect((await f.control.commandShell({ type: 'queue-followup', threadId: f.id, draftId: randomUUID(), text: 'Synthetic live continuation' })).error).toBeNull()
  await f.finish(f.id)
  await vi.waitFor(() => expect(f.workspace.adapters.codex.commands.some(item => item.type === 'send' && item.text.startsWith('Synthetic live continuation'))).toBe(true))
  expect(f.service.state().requests).toHaveLength(1)
  expect(f.service.state().requests[0]).toMatchObject({ id: f.requestId, state: 'active', userFollowups: [{ messageId: expect.any(String) }] })
})

it('retains an uncertain existing delivery through takeover while admitting an unrelated new start', async () => {
  const f = await fixture()
  const first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start refused')
  await f.finish(first.target.threadId)
  const original = f.workspace.adapters.codex.execute.bind(f.workspace.adapters.codex)
  let written: Parameters<typeof original>[0] | undefined
  vi.spyOn(f.workspace.adapters.codex, 'execute').mockImplementation(async command => {
    if (command.type === 'send' && command.text === 'Synthetic unknown delivery') { written = command; return { accepted: false, uncertain: true } }
    return original(command)
  })
  expect(await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target, delivery: 'now', text: 'Synthetic unknown delivery' }))
    .toMatchObject({ status: 'ok', receipt: { deliveryState: 'uncertain' } })
  await f.control.commandShell({ type: 'queue-followup', threadId: first.target.threadId, draftId: randomUUID(), text: 'Synthetic takeover continuation' })
  expect(f.service.state().watchedThreads[0]).toMatchObject({ watched: true, paused: true, participation: [{ state: 'participating' }] })
  expect(f.service.startsInFlight()).toBe(0)
  expect(await f.call('start_thread', f.start())).toMatchObject({ status: 'ok' })
  await original(written!)
  await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  expect(f.service.startsInFlight()).toBe(1)
})

it('releases a definitively failed creation reservation and refunds its pre-writer prompt', async () => {
  const f = await fixture()
  expect(await f.call('start_thread', { ...f.start(), workingCopy: { kind: 'new-worktree' } })).toMatchObject({ status: 'refused', code: 'WORKING_COPY_CHANGED' })
  expect(f.service.startsInFlight()).toBe(0)
  expect(f.service.state().requests[0]!.participants[0]!.promptCount).toBe(0)
  expect(f.service.state().receipts[0]!.deliveryState).toBe('failed')
  expect(await f.call('start_thread', f.start())).toMatchObject({ status: 'ok' })
})

it('detects a Sotto user instruction sent while the Watcher service was dormant', async () => {
  const f = await fixture(), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start refused')
  await f.finish(first.target.threadId)
  expect(f.control.watcherRecord().requests[0]!.participants[0]!.lastUserMessageId).toBeDefined()
  const baseline = f.control.watcherRecord().requests[0]!.participants[0]!.lastUserMessageId
  f.service.close()
  expect((await f.control.commandShell({ type: 'manual-send', threadId: first.target.threadId, draftId: randomUUID(), text: 'Synthetic stable-session user instruction' })).error).toBeNull()
  const binding = f.workspace.registry.byThread(first.target.threadId)!
  const native = f.workspace.adapters.codex.state.threads.find(item => item.id === binding.sessionId)!
  native.lastUserMessageId = native.messages.findLast(item => item.role === 'user')!.id
  f.workspace.adapters.codex.emit()
  await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  expect(f.control.watcherSnapshot().threads.find(item => item.id === first.target.threadId)!.lastUserMessageId).not.toBe(baseline)
  const recovered = new WatcherService({ ordinaryBatch: SHORT_BATCH, directory: f.root, host: f.workspace.host, control: f.control, historyEnabled: () => true })
  cleanups.push(async () => { recovered.close() })
  await recovered.recover()
  expect(recovered.state().recoveryNotice).toBeNull()
  // The instruction fences what Watcher had prepared, and the thread stays watched.
  expect(f.control.watcherRecord().watches![0]!.generation).toBeGreaterThan(0)
  expect(recovered.state().watchedThreads[0]).toMatchObject({ watched: true, participation: [{ state: 'participating' }] })
})

it('refuses reads and new instructions during provider replacement before changing identity', async () => {
  const f = await fixture(); await f.finish(f.id)
  await f.control.commandShell({ type: 'connect', provider: 'claude' })
  const model = f.control.watcherSnapshot().models.find(item => item.providerId === 'claude' && item.ready)!
  const entered = deferred(), released = deferred(), original = f.control.commandForWatcherRoom.bind(f.control)
  vi.spyOn(f.control, 'commandForWatcherRoom').mockImplementation(async command => {
    if (command.type === 'create-project' && command.provider === 'claude') { entered.resolve(); await released.promise }
    return original(command)
  })
  const opening = f.service.open({ provider: 'claude', modelId: model.id })
  try {
    await entered.promise
    expect(await f.call('list_threads', {})).toMatchObject({ status: 'refused', code: 'THREAD_BUSY' })
    expect((await f.control.commandShell({ type: 'manual-send', threadId: f.id, draftId: randomUUID(), text: 'Synthetic instruction during replacement' })).error).toContain('provider change')
    expect(f.service.state().current!.target.threadId).toBe(f.id)
  } finally { released.resolve() }
  expect(await opening).toMatchObject({ status: 'ok' })
  expect(f.service.state().current!.target.threadId).not.toBe(f.id)
})

it('fences remove-followup and branch controls as user reconfiguration', async () => {
  const f = await fixture(), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start refused')
  const generation = (threadId: string) => f.control.watcherRecord().watches!.find(watch => watch.target.threadId === threadId)!.generation
  const before = generation(first.target.threadId)
  f.service.userCommand({ type: 'remove-followup', threadId: first.target.threadId, itemId: randomUUID() }, first.target.threadId, false)
  expect(generation(first.target.threadId)).toBeGreaterThan(before)
  expect(f.service.state().watchedThreads[0]).toMatchObject({ watched: true, participation: [{ state: 'participating' }] })
  const other = await f.call('start_thread', f.start())
  if (other.status !== 'ok' || !('target' in other)) throw new Error('start refused')
  const otherBefore = generation(other.target.threadId)
  f.service.userCommand({ type: 'git-switch-branch', threadId: other.target.threadId, ref: 'synthetic-branch' }, other.target.threadId, false)
  expect(generation(other.target.threadId)).toBeGreaterThan(otherBefore)
})

// A machine Stop keeps the user's queue whole for their review, paused by Watcher so Resume queue is there to give it.
const pausedByWatcher = <T extends object>(items: T[]): T[] => items.map(item => ({ ...item, status: 'paused', pausedBy: 'watcher', error: WATCHER_STOP_PAUSE }))

it('keeps preexisting user queues intact when machine Stop interrupts their thread', async () => {
  const f = await fixture()
  await f.control.commandShell({ type: 'create-thread', projectId: f.project.id, title: 'Synthetic user worker', modelId: f.model.id })
  const threadId = f.control.shell().activeThreadId!
  await f.control.commandShell({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'Synthetic user work' })
  await f.control.commandShell({ type: 'queue-followup', threadId, draftId: randomUUID(), text: 'Synthetic preexisting user queue' })
  const queued = f.control.shell().followups!.filter(item => item.threadId === threadId)
  expect(queued).toHaveLength(1)
  expect(await f.call('stop_thread', { requestId: f.requestId, retryKey: randomUUID(), target: { hostId: f.control.hostId()!, threadId } })).toMatchObject({ status: 'ok' })
  await vi.waitFor(() => expect(f.control.shell().followups!.filter(item => item.threadId === threadId)).toEqual(pausedByWatcher(queued)))
  expect(f.workspace.adapters.codex.commands.some(item => item.type === 'send' && item.text === 'Synthetic preexisting user queue')).toBe(false)
})


it('pauses news that joins a queue the Watcher stop paused, so the whole queue says why it waits', async () => {
  const f = await fixture()
  await f.control.commandShell({ type: 'create-thread', projectId: f.project.id, title: 'Synthetic user worker', modelId: f.model.id })
  const threadId = f.control.shell().activeThreadId!
  await f.control.commandShell({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'Synthetic user work' })
  await f.control.commandShell({ type: 'queue-followup', threadId, draftId: randomUUID(), text: 'Synthetic preexisting user queue' })
  expect(await f.call('stop_thread', { requestId: f.requestId, retryKey: randomUUID(), target: { hostId: f.control.hostId()!, threadId } })).toMatchObject({ status: 'ok' })
  await vi.waitFor(() => expect(f.control.shell().followups!.find(item => item.threadId === threadId)?.pausedBy).toBe('watcher'))
  await f.control.deliverWakeUp(threadId, { pullRequest: { url: 'https://github.com/synthetic/project/pull/6', number: 6, title: 'Synthetic pull request' },
    startedBy: 'agent', startedAt: new Date().toISOString(), head: null, ended: null, changes: [{ kind: 'checks-passed', count: 1, required: true }] }, { tool: false })
  await vi.waitFor(() => expect(f.control.shell().followups!.filter(item => item.threadId === threadId).map(item => [item.wakeUp ? 'wake-up' : item.text, item.status, item.pausedBy]))
    .toEqual([['Synthetic preexisting user queue', 'paused', 'watcher'], ['wake-up', 'paused', 'watcher']]))
  expect(f.workspace.adapters.codex.commands.some(item => item.type === 'send' && item.text.includes('pull/6'))).toBe(false)
})

it.each(['persistence', 'queue cleanup'])('keeps saved user prompts waiting when a worker completes during machine Stop %s', async delay => {
  const f = await fixture()
  await f.control.commandShell({ type: 'create-thread', projectId: f.project.id, title: 'Synthetic user worker', modelId: f.model.id })
  const threadId = f.control.shell().activeThreadId!
  await f.control.commandShell({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'Synthetic user work' })
  await f.control.commandShell({ type: 'queue-followup', threadId, draftId: randomUUID(), text: 'Synthetic saved user prompt' })
  const queued = f.control.shell().followups!.filter(item => item.threadId === threadId)
  const entered = deferred<void>(), release = deferred<void>()
  let held = false
  const update = f.control.updateWatcher.bind(f.control), cancel = f.control.cancelWatcherQueue.bind(f.control)
  const saving = vi.spyOn(f.control, 'updateWatcher').mockImplementation(async change => {
    const pending = update(change)
    if (delay === 'persistence' && !held && f.service.preserveUserQueue(threadId)) { held = true; entered.resolve(); await release.promise }
    await pending
  })
  const cancelling = vi.spyOn(f.control, 'cancelWatcherQueue').mockImplementation(async ids => {
    if (delay === 'queue cleanup' && !held && f.service.preserveUserQueue(threadId)) { held = true; entered.resolve(); await release.promise }
    await cancel(ids)
  })
  const stop = f.call('stop_thread', { requestId: f.requestId, retryKey: randomUUID(), target: { hostId: f.control.hostId()!, threadId } })
  try {
    await entered.promise
    expect(f.service.preserveUserQueue(threadId)).toBe(true)
    await f.finish(threadId)
  } finally { release.resolve() }
  const result = await stop
  saving.mockRestore(); cancelling.mockRestore()
  expect(f.workspace.adapters.codex.commands.filter(item => item.type === 'send' && item.text === 'Synthetic saved user prompt')).toHaveLength(0)
  await vi.waitFor(() => expect(f.control.shell().followups!.filter(item => item.threadId === threadId)).toEqual(pausedByWatcher(queued)))
  expect(result).toMatchObject({ status: 'ok' })
  expect((await f.control.commandShell({ type: 'resume-followups', threadId })).error).toBeNull()
  await vi.waitFor(() => expect(f.workspace.adapters.codex.commands.filter(item => item.type === 'send' && item.text === 'Synthetic saved user prompt')).toHaveLength(1))
  expect(f.service.state().watchedThreads.find(item => item.target.threadId === threadId)!.participation[0]!.state).toBe('taken-over')
})

it('automatically sends an ordinary user queue on completion while Watcher has never participated', async () => {
  const f = await fixture()
  await f.control.commandShell({ type: 'create-thread', projectId: f.project.id, title: 'Synthetic ordinary worker', modelId: f.model.id })
  const threadId = f.control.shell().activeThreadId!
  await f.control.commandShell({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'Synthetic ordinary work' })
  await f.control.commandShell({ type: 'queue-followup', threadId, draftId: randomUUID(), text: 'Synthetic ordinary queued prompt' })
  expect(f.service.preserveUserQueue(threadId)).toBe(false)
  await f.finish(threadId)
  await vi.waitFor(() => expect(f.workspace.adapters.codex.commands.filter(item => item.type === 'send' && item.text === 'Synthetic ordinary queued prompt')).toHaveLength(1))
})

it('refuses an explicit user Queue before the first actual Watcher Send', async () => {
  const f = await fixture(); await f.finish(f.id)
  await f.control.updateWatcher(record => { record.requests = [] })
  expect((await f.control.commandShell({ type: 'queue-followup', threadId: f.id, draftId: randomUUID(), text: 'Synthetic unscoped continuation' })).error).toContain('Send an instruction')
  expect(f.service.state().requests).toEqual([])
  expect(f.control.shell().followups).toEqual([])
})


it('leaves user queues untouched when a machine Stop loses its guard before interrupt', async () => {
  const f = await fixture()
  await f.control.commandShell({ type: 'create-thread', projectId: f.project.id, title: 'Synthetic user worker', modelId: f.model.id })
  const threadId = f.control.shell().activeThreadId!
  await f.control.commandShell({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'Synthetic user work' })
  await f.control.commandShell({ type: 'queue-followup', threadId, draftId: randomUUID(), text: 'Synthetic guarded user queue' })
  const queued = f.control.shell().followups!.filter(item => item.threadId === threadId)
  const interrupts = f.workspace.adapters.codex.commands.filter(item => item.type === 'interrupt').length
  let checks = 0
  const stopped = await f.control.commandFromWatcher({ type: 'interrupt', threadId }, { guard: () => { if (++checks >= 3) throw new Error('Synthetic takeover fence') } })
  expect(stopped.error).toBe('Synthetic takeover fence')
  expect(f.control.shell().followups!.filter(item => item.threadId === threadId)).toEqual(queued)
  expect(f.workspace.adapters.codex.commands.filter(item => item.type === 'interrupt')).toHaveLength(interrupts)
})


it('replaces the master provider while a worker it started still works, and keeps its slot until it finishes (#1325)', async () => {
  const f = await fixture(), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start refused')
  await f.finish(f.id)
  await f.control.commandShell({ type: 'connect', provider: 'claude' })
  const model = f.control.watcherSnapshot().models.find(item => item.providerId === 'claude' && item.ready)!
  expect(f.service.startsInFlight()).toBe(1)
  expect(await f.service.open({ provider: 'claude', modelId: model.id })).toMatchObject({ status: 'ok', state: { current: { provider: 'claude' } } })
  expect(f.service.state().current!.target.threadId).not.toBe(f.id)
  expect(f.service.state().history.at(-1)!.target.threadId).toBe(f.id)
  // The worker belongs to the record, not the conversation: its slot is held until it finishes, then freed.
  expect(f.service.startsInFlight()).toBe(1)
  await f.finish(first.target.threadId)
  expect(f.service.startsInFlight()).toBe(0)
})

it('changes Watcher’s model with its send queued for a working thread, while a provider change waits for that send (#1325)', async () => {
  const f = await fixture()
  f.workspace.adapters.codex.state.models.push({ ...f.workspace.adapters.codex.state.models[0]!, id: 'fake:other', name: 'Other model' })
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  const other = f.control.shell().host.models.find(item => item.providerId === 'codex' && item.id !== f.model.id)!
  const first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start refused')
  const queued = await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target, delivery: 'queue', text: 'Synthetic queued brief' })
  expect(queued).toMatchObject({ status: 'ok', receipt: { deliveryState: 'queued' } })
  // Watcher's own turn holds the change, and the refusal says so.
  expect(await f.service.open({ provider: 'codex', modelId: other.id })).toMatchObject({ status: 'refused', code: 'THREAD_BUSY',
    message: 'Watcher is working. Wait for this turn to finish, or stop it, then change its model or effort. Nothing was changed.' })
  await f.finish(f.id)
  // The fake provider takes the new model as a real one does, so main sees it confirmed.
  const execute = f.workspace.adapters.codex.execute.bind(f.workspace.adapters.codex)
  vi.spyOn(f.workspace.adapters.codex, 'execute').mockImplementation(async command => {
    const thread = f.workspace.adapters.codex.state.threads.find(item => 'threadId' in command && item.id === command.threadId)
    if (thread && command.type === 'configure-thread') Object.assign(thread, command.modelId ? { modelId: command.modelId } : {}, command.reasoningEffort ? { reasoningEffort: command.reasoningEffort } : {})
    return execute(command)
  })
  // Resting, Watcher takes the new model while its send waits queued and the thread it started still works.
  expect(await f.service.open({ provider: 'codex', modelId: other.id, reasoningEffort: 'low' })).toMatchObject({ status: 'ok', state: { current: { target: { threadId: f.id } } } })
  expect(f.control.watcherSnapshot().threads.find(thread => thread.id === f.id)!.modelId).toBe(other.id)
  expect(f.control.watcherRecord().operations.find(item => item.id === (queued as { receipt: { operationId: string } }).receipt.operationId)!.deliveryState).toBe('queued')
  // A new Watcher could not send that queued brief, so a provider change waits for it and says what to do.
  await f.control.commandShell({ type: 'connect', provider: 'claude' })
  const claude = f.control.watcherSnapshot().models.find(item => item.providerId === 'claude' && item.ready)!
  expect(await f.service.open({ provider: 'claude', modelId: claude.id })).toMatchObject({ status: 'refused', code: 'THREAD_BUSY',
    message: 'Watcher has a message queued for a thread that is still working, which a new Watcher could not send. Wait until it has gone, or stop it with Stop all, then change its provider. Nothing was changed.' })
  expect(f.service.state()).toMatchObject({ current: { target: { threadId: f.id } }, history: [] })
})

it('changes Watcher’s model or effort while a send to another thread has been unconfirmed for days, set aside and through a restart, as Settings asks (#1325)', async () => {
  const f = await fixture(), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start refused')
  await f.finish(first.target.threadId)
  f.workspace.adapters.codex.state.models.push({ ...f.workspace.adapters.codex.state.models[0]!, id: 'fake:other', name: 'Other model' })
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  const other = f.control.shell().host.models.find(item => item.providerId === 'codex' && item.id !== f.model.id)!
  // The provider never says whether the brief arrived, and takes a model change as a real one does.
  const execute = f.workspace.adapters.codex.execute.bind(f.workspace.adapters.codex)
  vi.spyOn(f.workspace.adapters.codex, 'execute').mockImplementation(async command => {
    if (command.type === 'send' && command.text === 'Synthetic lost brief') return { accepted: false, uncertain: true }
    const thread = f.workspace.adapters.codex.state.threads.find(item => 'threadId' in command && item.id === command.threadId)
    if (thread && command.type === 'configure-thread') Object.assign(thread, command.modelId ? { modelId: command.modelId } : {}, command.reasoningEffort ? { reasoningEffort: command.reasoningEffort } : {})
    return execute(command)
  })
  const sent = await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target, delivery: 'now', text: 'Synthetic lost brief' })
  expect(sent).toMatchObject({ receipt: { deliveryState: 'uncertain' } })
  const operationId = (sent as { receipt: { operationId: string } }).receipt.operationId
  await f.control.updateWatcher(record => { Object.assign(record.operations.find(item => item.id === operationId)!, { createdAt: '2026-10-20T19:32:52.723Z', updatedAt: '2026-10-20T19:33:12.949Z' }) })
  await f.finish(f.id)
  // Watcher rests. A send to another thread that nothing can settle never holds its own model or effort.
  expect(await f.service.open({ provider: 'codex', modelId: other.id, reasoningEffort: 'low' })).toMatchObject({ status: 'ok', state: { current: { target: { threadId: f.id } } } })
  expect(f.control.watcherSnapshot().threads.find(thread => thread.id === f.id)!.modelId).toBe(other.id)
  expect(f.control.watcherRecord().operations.find(item => item.id === operationId)!.deliveryState).toBe('uncertain')
  // Set aside in its own thread, as the owner's were, then Sotto restarts: loading reads the delivery as unconfirmed again
  // and marks the send so once more, and the change still goes through.
  const draftId = f.control.watcherRecord().operations.find(item => item.id === operationId)!.draftId!
  expect((await f.control.commandShell({ type: 'set-aside-send', threadId: first.target.threadId, draftId })).error).toBeNull()
  f.service.close(); await f.tools.close(); f.control.dispose(); await f.control.closed()
  const control = f.create(), service = new WatcherService({ directory: f.root, host: f.workspace.host, control, historyEnabled: () => true })
  const tools = new WatcherToolServer(service); f.workspace.host.useWatcherTools(tools)
  cleanups.push(async () => { service.close(); await tools.close(); control.dispose(); await control.closed() })
  await control.start(); await control.commandShell({ type: 'connect', provider: 'codex' }); await service.recover()
  expect(control.watcherSendRecords().deliveries.find(item => item.draftId === draftId)).toMatchObject({ status: 'uncertain', setAside: true })
  expect(control.watcherRecord().operations.find(item => item.id === operationId)!.deliveryState).toBe('uncertain')
  expect(await service.open({ provider: 'codex', modelId: f.model.id, reasoningEffort: 'low' })).toMatchObject({ status: 'ok', state: { current: { target: { threadId: f.id } } } })
  expect(control.watcherSnapshot().threads.find(thread => thread.id === f.id)!.modelId).toBe(f.model.id)
})

it('lets a Watcher send whose prompt the user set aside hold nothing open, while it stays unconfirmed (#1325)', async () => {
  const f = await fixture(), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start refused')
  await f.finish(first.target.threadId)
  const native = f.workspace.adapters.codex.execute.bind(f.workspace.adapters.codex)
  vi.spyOn(f.workspace.adapters.codex, 'execute').mockImplementation(async command =>
    command.type === 'send' && command.text === 'Synthetic unconfirmed brief' ? { accepted: false, uncertain: true } : native(command))
  const sent = await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target, delivery: 'now', text: 'Synthetic unconfirmed brief' })
  expect(sent).toMatchObject({ receipt: { deliveryState: 'uncertain' } })
  const operation = f.control.watcherRecord().operations.find(item => item.id === (sent as { receipt: { operationId: string } }).receipt.operationId)!
  const settle = () => f.call('settle_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target })
  expect(await settle()).toMatchObject({ status: 'refused', code: 'DELIVERY_UNCERTAIN' })
  // Continue with a new message, in the worker's own thread: Sotto will never send that prompt again.
  expect((await f.control.commandShell({ type: 'set-aside-send', threadId: first.target.threadId, draftId: operation.draftId! })).error).toBeNull()
  // The user's fresh message there is confirmed, which lets automatic work go on (#1156).
  expect((await f.control.commandShell({ type: 'manual-send', threadId: first.target.threadId, draftId: randomUUID(), text: 'Synthetic fresh user message' })).error).toBeNull()
  await f.finish(first.target.threadId)
  expect(await settle()).not.toMatchObject({ code: 'DELIVERY_UNCERTAIN' })
  // Nothing proves it arrived, so its receipt still says so.
  expect(f.control.watcherRecord().operations.find(item => item.id === operation.id)!.deliveryState).toBe('uncertain')
})


it('refunds a coordinator preparation refusal returned as a failed result', async () => {
  const f = await fixture(), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start refused')
  await f.finish(first.target.threadId)
  const native = f.workspace.adapters.codex.execute.bind(f.workspace.adapters.codex)
  vi.spyOn(f.workspace.adapters.codex, 'execute').mockImplementation(async command => { if (command.type === 'send' && command.text === 'Synthetic preparation refused') throw new Error('Synthetic preparation failure'); return native(command) })
  expect(await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target, delivery: 'now', text: 'Synthetic preparation refused' }))
    .toMatchObject({ status: 'refused', code: 'PROVIDER_UNAVAILABLE', receipt: { deliveryState: 'failed' } })
  expect(f.service.state().requests[0]!.participants[0]!.promptCount).toBe(1)
})

it('keeps an unacknowledged native Stop uncertain in its original receipt', async () => {
  const f = await fixture(), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start refused')
  const native = f.workspace.adapters.codex.execute.bind(f.workspace.adapters.codex)
  vi.spyOn(f.workspace.adapters.codex, 'execute').mockImplementation(async command => command.type === 'interrupt' ? { accepted: false, uncertain: true } : native(command))
  expect(await f.call('stop_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target }))
    .toMatchObject({ status: 'ok', receipt: { deliveryState: 'uncertain' }, stopRequested: true })
  expect(f.service.startsInFlight()).toBe(1)
  await f.finish(first.target.threadId)
  await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  expect(f.service.state().receipts.at(-1)!.deliveryState).toBe('accepted')
  expect(f.service.startsInFlight()).toBe(0)
})

/** Sotto's wake-ups for Watcher are shown nowhere, so these read the coordinator's own queue and the news its send carries. */
const queued = (f: Awaited<ReturnType<typeof fixture>>) => storedFollowups(f.control)
const waitingNews = (f: Awaited<ReturnType<typeof fixture>>): string | undefined => {
  const item = queued(f).find(candidate => candidate.threadId === f.id && candidate.wakeUp)
  return item && (watcherWakeUpNote(item.news ?? []) ?? '')
}

it.each(['finish', 'question', 'failure'] as const)('wakes the master from fake-provider %s through the existing queue without answering', async kind => {
  const f = await fixture(false), started = await f.call('start_thread', f.start())
  if (started.status !== 'ok' || !('target' in started)) throw new Error('start refused')
  const binding = f.workspace.registry.byThread(started.target.threadId)!
  const native = f.workspace.adapters.codex.state.threads.find(thread => thread.id === binding.sessionId)!
  // Keep the master busy while news folds, then release its real follow-up pump.
  if (kind === 'question') native.requests = [{ id: 'private-card', kind: 'question', text: 'private_worker_question_82ac', options: [] }]
  else { native.status = kind === 'failure' ? 'error' : 'idle'; native.lastTurn = { id: 'wake-proof-turn', status: kind === 'failure' ? 'failed' : 'completed' }; if (kind === 'failure') native.activities = [{ id: 'native-error', turnId: 'wake-proof-turn', sequence: 0, kind: 'turn', status: 'failed', title: 'private_worker_error_73ff' }] }
  f.workspace.adapters.codex.emit()
  await vi.waitFor(() => expect(waitingNews(f)).toBeDefined(), { timeout: 15_000 })
  const expected = kind === 'finish' ? 'foreground turn finished' : kind === 'failure' ? 'turn failed' : 'waits on the user to answer'
  expect(waitingNews(f)).toContain(expected)
  expect(waitingNews(f)).not.toMatch(/private_worker_(question|error)/)
  // Waiting, it is in no queue panel or transcript.
  expect(f.control.shell().followups?.filter(item => item.threadId === f.id)).toEqual([])
  if (kind === 'failure') expect(f.service.state().watchedThreads.find(thread => thread.target.threadId === started.target.threadId)!.evidence)
    .toEqual(expect.arrayContaining([expect.objectContaining({ source: 'native-turn', fact: 'turn-failed', failureCategory: 'provider-turn-failed' })]))
  await f.finish(f.id)
  // The provider hears Sotto's short message with the news beside it, never in it.
  const master = () => f.workspace.adapters.codex.commands.filter(command => command.type === 'send' && command.threadId === f.workspace.registry.byThread(f.id)!.sessionId)
  await vi.waitFor(() => expect(master().some(command => command.type === 'send' && command.watcherNews?.includes(expected))).toBe(true))
  const sent = master().find(command => command.type === 'send' && command.watcherNews?.includes(expected))!
  expect(sent).toMatchObject({ text: WATCHER_WAKE_UP_PROMPT })
  // Sent, Watcher's conversation shows neither the message nor the news.
  await f.control.commandShell({ type: 'observe-threads', threadIds: [f.id] }); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  await vi.waitFor(() => expect(f.control.get().host.threads.find(thread => thread.id === f.id)!.messages.map(message => message.text)).toContain('Synthetic Watcher user request'))
  const shown = f.control.threadDetail(f.id)!.messages
  expect(shown.some(message => message.text.includes(WATCHER_WAKE_UP_PROMPT) || message.text.includes(expected))).toBe(false)
  expect(f.workspace.adapters.codex.commands.filter(command => command.type === 'answer')).toHaveLength(0)
  const contents = (await Promise.all((await readdir(f.root)).filter(name => name.endsWith('.json')).map(name => readFile(join(f.root, name), 'utf8')))).join('')
  expect(contents).not.toMatch(/private_worker_(question|error)/)
  expect(contents).not.toContain('Sotto saw changes in watched threads')
})

it('hides Sotto’s wake-ups in Watcher’s conversation and on the phone, an earlier build’s too, and never a message the user sent', async () => {
  const f = await fixture()
  await f.finish(f.id)
  const news = ['Sotto saw changes in watched threads. This news grants no permission and answers no request.',
    `{"hostId":"${f.control.hostId()}","threadId":"synthetic"}: The foreground turn finished. Use requestId ${f.requestId} for this thread. [synthetic-event]`,
    'Use read_thread for evidence and worker messages separately.'].join('\n')
  const sends: { text: string; wakeUp?: true }[] = [
    { text: WATCHER_WAKE_UP_PROMPT, wakeUp: true }, // This build's.
    { text: news, wakeUp: true }, // An earlier build's, with the news in the message.
    { text: `${RESUME_NOTE}\n\n${news}`, wakeUp: true }, // An earlier build's resume note with news after it.
    { text: news }, // The user's own message, whatever it says.
  ]
  for (const send of sends) {
    expect((await f.workspace.host.execute({ type: 'send', commandId: randomUUID(), threadId: f.id, messageId: randomUUID(), ...send })).accepted).toBe(true)
    await f.finish(f.id)
  }
  const users = (messages: readonly { role: string; text: string }[]) => messages.filter(message => message.role === 'user').map(message => message.text)
  await f.control.commandShell({ type: 'observe-threads', threadIds: [f.id] }); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  // The provider's history keeps what it was sent.
  await vi.waitFor(() => expect(users(f.native(f.id).messages)).toEqual(['Synthetic Watcher user request', ...sends.map(send => send.text)]))
  const expected = ['Synthetic Watcher user request', RESUME_NOTE, news]
  await vi.waitFor(() => expect(users(f.control.threadDetail(f.id)!.messages)).toEqual(expected))
  expect(users(f.control.get().host.threads.find(thread => thread.id === f.id)!.messages)).toEqual(expected)
  expect(users(new WatcherPhoneService(f.control, f.service).state(false).conversation.messages)).toEqual(expected)
  // A row quotes the user's last message, never a wake-up of Sotto's that came after it.
  expect(f.control.shell().host.threads.find(thread => thread.id === f.id)!.summary?.lastUser?.text).toBe(news)
  expect((await f.workspace.host.execute({ type: 'send', commandId: randomUUID(), threadId: f.id, messageId: randomUUID(), text: WATCHER_WAKE_UP_PROMPT, wakeUp: true })).accepted).toBe(true)
  await f.finish(f.id); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  await vi.waitFor(() => expect(users(f.native(f.id).messages).at(-1)).toBe(WATCHER_WAKE_UP_PROMPT))
  await vi.waitFor(() => expect(f.control.get().host.threads.find(thread => thread.id === f.id)!.wakeUpMessageIds?.length).toBe(4))
  for (const thread of [f.control.shell(), f.control.get()].map(state => state.host.threads.find(item => item.id === f.id)!)) {
    expect(thread.summary?.lastUser?.text ?? '').not.toContain(WATCHER_WAKE_UP_PROMPT)
  }
  // An unchanged history is presented as the same array on every publish, so nothing downstream copies or rebuilds it.
  const presented = (thread: AgentThread) => (f.control as unknown as { presentedMessages(item: AgentThread): readonly unknown[] }).presentedMessages(thread)
  const watcher = f.control.watcherSnapshot().threads.find(thread => thread.id === f.id)!
  const first = presented(watcher)
  expect(first).not.toBe(watcher.messages)
  expect(presented(watcher)).toBe(first)
})

/** Watcher's wake-up queued behind its own running turn, holding a worker's question. */
async function heldQuestion(f: Awaited<ReturnType<typeof fixture>>) {
  const started = await f.call('start_thread', f.start())
  if (started.status !== 'ok' || !('target' in started)) throw new Error('start refused')
  const worker = f.native(started.target.threadId)
  worker.requests = [{ id: 'held-card', kind: 'question', text: 'Synthetic question', options: [] }]
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  await vi.waitFor(() => expect(waitingNews(f)).toContain('waits on the user to answer'), { timeout: 15_000 })
  const master = f.workspace.registry.byThread(f.id)!.sessionId
  const sends = (words?: string) => f.workspace.adapters.codex.commands.filter(command => command.type === 'send' && command.threadId === master
    && command.watcherNews !== undefined && (words === undefined || command.watcherNews.includes(words)))
  return { started, worker, master, sends, hidden: () => queued(f).filter(item => item.threadId === f.id && item.wakeUp) }
}
/** The provider refuses Watcher's wake-ups, every one or the first `times`. */
function refuseWakeUps(f: Awaited<ReturnType<typeof fixture>>, master: string, times = Infinity) {
  const execute = f.workspace.adapters.codex.execute.bind(f.workspace.adapters.codex), refused = { count: 0 }
  vi.spyOn(f.workspace.adapters.codex, 'execute').mockImplementation(async command => {
    if (command.type === 'send' && command.threadId === master && command.watcherNews && refused.count < times) { refused.count++; throw new Error('Synthetic native pre-write failure') }
    return execute(command)
  })
  return refused
}

it('lets a Stop of Watcher hold its wake-up no one is shown without pausing it, and sends the news once Watcher next comes to rest', async () => {
  const f = await fixture(), { sends, hidden } = await heldQuestion(f)
  // The user stops Watcher. The wake-up is never paused, since no one is shown it to resume: it leaves unsent, its news kept.
  expect((await f.control.commandShell({ type: 'interrupt', threadId: f.id })).error).toBeNull()
  await vi.waitFor(() => expect(hidden()).toEqual([]), { timeout: 15_000 })
  expect(f.control.shell().followups?.filter(item => item.threadId === f.id)).toEqual([])
  await new Promise(resolve => setTimeout(resolve, 3_000))
  expect(sends()).toHaveLength(0)
  // The user asks Watcher something; when that turn ends, Watcher rests, and the news goes.
  expect((await f.control.commandShell({ type: 'manual-send', threadId: f.id, draftId: randomUUID(), text: 'Synthetic second request' })).error).toBeNull()
  await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  await f.finish(f.id)
  await vi.waitFor(() => expect(sends('waits on the user to answer')).toHaveLength(1), { timeout: 15_000 })
}, 40_000)

it('records the request its news says waits on the user with the wake-up, and places its card in the room, without Watcher answering it', async () => {
  const f = await fixture(), { started, sends } = await heldQuestion(f)
  const execute = f.workspace.host.execute.bind(f.workspace.host), recorded: unknown[] = []
  vi.spyOn(f.workspace.host, 'execute').mockImplementation(async command => {
    if (command.type === 'send' && command.threadId === f.id && command.wakeUp) recorded.push(command.watcherAsks)
    return execute(command)
  })
  await f.control.commandShell({ type: 'observe-threads', threadIds: [f.id] })
  await f.finish(f.id)
  await vi.waitFor(() => expect(sends('waits on the user to answer')).toHaveLength(1), { timeout: 15_000 })
  const ask = { target: started.target, requestCardId: 'held-card', kind: 'question' }
  expect(recorded).toEqual([[ask]])
  // The provider hears the news beside its message, never the asks, and the room places the card from the host's record.
  expect(sends().every(command => !('watcherAsks' in command))).toBe(true)
  // While the turn the wake-up began still runs with no reply, the card waits for it; once the turn ends it is placed.
  expect(f.service.state().asks).toEqual([])
  await f.finish(f.id)
  await vi.waitFor(() => expect(f.service.state().asks).toEqual([expect.objectContaining(ask)]), { timeout: 15_000 })
  // Nothing answered the worker's request: only the user's own answer from its card does that.
  expect(f.workspace.adapters.codex.commands.filter(command => command.type === 'answer')).toEqual([])
}, 40_000)

/** The wake-up IDs the coordinator's saved state remembers as told, read from disk as a restart would read them. */
async function savedTold(root: string): Promise<string[]> {
  const saved = JSON.parse(await readFile(join(root, 'agents.json'), 'utf8')) as { watcher?: { wakeEventIds?: string[] } }
  return saved.watcher?.wakeEventIds ?? []
}

it('saves a refused wake-up’s news as untold before the wake-up leaves the queue, so a crash between loses nothing (review P1)', async () => {
  const f = await fixture(), { master, hidden } = await heldQuestion(f)
  const events = hidden()[0]!.news!.flatMap(news => 'events' in news ? news.events.map(event => event.id) : [])
  await vi.waitFor(async () => expect(await savedTold(f.root)).toEqual(expect.arrayContaining(events)))
  // Were Sotto to stop at the moment the wake-up leaves, what would the next start read?
  const store = followupStoreOf(f.control), remove = store.removeWakeUp.bind(store), atRemoval: string[][] = []
  vi.spyOn(store, 'removeWakeUp').mockImplementation(async (...ids) => { atRemoval.push(await savedTold(f.root)); return remove(...ids) })
  const refused = refuseWakeUps(f, master, 1)
  await f.finish(f.id)
  await vi.waitFor(() => expect(refused.count).toBe(1), { timeout: 15_000 })
  await vi.waitFor(() => expect(hidden()).toEqual([]))
  expect(atRemoval).toHaveLength(1)
  for (const id of events) expect(atRemoval[0]).not.toContain(id)
}, 40_000)

it('settles a hidden wake-up once when two settles overlap, so a crash while the first saves its news as untold loses nothing (review P1)', async () => {
  const f = await fixture(), { hidden } = await heldQuestion(f)
  const item = hidden()[0]!, events = item.news!.flatMap(news => 'events' in news ? news.events.map(event => event.id) : [])
  await vi.waitFor(async () => expect(await savedTold(f.root)).toEqual(expect.arrayContaining(events)))
  // The save of agents.json that forgets the wake-up's news is held open, as a slow disk holds it.
  const inner = (f.control as unknown as { store: { write: (...args: unknown[]) => Promise<void> } }).store, write = inner.write.bind(inner)
  const entered = deferred<void>(), release = deferred<void>()
  vi.spyOn(inner, 'write').mockImplementation(async (...args) => { entered.resolve(); await release.promise; return write(...args) })
  const settle = (f.control as unknown as { settleWatcherWakeUp: (item: unknown, outcome: string) => Promise<void> }).settleWatcherWakeUp.bind(f.control)
  try {
    // The pump withdraws the wake-up, and advisory pruning settles it again while the first save is on its way.
    const first = settle(item, 'withdrawn')
    await entered.promise
    const second = settle(item, 'withdrawn')
    await Promise.race([second, new Promise(resolve => setTimeout(resolve, 1_000))])
    // Sotto stops here. The next start reads both files: the wake-up is still queued, so its news is dropped and observed afresh.
    const saved = JSON.parse(await readFile(join(f.root, 'followups.json'), 'utf8')) as { items: { id: string }[] }
    expect(saved.items.map(entry => entry.id)).toContain(item.id)
    expect(await savedTold(f.root)).toEqual(expect.arrayContaining(events))
    release.resolve(); await Promise.all([first, second])
  } finally { release.resolve() }
  expect(hidden()).toEqual([])
  for (const id of events) expect(await savedTold(f.root)).not.toContain(id)
}, 40_000)

it('saves the news of a hidden wake-up as untold again on the next settle when the first save failed, so a crash after loses nothing (review P1)', async () => {
  const f = await fixture(), { hidden } = await heldQuestion(f)
  const item = hidden()[0]!, events = item.news!.flatMap(news => 'events' in news ? news.events.map(event => event.id) : [])
  await vi.waitFor(async () => expect(await savedTold(f.root)).toEqual(expect.arrayContaining(events)))
  // The save of agents.json that forgets the wake-up's news fails once; memory has forgotten it, the disk has not.
  const inner = (f.control as unknown as { store: { write: (...args: unknown[]) => Promise<void> } }).store, write = inner.write.bind(inner)
  let failNext = true
  vi.spyOn(inner, 'write').mockImplementation(async (...args) => { if (failNext) { failNext = false; throw new Error('Synthetic disk failure') } return write(...args) })
  const settle = (f.control as unknown as { settleWatcherWakeUp: (item: unknown, outcome: string) => Promise<void> }).settleWatcherWakeUp.bind(f.control)
  await expect(settle(item, 'withdrawn')).rejects.toThrow('Synthetic disk failure')
  expect(hidden().map(entry => entry.id)).toEqual([item.id])
  // A later settle takes it out. Sotto then stops: the next start reads its news as untold, or the wake-up still queued.
  await settle(item, 'withdrawn')
  const saved = JSON.parse(await readFile(join(f.root, 'followups.json'), 'utf8')) as { items: { id: string }[] }
  expect(saved.items.map(entry => entry.id)).not.toContain(item.id)
  for (const id of events) expect(await savedTold(f.root)).not.toContain(id)
}, 40_000)

it('asks a provider that refused a wake-up no one is shown again only with news that needs Watcher, and sends both then', async () => {
  const f = await fixture(), { worker, master, sends, hidden } = await heldQuestion(f)
  const refused = refuseWakeUps(f, master, 1)
  await f.finish(f.id)
  await vi.waitFor(() => expect(refused.count).toBe(1), { timeout: 15_000 })
  await vi.waitFor(() => expect(hidden()).toEqual([]))
  // Nothing new: the provider is not asked again, and nothing is written for it.
  await new Promise(resolve => setTimeout(resolve, 4_000))
  expect(refused.count).toBe(1); expect(hidden()).toEqual([])
  // The worker's turn fails, its question still open: news that needs Watcher, and the question goes with it.
  worker.status = 'error'; worker.lastTurn = { id: 'stranded-turn', status: 'failed' }
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  await vi.waitFor(() => expect(sends().some(command => command.type === 'send' && command.watcherNews!.includes('turn failed')
    && command.watcherNews!.includes('waits on the user to answer'))).toBe(true), { timeout: 15_000 })
  expect(refused.count).toBe(1)
}, 40_000)

it('never changes a wake-up no one is shown while it is sent: news that comes then is the next one, and a refusing provider is asked a bounded number of times', async () => {
  const f = await fixture(), { worker, master, hidden } = await heldQuestion(f)
  const refused = refuseWakeUps(f, master)
  const entered = deferred<void>(), release = deferred<void>()
  f.workspace.host.setCheckpointHooks({ isBlocked: async () => false, beforeTurn: async id => { if (id === f.id) { entered.resolve(); await release.promise } } })
  try {
    const finishing = f.finish(f.id)
    await entered.promise
    const sending = hidden()
    expect(sending).toMatchObject([{ status: 'dispatching' }])
    // News that needs Watcher arrives while the wake-up is being sent: it waits for the next one and changes nothing.
    worker.status = 'error'; worker.lastTurn = { id: 'later-turn', status: 'failed' }
    f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
    await f.service.wakes.drained(); await new Promise(resolve => setTimeout(resolve, 3_000))
    expect(hidden()).toEqual(sending)
    release.resolve(); await finishing
  } finally { release.resolve() }
  // Refused: the news that came is news the send did not carry, so the next goes with it. Refused again, nothing new: it waits.
  await vi.waitFor(() => expect(refused.count).toBe(2), { timeout: 15_000 })
  const asked = f.workspace.adapters.codex.execute as unknown as { mock: { calls: [{ type: string; watcherNews?: string }][] } }
  expect(asked.mock.calls.map(([command]) => command).filter(command => command.watcherNews).at(-1)!.watcherNews).toContain('turn failed')
  await new Promise(resolve => setTimeout(resolve, 7_000))
  expect(refused.count).toBe(2)
  expect(hidden()).toEqual([])
}, 60_000)

it('never makes a wake-up no one is shown of a thread’s own facts, and sends them with news that needs Watcher', async () => {
  const f = await fixture(), started = await f.call('start_thread', f.start())
  if (started.status !== 'ok' || !('target' in started)) throw new Error('start refused')
  await f.finish(f.id)
  const master = f.workspace.registry.byThread(f.id)!.sessionId
  const sends = () => f.workspace.adapters.codex.commands.filter(command => command.type === 'send' && command.threadId === master && command.watcherNews)
  // The worker's working copy moves again and again while its turn runs: no wake-up is made, and nothing is saved for it.
  for (let n = 1; n <= 3; n++) {
    f.service.checkpointObserved({ threadId: started.target.threadId, checkpointId: randomUUID(), observedAt: new Date().toISOString(), availability: 'available', changedFiles: n })
    await f.service.wakes.drained(); await new Promise(resolve => setTimeout(resolve, 1_500))
  }
  expect(queued(f).filter(item => item.threadId === f.id)).toEqual([])
  expect(sends()).toHaveLength(0)
  f.native(started.target.threadId).requests = [{ id: 'card', kind: 'question', text: 'Synthetic question', options: [] }]
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  await vi.waitFor(() => expect(sends()).toHaveLength(1), { timeout: 15_000 })
}, 40_000)

it('publishes nothing for a wake-up no one is shown', async () => {
  const f = await fixture(), { hidden } = await heldQuestion(f)
  const news = hidden()[0]!.news!.find(item => 'events' in item)!
  if (!('events' in news)) throw new Error('Expected Watcher news')
  await followupStoreOf(f.control).removeWakeUp(hidden()[0]!.id)
  let published = 0
  const off = f.control.subscribe(() => { published++ })
  try {
    // Watcher's news is saved as its hidden wake-up, and nothing any window or phone shows changed.
    await f.control.deliverWakeUp(f.id, news, { tool: false })
    expect(hidden()).toHaveLength(1)
    expect(published).toBe(0)
    // A second is refused while it is there.
    await expect(f.control.deliverWakeUp(f.id, news, { tool: false })).rejects.toThrow('Watcher already has news on its way.')
    // A follow-up of the user's own is shown, and is published.
    await f.control.commandShell({ type: 'queue-followup', threadId: f.id, draftId: randomUUID(), text: 'Synthetic user follow-up' })
    expect(published).toBeGreaterThan(0)
  } finally { off() }
})

it('lets a hidden wake-up whose send is unknown go, and tells its news afresh rather than losing it', async () => {
  const f = await fixture(), started = await f.call('start_thread', f.start())
  if (started.status !== 'ok' || !('target' in started)) throw new Error('start refused')
  f.native(started.target.threadId).requests = [{ id: 'held-card', kind: 'question', text: 'Synthetic question', options: [] }]
  f.workspace.adapters.codex.emit()
  await vi.waitFor(() => expect(waitingNews(f)).toContain('waits on the user to answer'), { timeout: 15_000 })
  // Its send began and Sotto cannot say whether it landed: no outbox entry and no echo are left to reconcile it.
  const store = followupStoreOf(f.control), unknown = queued(f).find(item => item.threadId === f.id && item.wakeUp)!
  await store.claim(unknown.id); await store.settle(unknown.id, 'uncertain', 'Synthetic unknown send')
  await f.finish(f.id)
  // It is never sent twice; the question it named, still open, is told in a wake-up of its own.
  await vi.waitFor(() => expect(queued(f).some(item => item.id === unknown.id)).toBe(false), { timeout: 15_000 })
  const master = f.workspace.registry.byThread(f.id)!.sessionId
  await vi.waitFor(() => expect(f.workspace.adapters.codex.commands.some(command => command.type === 'send' && command.threadId === master
    && command.watcherNews?.includes('waits on the user to answer'))).toBe(true), { timeout: 15_000 })
}, 40_000)

/**
 * Resolves when the provider hears Watcher's wake-up. The fake provider acknowledges a send when the turn it starts
 * ends, so until the test ends that turn, the wake-up is heard and not yet acknowledged.
 */
function heardWakeUp(f: Awaited<ReturnType<typeof fixture>>, master: string): Promise<void> {
  const execute = f.workspace.adapters.codex.execute.bind(f.workspace.adapters.codex), heard = deferred<void>()
  vi.spyOn(f.workspace.adapters.codex, 'execute').mockImplementation(async command => {
    if (command.type === 'send' && command.threadId === master && command.watcherNews) heard.resolve()
    return execute(command)
  })
  return heard.promise
}
it('never sends a thread’s own facts alone after a pull request’s wake-up they changed under was acknowledged (finding 1)', async () => {
  const f = await fixture(), started = await f.call('start_thread', f.start())
  if (started.status !== 'ok' || !('target' in started)) throw new Error('start refused')
  f.service.pullRequestObserved(pullRequestNews(f, started.target.threadId).read)
  await vi.waitFor(() => expect(waitingNews(f)).toContain('Sotto observed changed evidence'), { timeout: 15_000 })
  const master = f.workspace.registry.byThread(f.id)!.sessionId
  const told = () => f.workspace.adapters.codex.commands.filter(command => command.type === 'send' && command.threadId === master && command.watcherNews)
  const moves = async (count: number) => {
    for (let n = 0; n < count; n++) {
      f.service.checkpointObserved({ threadId: started.target.threadId, checkpointId: randomUUID(), observedAt: new Date().toISOString(), availability: 'available', changedFiles: n + 2 })
      await f.service.wakes.drained(); await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
  await f.control.commandShell({ type: 'observe-threads', threadIds: [f.id] })
  const heard = heardWakeUp(f, master)
  await f.finish(f.id); await heard
  expect(told()).toHaveLength(1)
  // The worker's working copy moves after the provider heard the wake-up and before it is acknowledged, as Watcher's turn ends.
  await moves(2)
  await f.finish(f.id)
  // It keeps moving while the worker works. None of it wakes Watcher by itself.
  await moves(4)
  await new Promise(resolve => setTimeout(resolve, 5_000))
  expect(told()).toHaveLength(1)
}, 40_000)

it('loses no news that came while a wake-up was sent when saving its acknowledgement fails (finding 3)', async () => {
  const f = await fixture(), started = await f.call('start_thread', f.start())
  if (started.status !== 'ok' || !('target' in started)) throw new Error('start refused')
  const worker = f.native(started.target.threadId)
  worker.status = 'idle'; worker.lastTurn = { id: 'first-turn', status: 'completed' }
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  await vi.waitFor(() => expect(waitingNews(f)).toContain('foreground turn finished'), { timeout: 15_000 })
  const master = f.workspace.registry.byThread(f.id)!.sessionId
  const inner = (followupStoreOf(f.control) as unknown as { store: { write: (value: unknown) => Promise<void> } }).store
  const write = inner.write.bind(inner)
  let failNext = false
  vi.spyOn(inner, 'write').mockImplementation(async value => { if (failNext) { failNext = false; throw new Error('Synthetic disk failure') } return write(value) })
  // Sotto reads Watcher's conversation, so its send names the message it follows as the provider has it.
  await f.control.commandShell({ type: 'observe-threads', threadIds: [f.id] })
  const entered = deferred<void>(), release = deferred<void>()
  f.workspace.host.setCheckpointHooks({ isBlocked: async () => false, beforeTurn: async id => { if (id === f.id) { entered.resolve(); await release.promise } } })
  try {
    const finishing = f.finish(f.id)
    await entered.promise
    // GitHub reads the worker's pull request while the wake-up is being sent, and the save that records the send then fails once.
    f.service.pullRequestObserved(pullRequestNews(f, started.target.threadId).read)
    await f.service.wakes.drained(); await new Promise(resolve => setTimeout(resolve, 3_000))
    failNext = true
    release.resolve(); await finishing
  } finally { release.resolve() }
  // Watcher's turn on that wake-up ends; the pull request's news, which it did not carry, goes next.
  await vi.waitFor(() => expect(storedFollowups(f.control).some(item => item.threadId === f.id && item.wakeUp && item.status === 'dispatching')).toBe(false))
  await f.finish(f.id)
  await vi.waitFor(() => expect(f.workspace.adapters.codex.commands.some(command => command.type === 'send' && command.threadId === master
    && command.watcherNews?.includes('Sotto observed changed evidence'))).toBe(true), { timeout: 20_000 })
}, 40_000)

it('withdraws answered worker news while retaining the user queue before a busy master wake-up', async () => {
  const f = await fixture(), started = await f.call('start_thread', f.start())
  if (started.status !== 'ok' || !('target' in started)) throw new Error('start refused')
  const native = f.workspace.adapters.codex.state.threads.find(thread => thread.id === f.workspace.registry.byThread(started.target.threadId)!.sessionId)!
  native.requests = [{ id: 'answer-before-delivery', kind: 'permission', text: 'private args', options: [] }]; f.workspace.adapters.codex.emit()
  await vi.waitFor(() => expect(waitingNews(f)).toContain('waits on the user to answer'), { timeout: 15_000 })
  await f.control.commandShell({ type: 'queue-followup', threadId: f.id, draftId: randomUUID(), text: 'User continuation first' })
  const items = queued(f).filter(item => item.threadId === f.id)
  expect(items[0]!.text).toBe('User continuation first'); expect(items.at(-1)!.wakeUp).toBe(true)
  // The user's own follow-up shows; Sotto's wake-up behind it does not.
  expect(f.control.shell().followups!.filter(item => item.threadId === f.id).map(item => item.text)).toEqual(['User continuation first'])
  native.requests = []; f.workspace.adapters.codex.emit()
  await vi.waitFor(() => expect(waitingNews(f) ?? '').not.toContain('waits on the user to answer'))
  expect(f.control.shell().followups!.some(item => item.text === 'User continuation first')).toBe(true)
})

it('starts Watcher’s news afresh after a restart: wake-ups an earlier build saved go, and what is still true is told anew', async () => {
  const f = await fixture(), { started } = await heldQuestion(f)
  const saved = queued(f).find(item => item.threadId === f.id && item.wakeUp)!
  const question = saved.news!.flatMap(news => 'events' in news ? news.events : [])
  expect(f.control.watcherRecord().wakeEventIds).toEqual(expect.arrayContaining(question.map(event => event.id)))
  f.service.close(); f.control.dispose(); await f.control.closed()
  // An earlier build saved two for this Watcher, without what this one keeps beside them: one whose send was unknown, with
  // the news in its words, and one waiting behind it.
  const path = join(f.root, 'followups.json'), file = JSON.parse(await readFile(path, 'utf8')) as { items: Record<string, unknown>[] }
  const finish = { ...question[0]!, id: randomUUID(), kind: 'turn-finished', turnId: 'synthetic-earlier-turn' }
  file.items = file.items.flatMap(item => item.id !== saved.id ? [item] : [
    { ...item, status: 'uncertain', commandId: randomUUID(), messageId: randomUUID(), text: watcherNewsText(saved.news![0] as Parameters<typeof watcherNewsText>[0]) },
    { ...item, id: randomUUID(), draftId: randomUUID(), news: [{ ...saved.news![0], events: [finish] }] }])
  await writeFile(path, JSON.stringify(file))
  const restored = f.create(), service = new WatcherService({ ordinaryBatch: SHORT_BATCH, directory: f.root, control: restored, host: f.workspace.host, historyEnabled: () => true })
  f.workspace.host.useWatcherTools(new WatcherToolServer(service))
  cleanups.push(async () => { service.close(); restored.dispose(); await restored.closed() })
  // They leave the queue only once their news is saved as untold, so a crash in between leaves them to be observed afresh.
  const drop = vi.spyOn(FollowupStore.prototype, 'dropWatcherNews'), beforeDrop: string[][] = []
  drop.mockImplementation(async function (this: FollowupStore, word) { beforeDrop.push(await savedTold(f.root)); drop.mockRestore(); return this.dropWatcherNews(word) })
  await restored.start(); await restored.commandShell({ type: 'connect', provider: 'codex' }); await service.recover()
  expect(beforeDrop).toHaveLength(1)
  expect(beforeDrop[0]).not.toContain(question[0]!.id)
  // Both are gone, and so is the record that their news was told.
  expect(storedFollowups(restored).filter(item => item.threadId === f.id)).toEqual([])
  expect(restored.watcherRecord().wakeEventIds ?? []).not.toEqual(expect.arrayContaining([question[0]!.id]))
  expect(restored.watcherRecord().wakeEventIds ?? []).not.toContain(finish.id)
  // The question is still open, so it is observed afresh and reaches Watcher once it rests.
  await restored.commandShell({ type: 'refresh', provider: 'codex' })
  const native = f.native(f.id); native.status = 'idle'; native.lastTurn = { id: randomUUID(), status: 'completed' }
  f.workspace.adapters.codex.emit(); await restored.commandShell({ type: 'refresh', provider: 'codex' })
  const master = f.workspace.registry.byThread(f.id)!.sessionId
  await vi.waitFor(() => expect(f.workspace.adapters.codex.commands.some(command => command.type === 'send' && command.threadId === master
    && command.watcherNews?.includes('waits on the user to answer'))).toBe(true), { timeout: 20_000 })
  void started
}, 40_000)

it('reads Watcher’s turn from one copy of its thread, and records it once that copy holds it (#1249)', async () => {
  const f = await fixture()
  const live = f.control.watcherSnapshot(), latest = f.control.watcherRecord().promptTurns!.at(-1)!
  // A turn of Watcher's the record has not named yet, in the snapshot the pass is handed.
  const turnId = randomUUID()
  const turned = { ...live, threads: live.threads.map(thread => thread.id === f.id ? { ...thread, status: 'running' as const, lastTurn: { id: turnId, status: 'running' as const } } : thread) }
  // The coordinator's own copy does not hold Watcher's thread for the moment: the pass refuses nothing and records nothing.
  const elsewhere = vi.spyOn(f.control, 'watcherSnapshot').mockReturnValue({ ...live, threads: live.threads.filter(thread => thread.id !== f.id) })
  try { expect(() => f.service.observe(turned, new Set())).not.toThrow() } finally { elsewhere.mockRestore() }
  expect(f.control.watcherRecord().promptTurns!.find(turn => turn.id === latest.id)!.nativeTurnId).not.toBe(turnId)
  // Once it holds the thread again, the next pass records the turn.
  const held = vi.spyOn(f.control, 'watcherSnapshot').mockReturnValue(turned)
  try { f.service.observe(turned, new Set()) } finally { held.mockRestore() }
  expect(f.control.watcherRecord().promptTurns!.find(turn => turn.id === latest.id)!.nativeTurnId).toBe(turnId)
})

it('waits while this computer has no host ID, refusing nothing, and does what it waited on once the ID is back (#1129)', async () => {
  const f = await fixture(), started = await f.call('start_thread', f.start())
  if (started.status !== 'ok' || !('target' in started)) throw new Error('start refused')
  const worker = started.target.threadId, watch = () => f.control.watcherRecord().watches!.find(item => item.target.threadId === worker)!
  expect(f.service.watchedThreadIds()).toContain(worker)
  const rooms: unknown[] = [], unsubscribe = f.service.subscribe(() => { rooms.push(f.service.state()) })
  const observed = vi.spyOn(f.workspace.host, 'observeThreads')
  // Registered after Watcher's own listener, so each broadcast it counts has already reached Watcher's.
  let broadcasts = 0
  const counting = f.control.subscribe(() => { broadcasts++ })
  // The coordinator as it is while Sotto starts: no host ID, and a snapshot that names none.
  const live = f.control.watcherSnapshot(), userMessageId = randomUUID()
  const noHost = vi.spyOn(f.control, 'hostId').mockReturnValue(undefined)
  const noSnapshotHost = vi.spyOn(f.control, 'watcherSnapshot').mockReturnValue({ ...live, hostId: undefined })
  try {
    // What the snapshot subscriber, the coordinator's observe and the news timers ask of Watcher.
    expect(() => f.service.observe({ ...live, hostId: undefined }, new Set())).not.toThrow()
    expect(f.service.watchedThreadIds()).toEqual([])
    expect(() => f.control.refreshWatcherObservation()).not.toThrow()
    expect(f.service.phoneSnapshot().threads.some(thread => thread.id === worker)).toBe(true)
    // The user writes in the watched thread meanwhile, and the coordinator takes the snapshot and publishes it.
    const native = f.native(worker)
    native.messages.push({ id: userMessageId, role: 'user', text: 'Synthetic native user prompt', createdAt: new Date().toISOString() })
    native.status = 'running'; native.lastTurn = { id: randomUUID(), status: 'running' }
    f.workspace.adapters.codex.emit()
    const before = broadcasts
    expect((await f.control.commandShell({ type: 'refresh', provider: 'codex' })).error).toBeNull()
    await vi.waitFor(() => expect(broadcasts).toBeGreaterThan(before))
    // Watcher heard both and waited: no room yet, and the user's message is not yet a takeover.
    expect(rooms).toHaveLength(0)
    expect(watch()).toMatchObject({ pausedByUserMessageId: null })
    expect(watch().lastUserMessageId).not.toBe(userMessageId)
  } finally { noHost.mockRestore(); noSnapshotHost.mockRestore(); counting() }
  const calls = observed.mock.calls.length
  // The ID is back: the next snapshot's pass pauses the watch for the user's message, the room hears it, and the
  // watched thread is observed again.
  expect((await f.control.commandShell({ type: 'refresh', provider: 'codex' })).error).toBeNull()
  expect(watch()).toMatchObject({ pausedByUserMessageId: userMessageId, lastUserMessageId: userMessageId })
  await vi.waitFor(() => expect(rooms.length).toBeGreaterThan(0))
  expect(f.service.watchedThreadIds()).toContain(worker)
  expect(observed.mock.calls.slice(calls).some(([ids]) => ids.includes(worker))).toBe(true)
  unsubscribe(); observed.mockRestore()
})

it('keeps Watcher’s waiting news queued and a stopped thread’s queue held while this computer has no host ID (#1129)', async () => {
  const f = await fixture(), { started, hidden } = await heldQuestion(f)
  const worker = started.target.threadId
  // As while Sotto starts: no host ID, and a snapshot that names none.
  const hostless = () => {
    const live = f.control.watcherSnapshot()
    const noHost = vi.spyOn(f.control, 'hostId').mockReturnValue(undefined)
    const noSnapshotHost = vi.spyOn(f.control, 'watcherSnapshot').mockReturnValue({ ...live, hostId: undefined })
    return () => { noHost.mockRestore(); noSnapshotHost.mockRestore() }
  }
  // The queue prunes Watcher's waiting news: nothing says it is out of date, so it stays.
  const waiting = hidden().map(item => item.id)
  expect(waiting).toHaveLength(1)
  let restore = hostless()
  try {
    await expect(f.control.pruneWatcherWakeUps()).resolves.toBeUndefined()
    expect(hidden().map(item => item.id)).toEqual(waiting)
  } finally { restore() }
  // The queue asks whether Watcher's Stop holds the thread: it still does.
  expect(await f.call('stop_thread', { requestId: f.requestId, retryKey: randomUUID(), target: started.target })).toMatchObject({ status: 'ok' })
  await vi.waitFor(() => expect(f.service.preserveUserQueue(worker)).toBe(true))
  restore = hostless()
  try { expect(f.service.preserveUserQueue(worker)).toBe(true) } finally { restore() }
})

it('rechecks answered news after checkpoint preparation and before the provider writer', async () => {
  const f = await fixture(), started = await f.call('start_thread', f.start())
  if (started.status !== 'ok' || !('target' in started)) throw new Error('start refused')
  const native = f.workspace.adapters.codex.state.threads.find(thread => thread.id === f.workspace.registry.byThread(started.target.threadId)!.sessionId)!
  native.requests = [{ id: 'late-answer', kind: 'question', text: 'private question', options: [] }]; f.workspace.adapters.codex.emit()
  await vi.waitFor(() => expect(waitingNews(f)).toContain('waits on the user to answer'), { timeout: 15_000 })
  const entered = deferred<void>(), release = deferred<void>()
  f.workspace.host.setCheckpointHooks({ isBlocked: async () => false, beforeTurn: async id => { if (id === f.id) { entered.resolve(); await release.promise } } })
  const master = f.workspace.registry.byThread(f.id)!.sessionId
  const before = f.workspace.adapters.codex.commands.filter(command => command.type === 'send' && command.threadId === master).length
  try {
    const finishing = f.finish(f.id)
    await entered.promise
    expect(f.workspace.adapters.codex.commands.filter(command => command.type === 'send' && command.threadId === master)).toHaveLength(before)
    native.requests = []; f.workspace.adapters.codex.emit()
    await vi.waitFor(() => expect(f.control.watcherSnapshot().threads.find(thread => thread.id === started.target.threadId)!.requests).toHaveLength(0))
    release.resolve()
    await finishing
    await vi.waitFor(() => expect(waitingNews(f) ?? '').not.toContain('waits on the user to answer'))
    expect(f.workspace.adapters.codex.commands.filter(command => command.type === 'send' && command.threadId === master).slice(before)
      .some(command => command.type === 'send' && (command.text + (command.watcherNews ?? '')).includes('waits on the user to answer'))).toBe(false)
  } finally { release.resolve() }
})

it.each(['preparation', 'native', 'reconciled'])('refunds a queued prompt after a definite %s failure exactly once', async failure => {
  const f = await fixture(), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start refused')
  const input = { requestId: f.requestId, retryKey: randomUUID(), target: first.target, delivery: 'queue', text: 'Synthetic queued failure' }
  expect(await f.call('send_to_thread', input)).toMatchObject({ status: 'ok', limits: { promptCount: 2 } })
  const refresh = f.workspace.host.refreshThread.bind(f.workspace.host)
  const execute = f.workspace.adapters.codex.execute.bind(f.workspace.adapters.codex)
  const spy = failure === 'preparation'
    ? vi.spyOn(f.workspace.host, 'refreshThread').mockImplementation(async (id, purpose) => {
      if (id === first.target.threadId && purpose?.beforeSend) throw new Error('Synthetic preparation failure')
      return refresh(id, purpose)
    })
    : vi.spyOn(f.workspace.adapters.codex, 'execute').mockImplementation(async command => {
      if (command.type === 'send' && command.text === input.text) throw new Error('Synthetic native pre-write failure')
      return execute(command)
    })
  // Recovery must see the stale receipt before any live observation has already refunded it: neither a snapshot nor the
  // queue's own word of the failure reaches Watcher.
  const observation = failure === 'reconciled' ? [vi.spyOn(f.service, 'observe').mockImplementation(() => undefined),
    vi.spyOn(f.service, 'queueFailed').mockImplementation(() => undefined)] : []
  cleanups.push(async () => { for (const spy of observation) spy.mockRestore() })
  await f.finish(first.target.threadId)
  await vi.waitFor(() => expect(f.control.shell().followups?.find(item => item.text === input.text)?.status).toBe('failed'))
  if (failure === 'reconciled') expect(f.service.state().requests[0]!.participants[0]!.promptCount).toBe(2)
  if (failure === 'reconciled') await f.control.updateWatcher(record => {
    // Recovery can fence a stale dispatch receipt as uncertain before observing the durable failed queue item.
    record.operations.at(-1)!.deliveryState = 'uncertain'
  })
  for (const spy of observation) spy.mockRestore()
  await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  expect(f.service.state().receipts.at(-1)?.deliveryState).toBe('failed')
  expect(f.service.state().requests[0]!.participants[0]!.promptCount).toBe(1)
  expect(f.workspace.adapters.codex.commands.some(command => command.type === 'send' && command.text === input.text)).toBe(false)
  // The failed item still waits in the queue, and every snapshot reads it again: that changes nothing, so the record stays
  // the same object and Watcher's pass is not run again for it.
  const kept = f.control.watcherRecordView()
  await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  expect(f.control.watcherRecordView()).toBe(kept)
  spy.mockRestore()
  await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  expect(await f.call('send_to_thread', input)).toMatchObject({ status: 'refused', code: 'PROVIDER_UNAVAILABLE' })
  expect(f.service.state().requests[0]!.participants[0]!.promptCount).toBe(1)
  for (let count = 2; count <= 4; count++) {
    expect(await f.call('send_to_thread', { ...input, retryKey: randomUUID() })).toMatchObject({ status: 'ok', limits: { promptCount: count } })
    await f.finish(first.target.threadId)
  }
  expect(await f.call('send_to_thread', { ...input, retryKey: randomUUID() })).toMatchObject({ status: 'refused', code: 'PROMPT_LIMIT' })
})

it('refunds a definite thrown command failure after the worker exists', async () => {
  const f = await fixture(), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start refused')
  await f.finish(first.target.threadId)
  vi.spyOn(f.control, 'commandFromWatcher').mockRejectedValueOnce(new Error('Synthetic pre-dispatch failure'))
  expect(await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target, delivery: 'now', text: 'Synthetic failed dispatch' }))
    .toMatchObject({ status: 'refused', code: 'PROVIDER_UNAVAILABLE', receipt: { deliveryState: 'failed' } })
  expect(f.service.state().requests[0]!.participants[0]!.promptCount).toBe(1)
})


it('keeps the roster readable after more than one hundred requests address a worker', async () => {
  const f = await fixture(), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start refused')
  const latestRequestId = randomUUID()
  await f.control.updateWatcher(record => {
    const original = record.requests[0]!
    for (let index = 0; index < 100; index++) {
      const id = index === 99 ? latestRequestId : randomUUID()
      record.requests.push({ ...original, id, rootUserMessageId: randomUUID(), state: 'closed', closedAt: original.createdAt,
        participants: original.participants.map(item => ({ ...item, requestId: id, state: index === 99 ? 'taken-over' : 'relinquished',
          ...(index === 99 ? { takeover: { reason: 'user-send', at: original.createdAt } } : {}) })) })
    }
  })
  const result = await f.call('list_threads', { includeSettled: true, detail: 'full' })
  expect(result.status).toBe('ok')
  if (result.status !== 'ok' || !('rows' in result)) throw new Error('roster refused')
  const row = result.rows.find(item => item.target.threadId === first.target.threadId)! as Extract<(typeof result.rows)[number], { participation: unknown }>
  expect(row.participation).toHaveLength(100)
  expect(row.participation.at(-1)).toMatchObject({ requestId: latestRequestId, state: 'taken-over', takeover: { reason: 'user-send' } })
  expect(f.control.watcherRecord().requests).toHaveLength(101)
})


it.each([
  { delivery: 'now' }, { delivery: 'queue' }, { delivery: 'steer' },
])('refuses $delivery to a settled participant before admission', async ({ delivery }) => {
  const f = await fixture(), first = await f.call('start_thread', f.start()), second = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first) || second.status !== 'ok') throw new Error('start refused')
  await f.finish(first.target.threadId)
  expect(await f.call('settle_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target })).toMatchObject({ status: 'ok' })
  expect(f.service.state().requests[0]).toMatchObject({ state: 'active', participants: [
    { target: first.target, state: 'relinquished', promptCount: 1 }, { state: 'participating', promptCount: 1 },
  ] })
  const record = f.control.watcherRecord(), commands = f.workspace.adapters.codex.commands.length
  expect(await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target,
    delivery, text: 'Synthetic send after settle' })).toMatchObject({ status: 'refused', code: 'REQUEST_NOT_ACTIVE',
    message: 'Watcher settled this participation. It will not send another prompt for this request.' })
  expect(f.control.watcherRecord()).toEqual(record)
  expect(f.workspace.adapters.codex.commands).toHaveLength(commands)
})

it('returns a settle receipt on retry after its request closes without reviving it', async () => {
  const f = await fixture(), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start refused')
  await f.finish(first.target.threadId)
  await f.finish(f.id)
  const input = { requestId: f.requestId, retryKey: randomUUID(), target: first.target }
  const result = await f.call('settle_thread', input)
  expect(result).toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' } })
  expect(f.service.state().requests[0]!.state).toBe('closed')
  const commands = f.workspace.adapters.codex.commands.length
  const record = f.control.watcherRecord()
  expect(await f.call('settle_thread', input)).toMatchObject({ status: 'ok', receipt: 'receipt' in result ? result.receipt : undefined, state: { settled: true } })
  expect(await f.call('stop_thread', input)).toMatchObject({ status: 'refused', code: 'RETRY_KEY_CONFLICT' })
  expect(await f.call('settle_thread', { ...input, retryKey: randomUUID() })).toMatchObject({ status: 'refused', code: 'REQUEST_NOT_ACTIVE' })
  expect(f.workspace.adapters.codex.commands).toHaveLength(commands)
  expect(f.control.watcherRecord()).toEqual(record)
})

it.each(['sequential', 'parallel'])('settles many user threads in one Watcher turn, %s, and closes the request when the turn ends (#1254)', async order => {
  const f = await fixture(), targets: { hostId: string, threadId: string }[] = []
  for (let index = 0; index < 4; index++) {
    await f.control.commandShell({ type: 'create-thread', projectId: f.project.id, title: `Synthetic idle review ${index}`, modelId: f.model.id })
    const threadId = f.control.shell().activeThreadId!
    await f.control.commandShell({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'Synthetic review work' })
    await f.finish(threadId)
    targets.push({ hostId: f.control.hostId()!, threadId })
  }
  expect(f.control.watcherSnapshot().threads.find(thread => thread.id === f.id)!.status).toBe('running')
  const settle = (target: (typeof targets)[number]) => f.call('settle_thread', { requestId: f.requestId, retryKey: randomUUID(), target })
  // The last settle always comes after the others have been accepted, while Watcher's turn still runs.
  const first = targets.slice(0, -1)
  const results = order === 'parallel' ? await Promise.all(first.map(settle)) : await first.reduce<Promise<unknown[]>>(
    async (done, target) => [...await done, await settle(target)], Promise.resolve([]))
  results.push(await settle(targets.at(-1)!))
  for (const result of results) expect(result).toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' } })
  expect(f.service.state().requests[0]).toMatchObject({ state: 'active', participants: targets.map(target => ({ target, state: 'relinquished' })) })
  await f.finish(f.id)
  await vi.waitFor(() => expect(f.service.state().requests[0]!.state).toBe('closed'))
})

it('closes a settled request once Watcher\'s running turn answers another request (#1254)', async () => {
  const f = await fixture()
  await f.control.commandShell({ type: 'create-thread', projectId: f.project.id, title: 'Synthetic idle review', modelId: f.model.id })
  const threadId = f.control.shell().activeThreadId!
  await f.control.commandShell({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'Synthetic review work' })
  await f.finish(threadId)
  expect(await f.call('settle_thread', { requestId: f.requestId, retryKey: randomUUID(), target: { hostId: f.control.hostId()!, threadId } })).toMatchObject({ status: 'ok' })
  expect(f.service.state().requests[0]).toMatchObject({ id: f.requestId, state: 'active' })
  // Watcher's turn ends and the user's next message starts another request before any pass sees Watcher idle.
  const observe = vi.spyOn(f.service, 'observe').mockImplementation(() => undefined)
  await f.finish(f.id)
  expect((await f.control.commandShell({ type: 'manual-send', threadId: f.id, draftId: randomUUID(), text: 'Synthetic next request' })).error).toBeNull()
  observe.mockRestore()
  await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  expect(f.control.watcherSnapshot().threads.find(thread => thread.id === f.id)!.status).toBe('running')
  await vi.waitFor(() => expect(f.service.state().requests.find(item => item.id === f.requestId)!.state).toBe('closed'))
  expect(f.service.state().requests.find(item => item.id !== f.requestId)).toMatchObject({ state: 'active' })
})


it('keeps working-copy choices and base refs in the same snapshot across pages', async () => {
  const f = await fixture()
  const options = vi.spyOn(f.workspace.host, 'workingCopyOptions').mockResolvedValue({ isGit: true, currentBranch: 'main', branches: ['main'],
    worktrees: [{ path: f.project.path, branch: 'main' }] })
  const input = { project: f.start().project, limit: 1 }
  const first = await f.call('list_working_copies', input)
  if (first.status !== 'ok' || !('choices' in first) || !first.nextCursor) throw new Error('missing copy page')
  const second = await f.call('list_working_copies', { ...input, cursor: first.nextCursor })
  expect(second).toMatchObject({ status: 'ok', revision: first.revision, baseRefs: first.baseRefs })
  expect(options).toHaveBeenCalledTimes(1)
})

it.each(['working-copy-as-base', 'base-as-working-copy'])('refuses a %s choice before admission or creation', async role => {
  const f = await fixture()
  vi.spyOn(f.workspace.host, 'workingCopyOptions').mockResolvedValue({ isGit: true, currentBranch: 'main', branches: ['main'],
    worktrees: [{ path: f.project.path, branch: 'main' }] })
  const choices = await f.call('list_working_copies', { project: f.start().project })
  if (choices.status !== 'ok' || !('choices' in choices)) throw new Error('copy read refused')
  const copy = choices.choices.find(item => item.kind === 'existing-worktree')!, base = choices.baseRefs[0]!
  const record = f.control.watcherRecord(), commands = f.workspace.adapters.codex.commands.length
  const selection = [f.control.shell().activeProjectId, f.control.shell().activeThreadId]
  const input = role === 'working-copy-as-base' ? { ...f.start(), baseRefChoiceId: copy.choiceId }
    : { ...f.start(), workingCopy: { kind: 'existing-worktree', choiceId: base.choiceId } }
  expect(await f.call('start_thread', input)).toMatchObject({ status: 'refused', code: 'WORKING_COPY_CHANGED' })
  expect(f.control.watcherRecord()).toEqual(record)
  expect(f.workspace.adapters.codex.commands).toHaveLength(commands)
  expect([f.control.shell().activeProjectId, f.control.shell().activeThreadId]).toEqual(selection)
})

it('passes a valid branch choice to creation and retains it in the receipt', async () => {
  const f = await fixture()
  await initializeGitRepository(f.project.path)
  const choices = await f.call('list_working_copies', { project: f.start().project })
  if (choices.status !== 'ok' || !('baseRefs' in choices)) throw new Error('copy read refused')
  const base = choices.baseRefs.find(item => item.name === 'main')!
  const create = vi.spyOn(f.control, 'commandFromWatcher')
  expect(await f.call('start_thread', { ...f.start(), baseRefChoiceId: base.choiceId }))
    .toMatchObject({ status: 'ok', effectiveChoices: { baseRefChoiceId: base.choiceId } })
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ type: 'create-thread', baseBranch: 'main' }), expect.anything())
  create.mockRestore()
})

it.each(['expiry', 'eviction'])('refuses obsolete working-copy choices after snapshot %s before admission', async expiry => {
  const f = await fixture()
  vi.spyOn(f.workspace.host, 'workingCopyOptions').mockResolvedValue({ isGit: true, currentBranch: 'main', branches: ['main'],
    worktrees: [{ path: f.project.path, branch: 'main' }] })
  const first = await f.call('list_working_copies', { project: f.start().project })
  if (first.status !== 'ok' || !('choices' in first)) throw new Error('copy read refused')
  const choice = first.choices.find(item => item.kind === 'existing-worktree')!
  const clock = expiry === 'expiry' ? vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001) : undefined
  try {
    if (expiry === 'eviction') for (let index = 0; index < 16; index++) await f.call('list_working_copies', { project: f.start().project })
    const record = f.control.watcherRecord(), selected = f.control.shell().activeThreadId
    expect(await f.call('start_thread', { ...f.start(), workingCopy: { kind: 'existing-worktree', choiceId: choice.choiceId } }))
      .toMatchObject({ status: 'refused', code: 'WORKING_COPY_CHANGED' })
    expect(await f.call('start_thread', { ...f.start(), baseRefChoiceId: first.baseRefs[0]!.choiceId }))
      .toMatchObject({ status: 'refused', code: 'WORKING_COPY_CHANGED' })
    expect(f.control.watcherRecord()).toEqual(record)
    expect(f.control.shell().activeThreadId).toBe(selected)
  } finally { clock?.mockRestore() }
})


it.each(['manual-send', 'queue-followup'] as const)('keeps the Watcher request context on an image %s at the provider boundary', async type => {
  const f = await fixture()
  f.workspace.adapters.codex.state.models[0]!.supportsImages = true
  f.workspace.adapters.codex.emit()
  await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  const image = await f.control.stageAttachment({ name: 'Synthetic.png', mimeType: 'image/png', bytes: PIXEL_PNG })
  const selected = f.control.shell().activeThreadId
  if (type === 'manual-send') await f.finish(f.id)
  const result = await f.control.commandShell({ type, threadId: f.id, draftId: randomUUID(), text: 'Synthetic image instruction', attachments: [image] })
  expect(result.error).toBeNull()
  if (type === 'queue-followup') await f.finish(f.id)
  await vi.waitFor(() => expect(f.workspace.adapters.codex.images).toHaveLength(1))
  const sent = f.workspace.adapters.codex.commands.findLast(command => command.type === 'send' && command.attachments?.length)
  if (!sent || sent.type !== 'send') throw new Error('image not sent')
  expect(sent.text).toBe('Synthetic image instruction')
  expect(sent.watcherRequestNote).toContain(`Sotto Watcher request: ${f.service.state().requests.at(-1)!.id}`)
  expect(sent.watcherRequestNote).toContain(`Local host: ${f.control.hostId()}`)
  expect(sent.watcherRequestNote).not.toContain(f.project.id)
  expect(sent.attachments?.[0]?.id).toBe(image.id)
  expect(Buffer.from(f.workspace.adapters.codex.images[0]!)).toEqual(PIXEL_PNG)
  expect(f.control.shell().activeThreadId).toBe(selected)
  expect(f.service.state().requests).toHaveLength(type === 'manual-send' ? 2 : 1)
})

it.each(['grok', 'codex'] as const)('moves a follow-up’s display proof to the message a %s retry is sent as', async provider => {
  const f = await fixture(), draftId = randomUUID(), stale = { originalLength: 3, wireDigest: 'a'.repeat(64) }
  await f.control.updateWatcher(record => {
    record.current!.provider = provider
    record.requests.find(item => item.id === f.requestId)!.userFollowups = [{ draftId, messageId: 'first-message', displayPrompt: stale }]
  })
  const sent = f.service.beforeDispatch({ type: 'send', commandId: randomUUID(), threadId: f.id, messageId: 'retried-message', text: 'Synthetic retry' }, draftId)
  expect(sent).toMatchObject({ text: 'Synthetic retry', watcherRequestNote: watcherRequestNote(f.requestId, f.control.hostId()!) })
  const request = f.control.watcherRecord().requests.find(item => item.id === f.requestId)!
  const followup = request.userFollowups!.find(item => item.draftId === draftId)!
  expect(followup.messageId).toBe('retried-message')
  // Grok records no proof, so its retried message is found by provenance and its request line comes off;
  // Codex records the retried message's own proof. Neither keeps the first message's.
  if (provider === 'grok') {
    expect(followup).not.toHaveProperty('displayPrompt')
    const owner = watcherMessageRequests([request])(f.id, 'retried-message')
    expect(owner).toEqual({ requestId: f.requestId, hostId: f.control.hostId() })
    expect(watcherTextAsTyped(`Synthetic retry${watcherRequestLine(watcherRequestNote(f.requestId, f.control.hostId()!))}`, owner!)).toBe('Synthetic retry')
  } else expect(followup.displayPrompt).toEqual(watcherDisplayPrompt('Synthetic retry', 'Synthetic retry'))
})

it('sends Watcher the user’s words as typed, with its request in the note beside them and no project list', async () => {
  const f = await fixture()
  const session = f.workspace.registry.byThread(f.id)!.sessionId
  const sends = () => f.workspace.adapters.codex.commands.filter(command => command.type === 'send' && command.threadId === session)
  const projectIds = [...f.control.shell().host.projects, ...f.control.watcherSnapshot().projects].map(project => project.id)
  const first = sends()[0]
  if (first?.type !== 'send') throw new Error('Watcher was not sent the user request')
  // What the provider receives as the user's message is what the user typed: nothing of Sotto's and no project IDs.
  expect(first.text).toBe('Synthetic Watcher user request')
  for (const id of projectIds) expect(first.text).not.toContain(id)
  // The routing travels beside it, and names no project either.
  expect(first.watcherRequestNote).toBe(watcherRequestNote(f.requestId, f.control.hostId()!))
  for (const id of projectIds) expect(first.watcherRequestNote).not.toContain(id)
  // The desktop shows the message as typed.
  await f.control.commandShell({ type: 'observe-threads', threadIds: [f.id] })
  await vi.waitFor(() => expect(f.control.threadDetail(f.id)!.messages.filter(message => message.role === 'user').map(message => message.text))
    .toEqual(['Synthetic Watcher user request']))
  // The request the note names still reaches Watcher's tools.
  expect(await f.call('start_thread', f.start())).toMatchObject({ status: 'ok' })
  const worker = f.workspace.adapters.codex.commands.findLast(command => command.type === 'send' && command.threadId !== session)
  expect(worker).toMatchObject({ type: 'send', text: f.start().firstPrompt })
  expect(worker).not.toHaveProperty('watcherRequestNote')
  // A later instruction starts its own request and carries its own note.
  await f.finish(f.id)
  expect((await f.control.commandShell({ type: 'manual-send', threadId: f.id, draftId: randomUUID(), text: 'Synthetic later instruction' })).error).toBeNull()
  const later = f.service.state().requests.at(-1)!
  expect(later.id).not.toBe(f.requestId)
  expect(sends().at(-1)).toMatchObject({ text: 'Synthetic later instruction', watcherRequestNote: watcherRequestNote(later.id, f.control.hostId()!) })
})

it('shows Watcher’s request messages without the line Sotto added, and leaves what the user typed', async () => {
  const f = await fixture(), hostId = f.control.hostId()!
  const native = f.workspace.adapters.codex.state.threads.find(row => row.id === f.workspace.registry.byThread(f.id)!.sessionId)!
  const send = async (text: string) => {
    await f.finish(f.id)
    expect((await f.control.commandShell({ type: 'manual-send', threadId: f.id, draftId: randomUUID(), text })).error).toBeNull()
    return f.service.state().requests.at(-1)!
  }
  const first = f.service.state().requests.find(request => request.id === f.requestId)!
  // A message saved before the request note, with the footer main appended for its own request.
  const typed = 'Synthetic older instruction\n\nwith a second paragraph'
  const footer = `\n\n[Sotto Watcher request: ${first.id}. Local host: ${hostId}. Use this requestId for sotto_threads mutations. `
    + `Known project IDs: ${f.project.id}, native:claude:project:${randomUUID()}. Call list_projects for choices.]`
  native.messages.find(message => message.id === first.rootUserMessageId)!.text = typed + footer
  // A message as Grok Build is sent it, with the request line for its own request.
  const grok = await send('Synthetic Grok instruction')
  native.messages.find(message => message.id === grok.rootUserMessageId)!.text = `Synthetic Grok instruction${watcherRequestLine(watcherRequestNote(grok.id, hostId))}`
  // A user who types an example note, or a lookalike, keeps every word of it.
  const example = `Explain this example:${watcherRequestLine(watcherRequestNote(randomUUID(), hostId))}`
  const exampleRequest = await send(example)
  const lookalike = 'Synthetic [Sotto Watcher request: typed by the user.]'
  const lookalikeRequest = await send(lookalike)
  // Messages saved before display proofs, and Grok Build's (whose sends record none), carry no proof.
  await f.control.updateWatcher(record => { for (const request of record.requests) if (request.id === first.id || request.id === grok.id) delete request.displayPrompt })
  native.messages.push({ id: 'older-reply', role: 'assistant', text: `Synthetic reply quoting${footer}`, createdAt: new Date().toISOString() })
  native.status = 'idle'
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  await f.control.commandShell({ type: 'observe-threads', threadIds: [f.id] })
  const shown = (id: string) => f.control.threadDetail(f.id)!.messages.find(message => message.id === id)?.text
  await vi.waitFor(() => expect(shown(first.rootUserMessageId)).toBe(typed))
  expect(shown(grok.rootUserMessageId)).toBe('Synthetic Grok instruction')
  expect(shown(exampleRequest.rootUserMessageId)).toBe(example)
  expect(shown(lookalikeRequest.rootUserMessageId)).toBe(lookalike)
  expect(shown('older-reply')).toBe(`Synthetic reply quoting${footer}`)
  // The provider's own history keeps what it was sent; only what the user sees changes.
  expect(native.messages.find(message => message.id === first.rootUserMessageId)!.text).toBe(typed + footer)
})


it('keeps the newest messages in an oversized initial read and the oldest prefix in a forward read', async () => {
  const f = await fixture(), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start refused')
  const historyEpoch = randomUUID(), createdAt = new Date().toISOString()
  vi.spyOn(f.workspace.host, 'watcherRead').mockResolvedValue({ historyEpoch, hasMore: false, earlierAvailable: false, activities: [],
    messages: Array.from({ length: 50 }, (_, position) => ({ position,
      message: { id: randomUUID(), role: 'assistant', text: 'x'.repeat(2_000), createdAt } })) })
  const initial = await f.call('read_thread', { target: first.target })
  if (initial.status !== 'ok' || !('messages' in initial)) throw new Error('initial read refused')
  expect(initial.lastPosition).toBe(49)
  expect(initial.firstPosition).toBeGreaterThan(0)
  expect(initial.messages.map(item => item.position)).toEqual(Array.from({ length: initial.messages.length }, (_, index) => initial.firstPosition! + index))
  expect(initial).toMatchObject({ nextPosition: null, earlierAvailable: true, truncated: true })
  expect(Buffer.byteLength(JSON.stringify(initial))).toBeLessThanOrEqual(64 * 1_024)
  const forward = await f.call('read_thread', { target: first.target, position: { historyEpoch, afterPosition: -1 } })
  if (forward.status !== 'ok' || !('messages' in forward)) throw new Error('forward read refused')
  expect(forward.firstPosition).toBe(0)
  expect(forward.lastPosition).toBeLessThan(49)
  expect(forward.messages.map(item => item.position)).toEqual(Array.from({ length: forward.messages.length }, (_, index) => index))
  expect(forward).toMatchObject({ nextPosition: forward.lastPosition, earlierAvailable: false, truncated: true })
  expect(Buffer.byteLength(JSON.stringify(forward))).toBeLessThanOrEqual(64 * 1_024)
})


it.each(['list_threads', 'list_projects', 'list_working_copies'] as const)('restarts an expired %s page using the returned restart cursor', async name => {
  const f = await fixture()
  if (name === 'list_projects') {
    const path = join(f.root, 'other-project')
    expect((await f.control.commandShell({ type: 'create-project', path, title: 'Other synthetic project', provider: 'codex' })).error).toBeNull()
  }
  if (name === 'list_working_copies') vi.spyOn(f.workspace.host, 'workingCopyOptions').mockResolvedValue({ isGit: true, currentBranch: 'main', branches: ['main'], worktrees: [] })
  const input = { limit: 1, ...(name === 'list_working_copies' ? { project: f.start().project } : name === 'list_threads' ? { includeSettled: true } : {}) }
  const first = await f.call(name, input)
  if (first.status !== 'ok' || !('nextCursor' in first) || !first.nextCursor) throw new Error('missing list page')
  const selected = f.control.shell().activeThreadId, clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001)
  try {
    const expired = await f.call(name, { ...input, cursor: first.nextCursor })
    expect(expired).toMatchObject({ status: 'refused', code: 'CURSOR_EXPIRED', restartCursor: expect.any(String) })
    if (expired.status !== 'refused' || !expired.restartCursor) throw new Error('missing restart cursor')
    expect(await f.call(name, { ...input, cursor: expired.restartCursor })).toMatchObject({ status: 'ok' })
    expect(f.control.shell().activeThreadId).toBe(selected)
  } finally { clock.mockRestore() }
})


it('keeps news and checkpoint evidence from restarting a worker stopped by Watcher until user review', async () => {
  const f = await fixture(), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start refused')
  expect(await f.call('stop_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target })).toMatchObject({ status: 'ok' })
  await f.finish(first.target.threadId)
  const checkpointId = randomUUID()
  f.service.checkpointObserved({ threadId: first.target.threadId, checkpointId, observedAt: new Date().toISOString(),
    availability: 'available', changedFiles: 1 })
  await f.service.wakes.drained()
  const watched = f.service.state().watchedThreads.find(item => item.target.threadId === first.target.threadId)!
  expect(watched.participation[0]).toMatchObject({ automationStopped: true, promptCount: 1 })
  expect(watched.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'checkpoint', checkpointId, changedFiles: 1 })]))
  expect(f.service.watchedThreadIds()).toContain(first.target.threadId)
  expect(f.service.state().news?.some(item => item.target.threadId === first.target.threadId)).toBe(true)
  await f.control.deliverWakeUp(first.target.threadId, { pullRequest: { url: 'https://github.com/synthetic/project/pull/4', number: 4, title: 'Synthetic pull request' },
    startedBy: 'user', head: null, ended: null, changes: [{ kind: 'checks-passed', count: 1, required: true }] }, { tool: false })
  await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  expect(f.control.shell().followups!.find(item => item.threadId === first.target.threadId && item.wakeUp)).toMatchObject({ status: 'queued' })
  expect(f.workspace.adapters.codex.commands.filter(item => item.type === 'send' && item.text.includes('pull/4'))).toHaveLength(0)
  expect((await f.control.commandShell({ type: 'resume-followups', threadId: first.target.threadId })).error).toBeNull()
  await vi.waitFor(() => expect(f.workspace.adapters.codex.commands.filter(item => item.type === 'send' && item.text.includes('pull/4'))).toHaveLength(1))
  expect(f.service.state().watchedThreads.find(item => item.target.threadId === first.target.threadId)!.participation[0]).toMatchObject({ state: 'taken-over', promptCount: 1 })
  expect(f.workspace.adapters.codex.commands.filter(item => item.type === 'answer')).toHaveLength(0)
})

/**
 * Changes a thread on the coordinator's copy at once. Its thread records are the workspace's publication, frozen
 * (ADR-0016, October 22), so the record is replaced in the copy's own thread list rather than written into.
 */
function reshow(f: Awaited<ReturnType<typeof fixture>>, threadId: string, change: (thread: AgentThread) => AgentThread): void {
  const threads = f.control.watcherSnapshot().threads
  const at = threads.findIndex(thread => thread.id === threadId)
  threads[at] = change(threads[at]!)
}
const showLinks = (f: Awaited<ReturnType<typeof fixture>>, threadId: string, links: NonNullable<AgentThread['pullRequests']>): void =>
  reshow(f, threadId, thread => ({ ...thread, pullRequests: links }))

/** A worker's linked pull request and GitHub's read of its checks: news that wakes Watcher on its own. */
function pullRequestNews(f: Awaited<ReturnType<typeof fixture>>, threadId: string) {
  const url = 'https://github.com/synthetic/project/pull/5'
  const links = [{ url, number: 5, title: 'Synthetic pull request', state: 'open' as const, draft: false, source: 'linked' as const, linkedAt: new Date().toISOString() }]
  // The workspace's record holds a thread's links, so a later snapshot keeps them; the coordinator's copy shows them now.
  const record = (f.workspace.host as unknown as { state: { snapshot: { threads: { id: string; pullRequests?: typeof links }[] } } }).state.snapshot
  record.threads.find(thread => thread.id === threadId)!.pullRequests = structuredClone(links)
  showLinks(f, threadId, links)
  return { url, read: { url, head: 'synthetic-head', observedAt: new Date().toISOString(), availability: 'available' as const, checks: 'failed' as const, checkCount: 1 } }
}

it.each(['workspace-settled', 'archived', 'missing-hooks', 'disconnected'] as const)('holds pull request news for a %s master and queues it after recovery', async unavailable => {
  const f = await fixture(), started = await f.call('start_thread', f.start())
  if (started.status !== 'ok' || !('target' in started)) throw new Error('start refused')
  const target = f.service.state().current!.target
  expect(f.control.canDeliverWatcherNews(target)).toBe(true) // Busy is queueable.
  expect(f.control.canDeliverWatcherNews({ ...target, hostId: randomUUID() })).toBe(false)
  if (unavailable === 'workspace-settled') reshow(f, f.id, master => ({ ...master, workspaceSettledAt: new Date().toISOString() }))
  if (unavailable === 'archived') reshow(f, f.id, master => ({ ...master, archivedAt: new Date().toISOString() }))
  if (unavailable === 'missing-hooks') f.control.useWatcher(f.service)()
  if (unavailable === 'disconnected') f.control.watcherSnapshot().connected = false
  expect(f.control.canDeliverWatcherNews(target)).toBe(false)
  const deliver = vi.spyOn(f.control, 'deliverWakeUp')
  f.service.pullRequestObserved(pullRequestNews(f, started.target.threadId).read)
  await f.service.wakes.drained()
  expect(deliver).not.toHaveBeenCalled()
  reshow(f, f.id, master => { const recovered = { ...master }; delete recovered.workspaceSettledAt; delete recovered.archivedAt; return recovered })
  if (unavailable === 'disconnected') f.control.watcherSnapshot().connected = true
  if (unavailable === 'missing-hooks') f.control.useWatcher(f.service)
  f.service.wakes.observe()
  await vi.waitFor(() => expect(waitingNews(f)).toBeDefined(), { timeout: 15_000 })
  expect(deliver).toHaveBeenCalledTimes(1)
  await f.service.wakes.drained()
  const saved = deliver.mock.calls[0]![1]
  if (!('source' in saved) || saved.source !== 'watcher') throw new Error('Expected Watcher news')
  expect(saved.events.some(event => event.kind === 'evidence-changed')).toBe(true)
  expect(f.control.watcherRecord().wakeEventIds).toEqual(saved.events.map(event => event.id))
  expect(f.workspace.adapters.codex.commands.filter(command => command.type === 'answer')).toHaveLength(0)
})

it('tells pull request news again when the thread’s own facts change while its wake-up is being sent', async () => {
  const f = await fixture(), started = await f.call('start_thread', f.start())
  if (started.status !== 'ok' || !('target' in started)) throw new Error('start refused')
  f.service.pullRequestObserved(pullRequestNews(f, started.target.threadId).read)
  await vi.waitFor(() => expect(waitingNews(f)).toContain('Sotto observed changed evidence'), { timeout: 15_000 })
  await f.service.wakes.drained()
  const entered = deferred<void>(), release = deferred<void>()
  f.workspace.host.setCheckpointHooks({ isBlocked: async () => false, beforeTurn: async id => { if (id === f.id) { entered.resolve(); await release.promise } } })
  const master = f.workspace.registry.byThread(f.id)!.sessionId
  const told = () => f.workspace.adapters.codex.commands.filter(command => command.type === 'send' && command.threadId === master
    && command.watcherNews?.includes('Sotto observed changed evidence'))
  try {
    const finishing = f.finish(f.id)
    await entered.promise
    // The wake-up is claimed when the worker's working copy moves: the news it carries names evidence that is no longer current.
    expect(queued(f).find(item => item.threadId === f.id && item.wakeUp)).toMatchObject({ status: 'dispatching' })
    f.service.checkpointObserved({ threadId: started.target.threadId, checkpointId: randomUUID(), observedAt: new Date().toISOString(), availability: 'available', changedFiles: 3 })
    await f.service.wakes.drained()
    release.resolve()
    await finishing
    // The stale copy is withdrawn at the writer, and the pull request's news still reaches Watcher, as it stands now.
    await vi.waitFor(() => expect(told()).not.toHaveLength(0), { timeout: 10_000 })
  } finally { release.resolve() }
}, 30_000)

it('keeps durably waiting pull request news through Watcher recovery and same-fact replay', async () => {
  const f = await fixture(), started = await f.call('start_thread', f.start())
  if (started.status !== 'ok' || !('target' in started)) throw new Error('start refused')
  const { read } = pullRequestNews(f, started.target.threadId)
  f.service.pullRequestObserved(read)
  await vi.waitFor(() => expect(waitingNews(f)).toContain('Sotto observed changed evidence'), { timeout: 15_000 })
  await f.service.wakes.drained()
  const waiting = queued(f).find(item => item.threadId === f.id && item.wakeUp)!, news = waitingNews(f)
  const ids = f.control.watcherRecord().wakeEventIds
  f.service.close()
  const restarted = new WatcherService({ ordinaryBatch: SHORT_BATCH, directory: f.root, control: f.control, host: f.workspace.host,
    historyEnabled: () => true })
  cleanups.push(async () => restarted.close())
  await restarted.recover(); await restarted.wakes.drained()
  expect(queued(f).find(item => item.id === waiting.id) && waitingNews(f)).toBe(news)
  restarted.pullRequestObserved({ ...read, observedAt: new Date().toISOString() }); await restarted.wakes.drained()
  expect(queued(f).find(item => item.id === waiting.id) && waitingNews(f)).toBe(news)
  expect(f.control.watcherRecord().wakeEventIds).toEqual(ids)
  expect(f.workspace.adapters.codex.commands.filter(command => command.type === 'answer')).toHaveLength(0)
})

// #1189: Watcher's state, kept through compaction, and compacting its conversation when it grows.
it('keeps the decisions, rules and issues Watcher gives, list by list, and reads them back with what each watched thread waits on', async () => {
  const f = await fixture()
  const started = await f.call('start_thread', f.start())
  if (started.status !== 'ok' || !('target' in started)) throw new Error('start refused')
  expect(await f.call('keep_state', { decisions: ['Merge #1186 once CI is green?'], rules: ['Full test suites run in CI, not on the laptop.'] }))
    .toMatchObject({ status: 'ok', kept: { decisions: ['Merge #1186 once CI is green?'], rules: ['Full test suites run in CI, not on the laptop.'], issues: [] } })
  // A list left out stays as it was.
  await f.call('keep_state', { issues: ['#1189 Watcher: auto-compact its conversation'] })
  const read = await f.call('read_state', {})
  expect(read).toMatchObject({ status: 'ok', compactAtTokens: 400_000, kept: { decisions: ['Merge #1186 once CI is green?'],
    rules: ['Full test suites run in CI, not on the laptop.'], issues: ['#1189 Watcher: auto-compact its conversation'] } })
  if (read.status !== 'ok' || !('watching' in read)) throw new Error('read refused')
  expect(read.watching).toContainEqual(expect.objectContaining({ target: started.target, waitsOn: expect.any(String) }))
  expect(f.service.state().state?.kept.rules).toEqual(['Full test suites run in CI, not on the laptop.'])
  // With Keep local history on, the kept words are saved beside the control record.
  expect(await readFile(join(f.root, 'watcher-state.json'), 'utf8')).toContain('Full test suites run in CI')
})

it('says a watched thread waits on the card of a thread it delegated to, as list_threads does', async () => {
  const f = await fixture()
  const started = await f.call('start_thread', f.start())
  if (started.status !== 'ok' || !('target' in started)) throw new Error('start refused')
  const real = f.control.watcherSnapshot.bind(f.control)
  vi.spyOn(f.control, 'watcherSnapshot').mockImplementation(() => {
    const snapshot = real(), parent = snapshot.threads.find(thread => thread.id === started.target.threadId)!
    return { ...snapshot, threads: [...snapshot.threads, { ...structuredClone(parent), id: 'synthetic-delegated', title: 'Delegated', delegatedBy: parent.id, status: 'idle',
      requests: [{ id: 'card', kind: 'permission', text: 'synthetic private command', options: [] }] }] }
  })
  const read = await f.call('read_state', {})
  if (read.status !== 'ok' || !('watching' in read)) throw new Error('read refused')
  expect(read.watching).toContainEqual(expect.objectContaining({ target: started.target, waitsOn: 'The user’s answer to a permission request in a thread it delegated to.' }))
  expect(JSON.stringify(read)).not.toContain('synthetic private command')
})

// #1274: read_state works out what changes from live data, and flags kept notes that name what is over.
it('gives the merge queue and each watched thread’s open pull requests from live data, and flags kept notes that name what is over', async () => {
  const f = await fixture()
  const first = await f.call('start_thread', f.start()), second = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first) || second.status !== 'ok' || !('target' in second)) throw new Error('start refused')
  // A thread the user put aside, under a title of its own.
  const aside = randomUUID()
  expect((await f.control.commandShell({ type: 'create-thread', threadId: aside, projectId: f.project.id, modelId: f.model.id,
    title: 'Synthetic release notes', runtimeMode: 'approval-required', workingCopy: 'shared' })).error).toBeNull()
  const pr = (number: number, state: 'open' | 'merged', draft = false) => ({ url: `https://github.com/synthetic/project/pull/${number}`, number,
    title: 'Synthetic pull request', state, draft, source: 'linked' as const, linkedAt: new Date().toISOString() })
  const link = (threadId: string, links: ReturnType<typeof pr>[]) => {
    const record = (f.workspace.host as unknown as { state: { snapshot: { threads: { id: string; pullRequests?: typeof links }[] } } }).state.snapshot
    record.threads.find(thread => thread.id === threadId)!.pullRequests = structuredClone(links)
    showLinks(f, threadId, links)
  }
  link(first.target.threadId, [pr(5, 'open'), pr(6, 'open', true)])
  link(second.target.threadId, [pr(7, 'open')])
  link(aside, [pr(4, 'merged')])
  const passed = (number: number, observedAt: string) => f.service.pullRequestObserved({ url: `https://github.com/synthetic/project/pull/${number}`,
    head: `synthetic-head-${number}`, observedAt, availability: 'available', checks: 'passed', checkCount: 1, state: 'open' })
  passed(7, '2026-10-21T10:00:00.000Z'); passed(5, '2026-10-21T10:05:00.000Z'); passed(6, '2026-10-21T09:00:00.000Z')
  await f.call('keep_state', { decisions: ['Merge #4 once CI is green?', 'Merge #5 after #7?'], rules: ['Leave Synthetic release notes to the user.'] })
  const read = watcherToolSchemas.read_state.output.parse(await f.call('read_state', {}))
  if (read.status !== 'ok') throw new Error('read refused')
  // The draft passed first but is not queued; the rest go in the order their checks passed.
  expect(read.mergeQueue.map(item => [item.target.threadId, item.pullRequest.number])).toEqual([[second.target.threadId, 7], [first.target.threadId, 5]])
  // Watcher's picture reads the same queue, worked out without building the room (#1339).
  expect(f.service.readMergeTurns()).toEqual({ status: 'ok', queue: read.mergeQueue, turns: [] })
  expect(read.watching.find(row => row.target.threadId === first.target.threadId)?.pullRequests).toEqual([
    expect.objectContaining({ number: 5, state: 'open', checks: 'passed' }), expect.objectContaining({ number: 6, state: 'open', checks: 'passed' })])
  expect(read.staleNotes).toEqual([
    { list: 'decisions', index: 0, reasons: ['Names pull request #4, which is merged.'] },
    { list: 'rules', index: 0, reasons: ['Names the thread “Synthetic release notes”, which Watcher does not watch.'] },
  ])
  // This fixture has no Settle finished threads, so nothing is pending and read_state says why.
  expect(read).toMatchObject({ settlesFinishedThreads: false, pendingSettles: [] })
  // The kept words are as Watcher gave them: the flags sit beside them and change nothing kept.
  expect(read.kept.decisions).toEqual(['Merge #4 once CI is green?', 'Merge #5 after #7?'])
})

it('pages the merge queue with the watched threads, a hundred to a page, leaving none out', async () => {
  const f = await fixture(), targets: string[] = []
  for (let at = 0; at < 6; at++) {
    const started = await f.call('start_thread', f.start())
    if (started.status !== 'ok' || !('target' in started)) throw new Error('start refused')
    targets.push(started.target.threadId)
  }
  const record = (f.workspace.host as unknown as { state: { snapshot: { threads: { id: string; pullRequests?: unknown[] }[] } } }).state.snapshot
  targets.forEach((threadId, at) => {
    const links = Array.from({ length: 20 }, (_, index) => ({ url: `https://github.com/synthetic/project/pull/${at * 20 + index + 1}`, number: at * 20 + index + 1,
      title: 'Synthetic pull request', state: 'open' as const, draft: false, source: 'linked' as const, linkedAt: new Date().toISOString() }))
    record.threads.find(thread => thread.id === threadId)!.pullRequests = structuredClone(links)
    showLinks(f, threadId, links)
  })
  for (let number = 1; number <= 120; number++) f.service.pullRequestObserved({ url: `https://github.com/synthetic/project/pull/${number}`, head: `synthetic-head-${number}`,
    observedAt: new Date(Date.now() + number * 1_000).toISOString(), availability: 'available', checks: 'passed', checkCount: 1, state: 'open' })
  const first = watcherToolSchemas.read_state.output.parse(await f.call('read_state', {}))
  if (first.status !== 'ok' || first.nextCursor === null) throw new Error('expected a second page')
  const second = watcherToolSchemas.read_state.output.parse(await f.call('read_state', { cursor: first.nextCursor }))
  if (second.status !== 'ok') throw new Error('read refused')
  expect(second.nextCursor).toBeNull()
  expect([...first.mergeQueue, ...second.mergeQueue].map(item => item.pullRequest.number)).toEqual(Array.from({ length: 120 }, (_, index) => index + 1))
  expect(first.mergeQueue).toHaveLength(100)
})

it('saves none of Watcher’s kept words with Keep local history off', async () => {
  const f = await fixture(false)
  await f.call('keep_state', { rules: ['synthetic_private_rule_51c2'] })
  expect(await f.call('read_state', {})).toMatchObject({ kept: { rules: ['synthetic_private_rule_51c2'] } })
  const saved = await readFile(join(f.root, 'watcher-state.json'), 'utf8').catch(() => '')
  expect(saved).not.toContain('synthetic_private_rule_51c2')
})

it('compacts Watcher once its conversation passes 400K tokens while it rests, and tells it to read its state after', async () => {
  const f = await fixture()
  const real = f.control.watcherSnapshot.bind(f.control)
  let watcher: Partial<AgentThread> = { status: 'idle', requests: [], lastTurn: { id: 'synthetic-turn-1', status: 'completed' },
    usage: { contextUsed: 400_000, contextUpdatedAt: '2026-10-19T10:00:00.000Z', rateVersions: [], partial: false, updatedAt: '2026-10-19T10:00:00.000Z' } }
  vi.spyOn(f.control, 'watcherSnapshot').mockImplementation(() => {
    const snapshot = real()
    return { ...snapshot, capabilities: { ...snapshot.capabilities, compact: true },
      ...snapshot.providers ? { providers: snapshot.providers.map(provider => ({ ...provider, capabilities: { ...provider.capabilities, compact: true } })) } : {},
      threads: snapshot.threads.map(thread => thread.id === f.id ? { ...thread, ...watcher } : thread) }
  })
  vi.spyOn(f.control, 'hasPendingThreadWork').mockReturnValue(false)
  vi.spyOn(f.control, 'watcherWakeUpQueued').mockReturnValue(false)
  const command = vi.spyOn(f.control, 'command').mockResolvedValue(f.control.shell())
  const nudge = () => f.control.commandShell({ type: 'refresh', provider: 'codex' })
  // Sotto sends Watcher a message, here a wake-up, which starts its next turn.
  const sent = () => f.service.beforeDispatch({ type: 'send', commandId: randomUUID(), threadId: f.id, messageId: randomUUID(), text: 'synthetic news', wakeUp: true }, undefined)
  await nudge()
  // At the point, not past it.
  expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'compact-thread' }))
  expect(f.service.state().context).toMatchObject({ tokens: 400_000, compactAt: 400_000, canCompact: true, compacting: false })
  // Past the point, but Watcher's turn is running: it waits for Watcher to rest.
  watcher = { ...watcher, status: 'running', usage: { ...watcher.usage!, contextUsed: 412_000, contextUpdatedAt: '2026-10-19T10:01:00.000Z' } }
  await nudge()
  expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'compact-thread' }))
  watcher = { ...watcher, status: 'idle' }
  await nudge(); await nudge()
  expect(command.mock.calls.filter(([sent]) => sent.type === 'compact-thread')).toEqual([[{ type: 'compact-thread', threadId: f.id }]])
  expect(f.service.stateNote()).toBeUndefined()
  // The compaction finished: the next turn's note says to read the state back, until Watcher does.
  watcher = { ...watcher, compaction: { commandId: 'synthetic-compaction', status: 'completed' }, usage: { ...watcher.usage!, contextUsed: 31_000, contextUpdatedAt: '2026-10-19T10:02:00.000Z' } }
  await nudge()
  expect(f.service.stateNote()).toContain('call read_state')
  await f.call('read_state', {})
  expect(f.service.stateNote()).toBeUndefined()
  // A reading after the compaction that still says past the point, before Watcher's next turn reports, compacts nothing again.
  watcher = { ...watcher, usage: { ...watcher.usage!, contextUsed: 405_000, contextUpdatedAt: '2026-10-19T10:03:00.000Z' } }
  await nudge(); await nudge()
  expect(command.mock.calls.filter(([sent]) => sent.type === 'compact-thread')).toHaveLength(1)
  // Watcher's next turn still past it: one more try.
  sent()
  watcher = { ...watcher, lastTurn: { id: 'synthetic-turn-2', status: 'completed' }, usage: { ...watcher.usage!, contextUsed: 406_000, contextUpdatedAt: '2026-10-19T10:04:00.000Z' } }
  await nudge(); await nudge()
  expect(command.mock.calls.filter(([sent]) => sent.type === 'compact-thread')).toHaveLength(2)
  // It fails, and the provider reported the compaction as a turn of its own, as Codex does, or reports that turn only
  // after the compaction finished, as Claude Code does: no try until Sotto sends Watcher its next message.
  watcher = { ...watcher, compaction: { commandId: 'synthetic-compaction-2', status: 'failed' }, usage: { ...watcher.usage!, contextUpdatedAt: '2026-10-19T10:05:00.000Z' } }
  await nudge()
  watcher = { ...watcher, lastTurn: { id: 'synthetic-compaction-turn', status: 'failed' }, usage: { ...watcher.usage!, contextUpdatedAt: '2026-10-19T10:05:30.000Z' } }
  await nudge(); await nudge()
  expect(command.mock.calls.filter(([sent]) => sent.type === 'compact-thread')).toHaveLength(2)
  sent()
  watcher = { ...watcher, lastTurn: { id: 'synthetic-turn-3', status: 'completed' }, usage: { ...watcher.usage!, contextUpdatedAt: '2026-10-19T10:06:00.000Z' } }
  await nudge(); await nudge()
  expect(command.mock.calls.filter(([sent]) => sent.type === 'compact-thread')).toHaveLength(3)
})

it('tells Watcher to read its state after its context drops by more than half, as when Muse compacts', async () => {
  const f = await fixture()
  const real = f.control.watcherSnapshot.bind(f.control)
  let tokens = 300_000
  vi.spyOn(f.control, 'watcherSnapshot').mockImplementation(() => {
    const snapshot = real()
    return { ...snapshot, threads: snapshot.threads.map(thread => thread.id === f.id ? { ...thread, usage: { contextUsed: tokens, contextUpdatedAt: `2026-10-19T10:00:0${tokens > 200_000 ? 0 : 1}.000Z`,
      rateVersions: [], partial: false, updatedAt: '2026-10-19T10:00:00.000Z' } } : thread) }
  })
  await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  expect(f.service.stateNote()).toBeUndefined()
  tokens = 40_000
  await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  expect(f.service.stateNote()).toContain('call read_state')
})

it.each([true, false])('takes a smaller context on another model for another conversation’s size, not a compaction (reading names its model: %s)', async named => {
  const f = await fixture()
  const real = f.control.watcherSnapshot.bind(f.control)
  let reading: { tokens: number; modelId: string; at: string | undefined } = { tokens: 300_000, modelId: 'synthetic-model-a', at: '2026-10-19T10:00:00.000Z' }
  vi.spyOn(f.control, 'watcherSnapshot').mockImplementation(() => {
    const snapshot = real()
    return { ...snapshot, threads: snapshot.threads.map(thread => thread.id === f.id ? { ...thread, modelId: reading.modelId, usage: { contextUsed: reading.tokens,
      ...named ? { modelId: reading.modelId } : {}, ...reading.at ? { contextUpdatedAt: reading.at } : {}, rateVersions: [], partial: false, updatedAt: '2026-10-19T10:00:00.000Z' } } : thread) }
  })
  const nudge = () => f.control.commandShell({ type: 'refresh', provider: 'codex' })
  await nudge()
  // The model changes before its first reading comes. A token update that keeps the old size and drops its time, as
  // Muse's does, is not the new model's either. Then the new model's own reading is far smaller.
  reading = { ...reading, modelId: 'synthetic-model-b' }
  await nudge()
  reading = { ...reading, at: undefined }
  await nudge()
  reading = { ...reading, tokens: 40_000, at: '2026-10-19T10:01:00.000Z' }
  await nudge()
  expect(f.service.stateNote()).toBeUndefined()
  // A drop on the new model is still a compaction.
  reading = { ...reading, tokens: 120_000, at: '2026-10-19T10:02:00.000Z' }
  await nudge()
  reading = { ...reading, tokens: 30_000, at: '2026-10-19T10:03:00.000Z' }
  await nudge()
  expect(f.service.stateNote()).toContain('call read_state')
})

it('asks Watcher to read its state after any Compact context for its conversation, whatever the provider reports', async () => {
  const f = await fixture()
  expect(f.service.stateNote()).toBeUndefined()
  // Asked for, it owes nothing yet: control may still refuse it.
  f.service.userCommand({ type: 'compact-thread', threadId: f.id }, f.id, false)
  expect(f.service.stateNote()).toBeUndefined()
  f.service.beforeDispatch({ type: 'compact-thread', commandId: randomUUID(), threadId: f.id }, undefined)
  expect(f.service.stateNote()).toContain('call read_state')
  // A refused read, as for an expired cursor, has not read the state back, so the reminder stays.
  expect(await f.call('read_state', { cursor: `${randomUUID()}:100` })).toMatchObject({ status: 'refused', code: 'CURSOR_EXPIRED' })
  expect(f.service.stateNote()).toContain('call read_state')
  await f.call('read_state', {})
  expect(f.service.stateNote()).toBeUndefined()
})

it('remembers a send that gives a thread its merge turn for the picture alone, and sends it as any other (#1339)', async () => {
  const f = await fixture(), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start refused')
  await f.finish(first.target.threadId)
  expect(f.service.readMergeTurns()).toEqual({ status: 'ok', queue: [], turns: [] })
  const input = { requestId: f.requestId, retryKey: randomUUID(), target: first.target, delivery: 'now' as const, text: 'Synthetic GO MERGE #1291' }
  const sent = await f.call('send_to_thread', { ...input, mergeTurn: { pullRequest: 1291 } })
  if (sent.status !== 'ok' || !('receipt' in sent)) throw new Error('send refused')
  // The send went as it would have unmarked: the same words, and the record keeps no new key, so an older build reads it.
  await vi.waitFor(() => expect(f.workspace.adapters.codex.commands.some(item => item.type === 'send' && item.text.startsWith('Synthetic GO MERGE #1291'))).toBe(true))
  const operation = f.service.state().receipts.find(item => item.id === sent.receipt.operationId)!
  expect(Object.keys(operation)).not.toContain('mergeTurn')
  expect(watcherRecordSchema.safeParse(f.control.watcherRecord()).success).toBe(true)
  // A retry of the same call without the mark reads the same receipt: the mark is not part of what the send is.
  expect(await f.call('send_to_thread', input)).toMatchObject({ status: 'ok', receipt: { operationId: sent.receipt.operationId } })
  expect(f.service.readMergeTurns()).toMatchObject({ status: 'ok', turns: [{ operationId: sent.receipt.operationId, target: first.target, pullRequest: 1291 }] })
  // A plain send is no merge turn.
  const plain = await f.call('send_to_thread', { ...input, retryKey: randomUUID(), delivery: 'queue', text: 'Synthetic check-in' })
  expect(plain).toMatchObject({ status: 'ok' })
  expect(f.service.readMergeTurns()).toMatchObject({ turns: [{ pullRequest: 1291 }] })
  expect((f.service.readMergeTurns() as { turns: unknown[] }).turns).toHaveLength(1)
})
