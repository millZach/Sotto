// @vitest-environment node
// What read_operation says of a Watcher brief once its turn moves on: the outcome, the text-free reference to the turn
// that answers it and, once answered, that turn's reply as the worker's words (ADR-0073, October 14, 2026: outcomes).
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { WatcherService } from '../../src/main/agents/watcher'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import { WatcherPhoneService } from '../../src/main/agents/watcherPhone'
import type { AgentThread, ProviderId } from '../../src/shared/agents'
import { watcherToolSchemas, type WatcherToolName, type WatcherToolOutput } from '../../src/shared/watcher'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { storedFollowups } from '../fixtures/followupQueue'
import { watcherWakeUpNote } from '../../src/main/agents/wakeUp'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture(history = true) {
  const workspace = await workspaceFixture(undefined, { history })
  cleanups.push(workspace.remove)
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host,
    credentialOptions: { mode: 'unavailable' }, control: { historyEnabled: () => history, watcherEnabled: true } })
  let service = new WatcherService({ ordinaryBatch: { quietMs: 2_000, maxMs: 5_000 }, directory: f.root, host: workspace.host, control: f.control, historyEnabled: () => history, limit: () => 4 })
  const tools = new WatcherToolServer(service)
  workspace.host.useWatcherTools(tools)
  cleanups.push(async () => { service.close(); await tools.close(); f.control.dispose(); await f.control.closed(); await workspace.stop() })
  await f.control.start()
  await f.control.commandShell({ type: 'connect', provider: 'codex' })
  await service.recover()
  const model = f.control.shell().host.models.find(item => item.providerId === 'codex')!
  const project = f.control.shell().host.projects.find(item => item.providerId === 'codex')!
  expect(await service.open({ provider: 'codex', modelId: model.id })).toMatchObject({ status: 'ok' })
  const id = service.state().current!.target.threadId
  expect((await f.control.commandShell({ type: 'manual-send', threadId: id, draftId: randomUUID(), text: 'Synthetic Watcher user request' })).error).toBeNull()
  const requestId = service.state().requests.at(-1)!.id
  const call = async <N extends WatcherToolName>(name: N, input: unknown): Promise<WatcherToolOutput<N>> =>
    watcherToolSchemas[name].output.parse(await service.invoke(id, name, input)) as WatcherToolOutput<N>
  const native = (threadId: string): AgentThread => {
    const binding = workspace.registry.byThread(threadId)!
    return workspace.adapters[binding.provider as keyof typeof workspace.adapters].state.threads.find(item => item.id === binding.sessionId)!
  }
  const emit = async (threadId: string) => {
    const binding = workspace.registry.byThread(threadId)!
    workspace.adapters[binding.provider as keyof typeof workspace.adapters].emit()
    await f.control.commandShell({ type: 'refresh', provider: binding.provider as ProviderId })
  }
  /** The provider ends the running turn, as Grok Build names one: by the user message it began with. */
  const endTurn = async (threadId: string, reply: string, status: 'completed' | 'interrupted' | 'failed' = 'completed') => {
    const thread = native(threadId)
    thread.messages.push({ id: randomUUID(), role: 'assistant', text: reply, createdAt: new Date().toISOString() })
    thread.lastTurn = { id: thread.messages.findLast(message => message.role === 'user')!.id, status }
    thread.status = 'idle'
    await emit(threadId)
  }
  const start = async () => {
    const result = await call('start_thread', { requestId, retryKey: randomUUID(), project: { hostId: f.control.hostId()!, projectId: project.id },
      modelId: model.id, title: 'Synthetic worker', workingCopy: { kind: 'shared' }, firstPrompt: 'Synthetic brief' })
    if (result.status !== 'ok' || !('target' in result)) throw new Error('start refused')
    return result
  }
  const read = async (operationId: string) => {
    const result = await call('read_operation', { operationId })
    if (result.status !== 'ok') throw new Error(`read refused: ${result.code}`)
    return result
  }
  const restart = async () => {
    service.close()
    service = new WatcherService({ ordinaryBatch: { quietMs: 2_000, maxMs: 5_000 }, directory: f.root, host: workspace.host, control: f.control, historyEnabled: () => history, limit: () => 4 })
    await service.recover()
  }
  return { ...f, workspace, id, requestId, call, native, emit, endTurn, start, read, restart, get service() { return service } }
}

