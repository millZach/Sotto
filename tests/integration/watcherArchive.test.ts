// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { open, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { WatcherService } from '../../src/main/agents/watcher'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import { watcherRecordSchema, watcherToolSchemas } from '../../src/shared/watcher'
import { joinedReceipts, liveReceipts, recalledConversation } from '../../src/renderer/src/watcher/watcherConversationWork'
import { WATCHER_ARCHIVE_FILE, WATCHER_LIVE_CLOSED_REQUESTS, WatcherArchive } from '../../src/main/agents/watcherArchive'
import { addWatcherHistory } from '../fixtures/ownerScale'
import { WatcherLaunchProfiles } from '../../src/main/agents/watcherLaunchProfiles'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { workspaceFixture } from '../fixtures/workspaceFixture'

// Watcher's archive (#1759) changes nothing Watcher does: a read of an archived operation, a retry of archived work and a
// new call under an archived request answer exactly as they did while the live record held them.
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** A result without the times it was read at, which move between two reads of the same thing. */
const steady = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (name, item: unknown) => name === 'observedAt' ? undefined : item))

it('answers reads, retries and new calls on archived work as it did before the work was archived', async () => {
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
  expect(await service.open({ provider: 'codex', modelId: model.id })).toMatchObject({ status: 'ok' })
  const watcherId = service.state().current!.target.threadId
  expect((await f.control.commandShell({ type: 'manual-send', threadId: watcherId, draftId: randomUUID(), text: 'Synthetic Watcher user request' })).error).toBeNull()
  const requestId = service.state().requests.at(-1)!.id
  const call = async <N extends keyof typeof watcherToolSchemas>(name: N, input: unknown) =>
    watcherToolSchemas[name].output.parse((await tools.call(watcherId, name, input)).structuredContent)
  const project = f.control.shell().host.projects.find(item => item.providerId === 'codex')!
  const start = { requestId, retryKey: randomUUID(), project: { hostId: f.control.hostId()!, projectId: project.id },
    modelId: model.id, title: 'Synthetic worker', workingCopy: { kind: 'shared' }, firstPrompt: 'Synthetic first prompt' }
  const started = await call('start_thread', start)
  if (started.status !== 'ok' || !('target' in started)) throw new Error('The start was refused.')
  const send = { requestId, retryKey: randomUUID(), target: started.target, text: 'Synthetic follow-up', delivery: 'queue' }
  const sent = await call('send_to_thread', send)
  expect(sent).toMatchObject({ status: 'ok' })
  const operations = service.state().receipts.filter(item => item.requestId === requestId).map(item => item.id)
  expect(operations).toHaveLength(2)
  // The request's turn is over: its work is closed, as archived work always is.
  await f.control.updateWatcher(record => { const request = record.requests.find(item => item.id === requestId)!; request.state = 'closed'; request.closedAt = new Date().toISOString()
    // A closed request holds no reservation once its threads no longer need one.
    record.reservations = record.reservations.filter(item => item.requestId !== requestId) })
  const turnId = f.control.watcherRecordView().operations.find(item => item.id === operations[0])!.promptTurnId!
  const laterId = randomUUID(), laterOperation = randomUUID(), at = new Date().toISOString()
  await f.control.updateWatcher(record => {
    record.requests.push({ id: laterId, watcher: record.current!.target, rootUserMessageId: `synthetic-later-${laterId}`, state: 'closed', createdAt: at, closedAt: at,
      participants: [{ target: started.target, requestId: laterId, startedBy: 'watcher', generation: 0, state: 'relinquished', promptCount: 1 }] })
    record.operations.push({ id: laterOperation, requestId: laterId, retryKey: randomUUID(), digest: 'a'.repeat(64), promptTurnId: turnId, action: 'send', target: started.target,
      generation: 0, deliveryState: 'accepted', createdAt: at, updatedAt: at, receiptId: `receipt-${laterOperation}`, cardId: `card-${laterOperation}`, outcome: 'answered', outcomeAt: at })
  })

  // The window shows Watcher's conversation, as its open pane does.
  await f.control.command({ type: 'observe-threads', threadIds: [watcherId] })
  await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  await expect.poll(() => f.control.watcherSnapshot().threads.find(item => item.id === watcherId)?.messages.length ?? 0).toBeGreaterThan(0)
  // What the window shows of Watcher's work, joined as its pane joins it: each receipt card under its message of
  // Watcher's conversation, the room's own and what the conversation shown back recalled. The room carries the request
  // in its own list or in what was recalled.
  const cards = () => {
    const state = service.state(), own = liveReceipts(state.receipts, state.receiptReplies)
    const shown = joinedReceipts(own.byMessage, own.operations, recalledConversation(state.recalled, state.current?.target))
    return (f.control.watcherSnapshot().threads.find(item => item.id === watcherId)?.messages ?? [])
      .flatMap(message => (shown.get(message.id) ?? []).map(operation => ({ messageId: message.id, operation })))
  }
  const requestsHeld = () => { const state = service.state(); return [...state.recalled?.requests ?? [], ...state.requests].filter(item => item.id === requestId) }
  const room = () => steady({ cards: cards().filter(item => item.operation.requestId === requestId), requests: requestsHeld() })
  const shown = room()
  expect(shown).toMatchObject({ cards: { length: 2 }, requests: { length: 1 } })
  const asked = async () => steady({
    reads: await Promise.all([...operations, laterOperation].map(operationId => call('read_operation', { operationId }))),
    startRetry: await call('start_thread', start),
    sendRetry: await call('send_to_thread', send),
    conflict: await call('send_to_thread', { ...send, text: 'Another follow-up' }),
    newCall: await call('send_to_thread', { ...send, retryKey: randomUUID() }),
    started: service.startedByWatcher(started.target.hostId, started.target.threadId),
  })
  const before = await asked()
  expect(before).toMatchObject({ startRetry: { status: 'ok' }, sendRetry: { status: 'ok' }, conflict: { status: 'refused', code: 'RETRY_KEY_CONFLICT' },
    newCall: { status: 'refused', code: 'REQUEST_NOT_ACTIVE' }, started: true })
  // The later send counts the two archived ones of its turn: three prompts to that thread in the turn.
  expect((before as { reads: { limits: { promptCount: number } }[] }).reads[2]!.limits.promptCount).toBe(3)

  expect(await f.control.archiveWatcherWork([requestId], () => [requestId])).toBe(1)
  expect(f.control.watcherRecordView().requests.some(item => item.id === requestId)).toBe(false)
  {
    // As Sotto starts: the archive's index is still being read when Watcher reads the later operation, whose turn has two
    // archived prompts. The read waits for the index rather than count one.
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const prototype = WatcherArchive.prototype as unknown as { load(): Promise<void> }, load = prototype.load
    const loading = vi.spyOn(prototype, 'load').mockImplementation(async function (this: WatcherArchive) { await gate; return load.call(this) })
    const starting = new WatcherArchive(f.root, () => true)
    loading.mockRestore()
    const archived = f.control.archivedWatcherWork()
    Object.assign(f.control, { watcherArchive: starting })
    const reading = call('read_operation', { operationId: laterOperation })
    await new Promise(resolve => setTimeout(resolve, 50))
    release()
    expect(await reading).toMatchObject({ status: 'ok', limits: { promptCount: 3 } })
    Object.assign(f.control, { watcherArchive: archived })
  }
  expect(f.control.watcherRecordView().operations.some(item => operations.includes(item.id))).toBe(false)
  expect(await asked()).toEqual(before)
  // Archived, the room no longer carries the work until the conversation is shown back to it; once Watcher's
  // conversation is read that far back, its cards come back under the same messages.
  expect(room()).toMatchObject({ cards: [], requests: [] })
  f.control.threadDetail(watcherId)
  await expect.poll(async () => { await f.control.watcherArchiveSettled(); return room() }).toEqual(shown)
  // Archiving more while that conversation stays shown back brings the newly archived card back too.
  const laterCard = () => steady(cards().filter(item => item.operation.id === laterOperation))
  const laterShown = laterCard()
  expect(laterShown).toMatchObject({ length: 1 })
  expect(await f.control.archiveWatcherWork([laterId], () => [laterId])).toBe(1)
  f.control.threadDetail(watcherId)
  await expect.poll(async () => { await f.control.watcherArchiveSettled(); f.control.threadDetail(watcherId); return laterCard() }).toEqual(laterShown)
  // A thread an archived start made is still one Watcher started: a new request's send to it records it so, and Stop all
  // still counts it.
  const nextId = randomUUID()
  await f.control.updateWatcher(record => { record.requests.push({ id: nextId, watcher: record.current!.target, rootUserMessageId: `synthetic-next-${nextId}`, state: 'active',
    createdAt: new Date().toISOString(), closedAt: null, participants: [] }) })
  const nextSend = await call('send_to_thread', { requestId: nextId, retryKey: randomUUID(), target: started.target, text: 'Synthetic next follow-up', delivery: 'queue' })
  // Its head is Watcher's own archived send, not the user's, so the watch is not paused and the send goes.
  expect(nextSend).toMatchObject({ status: 'ok' })
  expect(f.control.watcherRecordView().requests.find(item => item.id === nextId)!.participants.find(item => item.target.threadId === started.target.threadId)?.startedBy).toBe('watcher')
  // Nothing was made again: the request still has its two operations, all archived, and the live record none of them.
  expect((await f.control.archivedWatcherWork()!.read({ requests: [requestId] })).operations.filter(item => item.requestId === requestId).map(item => item.id)).toEqual(operations)
  expect(f.control.watcherRecordView().operations.some(item => item.requestId === requestId)).toBe(false)
  // An archive whose batch cannot be read refuses the retry, rather than take the work for never done and run it again.
  const handle = await open(join(f.root, WATCHER_ARCHIVE_FILE), 'r+')
  await handle.truncate(10); await handle.close()
  expect(await call('send_to_thread', send)).toMatchObject({ status: 'refused', code: 'HISTORY_UNAVAILABLE' })
  expect(await call('read_operation', { operationId: operations[0] })).toMatchObject({ status: 'refused', code: 'HISTORY_UNAVAILABLE' })
})

