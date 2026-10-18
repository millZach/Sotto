// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createAgentRuntime } from '../../src/main/agents/runtime'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { watcherToolSchemas, type WatcherToolName, type WatcherToolOutput } from '../../src/shared/watcher'
import { codexFixture } from '../fixtures/codexFixture'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { testCredentials } from '../fixtures/testCredentials'
import { heldOperation } from '../fixtures/deferred'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** Real admission, queue and native adapter; only the Codex process is the scripted fixture. */
async function fixture() {
  const native = await codexFixture(undefined, false, 10_000)
  cleanups.push(native.cleanup)
  const directory = join(native.root, 'sotto'), projectPath = join(native.root, 'worker-project')
  await mkdir(projectPath)
  const credentials = await testCredentials(join(directory, 'vault'), { mode: 'unavailable' })
  const settings = { ...DEFAULT_SETTINGS, threadTitles: false }
  let watcherEnabled = true
  const createRuntime = async () => {
    const created = await createAgentRuntime({ directory, credentials, watcherEnabled, settings: () => settings,
      writingSettings: async () => settings, historyEnabled: () => true, openExternal: async () => undefined, reasoner: {},
      providers: { codex: native.adapter, claude: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost() } })
    // These cases are about which user request may send, not Watcher's news. Two seconds after a worker's turn ends,
    // news would start a hidden wake-up turn on Watcher's thread, and a user request sent behind it waits in the queue
    // instead of starting a request. A slow runner reaches those two seconds between steps, so news is held back.
    if (created.watcher) vi.spyOn(created.watcher.wakes, 'observe').mockImplementation(() => undefined)
    return created
  }
  let runtime = await createRuntime()
  cleanups.push(() => runtime.close())
  let control = runtime.agentControl, watcher = runtime.watcher!, tools = runtime.watcherTools!
  expect((await control.commandShell({ type: 'connect', provider: 'codex' })).error).toBeNull()
  expect((await control.commandShell({ type: 'create-project', provider: 'codex', title: 'Synthetic project', path: projectPath, useExisting: true })).error).toBeNull()
  const project = control.shell().host.projects.find(item => item.path === projectPath)!
  const model = control.shell().host.models.find(item => item.providerId === 'codex' && item.ready)!
  expect(await watcher.open({ provider: 'codex', modelId: model.id })).toMatchObject({ status: 'ok' })
  const watcherId = watcher.state().current!.target.threadId
  const call = async <N extends WatcherToolName>(name: N, input: unknown) =>
    watcherToolSchemas[name].output.parse((await tools.call(watcherId, name, input)).structuredContent) as WatcherToolOutput<N>
  const request = async (text: string) => {
    const known = new Set(watcher.state().requests.map(item => item.id))
    expect((await control.commandShell({ type: 'manual-send', threadId: watcherId, draftId: randomUUID(), text })).error).toBeNull()
    // A send to a busy Watcher is queued and starts no request; the cases below need the request it starts.
    const started = watcher.state().requests.at(-1)!.id
    expect(known.has(started), 'the user request started a new Watcher request').toBe(false)
    return started
  }
  const thread = (threadId: string) => control.watcherSnapshot().threads.find(item => item.id === threadId)!
  const session = (threadId: string) => runtime.threadRegistry!.byThread(threadId)!.sessionId
  const finish = async (threadId: string) => {
    const sessionId = session(threadId)
    const action = await native.action(sessionId, { type: 'complete', text: 'Synthetic completed reply' })
    // Only an app-server that has the thread loaded carries out a turn action, and after a restart none has until
    // something reads the thread. Until then Sotto shows it idle from its saved record while its turn still runs
    // natively, so an idle status alone would let the completion land later, inside the next send. Load the thread,
    // wait for the completion, and have Sotto take in what Codex now reports: the adapter answers its own read only
    // to its caller.
    const unloaded = await native.sessions.stopped(sessionId)
    if (unloaded) await native.adapter.refreshThread(sessionId)
    await expect.poll(() => native.acted(action)).toBe(true)
    if (unloaded) {
      await expect.poll(async () => (await native.adapter.snapshot()).threads.find(item => item.id === sessionId)?.status).toBe('idle')
      expect((await control.commandShell({ type: 'refresh', provider: 'codex' })).error).toBeNull()
    }
    await expect.poll(() => thread(threadId).status).toBe('idle')
  }
  const advanceToQueuedTurn = async (threadId: string, text: string) => {
    const nativeId = await native.realId(session(threadId))
    const nativeTurn = async () => {
      const state = JSON.parse(await readFile(join(native.root, 'state.json'), 'utf8')) as {
        threads: Record<string, { turns: { id: string; status: string; items: { type: string; content?: { type: string; text?: string }[] }[] }[] }>
      }
      return state.threads[nativeId]?.turns.at(-1)
    }
    const previousTurn = await nativeTurn()
    expect(previousTurn?.status).toBe('inProgress')
    const action = await native.action(session(threadId), { type: 'complete', text: 'Synthetic completed reply' })
    await expect.poll(() => native.acted(action)).toBe(true)
    // The queued turn may start before an idle snapshot is published. Prove its native dispatch and head instead.
    await expect.poll(async () => {
      const turn = await nativeTurn(), current = thread(threadId), message = current.messages.findLast(item => item.role === 'user')
      if (!turn || turn.id === previousTurn!.id || turn.status !== 'inProgress') return false
      const input = turn.items.filter(item => item.type === 'userMessage').flatMap(item => item.content ?? [])
      return input.length === 1 && input[0]?.type === 'text' && input[0].text === text
        && current.lastTurn?.id === turn.id && current.lastTurn.status === 'running'
        && message?.text === text && current.lastUserMessageId === message.id
    }).toBe(true)
  }
  const requestA = await request('Synthetic request A')
  const start = await call('start_thread', { requestId: requestA, retryKey: randomUUID(),
    project: { hostId: control.hostId()!, projectId: project.id }, modelId: model.id,
    title: 'Synthetic worker', workingCopy: { kind: 'shared' }, firstPrompt: 'Synthetic request A worker prompt' })
  expect(start).toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' } })
  if (start.status !== 'ok') throw new Error('Synthetic worker was not admitted')
  const target = start.target
  expect(await watcher.watchThread({ target })).toMatchObject({ status: 'ok' })
  const watchId = watcher.state().standingWatches![0]!.id
  const row = () => watcher.state().watchedThreads.find(item => item.target.threadId === target.threadId)!
  const participationA = () => watcher.state().requests.find(item => item.id === requestA)!.participants.find(item => item.target.threadId === target.threadId)!
  return { native, get control() { return control }, get watcher() { return watcher }, call, request, finish, advanceToQueuedTurn, thread, session, watcherId, requestA, target, watchId, row, participationA,
    restart: async (enabled = true) => {
      await runtime.close(); watcherEnabled = enabled; runtime = await createRuntime()
      control = runtime.agentControl; watcher = runtime.watcher!; tools = runtime.watcherTools!
      expect((await control.commandShell({ type: 'connect', provider: 'codex' })).error).toBeNull()
      if (enabled) expect(watcher.state().current?.target.threadId).toBe(watcherId)
    } }
}