it('reads a start as working, then answered with its turn\'s exact reply as the worker\'s words, charging nothing', async () => {
  const f = await fixture(), started = await f.start()
  const working = await f.read(started.receipt.operationId)
  expect(working).toMatchObject({ outcome: 'working', reference: { target: started.target }, limits: { promptCount: 1 } })
  expect(working.reply).toBeUndefined()
  await f.endTurn(started.target.threadId, 'Synthetic worker reply')
  const answered = await f.read(started.receipt.operationId)
  const brief = f.native(started.target.threadId).messages[0]!
  expect(answered).toMatchObject({ outcome: 'answered', limits: { promptCount: 1 },
    reference: { target: started.target, turnMessageId: brief.id, nativeTurnId: brief.id, replyMessageId: expect.any(String) },
    reply: { from: 'worker', text: 'Synthetic worker reply', truncated: false } })
  expect(answered.outcomeNote).toMatch(/worker’s own words/u)
  expect(answered.reply?.messageId).toBe(answered.reference?.replyMessageId)
  // Reads and retries charge no budget.
  expect((await f.read(started.receipt.operationId)).limits.promptCount).toBe(1)
  expect(f.control.watcherRecord().operations.find(item => item.id === started.receipt.operationId)).toMatchObject({ outcome: 'answered',
    replyMessageId: answered.reference!.replyMessageId })
  // The record and the room hold identities only, never the reply's words.
  expect(JSON.stringify(f.control.watcherRecord())).not.toContain('Synthetic worker reply')
  expect(f.service.state().receipts.find(item => item.id === started.receipt.operationId)).toMatchObject({ outcome: 'answered' })
  // A phone sees the same outcome on its receipt row.
  const phone = new WatcherPhoneService(f.control, f.service).state(false)
  expect(phone.receiptGroups.flatMap(group => group.rows).find(row => row.operationId === started.receipt.operationId)).toMatchObject({ outcome: 'answered' })
})

it('names the operation a finished turn answers in its news', async () => {
  const f = await fixture(), started = await f.start()
  await f.endTurn(started.target.threadId, 'Synthetic worker reply')
  await vi.waitFor(() => expect(f.service.state().news?.find(event => event.kind === 'turn-finished' && event.target.threadId === started.target.threadId))
    .toMatchObject({ operationId: started.receipt.operationId }))
  // Watcher's own turn is still running, so the news waits in its queue. Its words are the note the wake-up's send carries (ADR-0073).
  const note = () => storedFollowups(f.control).filter(item => item.threadId === f.id && item.wakeUp)
    .map(item => watcherWakeUpNote(item.news ?? []) ?? '').find(text => text.includes('foreground turn finished'))
  await vi.waitFor(() => expect(note()).toBeDefined(), { timeout: 15_000 })
  expect(note()).toContain(`This turn answers operation ${started.receipt.operationId}`)
  // The queued news holds identities only: Sotto adds the reply's start when the note is sent (#1190), never to the queue.
  expect(note()).not.toContain('Synthetic worker reply')
})

it('gives a queued send its own outcome and reply', async () => {
  const f = await fixture(), started = await f.start()
  const queued = await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: started.target, text: 'Synthetic queued brief', delivery: 'queue' })
  if (queued.status !== 'ok') throw new Error('queue refused')
  expect(await f.read(queued.receipt.operationId)).toMatchObject({ outcome: 'working' })
  await f.endTurn(started.target.threadId, 'Synthetic first reply')
  await vi.waitFor(() => expect(f.native(started.target.threadId).messages.some(message => message.text === 'Synthetic queued brief')).toBe(true))
  expect(await f.read(started.receipt.operationId)).toMatchObject({ outcome: 'answered', reply: { text: 'Synthetic first reply' } })
  expect(await f.read(queued.receipt.operationId)).toMatchObject({ outcome: 'working' })
  await f.endTurn(started.target.threadId, 'Synthetic second reply')
  const own = await f.read(queued.receipt.operationId)
  expect(own).toMatchObject({ outcome: 'answered', reply: { text: 'Synthetic second reply' } })
  expect(own.reference?.turnMessageId).not.toBe((await f.read(started.receipt.operationId)).reference?.turnMessageId)
})

it('reads a brief the user\'s own turn took over as paused', async () => {
  const f = await fixture(), started = await f.start()
  const queued = await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: started.target, text: 'Synthetic queued brief', delivery: 'queue' })
  if (queued.status !== 'ok') throw new Error('queue refused')
  expect((await f.control.commandShell({ type: 'queue-followup', threadId: started.target.threadId, draftId: randomUUID(), text: 'Synthetic user follow-up' })).error).toBeNull()
  await vi.waitFor(async () => expect(await f.read(queued.receipt.operationId)).toMatchObject({ outcome: 'paused', receipt: { deliveryState: 'failed' } }))
})

it('reads a turn left with background work as background until that work ends', async () => {
  const f = await fixture(), started = await f.start()
  f.native(started.target.threadId).backgroundWork = [{ id: randomUUID(), label: 'Synthetic agent', type: 'subagent' }]
  await f.endTurn(started.target.threadId, 'Synthetic reply, agent still running')
  expect(await f.read(started.receipt.operationId)).toMatchObject({ outcome: 'background' })
  f.native(started.target.threadId).backgroundWork = []
  await f.emit(started.target.threadId)
  expect(await f.read(started.receipt.operationId)).toMatchObject({ outcome: 'answered', reply: { text: 'Synthetic reply, agent still running' } })
  // The work-settled news that moves it on names the same operation.
  await vi.waitFor(() => expect(f.service.state().news?.find(event => event.kind === 'work-settled' && event.target.threadId === started.target.threadId))
    .toMatchObject({ operationId: started.receipt.operationId, backgroundWorkCount: 0 }))
})