it('archives a long record after an upgrade without holding Sotto up, keeping it valid and the newest closed work live', async () => {
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
  expect(await service.open({ provider: 'codex', modelId: model.id })).toMatchObject({ status: 'ok' })
  const targets = ['synthetic-worker', 'synthetic-other'].map(threadId => ({ hostId: f.control.hostId()!, threadId }))
  // The owner's record on October 28, 2026: 1,255 requests and 1,126 operations.
  await f.control.updateWatcher(record => addWatcherHistory(record, targets, { requests: 1_255, operations: 1_126 }))
  const before = Buffer.byteLength(JSON.stringify(f.control.watcherRecordView()))
  const started = performance.now()
  await service.archiveSettled()
  const took = performance.now() - started
  const record = f.control.watcherRecordView()
  expect(() => watcherRecordSchema.parse(record)).not.toThrow()
  expect(record.requests.filter(item => item.state !== 'active')).toHaveLength(WATCHER_LIVE_CLOSED_REQUESTS)
  const after = Buffer.byteLength(JSON.stringify(record))
  const saved = JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')) as { watcher: { requests: unknown[] } }
  expect(saved.watcher.requests).toHaveLength(WATCHER_LIVE_CLOSED_REQUESTS)
  if (process.env.SOTTO_PERF_BENCH === '1') console.log(`Watcher's archive migration: ${before} bytes to ${after}, ${Math.round(took)} ms`)
  expect(after).toBeLessThan(before / 4)
})

