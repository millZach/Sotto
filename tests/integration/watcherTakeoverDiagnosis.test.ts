// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createAgentRuntime } from '../../src/main/agents/runtime'
import { WatcherWakeUp } from '../../src/main/agents/watcherWakeUp'
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
  // These cases are about which user request may send, not Watcher's news. Two seconds after a worker's turn ends,
  // news would start a hidden wake-up turn on Watcher's thread, and a user request sent behind it waits in the queue
  // instead of starting a request. A slow runner reaches those two seconds between steps, so every case holds news
  // back for every Watcher, including the one a restart makes before its first pass. Every pass goes through observe.
  const held = vi.spyOn(WatcherWakeUp.prototype, 'observe').mockImplementation(() => undefined)
  cleanups.push(async () => { held.mockRestore() })
  const createRuntime = () => createAgentRuntime({ directory, credentials, watcherEnabled, settings: () => settings,
    writingSettings: async () => settings, historyEnabled: () => true, openExternal: async () => undefined, reasoner: {},
    providers: { codex: native.adapter, claude: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost() } })
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
  const watch = () => control.watcherRecord().watches?.find(item => item.target.threadId === target.threadId)
  return { native, get control() { return control }, get watcher() { return watcher }, call, request, finish, advanceToQueuedTurn, thread, session, watcherId, requestA, target, watchId, row, participationA, watch,
    restart: async (enabled = true) => {
      await runtime.close(); watcherEnabled = enabled; runtime = await createRuntime()
      control = runtime.agentControl; watcher = runtime.watcher!; tools = runtime.watcherTools!
      expect((await control.commandShell({ type: 'connect', provider: 'codex' })).error).toBeNull()
      if (enabled) expect(watcher.state().current?.target.threadId).toBe(watcherId)
    } }
}