it.each(['manual-send', 'queue-followup', 'steer', 'native'] as const)(
  'keeps request A fenced after %s takeover while a fresh user request B can use the resumed watch', async origin => {
    const f = await fixture()
    // Sotto's own native send and acceptance echo must leave participation intact.
    expect(f.participationA().state).toBe('participating')
    expect(f.row()).toMatchObject({ watched: true, paused: false })
    const machineText = 'Synthetic old queued automatic prompt'
    const queued = await f.call('send_to_thread', { requestId: f.requestA, retryKey: randomUUID(), target: f.target,
      delivery: 'queue', text: machineText })
    expect(queued).toMatchObject({ status: 'ok', receipt: { deliveryState: 'queued' } })
    if (queued.status !== 'ok') throw new Error('Synthetic automatic queue was not admitted')
    const oldDraftId = f.control.watcherRecord().operations.find(item => item.id === queued.receipt.operationId)!.draftId
    const userText = 'Synthetic direct user takeover'
    if (origin === 'native') {
      // Another native client changes provider history without a Sotto command or stream echo.
      const action = await f.native.action(f.session(f.target.threadId), { type: 'native-turn', text: userText, status: 'inProgress' })
      await expect.poll(() => f.native.acted(action)).toBe(true)
      await f.native.adapter.refreshThread(f.session(f.target.threadId))
      // refreshThread answers its read to its caller; the coordinator must accept that provider snapshot too.
      expect((await f.control.commandShell({ type: 'refresh', provider: 'codex' })).error).toBeNull()
    } else {
      expect((await f.control.commandShell({ type: origin, threadId: f.target.threadId, draftId: randomUUID(), text: userText })).error).toBeNull()
    }
    if (origin === 'steer') await expect.poll(() => {
      const thread = f.thread(f.target.threadId), message = thread.messages.findLast(item => item.role === 'user')
      return message?.text === userText && thread.lastUserMessageId === message.id
    }).toBe(true)
    await expect.poll(() => f.participationA().state).toBe('taken-over')
    expect(f.participationA().takeover?.reason).toBe(origin === 'native' ? 'native-user-send' : 'user-send')
    expect(f.row()).toMatchObject({ watched: true, paused: true })
    await expect.poll(() => f.control.shell().followups?.some(item => item.draftId === oldDraftId) ?? false).toBe(false)
    for (const delivery of ['now', 'queue', 'steer']) {
      expect(await f.call('send_to_thread', { requestId: f.requestA, retryKey: randomUUID(), target: f.target, delivery,
        expectedTurnId: f.thread(f.target.threadId).lastTurn?.id, text: 'Synthetic forbidden request A continuation' }))
        .toMatchObject({ status: 'refused', code: 'THREAD_TAKEN_OVER' })
    }
    if (origin === 'manual-send' || origin === 'queue-followup') {
      // The original automatic turn ends, then the user's queued turn actually starts.
      await f.advanceToQueuedTurn(f.target.threadId, userText)
    }
    await f.finish(f.target.threadId)
    await expect.poll(() => f.control.hasPendingThreadWork(f.target.threadId)).toBe(false)
    await expect.poll(() => f.row().paused).toBe(false)
    expect(f.watcher.state().standingWatches).toEqual([expect.objectContaining({ id: f.watchId, pausedByUserMessageId: null })])
    const oldParticipation = structuredClone(f.participationA())

    await f.finish(f.watcherId)
    const requestB = await f.request('Synthetic fresh user request B')
    expect(requestB).not.toBe(f.requestA)
    expect(f.watcher.state().requests.find(item => item.id === requestB)?.state).toBe('active')
    // Control: in this same Watcher turn, the standing origin can already send to the watched, unpaused worker.
    expect(await f.call('send_to_thread', { requestId: f.watchId, retryKey: randomUUID(), target: f.target,
      delivery: 'now', text: 'Synthetic request B standing continuation' })).toMatchObject({ status: 'ok' })
    await f.finish(f.target.threadId)
    expect(f.row()).toMatchObject({ watched: true, paused: false })
    expect(f.participationA()).toEqual(oldParticipation)
    expect(JSON.stringify(await f.native.driver.requests())).not.toContain(machineText)
    // Regression: an unrelated historical takeover must not poison the new ordinary request's admission.
    const fresh = await f.call('send_to_thread', { requestId: requestB, retryKey: randomUUID(), target: f.target,
      delivery: 'now', text: 'Synthetic fresh request B continuation' })
    expect(fresh, JSON.stringify(fresh)).toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' } })
    expect(f.participationA()).toEqual(oldParticipation)
  }, 60_000)