it('releases from the record only what the archive still holds when Keep local history goes off part-way through archiving', async () => {
  const workspace = await workspaceFixture(undefined, { history: true })
  cleanups.push(workspace.remove)
  let history = true
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host,
    credentialOptions: { mode: 'unavailable' }, control: { historyEnabled: () => history, watcherEnabled: true } })
  const service = new WatcherService({ directory: f.root, host: workspace.host, control: f.control, historyEnabled: () => history })
  const tools = new WatcherToolServer(service)
  workspace.host.useWatcherTools(tools)
  cleanups.push(async () => { service.close(); await tools.close(); f.control.dispose(); await f.control.closed(); await workspace.stop() })
  await f.control.start()
  await f.control.commandShell({ type: 'connect', provider: 'codex' })
  await service.recover()
  const model = f.control.shell().host.models.find(item => item.providerId === 'codex')!
  expect(await service.open({ provider: 'codex', modelId: model.id })).toMatchObject({ status: 'ok' })
  const targets = ['synthetic-worker', 'synthetic-other'].map(threadId => ({ hostId: f.control.hostId()!, threadId }))
  // Watcher's own archiving is held off, so this test's is the only one (#1780): the history below is due for it, and its
  // batches would reach the spy and race the test's own.
  vi.spyOn(service as unknown as { archiveWhenDue(): void }, 'archiveWhenDue').mockImplementation(() => undefined)
  await f.control.updateWatcher(record => addWatcherHistory(record, targets, { requests: WATCHER_LIVE_CLOSED_REQUESTS + 100, operations: WATCHER_LIVE_CLOSED_REQUESTS + 100 }))
  const ids = f.control.watcherRecordView().requests.slice(0, 100).map(item => item.id)
  const archive = f.control.archivedWatcherWork()!
  const append = archive.append.bind(archive)
  let batches = 0
  vi.spyOn(archive, 'append').mockImplementation(async work => {
    await append(work)
    if (++batches === 1) { history = false; await archive.privacyChanged() }
  })
  expect(await f.control.archiveWatcherWork(ids, () => ids)).toBe(100)
  expect(batches).toBe(2)
  const live = new Set(f.control.watcherRecordView().requests.map(item => item.id))
  for (const id of ids.filter(item => !live.has(item))) expect.soft(archive.holds(id), id).toBe(true)
  expect((await archive.read({ requests: [ids[0]!] })).requests.map(item => item.id)).toContain(ids[0])
})