it.each(['manual-send', 'queue-followup', 'steer', 'native'] as const)(
  'fences queued request A work after a %s user turn and lets request A and a fresh request B send once it ends', async origin => {
    const f = await fixture()
    // Sotto's own native send and acceptance echo must leave participation intact.
    expect(f.participationA().state).toBe('participating')
    expect(f.row()).toMatchObject({ watched: true, paused: false })
    const generation = f.watch()!.generation
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
    // A standing watch lasts until the user stops it (ADR-0073): the user's turn pauses the watch and fences what Watcher
    // had prepared, one generation on, but request A keeps its participation.
    await expect.poll(() => f.row()).toMatchObject({ watched: true, paused: true })
    expect(f.watch()!.generation).toBeGreaterThan(generation)
    expect(f.participationA()).toMatchObject({ state: 'participating', generation: f.watch()!.generation })
    expect(f.participationA().takeover).toBeUndefined()
    expect(f.control.watcherRecord().operations.find(item => item.id === queued.receipt.operationId))
      .toMatchObject({ deliveryState: 'failed', refusalCode: 'THREAD_TAKEN_OVER' })
    await expect.poll(() => f.control.shell().followups?.some(item => item.draftId === oldDraftId) ?? false).toBe(false)
    // While the user's turn is on its way, Watcher may only steer.
    for (const delivery of ['now', 'queue']) {
      expect(await f.call('send_to_thread', { requestId: f.requestA, retryKey: randomUUID(), target: f.target, delivery,
        text: 'Synthetic held request A continuation' })).toMatchObject({ status: 'refused', code: 'THREAD_BUSY' })
    }
    const steered = await f.call('send_to_thread', { requestId: f.requestA, retryKey: randomUUID(), target: f.target, delivery: 'steer',
      expectedTurnId: f.thread(f.target.threadId).lastTurn?.id, text: 'Synthetic request A steer during the user turn' })
    expect(steered, JSON.stringify(steered)).toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' } })
    if (origin === 'manual-send' || origin === 'queue-followup') {
      // The original automatic turn ends, then the user's queued turn actually starts.
      await f.advanceToQueuedTurn(f.target.threadId, userText)
    }
    await f.finish(f.target.threadId)
    await expect.poll(() => f.control.hasPendingThreadWork(f.target.threadId)).toBe(false)
    await expect.poll(() => f.row().paused).toBe(false)
    expect(f.watcher.state().standingWatches).toEqual([expect.objectContaining({ id: f.watchId, pausedByUserMessageId: null })])
    // Once the user's turn ends, request A sends again under the watch.
    const resumed = await f.call('send_to_thread', { requestId: f.requestA, retryKey: randomUUID(), target: f.target,
      delivery: 'now', text: 'Synthetic request A continuation after the user turn' })
    expect(resumed, JSON.stringify(resumed)).toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' } })
    await f.finish(f.target.threadId)
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
    // Request A's participation is live, so it follows the thread's head, but no other request's send counts as A's.
    expect(f.participationA()).toMatchObject({ state: 'participating', generation: oldParticipation.generation, promptCount: oldParticipation.promptCount })
    expect(JSON.stringify(await f.native.driver.requests())).not.toContain(machineText)
    // Regression: an unrelated historical takeover must not poison the new ordinary request's admission.
    const fresh = await f.call('send_to_thread', { requestId: requestB, retryKey: randomUUID(), target: f.target,
      delivery: 'now', text: 'Synthetic fresh request B continuation' })
    expect(fresh, JSON.stringify(fresh)).toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' } })
    expect(f.participationA()).toMatchObject({ state: 'participating', generation: oldParticipation.generation, promptCount: oldParticipation.promptCount })
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
    // The stale machine head must not hide the user's turn: Watcher may only steer it (ADR-0073). A steer is left out
    // here because the held publication leaves no confirmed turn to steer; the other cases steer the user's turn.
    for (const requestId of [requestB, f.watchId]) for (const delivery of ['queue', 'now']) {
      expect(await f.call('send_to_thread', { requestId, retryKey: randomUUID(), target: f.target, delivery,
        text: 'Synthetic refused prompt during held user steer' })).toMatchObject({ status: 'refused', code: 'THREAD_BUSY' })
    }
    expect(f.participationA().state).toBe('participating')
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

it('lets request A and a fresh request B use an active watch after user reconfiguration', async () => {
  const f = await fixture()
  await f.finish(f.target.threadId)
  const generation = f.watch()!.generation
  expect((await f.control.commandShell({ type: 'configure-thread', threadId: f.target.threadId, reasoningEffort: 'high' })).error).toBeNull()
  // The user's change fences what Watcher had prepared, one generation on, and the watch keeps request A (ADR-0073).
  await expect.poll(() => f.control.watcherRecord().localTakeovers?.some(item => item.target.threadId === f.target.threadId)).toBe(true)
  expect(f.watch()!.generation).toBeGreaterThan(generation)
  expect(f.participationA()).toMatchObject({ state: 'participating', generation: f.watch()!.generation })
  await expect.poll(() => f.row().paused).toBe(false)
  expect(f.row().watched).toBe(true)
  const resumed = await f.call('send_to_thread', { requestId: f.requestA, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic reconfigured request A continuation' })
  expect(resumed, JSON.stringify(resumed)).toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' } })
  await f.finish(f.target.threadId)
  const oldParticipation = structuredClone(f.participationA())
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
  expect(f.participationA()).toMatchObject({ state: 'participating', generation: oldParticipation.generation, promptCount: oldParticipation.promptCount })
}, 60_000)

it('resumes from an instruction queued to a busy Watcher after the user took over its worker', async () => {
  // Bug Bot finding 3 on #1157: the queued instruction joined taken-over request A, so Watcher's reply could never send.
  const f = await fixture()
  await f.finish(f.target.threadId)
  expect((await f.control.commandShell({ type: 'configure-thread', threadId: f.target.threadId, reasoningEffort: 'high' })).error).toBeNull()
  await expect.poll(() => f.control.watcherRecord().localTakeovers?.some(item => item.target.threadId === f.target.threadId)).toBe(true)
  await expect.poll(() => f.row().paused).toBe(false)
  expect(f.participationA().state).toBe('participating')
  // Watcher's turn for request A is still running, so the user's next instruction to it waits in its queue.
  const text = 'Synthetic instruction queued to a busy Watcher after takeover'
  expect((await f.control.commandShell({ type: 'queue-followup', threadId: f.watcherId, draftId: randomUUID(), text })).error).toBeNull()
  await f.advanceToQueuedTurn(f.watcherId, text)
  const head = f.thread(f.watcherId).lastUserMessageId
  const carrying = f.control.watcherRecord().requests.find(item => item.rootUserMessageId === head || item.userFollowups?.some(followup => followup.messageId === head))
  expect(carrying, 'the queued instruction has a request').toBeDefined()
  const fresh = await f.call('send_to_thread', { requestId: carrying!.id, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic continuation from the queued instruction' })
  expect(fresh, JSON.stringify(fresh)).toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' } })
  // The watch keeps request A as well (ADR-0073): it can queue behind the fresh request's turn.
  const queued = await f.call('send_to_thread', { requestId: f.requestA, retryKey: randomUUID(), target: f.target,
    delivery: 'queue', text: 'Synthetic request A continuation behind the fresh request' })
  expect(queued, JSON.stringify(queued)).toMatchObject({ status: 'ok', receipt: { deliveryState: 'queued' } })
  expect(f.participationA().state).toBe('participating')
}, 60_000)

/** Takes the worker over by a settings change, then queues one instruction to Watcher, still busy with request A. */
async function queueAfterTakeover(f: Awaited<ReturnType<typeof fixture>>, text: string) {
  await f.finish(f.target.threadId)
  expect((await f.control.commandShell({ type: 'configure-thread', threadId: f.target.threadId, reasoningEffort: 'high' })).error).toBeNull()
  await expect.poll(() => f.control.watcherRecord().localTakeovers?.some(item => item.target.threadId === f.target.threadId)).toBe(true)
  await expect.poll(() => f.row().paused).toBe(false)
  // The watch keeps request A's participation (ADR-0073); the takeover's order alone makes the next instruction fresh.
  expect(f.participationA().state).toBe('participating')
  const draftId = randomUUID()
  expect((await f.control.commandShell({ type: 'queue-followup', threadId: f.watcherId, draftId, text })).error).toBeNull()
  return draftId
}
const carryingHead = (f: Awaited<ReturnType<typeof fixture>>) => {
  const head = f.thread(f.watcherId).lastUserMessageId
  return f.control.watcherRecord().requests.find(item => item.rootUserMessageId === head || item.userFollowups?.some(followup => followup.messageId === head))
}

it('keeps an instruction queued after a takeover fresh when the user renews a watch before it is read', async () => {
  // Bug Bot finding 1 on #1163: a renewed watch cleared the mark, so the instruction joined fenced request A again.
  const f = await fixture(), text = 'Synthetic instruction queued before a renewed watch'
  await queueAfterTakeover(f, text)
  expect(await f.watcher.unwatchThread({ target: f.target })).toMatchObject({ status: 'ok' })
  expect(await f.watcher.watchThread({ target: f.target })).toMatchObject({ status: 'ok' })
  await f.advanceToQueuedTurn(f.watcherId, text)
  const carrying = carryingHead(f)
  expect(carrying?.id).toBeDefined()
  expect(carrying!.id).not.toBe(f.requestA)
  const sent = await f.call('send_to_thread', { requestId: carrying!.id, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic continuation after a renewed watch' })
  expect(sent, JSON.stringify(sent)).toMatchObject({ status: 'ok' })
}, 60_000)

it('keeps the display proof on the message that starts a fresh request', async () => {
  // Bug Bot finding 5 on #1163: the fresh root claimed the message without a proof, which cancelled the follow-up's.
  const f = await fixture(), text = 'Synthetic instruction whose display proof is kept'
  await queueAfterTakeover(f, text)
  await f.advanceToQueuedTurn(f.watcherId, text)
  const carrying = carryingHead(f)!
  expect(carrying.id).not.toBe(f.requestA)
  expect(carrying.displayPrompt).toBeDefined()
  expect(carrying.displayPrompt).toEqual(carrying.userFollowups!.find(item => item.messageId === carrying.rootUserMessageId)!.displayPrompt)
}, 60_000)

it('keeps an instruction steered into Watcher’s running turn after a takeover inside that turn’s request', async () => {
  // Bug Bot finding 2 on #1163, kept as documented: a steer joins Watcher's running turn, and a request reaches Watcher
  // only when a turn starts, so the steered words have no way to carry a new request.
  const f = await fixture(), text = 'Synthetic instruction steered into Watcher after takeover'
  const draftId = await queueAfterTakeover(f, text)
  const requests = f.control.watcherRecord().requests.length
  const itemId = f.control.shell().followups!.find(item => item.draftId === draftId)!.id
  expect((await f.control.commandShell({ type: 'steer-followup', threadId: f.watcherId, itemId })).error).toBeNull()
  await expect.poll(() => f.thread(f.watcherId).messages.findLast(item => item.role === 'user')?.text).toBe(text)
  expect(f.thread(f.watcherId).status).toBe('running')
  expect(f.control.watcherRecord().requests).toHaveLength(requests)
  // The watch keeps request A (ADR-0073), so the steered words can still reach the worker through it.
  const sent = await f.call('send_to_thread', { requestId: f.requestA, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic continuation of a steered instruction' })
  expect(sent, JSON.stringify(sent)).toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' } })
}, 60_000)

it('keeps an instruction inside its request when the takeover was on a thread the request never used', async () => {
  // Bug Bot finding 4 on #1163: a takeover anywhere split the next queued instruction off request A.
  const f = await fixture(), other = randomUUID(), worker = f.thread(f.target.threadId)
  expect((await f.control.commandShell({ type: 'create-thread', threadId: other, projectId: worker.projectId, modelId: worker.modelId,
    title: 'Synthetic thread request A never used', runtimeMode: 'approval-required', workingCopy: 'shared' })).error).toBeNull()
  const otherTarget = { hostId: f.target.hostId, threadId: other }
  expect(await f.watcher.watchThread({ target: otherTarget })).toMatchObject({ status: 'ok' })
  await f.finish(f.target.threadId)
  expect((await f.control.commandShell({ type: 'configure-thread', threadId: other, reasoningEffort: 'high' })).error).toBeNull()
  await expect.poll(() => f.control.watcherRecord().localTakeovers?.some(item => item.target.threadId === other)).toBe(true)
  expect(f.participationA().state).toBe('participating')
  const text = 'Synthetic instruction after an unrelated takeover'
  expect((await f.control.commandShell({ type: 'queue-followup', threadId: f.watcherId, draftId: randomUUID(), text })).error).toBeNull()
  const requests = f.control.watcherRecord().requests.length
  await f.advanceToQueuedTurn(f.watcherId, text)
  expect(f.control.watcherRecord().requests).toHaveLength(requests)
  expect(carryingHead(f)?.id).toBe(f.requestA)
  expect(await f.call('send_to_thread', { requestId: f.requestA, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic continuation of request A' })).toMatchObject({ status: 'ok' })
}, 60_000)

it('keeps an instruction queued to a busy Watcher before the takeover inside request A', async () => {
  const f = await fixture()
  await f.finish(f.target.threadId)
  const text = 'Synthetic instruction queued to a busy Watcher before takeover'
  expect((await f.control.commandShell({ type: 'queue-followup', threadId: f.watcherId, draftId: randomUUID(), text })).error).toBeNull()
  expect((await f.control.commandShell({ type: 'configure-thread', threadId: f.target.threadId, reasoningEffort: 'high' })).error).toBeNull()
  await expect.poll(() => f.control.watcherRecord().localTakeovers?.some(item => item.target.threadId === f.target.threadId)).toBe(true)
  await expect.poll(() => f.row().paused).toBe(false)
  expect(f.participationA().state).toBe('participating')
  const requests = f.control.watcherRecord().requests.length
  await f.advanceToQueuedTurn(f.watcherId, text)
  // It was given before the user's change, so it continues request A, which the watch keeps sending (ADR-0073).
  expect(f.control.watcherRecord().requests).toHaveLength(requests)
  expect(carryingHead(f)?.id).toBe(f.requestA)
  const sent = await f.call('send_to_thread', { requestId: f.requestA, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic earlier continuation' })
  expect(sent, JSON.stringify(sent)).toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' } })
}, 60_000)

it('keeps an instruction queued between two takeovers inside its earlier request', async () => {
  const f = await fixture()
  await f.finish(f.target.threadId)
  expect((await f.control.commandShell({ type: 'configure-thread', threadId: f.target.threadId, reasoningEffort: 'high' })).error).toBeNull()
  await expect.poll(() => f.control.watcherRecord().localTakeovers?.some(item => item.target.threadId === f.target.threadId)).toBe(true)
  expect(f.participationA().state).toBe('participating')
  const text = 'Synthetic instruction queued between two takeovers'
  expect((await f.control.commandShell({ type: 'queue-followup', threadId: f.watcherId, draftId: randomUUID(), text })).error).toBeNull()
  // The user changes the worker again before Watcher reads the instruction, so the instruction predates this takeover.
  expect((await f.control.commandShell({ type: 'configure-thread', threadId: f.target.threadId, reasoningEffort: 'low' })).error).toBeNull()
  await expect.poll(() => f.row().paused).toBe(false)
  const requests = f.control.watcherRecord().requests.length
  await f.advanceToQueuedTurn(f.watcherId, text)
  expect(f.control.watcherRecord().requests).toHaveLength(requests)
  expect(carryingHead(f)?.id).toBe(f.requestA)
  const sent = await f.call('send_to_thread', { requestId: f.requestA, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic continuation between takeovers' })
  expect(sent, JSON.stringify(sent)).toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' } })
}, 60_000)

it('ends a request with no participants when its queued instruction starts a fresh one', async () => {
  const f = await fixture()
  await f.finish(f.target.threadId)
  await f.finish(f.watcherId)
  // Watcher is busy with request C, which never sent to the worker; the takeover's boundary still fences C.
  const requestC = await f.request('Synthetic request C without workers')
  expect((await f.control.commandShell({ type: 'configure-thread', threadId: f.target.threadId, reasoningEffort: 'high' })).error).toBeNull()
  await expect.poll(() => f.control.watcherRecord().localTakeovers?.find(item => item.target.threadId === f.target.threadId)?.lastRequestId).toBe(requestC)
  await expect.poll(() => f.row().paused).toBe(false)
  const text = 'Synthetic instruction queued behind request C'
  expect((await f.control.commandShell({ type: 'queue-followup', threadId: f.watcherId, draftId: randomUUID(), text })).error).toBeNull()
  await f.advanceToQueuedTurn(f.watcherId, text)
  const head = f.thread(f.watcherId).lastUserMessageId
  const carrying = f.control.watcherRecord().requests.find(item => item.rootUserMessageId === head)
  expect(carrying, 'the queued instruction has a fresh request').toBeDefined()
  expect(await f.call('send_to_thread', { requestId: carrying!.id, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic continuation from the instruction behind C' })).toMatchObject({ status: 'ok' })
  // C ends with the turn its instruction moved to, as it would have had the instruction stayed with it.
  await f.finish(f.watcherId)
  await expect.poll(() => f.control.watcherRecord().requests.find(item => item.id === requestC)?.state).toBe('closed')
  expect(await f.call('send_to_thread', { requestId: requestC, retryKey: randomUUID(), target: f.target,
    delivery: 'queue', text: 'Synthetic forbidden request C continuation' })).toMatchObject({ status: 'refused' })
}, 60_000)

it('keeps a request with no participants open while an earlier instruction to it is still queued', async () => {
  const f = await fixture()
  await f.finish(f.target.threadId)
  await f.finish(f.watcherId)
  const requestC = await f.request('Synthetic request C with two queued instructions')
  const earlier = { draftId: randomUUID(), text: 'Synthetic instruction queued before takeover behind C' }
  const later = { draftId: randomUUID(), text: 'Synthetic instruction queued after takeover behind C' }
  expect((await f.control.commandShell({ type: 'queue-followup', threadId: f.watcherId, ...earlier })).error).toBeNull()
  expect((await f.control.commandShell({ type: 'configure-thread', threadId: f.target.threadId, reasoningEffort: 'high' })).error).toBeNull()
  await expect.poll(() => f.row().paused).toBe(false)
  expect((await f.control.commandShell({ type: 'queue-followup', threadId: f.watcherId, ...later })).error).toBeNull()
  // The user moves the later instruction to the front, so it reaches Watcher while the earlier one still waits for C.
  const queued = f.control.shell().followups!.filter(item => item.threadId === f.watcherId)
  const ids = [later, earlier].map(draft => queued.find(item => item.draftId === draft.draftId)!.id)
  expect((await f.control.commandShell({ type: 'reorder-followups', threadId: f.watcherId, itemIds: ids })).error).toBeNull()
  await f.advanceToQueuedTurn(f.watcherId, later.text)
  expect(f.control.watcherRecord().requests.find(item => item.rootUserMessageId === f.thread(f.watcherId).lastUserMessageId)?.id).not.toBe(requestC)
  expect(f.control.watcherRecord().requests.find(item => item.id === requestC)).toMatchObject({ state: 'active', userFollowups: [{ draftId: earlier.draftId }] })
  // Removing that earlier instruction afterwards leaves C nothing to wait for, so it ends with Watcher's turn.
  const itemId = f.control.shell().followups!.find(item => item.draftId === earlier.draftId)!.id
  expect((await f.control.commandShell({ type: 'remove-followup', threadId: f.watcherId, itemId })).error).toBeNull()
  await f.finish(f.watcherId)
  await expect.poll(() => f.control.watcherRecord().requests.find(item => item.id === requestC)?.state).toBe('closed')
}, 60_000)

it('ends a request with no participants when the only other instruction to it was removed', async () => {
  const f = await fixture()
  await f.finish(f.target.threadId)
  await f.finish(f.watcherId)
  const requestC = await f.request('Synthetic request C with a removed instruction')
  const earlier = { draftId: randomUUID(), text: 'Synthetic removed instruction behind C' }
  expect((await f.control.commandShell({ type: 'queue-followup', threadId: f.watcherId, ...earlier })).error).toBeNull()
  expect((await f.control.commandShell({ type: 'configure-thread', threadId: f.target.threadId, reasoningEffort: 'high' })).error).toBeNull()
  await expect.poll(() => f.row().paused).toBe(false)
  const text = 'Synthetic kept instruction behind C'
  expect((await f.control.commandShell({ type: 'queue-followup', threadId: f.watcherId, draftId: randomUUID(), text })).error).toBeNull()
  const itemId = f.control.shell().followups!.find(item => item.draftId === earlier.draftId)!.id
  expect((await f.control.commandShell({ type: 'remove-followup', threadId: f.watcherId, itemId })).error).toBeNull()
  await f.advanceToQueuedTurn(f.watcherId, text)
  await f.finish(f.watcherId)
  await expect.poll(() => f.control.watcherRecord().requests.find(item => item.id === requestC)?.state).toBe('closed')
}, 60_000)

it('delivers an instruction queued before the user stopped Watcher under a request of its own (#1184)', async () => {
  const f = await fixture()
  await f.finish(f.target.threadId)
  expect((await f.control.commandShell({ type: 'configure-thread', threadId: f.target.threadId, reasoningEffort: 'high' })).error).toBeNull()
  await expect.poll(() => f.row().paused).toBe(false)
  const text = 'Synthetic instruction queued before the user stopped Watcher'
  expect((await f.control.commandShell({ type: 'queue-followup', threadId: f.watcherId, draftId: randomUUID(), text })).error).toBeNull()
  const requests = f.control.watcherRecord().requests.length
  // Stop comes after the instruction, so the instruction is no longer the user's latest word.
  expect((await f.control.commandShell({ type: 'interrupt', threadId: f.watcherId })).error).toBeNull()
  await expect.poll(() => f.thread(f.watcherId).status).not.toBe('running')
  if (f.control.shell().followups?.some(item => item.threadId === f.watcherId)) {
    expect((await f.control.commandShell({ type: 'resume-followups', threadId: f.watcherId })).error).toBeNull()
  }
  await expect.poll(() => f.thread(f.watcherId).messages.findLast(item => item.role === 'user')?.text).toBe(text)
  // The Stop ended the request the instruction was queued under; the instruction is the user's word and starts its own.
  const delivered = f.thread(f.watcherId).messages.findLast(item => item.role === 'user')!.id
  expect(f.control.watcherRecord().requests).toHaveLength(requests + 1)
  expect(f.control.watcherRecord().requests.find(item => item.rootUserMessageId === delivered)).toMatchObject({ state: 'active' })
  expect(f.control.watcherRecord().requests.find(item => item.id === f.requestA)?.state).not.toBe('active')
  // The stopped request stays stopped.
  expect(await f.call('send_to_thread', { requestId: f.requestA, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic forbidden continuation after Stop' })).toMatchObject({ status: 'refused' })
}, 60_000)

it('holds requests to steering, and refuses unasked stops, until the user turn ends', async () => {
  const f = await fixture(), userText = 'Synthetic running user turn'
  expect((await f.control.commandShell({ type: 'manual-send', threadId: f.target.threadId, draftId: randomUUID(), text: userText })).error).toBeNull()
  await f.finish(f.watcherId)
  const requestB = await f.request('Synthetic request B during the user turn')
  expect(f.participationA().state).toBe('participating')
  expect(f.row()).toMatchObject({ watched: true, paused: true })
  const operations = f.control.watcherRecord().operations.length
  const held = async () => {
    for (const requestId of [f.requestA, requestB]) for (const delivery of ['now', 'queue']) expect(await f.call('send_to_thread', {
      requestId, retryKey: randomUUID(), target: f.target, delivery, text: 'Synthetic held prompt during the user turn',
    })).toMatchObject({ status: 'refused', code: 'THREAD_BUSY' })
    for (const requestId of [f.requestA, requestB]) expect(await f.call('settle_thread', { requestId, retryKey: randomUUID(), target: f.target }))
      .toMatchObject({ status: 'refused', code: 'THREAD_BUSY' })
    expect(f.control.watcherRecord().operations).toHaveLength(operations)
  }
  // Watcher's first turn still runs with the user's turn queued behind it: nothing may go ahead of the user's turn.
  await held()
  await f.advanceToQueuedTurn(f.target.threadId, userText)
  // Now the user's own turn runs. Request A's Watcher turn is over and a standing watch never asks for a stop, so
  // neither may stop it (ADR-0073); only request B's turn answers the user's own message and is left untried here.
  await held()
  for (const requestId of [f.requestA, f.watchId]) expect(await f.call('stop_thread', { requestId, retryKey: randomUUID(), target: f.target }))
    .toMatchObject({ status: 'refused', code: 'THREAD_BUSY' })
  expect(f.control.watcherRecord().operations).toHaveLength(operations)
  const steered = await f.call('send_to_thread', { requestId: requestB, retryKey: randomUUID(), target: f.target, delivery: 'steer',
    expectedTurnId: f.thread(f.target.threadId).lastTurn?.id, text: 'Synthetic steer into the user turn' })
  expect(steered, JSON.stringify(steered)).toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' } })
  await f.finish(f.target.threadId)
  await expect.poll(() => f.control.hasPendingThreadWork(f.target.threadId)).toBe(false)
  await expect.poll(() => f.row().paused).toBe(false)
  expect(await f.call('send_to_thread', { requestId: requestB, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic fresh prompt after the user turn' })).toMatchObject({ status: 'ok' })
  await f.finish(f.target.threadId)
  expect(await f.call('send_to_thread', { requestId: f.requestA, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic request A prompt after the user turn' })).toMatchObject({ status: 'ok' })
}, 60_000)

it('keeps a pre-existing nonparticipant request fenced through restart on a thread watched for a request alone', async () => {
  const f = await fixture()
  await f.finish(f.target.threadId); await f.finish(f.watcherId)
  const requestB = await f.request('Synthetic request B before takeover')
  expect(f.watcher.state().requests.find(item => item.id === requestB)?.participants).toEqual([])
  // Watched for request A alone, as on an older paired host, the thread becomes the user's again (ADR-0073).
  await f.control.updateWatcher(record => { record.watches = [] })
  expect((await f.control.commandShell({ type: 'configure-thread', threadId: f.target.threadId, reasoningEffort: 'high' })).error).toBeNull()
  expect(f.participationA()).toMatchObject({ state: 'taken-over', takeover: { reason: 'user-reconfigure' } })
  await f.restart()
  expect(f.control.watcherRecord().watches ?? []).toEqual([])
  expect(f.participationA()).toMatchObject({ state: 'taken-over', takeover: { reason: 'user-reconfigure' } })
  for (const requestId of [f.requestA, requestB]) expect(await f.call('send_to_thread', {
    requestId, retryKey: randomUUID(), target: f.target, delivery: 'now', text: 'Synthetic old request after restart',
  })).toMatchObject({ status: 'refused', code: 'THREAD_TAKEN_OVER' })
  // The user's own Watch hands the thread back, and from then on the watch decides.
  expect(await f.watcher.watchThread({ target: f.target })).toMatchObject({ status: 'ok' })
  expect(f.watcher.state().standingWatches![0]!.id).not.toBe(f.watchId)
  const resumed = await f.call('send_to_thread', { requestId: requestB, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic pre-existing request after the user watched again' })
  expect(resumed, JSON.stringify(resumed)).toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' } })
  await f.finish(f.target.threadId)
  await f.finish(f.watcherId)
  const requestC = await f.request('Synthetic request C after takeover and rewatch')
  expect(await f.call('send_to_thread', { requestId: requestC, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic fresh request after rewatch' })).toMatchObject({ status: 'ok' })
}, 60_000)

it('lets a request the user sends after taking over a thread watched for a request alone reach it, and keeps the earlier one fenced (#1148)', async () => {
  const f = await fixture(), userText = 'Synthetic user takeover of a request-only thread'
  await f.finish(f.target.threadId)
  // Watched for request A alone: the user's own message takes the thread back from A (ADR-0073).
  await f.control.updateWatcher(record => { record.watches = [] })
  expect((await f.control.commandShell({ type: 'manual-send', threadId: f.target.threadId, draftId: randomUUID(), text: userText })).error).toBeNull()
  await expect.poll(() => f.participationA()).toMatchObject({ state: 'taken-over', takeover: { reason: 'user-send' } })
  await expect.poll(() => f.thread(f.target.threadId).lastTurn?.status).toBe('running')
  const at = f.participationA().takeover!.at
  await f.finish(f.watcherId)
  const requestB = await f.request('Synthetic request B after the takeover')
  const send = (requestId: string, delivery: 'now' | 'queue' | 'steer') => f.call('send_to_thread', { requestId, retryKey: randomUUID(), target: f.target, delivery,
    text: `Synthetic ${delivery} send`, ...delivery === 'steer' ? { expectedTurnId: f.thread(f.target.threadId).lastTurn?.id } : {} })
  // Request A is over for this thread, and its refusal says how and when the user took it, and what does reach it.
  const refusedA = await send(f.requestA, 'now')
  expect(refusedA).toMatchObject({ status: 'refused', code: 'THREAD_TAKEN_OVER', retryable: false })
  expect(refusedA.status === 'refused' && refusedA.message).toBe(`The user sent this thread a message at ${at}, after this request began, so this request no longer sends to it. Nothing was sent. A message the user sends Watcher after that starts a request that reaches the thread; while the user’s own turn there runs, it can only steer it.`)
  // While the user's own turn runs, request B may only steer it, and is told to send once it ends.
  for (const delivery of ['now', 'queue'] as const) expect(await send(requestB, delivery)).toMatchObject({ status: 'refused', code: 'THREAD_BUSY', retryable: true })
  const steered = await send(requestB, 'steer')
  expect(steered, JSON.stringify(steered)).toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' } })
  await f.finish(f.target.threadId)
  await expect.poll(() => f.control.hasPendingThreadWork(f.target.threadId)).toBe(false)
  // Once it ends, request B sends. Its first send watched the thread, as every Watcher send does, so from then on the
  // watch decides (ADR-0073, October 19) and request A's participation follows it again.
  const sent = await send(requestB, 'now')
  expect(sent, JSON.stringify(sent)).toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' } })
  expect(f.control.watcherRecord().watches).toEqual([expect.objectContaining({ target: f.target })])
  await f.finish(f.target.threadId)
}, 60_000)

it('keeps an unparticipated worker’s takeover boundary through an unrelated takeover, then sends after rewatch', async () => {
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
  // The unwatched worker's fence gives the renewed watch its takeover boundary again.
  expect(f.control.watcherRecord().localTakeovers).toContainEqual(expect.objectContaining({ target, lastRequestId: f.requestA }))
  // The user's Watch gives the thread back, and a watched thread's takeover fences no request (ADR-0073).
  const resumed = await f.call('send_to_thread', { requestId: f.requestA, retryKey: randomUUID(), target,
    delivery: 'now', text: 'Synthetic pre-user request continuation after rewatch' })
  expect(resumed, JSON.stringify(resumed)).toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' } })
  expect(participations()).toContainEqual(expect.objectContaining({ requestId: f.requestA, state: 'participating' }))
  await f.finish(target.threadId)

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
  expect(f.participationA().state).toBe('participating')
}, 60_000)

it('keeps the latest takeover through restart while a request between two takeovers still sends', async () => {
  const f = await fixture()
  await f.finish(f.target.threadId)
  expect((await f.control.commandShell({ type: 'configure-thread', threadId: f.target.threadId, reasoningEffort: 'high' })).error).toBeNull()
  await f.finish(f.watcherId)
  const requestB = await f.request('Synthetic request between two user reconfigurations')
  expect((await f.control.commandShell({ type: 'configure-thread', threadId: f.target.threadId, reasoningEffort: 'low' })).error).toBeNull()
  // The marker follows the latest takeover, which came after B. It still orders when an instruction starts a request.
  const marker = f.control.watcherRecord().localTakeovers!.find(item => item.target.threadId === f.target.threadId)!
  expect(marker.lastRequestId).toBe(requestB)
  expect(f.participationA()).toMatchObject({ state: 'participating' })
  expect(f.participationA().takeover).toBeUndefined()
  // On a watched thread no takeover fences a request (ADR-0073), so B sends although it predates the latest one.
  expect(await f.call('send_to_thread', { requestId: requestB, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic request that predates the latest takeover' })).toMatchObject({ status: 'ok' })
  await f.restart()
  expect(f.control.watcherRecord().localTakeovers!.find(item => item.target.threadId === f.target.threadId)).toEqual(marker)
  await f.finish(f.target.threadId)
  await f.finish(f.watcherId)
  const requestC = await f.request('Synthetic request after the latest reconfiguration')
  expect(await f.call('send_to_thread', { requestId: requestC, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic fresh continuation after the latest takeover' })).toMatchObject({ status: 'ok' })
}, 60_000)

it('keeps a legacy request-only takeover fenced until the user watches the thread again', async () => {
  const f = await fixture()
  await f.finish(f.target.threadId)
  // Watched for request A alone, as on an older paired host, the user's change takes the thread back (ADR-0073).
  await f.control.updateWatcher(record => { record.watches = [] })
  expect((await f.control.commandShell({ type: 'configure-thread', threadId: f.target.threadId, reasoningEffort: 'high' })).error).toBeNull()
  expect(f.participationA()).toMatchObject({ state: 'taken-over', takeover: { reason: 'user-reconfigure' } })
  // Earlier records retained first-takeover provenance but not a reliable newest local takeover marker.
  await f.control.updateWatcher(record => { delete record.localTakeovers })
  await f.finish(f.watcherId)
  const requestB = await f.request('Synthetic fresh request with legacy evidence')
  for (const requestId of [f.requestA, requestB]) {
    const refused = await f.call('send_to_thread', { requestId, retryKey: randomUUID(), target: f.target, delivery: 'now', text: 'Synthetic conservative legacy continuation' })
    expect(refused).toMatchObject({ status: 'refused', code: 'THREAD_TAKEN_OVER' })
    // With no local record a later request does not lift the fence, so the refusal points at the watch instead (#1148).
    expect(refused.status === 'refused' && refused.message).toContain('A later request does not lift this here; Watcher reaches the thread again under its standing watch once the user watches it.')
  }
  // The user's own Watch hands the thread back and establishes a boundary of its own; from then on the watch decides.
  expect(await f.watcher.watchThread({ target: f.target })).toMatchObject({ status: 'ok' })
  expect(f.control.watcherRecord().localTakeovers).toContainEqual(expect.objectContaining({ target: f.target, lastRequestId: requestB }))
  const renewed = await f.call('send_to_thread', { requestId: requestB, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic legacy continuation under the renewed watch' })
  expect(renewed, JSON.stringify(renewed)).toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' } })
  expect(f.participationA().state).toBe('participating')
}, 60_000)

it('still fences what Watcher prepared before a known direct delivery made in stable when Owl returns', async () => {
  const f = await fixture()
  await f.finish(f.target.threadId)
  const generation = f.watch()!.generation
  await f.restart(false)
  expect((await f.control.commandShell({ type: 'manual-send', threadId: f.target.threadId, draftId: randomUUID(), text: 'Synthetic direct stable prompt' })).error).toBeNull()
  await f.finish(f.target.threadId)
  await f.restart()
  // The user's stable delivery moves the watch and request A on a generation, but the watch keeps the thread (ADR-0073).
  await expect.poll(() => f.control.watcherRecord().localTakeovers?.find(item => item.target.threadId === f.target.threadId)).toBeDefined()
  await expect.poll(() => f.watch()!.generation).toBeGreaterThan(generation)
  expect(f.participationA()).toMatchObject({ state: 'participating', generation: f.watch()!.generation })
  expect(f.participationA().takeover).toBeUndefined()
  expect(f.row()).toMatchObject({ watched: true, paused: false })
}, 60_000)

it('orders a takeover after a request by retained requests when the clock moves backward', async () => {
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
  // The second takeover's wall time is earlier than B's, but the retained request order puts it after B.
  expect(f.control.watcherRecord().localTakeovers!.find(item => item.target.threadId === f.target.threadId)!.lastRequestId).toBe(requestB)
  // That order still decides whether an instruction queued to a busy Watcher starts a request of its own.
  const text = 'Synthetic instruction queued after the rolled-back takeover'
  expect((await f.control.commandShell({ type: 'queue-followup', threadId: f.watcherId, draftId: randomUUID(), text })).error).toBeNull()
  vi.setSystemTime(new Date('2026-10-17T09:00:00.000Z'))
  await f.advanceToQueuedTurn(f.watcherId, text)
  const carrying = carryingHead(f)
  expect(carrying, 'the queued instruction has a request').toBeDefined()
  expect([f.requestA, requestB]).not.toContain(carrying!.id)
  expect(await f.call('send_to_thread', { requestId: carrying!.id, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic fresh request after clock rollback' })).toMatchObject({ status: 'ok' })
}, 60_000)

it('lets a watched thread’s request send when its takeover frontier is missing', async () => {
  const f = await fixture()
  await f.finish(f.target.threadId)
  expect((await f.control.commandShell({ type: 'configure-thread', threadId: f.target.threadId, reasoningEffort: 'high' })).error).toBeNull()
  await f.finish(f.watcherId)
  const requestB = await f.request('Synthetic fresh request with missing frontier')
  await f.control.updateWatcher(record => { record.localTakeovers!.find(item => item.target.threadId === f.target.threadId)!.lastRequestId = randomUUID() })
  // Under a standing watch the watch decides, not the takeover's ordering evidence (ADR-0073).
  expect(await f.call('send_to_thread', { requestId: requestB, retryKey: randomUUID(), target: f.target,
    delivery: 'now', text: 'Synthetic request with unavailable ordering evidence' })).toMatchObject({ status: 'ok' })
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
  // The newer stable input holds Watcher to steering while it runs, as the user's own turn (ADR-0073).
  expect(f.row()).toMatchObject({ watched: true, paused: true })
  expect(f.participationA().state).toBe('participating')
  for (const delivery of ['now', 'queue']) expect(await f.call('send_to_thread', { requestId: requestB, retryKey: randomUUID(), target: f.target,
    delivery, text: 'Synthetic pre-existing request behind stable input' })).toMatchObject({ status: 'refused', code: 'THREAD_BUSY' })
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