it('blocks fresh and standing sends between an accepted user steer and its published native head', async () => {
  const f = await fixture()
  await f.finish(f.watcherId)
  const worker = f.thread(f.target.threadId), machineHead = worker.lastUserMessageId
  expect(machineHead).toBeDefined()
  // An explicit human head keeps its authority even if the window is older or already contains a later machine send.
  const human = { ...worker.messages.findLast(message => message.role === 'user')!, id: randomUUID() }
  const guard = f.watcher as unknown as { humanTurnRunning(thread: typeof worker): boolean }
  for (const messages of [worker.messages, [human, ...worker.messages]]) {
    expect(guard.humanTurnRunning({ ...worker, lastUserMessageId: human.id, messages })).toBe(true)
  }
  const draftId = randomUUID(), text = 'Synthetic accepted user steer before metadata publication', gate = heldOperation()
  const prepare = f.native.adapter.prepareSkillInput.bind(f.native.adapter)
  const preparing = vi.spyOn(f.native.adapter, 'prepareSkillInput').mockImplementation(async (...args) => {
    const result = await prepare(...args)
    if (args[1] === text) await gate.wait()
    return result
  })
  const publisher = (f.native.adapter as unknown as { publisher: { publish(streaming?: boolean): void; cancel(): void } }).publisher
  let restorePublisher: (() => void) | undefined
  let requestB!: string
  const steering = f.control.commandShell({ type: 'steer', threadId: f.target.threadId, draftId, text })
  try {
    await gate.entered
    requestB = await f.request('Synthetic fresh request during held user-head publication')
    // B is created after the user's fence and before their echo. Conversation events still reach the real event
    // store; only metadata publication is held, including any already-scheduled trailing publication.
    publisher.cancel()
    const held = vi.spyOn(publisher, 'publish').mockImplementation(() => undefined)
    restorePublisher = () => held.mockRestore()
    gate.release()
    expect((await steering).error).toBeNull()
    const progress = 'Synthetic user-turn progress while metadata is held'
    const action = await f.native.action(f.session(f.target.threadId), { type: 'say', text: progress })
    await expect.poll(() => f.native.acted(action)).toBe(true)
    await expect.poll(() => f.thread(f.target.threadId).messages.findLast(item => item.role === 'assistant')?.text).toBe(progress)
    expect(f.control.shell().deliveries?.find(item => item.draftId === draftId)?.status).toBe('accepted')
    expect(f.control.hasPendingThreadWork(f.target.threadId)).toBe(false)
    expect(f.thread(f.target.threadId).lastUserMessageId).toBe(machineHead)
    expect(f.thread(f.target.threadId).messages.findLast(item => item.role === 'user')?.text).toBe(text)
    for (const requestId of [requestB, f.watchId]) for (const delivery of ['queue', 'steer', 'now']) {
      expect(await f.call('send_to_thread', { requestId, retryKey: randomUUID(), target: f.target, delivery,
        expectedTurnId: f.thread(f.target.threadId).lastTurn?.id, text: 'Synthetic refused prompt during held user steer' }))
        .toMatchObject({ status: 'refused', code: 'THREAD_TAKEN_OVER' })
    }
  } finally {
    gate.release(); await steering; preparing.mockRestore(); restorePublisher?.(); publisher.publish()
    await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  }
  await f.finish(f.target.threadId)
  await expect.poll(() => f.row().paused).toBe(false)
  expect(await f.call('send_to_thread', { requestId: requestB, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic fresh continuation after the published user turn' })).toMatchObject({ status: 'ok' })
  await f.finish(f.target.threadId)
  expect(await f.call('send_to_thread', { requestId: f.watchId, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic standing continuation after the published user turn' })).toMatchObject({ status: 'ok' })
}, 60_000)

it('lets a fresh request B use an active watch after user reconfiguration fences request A', async () => {
  const f = await fixture()
  await f.finish(f.target.threadId)
  expect((await f.control.commandShell({ type: 'configure-thread', threadId: f.target.threadId, reasoningEffort: 'high' })).error).toBeNull()
  await expect.poll(() => f.participationA().state).toBe('taken-over')
  expect(f.participationA().takeover?.reason).toBe('user-reconfigure')
  await expect.poll(() => f.row().paused).toBe(false)
  expect(f.row().watched).toBe(true)
  const oldParticipation = structuredClone(f.participationA())
  expect(await f.call('send_to_thread', { requestId: f.requestA, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic forbidden reconfigured request A' })).toMatchObject({ status: 'refused', code: 'THREAD_TAKEN_OVER' })
  await f.finish(f.watcherId)
  const requestB = await f.request('Synthetic fresh request B after reconfiguration')
  expect(requestB).not.toBe(f.requestA)
  expect(await f.call('send_to_thread', { requestId: f.watchId, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic standing continuation after reconfiguration' })).toMatchObject({ status: 'ok' })
  await f.finish(f.target.threadId)
  expect(f.row()).toMatchObject({ watched: true, paused: false })
  const fresh = await f.call('send_to_thread', { requestId: requestB, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic ordinary continuation after reconfiguration' })
  expect(fresh, JSON.stringify(fresh)).toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' } })
  expect(f.participationA()).toEqual(oldParticipation)
}, 60_000)

it('keeps a fresh request blocked for now, queue and steer until the user turn ends', async () => {
  const f = await fixture()
  expect((await f.control.commandShell({ type: 'manual-send', threadId: f.target.threadId, draftId: randomUUID(), text: 'Synthetic running user turn' })).error).toBeNull()
  await f.finish(f.watcherId)
  const requestB = await f.request('Synthetic request B during the user turn')
  expect(f.participationA().state).toBe('taken-over')
  expect(f.row()).toMatchObject({ watched: true, paused: true })
  const operations = f.control.watcherRecord().operations.length
  for (const delivery of ['now', 'queue', 'steer']) expect(await f.call('send_to_thread', {
    requestId: requestB, retryKey: randomUUID(), target: f.target, delivery,
    expectedTurnId: f.thread(f.target.threadId).lastTurn?.id, text: 'Synthetic blocked fresh prompt',
  })).toMatchObject({ status: 'refused', code: 'THREAD_TAKEN_OVER' })
  for (const requestId of [f.requestA, requestB]) for (const name of ['stop_thread', 'settle_thread'] as const) {
    expect(await f.call(name, { requestId, retryKey: randomUUID(), target: f.target }))
      .toMatchObject({ status: 'refused', code: 'THREAD_TAKEN_OVER' })
  }
  expect(f.control.watcherRecord().operations).toHaveLength(operations)
  // The queued user's own native echo must not move the fence past request B, which the user already sent.
  await f.advanceToQueuedTurn(f.target.threadId, 'Synthetic running user turn')
  await f.finish(f.target.threadId)
  await expect.poll(() => f.control.hasPendingThreadWork(f.target.threadId)).toBe(false)
  await expect.poll(() => f.row().paused).toBe(false)
  expect(await f.call('send_to_thread', { requestId: requestB, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic fresh prompt after the user turn' })).toMatchObject({ status: 'ok' })
}, 60_000)

it('keeps a pre-existing nonparticipant request fenced through restart and rewatch', async () => {
  const f = await fixture()
  await f.finish(f.target.threadId); await f.finish(f.watcherId)
  const requestB = await f.request('Synthetic request B before takeover')
  expect(f.watcher.state().requests.find(item => item.id === requestB)?.participants).toEqual([])
  expect((await f.control.commandShell({ type: 'configure-thread', threadId: f.target.threadId, reasoningEffort: 'high' })).error).toBeNull()
  expect(f.participationA()).toMatchObject({ state: 'taken-over', takeover: { reason: 'user-reconfigure' } })
  await f.restart()
  expect(f.row()).toMatchObject({ watched: true, paused: false })
  expect(await f.watcher.unwatchThread({ target: f.target })).toMatchObject({ status: 'ok' })
  expect(await f.watcher.watchThread({ target: f.target })).toMatchObject({ status: 'ok' })
  expect(f.watcher.state().standingWatches![0]!.id).not.toBe(f.watchId)
  for (const requestId of [f.requestA, requestB]) expect(await f.call('send_to_thread', {
    requestId, retryKey: randomUUID(), target: f.target, delivery: 'now', text: 'Synthetic old request after rewatch',
  })).toMatchObject({ status: 'refused', code: 'THREAD_TAKEN_OVER' })
  await f.finish(f.watcherId)
  const requestC = await f.request('Synthetic request C after takeover and rewatch')
  expect(await f.call('send_to_thread', { requestId: requestC, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic fresh request after rewatch' })).toMatchObject({ status: 'ok' })
}, 60_000)

it('keeps an unparticipated worker fenced after unrelated takeover and rewatch', async () => {
  const f = await fixture(), source = f.thread(f.target.threadId)
  const createWatchedWorker = async (title: string) => {
    const target = { hostId: f.target.hostId, threadId: randomUUID() }
    expect((await f.control.commandShell({ type: 'create-thread', threadId: target.threadId, projectId: source.projectId,
      modelId: source.modelId, title, runtimeMode: 'approval-required', workingCopy: 'shared' })).error).toBeNull()
    expect(await f.watcher.watchThread({ target })).toMatchObject({ status: 'ok' })
    return target
  }
  const target = await createWatchedWorker('Synthetic unparticipated worker')
  const other = await createWatchedWorker('Synthetic unrelated watched worker')
  const participations = () => f.control.watcherRecord().requests.flatMap(request => request.participants)
    .filter(item => item.target.threadId === target.threadId)
  const watch = () => f.control.watcherRecord().watches?.find(item => item.target.threadId === target.threadId)
  const originalWatchId = watch()!.id
  expect(participations()).toEqual([])

  const text = 'Synthetic direct user turn before first participation'
  expect((await f.control.commandShell({ type: 'manual-send', threadId: target.threadId, draftId: randomUUID(), text })).error).toBeNull()
  await expect.poll(() => f.thread(target.threadId).messages.findLast(item => item.role === 'user')?.text).toBe(text)
  await f.finish(target.threadId)
  await expect.poll(() => watch()?.pausedByUserMessageId).toBeNull()
  expect(participations()).toEqual([])
  expect(f.control.watcherRecord().localTakeovers).toContainEqual(expect.objectContaining({ target, lastRequestId: f.requestA }))
  expect(await f.watcher.unwatchThread({ target })).toMatchObject({ status: 'ok' })
  expect(await f.call('send_to_thread', { requestId: f.requestA, retryKey: randomUUID(), target,
    delivery: 'now', text: 'Synthetic forbidden continuation while unwatched' })).toMatchObject({ status: 'refused', code: 'REQUEST_NOT_ACTIVE' })

  // An unrelated takeover must not erase the first worker's boundary merely because it has no participation.
  expect((await f.control.commandShell({ type: 'configure-thread', threadId: other.threadId, reasoningEffort: 'high' })).error).toBeNull()
  expect(participations()).toEqual([])
  expect(f.control.watcherRecord().requests.find(request => request.id === f.requestA)?.state).toBe('active')
  expect(f.control.watcherRecord().watchFences).toContainEqual(expect.objectContaining({ id: originalWatchId, target }))
  expect(await f.watcher.watchThread({ target })).toMatchObject({ status: 'ok' })
  expect(watch()!.id).not.toBe(originalWatchId)
  expect(await f.call('send_to_thread', { requestId: f.requestA, retryKey: randomUUID(), target,
    delivery: 'now', text: 'Synthetic forbidden pre-user continuation after rewatch' })).toMatchObject({ status: 'refused', code: 'THREAD_TAKEN_OVER' })
  expect(participations()).toEqual([])

  await f.finish(f.watcherId)
  const requestB = await f.request('Synthetic fresh request after unparticipated worker rewatch')
  expect(await f.call('send_to_thread', { requestId: requestB, retryKey: randomUUID(), target,
    delivery: 'now', text: 'Synthetic fresh continuation after unparticipated worker rewatch' })).toMatchObject({ status: 'ok' })
}, 60_000)

it.each(['queue', 'steer'] as const)('allows a fresh request to %s after user reconfiguration ends', async delivery => {
  const f = await fixture()
  await f.finish(f.target.threadId)
  expect((await f.control.commandShell({ type: 'configure-thread', threadId: f.target.threadId, reasoningEffort: 'high' })).error).toBeNull()
  await f.finish(f.watcherId)
  const requestB = await f.request('Synthetic request B for explicit delivery')
  const previousTurnId = f.thread(f.target.threadId).lastTurn?.id
  const standing = await f.call('send_to_thread', { requestId: f.watchId, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic running standing work' })
  expect(standing, JSON.stringify(standing)).toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' } })
  if (standing.status !== 'ok') throw new Error('Synthetic standing work was not admitted')
  const messageId = f.control.watcherRecord().operations.find(item => item.id === standing.receipt.operationId)!.messageId
  expect(messageId).toBeDefined()
  // Acceptance can precede the native user head even after the running turn is published. Steer only that send's turn.
  await expect.poll(() => {
    const current = f.thread(f.target.threadId)
    return current.status === 'running' && current.lastTurn?.status === 'running' && current.lastTurn.id !== previousTurnId
      && current.lastUserMessageId === messageId && current.messages.findLast(item => item.role === 'user')?.id === messageId
  }).toBe(true)
  const result = await f.call('send_to_thread', { requestId: requestB, retryKey: randomUUID(), target: f.target, delivery,
    expectedTurnId: f.thread(f.target.threadId).lastTurn?.id, text: 'Synthetic fresh explicit delivery' })
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'ok', receipt: { deliveryState: delivery === 'queue' ? 'queued' : 'accepted' } })
  expect(f.participationA().state).toBe('taken-over')
}, 60_000)

it('uses the latest takeover when the next request has never participated', async () => {
  const f = await fixture()
  await f.finish(f.target.threadId)
  expect((await f.control.commandShell({ type: 'configure-thread', threadId: f.target.threadId, reasoningEffort: 'high' })).error).toBeNull()
  const firstTakeover = structuredClone(f.participationA().takeover)
  await f.finish(f.watcherId)
  const requestB = await f.request('Synthetic request between two user reconfigurations')
  expect((await f.control.commandShell({ type: 'configure-thread', threadId: f.target.threadId, reasoningEffort: 'low' })).error).toBeNull()
  expect(f.participationA().takeover).toEqual(firstTakeover)
  expect(await f.call('send_to_thread', { requestId: requestB, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic request that predates the latest takeover' })).toMatchObject({ status: 'refused', code: 'THREAD_TAKEN_OVER' })
  const marker = f.control.watcherRecord().localTakeovers!.find(item => item.target.threadId === f.target.threadId)!
  await f.restart()
  expect(f.control.watcherRecord().localTakeovers!.find(item => item.target.threadId === f.target.threadId)).toEqual(marker)
  await f.finish(f.watcherId)
  const requestC = await f.request('Synthetic request after the latest reconfiguration')
  expect(await f.call('send_to_thread', { requestId: requestC, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic fresh continuation after the latest takeover' })).toMatchObject({ status: 'ok' })
}, 60_000)

it('keeps a legacy watch conservative until a renewed assignment establishes a later boundary', async () => {
  const f = await fixture()
  await f.finish(f.target.threadId)
  expect((await f.control.commandShell({ type: 'configure-thread', threadId: f.target.threadId, reasoningEffort: 'high' })).error).toBeNull()
  // Earlier records retained first-takeover provenance but not a reliable newest local takeover marker.
  await f.control.updateWatcher(record => { delete record.localTakeovers })
  await f.finish(f.watcherId)
  const requestB = await f.request('Synthetic fresh request with legacy evidence')
  expect(await f.call('send_to_thread', { requestId: requestB, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic conservative legacy continuation' })).toMatchObject({ status: 'refused', code: 'THREAD_TAKEN_OVER' })
  expect(await f.call('send_to_thread', { requestId: f.watchId, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic existing standing legacy route' })).toMatchObject({ status: 'ok' })
  await f.finish(f.target.threadId)
  expect(await f.watcher.unwatchThread({ target: f.target })).toMatchObject({ status: 'ok' })
  expect(await f.watcher.watchThread({ target: f.target })).toMatchObject({ status: 'ok' })
  expect(await f.call('send_to_thread', { requestId: requestB, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic legacy request before renewed watch' })).toMatchObject({ status: 'refused', code: 'THREAD_TAKEN_OVER' })
  await f.finish(f.watcherId)
  const requestC = await f.request('Synthetic fresh request after renewed legacy watch')
  expect(await f.call('send_to_thread', { requestId: requestC, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic legacy continuation with reliable boundary' })).toMatchObject({ status: 'ok' })
}, 60_000)

it('still fences a known direct delivery made in stable when Owl returns', async () => {
  const f = await fixture()
  await f.finish(f.target.threadId)
  await f.restart(false)
  expect((await f.control.commandShell({ type: 'manual-send', threadId: f.target.threadId, draftId: randomUUID(), text: 'Synthetic direct stable prompt' })).error).toBeNull()
  await f.finish(f.target.threadId)
  await f.restart()
  await expect.poll(() => f.participationA().state).toBe('taken-over')
  expect(f.participationA().takeover?.reason).toBe('native-user-send')
  expect(f.row()).toMatchObject({ watched: true, paused: false })
  expect(f.control.watcherRecord().localTakeovers?.find(item => item.target.threadId === f.target.threadId)).toBeDefined()
}, 60_000)

it('orders repeated takeovers by retained requests when the clock moves backward', async () => {
  const f = await fixture()
  await f.finish(f.target.threadId)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-17T10:00:00.000Z'))
  expect((await f.control.commandShell({ type: 'configure-thread', threadId: f.target.threadId, reasoningEffort: 'high' })).error).toBeNull()
  await f.finish(f.watcherId)
  vi.setSystemTime(new Date('2026-10-17T10:10:00.000Z'))
  const requestB = await f.request('Synthetic request before clock rollback')
  vi.setSystemTime(new Date('2026-10-17T10:05:00.000Z'))
  expect((await f.control.commandShell({ type: 'configure-thread', threadId: f.target.threadId, reasoningEffort: 'low' })).error).toBeNull()
  expect(await f.call('send_to_thread', { requestId: requestB, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic pre-existing request after rollback' })).toMatchObject({ status: 'refused', code: 'THREAD_TAKEN_OVER' })
  await f.finish(f.watcherId)
  vi.setSystemTime(new Date('2026-10-17T09:00:00.000Z'))
  const requestC = await f.request('Synthetic fresh request despite earlier wall time')
  expect(await f.call('send_to_thread', { requestId: requestC, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic fresh request after clock rollback' })).toMatchObject({ status: 'ok' })
}, 60_000)

it('keeps a missing request frontier conservative', async () => {
  const f = await fixture()
  await f.finish(f.target.threadId)
  expect((await f.control.commandShell({ type: 'configure-thread', threadId: f.target.threadId, reasoningEffort: 'high' })).error).toBeNull()
  await f.finish(f.watcherId)
  const requestB = await f.request('Synthetic fresh request with missing frontier')
  await f.control.updateWatcher(record => { record.localTakeovers!.find(item => item.target.threadId === f.target.threadId)!.lastRequestId = randomUUID() })
  expect(await f.call('send_to_thread', { requestId: requestB, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic request with unavailable ordering evidence' })).toMatchObject({ status: 'refused', code: 'THREAD_TAKEN_OVER' })
}, 60_000)

it('keeps both queued user echoes inside their original fences', async () => {
  const f = await fixture(), texts = ['Synthetic first queued user turn', 'Synthetic second queued user turn']
  for (const text of texts) expect((await f.control.commandShell({ type: 'queue-followup', threadId: f.target.threadId, draftId: randomUUID(), text })).error).toBeNull()
  await f.finish(f.watcherId)
  const requestB = await f.request('Synthetic request after both queued user commands')
  for (const text of texts) {
    await f.advanceToQueuedTurn(f.target.threadId, text)
  }
  await f.finish(f.target.threadId)
  await expect.poll(() => f.control.hasPendingThreadWork(f.target.threadId)).toBe(false)
  await expect.poll(() => f.row().paused).toBe(false)
  expect(await f.call('send_to_thread', { requestId: requestB, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic continuation after both already-fenced user turns' })).toMatchObject({ status: 'ok' })
}, 60_000)

it('does not let an old queued sentinel hide a newer stable delivery', async () => {
  const f = await fixture()
  expect((await f.control.commandShell({ type: 'queue-followup', threadId: f.target.threadId, draftId: randomUUID(), text: 'Synthetic old Owl queued user turn' })).error).toBeNull()
  expect(f.control.watcherRecord().watches![0]!.pausedByUserMessageId).toBe('unobserved-user-turn')
  await f.finish(f.watcherId)
  const requestB = await f.request('Synthetic request before newer stable input')
  expect(f.control.watcherRecord().localTakeovers![0]!.lastRequestId).toBe(f.requestA)
  await f.restart(false)
  const draftId = randomUUID()
  expect((await f.control.commandShell({ type: 'queue-followup', threadId: f.target.threadId, draftId, text: 'Synthetic newer stable user turn' })).error).toBeNull()
  const itemId = f.control.shell().followups!.find(item => item.draftId === draftId)!.id
  expect((await f.control.commandShell({ type: 'steer-followup', threadId: f.target.threadId, itemId })).error).toBeNull()
  await f.restart()
  await expect.poll(() => f.control.watcherRecord().localTakeovers!.find(item => item.target.threadId === f.target.threadId)?.lastRequestId).toBe(requestB)
  expect(await f.call('send_to_thread', { requestId: requestB, retryKey: randomUUID(), target: f.target,
    delivery: 'queue', text: 'Synthetic pre-existing request behind stable input' })).toMatchObject({ status: 'refused', code: 'THREAD_TAKEN_OVER' })
}, 60_000)

it.each(['manual', 'packet', 'composer'] as const)('admits a fresh request after a no-draft %s user turn ends', async form => {
  const f = await fixture(), text = 'Synthetic user command without an explicit draft identity'
  await f.finish(f.target.threadId)
  expect((await f.control.commandShell({ type: 'select-thread', threadId: f.target.threadId })).error).toBeNull()
  if (form === 'manual') expect((await f.control.commandShell({ type: 'manual-send', threadId: f.target.threadId, text })).error).toBeNull()
  else if (form === 'packet') expect((await f.control.commandShell({ type: 'send', draft: { threadId: f.target.threadId, text } })).error).toBeNull()
  else {
    expect((await f.control.commandShell({ type: 'compose', threadId: f.target.threadId, text })).error).toBeNull()
    expect((await f.control.commandShell({ type: 'send' })).error).toBeNull()
  }
  await f.finish(f.target.threadId)
  await expect.poll(() => f.row().paused).toBe(false)
  await f.finish(f.watcherId)
  const requestB = await f.request('Synthetic fresh request after a no-draft user turn')
  expect(await f.call('send_to_thread', { requestId: requestB, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic continuation after a no-draft user turn' })).toMatchObject({ status: 'ok' })
}, 60_000)
