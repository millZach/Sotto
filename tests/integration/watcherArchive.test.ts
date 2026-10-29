// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { WatcherService } from '../../src/main/agents/watcher'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import { watcherRecordSchema, watcherToolSchemas } from '../../src/shared/watcher'
import { WATCHER_ARCHIVE_FILE, WATCHER_LIVE_CLOSED_REQUESTS } from '../../src/main/agents/watcherArchive'
import { addWatcherHistory } from '../fixtures/ownerScale'
import { WatcherLaunchProfiles } from '../../src/main/agents/watcherLaunchProfiles'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { workspaceFixture } from '../fixtures/workspaceFixture'

// Watcher's archive (#1759) changes nothing Watcher does: a read of an archived operation, a retry of archived work and a
// new call under an archived request answer exactly as they did while the live record held them.
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

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

  // The window shows Watcher's conversation, as its open pane does.
  await f.control.command({ type: 'observe-threads', threadIds: [watcherId] })
  await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  await expect.poll(() => f.control.watcherSnapshot().threads.find(item => item.id === watcherId)?.messages.length ?? 0).toBeGreaterThan(0)
  const room = () => steady({ receipts: service.state().receipts.filter(item => item.requestId === requestId),
    replies: (service.state().receiptReplies ?? []).filter(item => operations.includes(item.operationId)),
    requests: service.state().requests.filter(item => item.id === requestId) })
  const shown = room()
  expect(shown).toMatchObject({ receipts: { length: 2 }, replies: { length: 2 }, requests: { length: 1 } })
  const asked = async () => steady({
    reads: await Promise.all(operations.map(operationId => call('read_operation', { operationId }))),
    startRetry: await call('start_thread', start),
    sendRetry: await call('send_to_thread', send),
    conflict: await call('send_to_thread', { ...send, text: 'Another follow-up' }),
    newCall: await call('send_to_thread', { ...send, retryKey: randomUUID() }),
    started: service.startedByWatcher(started.target.hostId, started.target.threadId),
  })
  const before = await asked()
  expect(before).toMatchObject({ startRetry: { status: 'ok' }, sendRetry: { status: 'ok' }, conflict: { status: 'refused', code: 'RETRY_KEY_CONFLICT' },
    newCall: { status: 'refused', code: 'REQUEST_NOT_ACTIVE' }, started: true })

  expect(await f.control.archiveWatcherWork([requestId], () => [requestId])).toBe(1)
  expect(f.control.watcherRecordView().requests.some(item => item.id === requestId)).toBe(false)
  expect(f.control.watcherRecordView().operations.some(item => operations.includes(item.id))).toBe(false)
  expect(await asked()).toEqual(before)
  // Archived, the room no longer carries the work until the conversation is shown back to it; once Watcher's
  // conversation is read that far back, its cards come back under the same messages.
  expect(room()).toMatchObject({ receipts: [], replies: [], requests: [] })
  f.control.threadDetail(watcherId)
  await expect.poll(async () => { await f.control.watcherArchiveSettled(); return room() }).toEqual(shown)
  // Nothing was made again: the request still has its two operations, all archived, and the live record none of them.
  expect((await f.control.archivedWatcherWork()!.read({ requests: [requestId] })).operations.filter(item => item.requestId === requestId).map(item => item.id)).toEqual(operations)
  expect(f.control.watcherRecordView().operations.some(item => item.requestId === requestId)).toBe(false)
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