it('keeps a brief answered with nothing running answered, with no work-settled news, when work starts on its turn later', async () => {
  const f = await fixture(), started = await f.start()
  await f.endTurn(started.target.threadId, 'Synthetic reply, nothing running')
  await vi.waitFor(() => expect(f.service.state().news?.find(event => event.kind === 'turn-finished' && event.target.threadId === started.target.threadId))
    .toMatchObject({ operationId: started.receipt.operationId, backgroundWorkCount: 0 }))
  expect(await f.read(started.receipt.operationId)).toMatchObject({ outcome: 'answered' })
  // A finish delivered as done stays done: work that shows up on the same turn afterwards neither reopens the outcome
  // nor earns that turn work-settled news when it ends.
  f.native(started.target.threadId).monitoring = [{ id: randomUUID(), label: 'Synthetic watch' }]
  await f.emit(started.target.threadId)
  expect(await f.read(started.receipt.operationId)).toMatchObject({ outcome: 'answered', reply: { text: 'Synthetic reply, nothing running' } })
  f.native(started.target.threadId).monitoring = []
  await f.emit(started.target.threadId)
  expect(await f.read(started.receipt.operationId)).toMatchObject({ outcome: 'answered' })
  expect(f.service.state().news?.some(event => event.kind === 'work-settled' && event.target.threadId === started.target.threadId)).toBe(false)
})

it('reads a brief whose turn was running when Watcher restarted as unknown, never answered', async () => {
  const f = await fixture(), started = await f.start()
  expect(await f.read(started.receipt.operationId)).toMatchObject({ outcome: 'working' })
  await f.restart()
  await f.endTurn(started.target.threadId, 'Synthetic reply after restart')
  const read = await f.read(started.receipt.operationId)
  expect(read).toMatchObject({ outcome: 'unknown' })
  expect(read.reply).toBeUndefined()
  expect(read.outcomeNote).toMatch(/cannot prove/u)
})

it('says a reply is unavailable after a restart with history off, and shows it before', async () => {
  const f = await fixture(false), started = await f.start()
  await f.endTurn(started.target.threadId, 'Synthetic reply kept only in memory')
  expect(await f.read(started.receipt.operationId)).toMatchObject({ outcome: 'answered', reply: { text: 'Synthetic reply kept only in memory' } })
  await f.restart()
  const read = await f.read(started.receipt.operationId)
  expect(read).toMatchObject({ outcome: 'answered', replyUnavailable: { reason: 'history-off', message: expect.stringMatching(/Keep local history is off/u) } })
  expect(read.reply).toBeUndefined()
})

it('keeps a stop and a settle without an outcome', async () => {
  const f = await fixture(), started = await f.start()
  const stop = await f.call('stop_thread', { requestId: f.requestId, retryKey: randomUUID(), target: started.target })
  if (stop.status !== 'ok') throw new Error('stop refused')
  const read = await f.read(stop.receipt.operationId)
  expect(read.outcome).toBeUndefined()
  expect(read.reference).toBeUndefined()
})

it('says no work-settled news will follow a background brief once its thread begins another turn', async () => {
  const f = await fixture(), started = await f.start()
  f.native(started.target.threadId).backgroundWork = [{ id: randomUUID(), label: 'Synthetic agent', type: 'subagent' }]
  await f.endTurn(started.target.threadId, 'Synthetic reply, agent still running')
  expect(await f.read(started.receipt.operationId)).toMatchObject({ outcome: 'background', outcomeNote: expect.stringContaining('Sotto sends work-settled news when that work ends') })
  // The work is still running, and a second brief begins another turn in the thread.
  const next = await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: started.target, text: 'Synthetic second brief', delivery: 'now' })
  if (next.status !== 'ok') throw new Error('send refused')
  await vi.waitFor(() => expect(f.native(started.target.threadId).messages.some(message => message.text === 'Synthetic second brief')).toBe(true))
  // The provider reports the turn that brief began, as a real one does; a steer would keep the turn it was read into.
  const native = f.native(started.target.threadId), second = native.messages.find(message => message.text === 'Synthetic second brief')!
  const brief = native.messages.find(message => message.role === 'user')!
  native.activities = [{ id: 'first-turn', turnId: brief.id, sequence: 0, kind: 'turn', title: 'Turn', status: 'completed' }]
  native.status = 'running'; native.lastTurn = { id: second.id, status: 'running', messageId: second.id }
  await f.emit(started.target.threadId)
  await vi.waitFor(async () => expect(await f.read(started.receipt.operationId)).toMatchObject({ outcome: 'background',
    outcomeNote: expect.stringContaining('no work-settled news for that turn will follow') }))
})