it('archives a request again as it now stands when it changed after an earlier archiving, before the record lets go of it', async () => {
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
  expect(await service.open({ provider: 'codex', modelId: model.id })).toMatchObject({ status: 'ok' })
  const targets = ['synthetic-worker', 'synthetic-other'].map(threadId => ({ hostId: f.control.hostId()!, threadId }))
  await f.control.updateWatcher(record => addWatcherHistory(record, targets, { requests: WATCHER_LIVE_CLOSED_REQUESTS + 60, operations: WATCHER_LIVE_CLOSED_REQUESTS + 60 }))
  const id = f.control.watcherRecordView().requests[0]!.id
  const archive = f.control.archivedWatcherWork()!
  const append = archive.append.bind(archive)
  let first = true
  // While the first archiving writes it, the user takes the request's thread over; that archiving keeps it live.
  vi.spyOn(archive, 'append').mockImplementation(async work => {
    await append(work)
    if (!first) return
    first = false
    await f.control.updateWatcher(record => {
      const participant = record.requests.find(item => item.id === id)!.participants[0]!
      participant.state = 'taken-over'; participant.takeover = { reason: 'user-send', at: new Date().toISOString() }
    })
  })
  expect(await f.control.archiveWatcherWork([id], () => [])).toBe(0)
  // Later it may go: it goes as it now stands, takeover and all.
  expect(await f.control.archiveWatcherWork([id], () => [id])).toBe(1)
  const archived = (await archive.read({ requests: [id] })).requests.find(item => item.id === id)!
  expect(archived.participants[0]).toMatchObject({ state: 'taken-over', takeover: { reason: 'user-send' } })
  expect(await archive.recall({ threadId: f.control.watcherRecordView().current!.target.threadId, ids: new Set([archived.rootUserMessageId]), from: archived.createdAt }))
    .toMatchObject({ requests: [{ id, participants: [{ state: 'taken-over' }, {}] }] })
})

it('archives nothing and keeps the record whole where Watcher is off', async () => {
  const workspace = await workspaceFixture(undefined, { history: true })
  cleanups.push(workspace.remove)
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host,
    credentialOptions: { mode: 'unavailable' }, control: { historyEnabled: () => true, watcherEnabled: false } })
  cleanups.push(async () => { f.control.dispose(); await f.control.closed(); await workspace.stop() })
  await f.control.start()
  const hostId = f.control.hostId() ?? randomUUID()
  f.control.mutateWatcher(record => addWatcherHistory(record, [{ hostId, threadId: 'synthetic-worker' }, { hostId, threadId: 'synthetic-other' }], { requests: 400, operations: 400 }, { hostId, threadId: 'earlier-watcher' }))
  expect(await f.control.archiveWatcherWork(f.control.watcherRecordView().requests.slice(0, 100).map(item => item.id), () => [])).toBe(0)
  f.control.dispose(); await f.control.closed()
  const saved = JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')) as { watcher: { requests: unknown[] } }
  expect(saved.watcher.requests).toHaveLength(400)
  expect(await readdir(f.root)).not.toContain(WATCHER_ARCHIVE_FILE)
})

it("reads no more of agents.json for Watcher's identity check however much closed work Watcher has archived", async () => {
  /** The bytes the identity check parses after a save, once Watcher has done `requests` requests of work. */
  const checked = async (requests: number): Promise<number> => {
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
    expect(await service.open({ provider: 'codex', modelId: model.id })).toMatchObject({ status: 'ok' })
    const targets = ['synthetic-worker', 'synthetic-other'].map(threadId => ({ hostId: f.control.hostId()!, threadId }))
    await f.control.updateWatcher(record => addWatcherHistory(record, targets, { requests, operations: requests }))
    await service.archiveSettled()
    const profiles = new WatcherLaunchProfiles(f.root, () => f.control.hostId(), () => undefined, true)
    expect(await profiles.retainedThreadIds()).toContain(service.state().current!.target.threadId)
    return Buffer.byteLength(await readFile(join(f.root, 'agents.json'), 'utf8'))
  }
  const few = await checked(WATCHER_LIVE_CLOSED_REQUESTS + 50), many = await checked(WATCHER_LIVE_CLOSED_REQUESTS + 2_000)
  expect(many).toBeLessThan(few * 1.05)
}, 120_000)
