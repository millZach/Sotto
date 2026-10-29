// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { deferred } from '../fixtures/deferred'
import { WatcherService } from '../../src/main/agents/watcher'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import { watcherToolSchemas, type WatcherToolName, type WatcherToolOutput } from '../../src/shared/watcher'
import type { WatcherHostControl, WatcherHostProjection, WatcherRemoteHosts } from '../../src/shared/watcherHost'
import type { AgentControl } from '../../src/main/agents/control'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { WATCHER_WAKE_UP_PROMPT } from '../../src/main/agents/watcherNews'
import { watcherRequestLine, watcherRequestNote } from '../../src/main/agents/watcherRequestNote'
import { isWatcherWakeUpTurn } from '../../src/shared/threadActivity'
import { SLASH_COMMAND_REFUSAL, UNCONFIRMED_SEND_HOLD, USER_TURN_RUNNING } from '../../src/main/agents/watcherSendHolds'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture(workerHost = false, open = true) {
  const workspace = await workspaceFixture()
  cleanups.push(workspace.remove)
  workspace.adapters.codex.state.capabilities.steer = true
  workspace.adapters.codex.state.models[0]!.runtimeModes = ['approval-required', 'auto-accept-edits', 'auto', 'full-access']
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' },
    control: { watcherEnabled: true, historyEnabled: () => true } })
  let control: AgentControl = f.control
  const makeService = () => new WatcherService({ directory: f.root, host: workspace.host, control, historyEnabled: () => true, workerHost })
  let service = makeService()
  let toolServer = new WatcherToolServer(service)
  workspace.host.useWatcherTools(toolServer)
  cleanups.push(async () => { service.close(); await toolServer.close(); await f.dispose(); await control.closed(); await workspace.stop() })
  await control.start(); await control.commandShell({ type: 'connect', provider: 'codex' }); await service.recover()
  const model = control.watcherSnapshot().models.find(item => item.providerId === 'codex')!
  const project = control.watcherSnapshot().projects.find(item => item.providerId === 'codex')!
  if (!workerHost && open) { const opened = await service.open({ provider: 'codex', modelId: model.id }); expect(opened, JSON.stringify(opened)).toMatchObject({ status: 'ok' }) }
  const watcherId = () => service.state().current!.target.threadId
  const call = async <N extends WatcherToolName>(name: N, input: unknown) => watcherToolSchemas[name].output.parse(await service.invoke(watcherId(), name, input)) as WatcherToolOutput<N>
  const create = async () => {
    const threadId = randomUUID()
    expect((await control.commandShell({ type: 'create-thread', threadId, projectId: project.id, modelId: model.id,
      title: 'Synthetic existing worker', runtimeMode: 'approval-required', workingCopy: 'shared' })).error).toBeNull()
    return { hostId: control.hostId()!, threadId }
  }
  const native = (threadId: string) => workspace.adapters.codex.state.threads.find(thread => thread.id === workspace.registry.byThread(threadId)!.sessionId)!
  const finish = async (threadId: string) => {
    const thread = native(threadId); thread.status = 'idle'; thread.lastTurn = { id: thread.lastTurn?.id ?? randomUUID(), status: 'completed' }
    workspace.adapters.codex.emit(); await control.commandShell({ type: 'refresh', provider: 'codex' })
  }
  return { f, workspace, model, project, call, create, native, finish, watcherId,
    get control() { return control }, get service() { return service },
    restart: async () => {
      service.close(); await toolServer.close(); control.dispose(); await control.closed()
      control = f.create(); service = makeService(); toolServer = new WatcherToolServer(service); workspace.host.useWatcherTools(toolServer)
      await control.start(); await control.commandShell({ type: 'connect', provider: 'codex' }); await service.recover()
    },
    request: async () => {
      expect((await control.commandShell({ type: 'manual-send', threadId: watcherId(), draftId: randomUUID(), text: 'Synthetic coordination request' })).error).toBeNull()
      return service.state().requests.at(-1)!.id
    },
  }
}

it('watches without sending, survives request closure and process-state restart, and withdraws all news', async () => {
  const f = await fixture(), target = await f.create(), requestId = await f.request()
  await f.control.commandShell({ type: 'manual-send', threadId: target.threadId, draftId: randomUUID(), text: 'Synthetic existing turn' })
  await f.finish(target.threadId)
  const before = f.workspace.adapters.codex.commands.filter(command => command.type === 'send').length
  const watched = await f.call('watch_thread', { target })
  expect(watched.status).toBe('ok')
  expect(f.workspace.adapters.codex.commands.filter(command => command.type === 'send')).toHaveLength(before)
  await f.finish(f.watcherId())
  expect(f.service.state().requests.find(request => request.id === requestId)?.state).toBe('closed')
  const watch = f.service.state().standingWatches![0]!
  await f.restart()
  expect(f.service.state().standingWatches).toEqual([watch])
  const roster = await f.call('list_threads', { detail: 'full' })
  expect(roster.status === 'ok' && (roster.rows.find(row => row.target.threadId === target.threadId) as { standingWatch?: { id: string } } | undefined)?.standingWatch?.id).toBe(watch.id)
  // The slim roster, its default, names the watch too (#1191).
  expect(await f.call('list_threads', {})).toMatchObject({ rows: expect.arrayContaining([expect.objectContaining({ target, watched: true, standingWatchId: watch.id })]) })
  // Real adapters publish the native head even when the master has no open message window.
  const master = f.native(f.watcherId())
  master.lastUserMessageId = master.messages.findLast(message => message.role === 'user')?.id
  const native = f.native(target.threadId)
  native.requests = [{ id: 'synthetic-card', kind: 'question', text: 'Synthetic question', options: [] }]
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  const news = f.service.state().news!.find(event => event.kind === 'needs-user')!
  expect(news).toMatchObject({ requestId: watch.id, target })
  expect(f.service.wakeDueAll([news])).toEqual([true])
  await f.control.deliverWakeUp(f.watcherId(), { source: 'watcher', watcher: f.service.state().current!.target, events: [news], omitted: 0 }, { tool: false })
  expect(f.service.wakeReady()).toBe(true)
  // The news, with the standing watch's request, travels beside Sotto's short message.
  const sessionId = f.workspace.registry.byThread(f.watcherId())!.sessionId
  await expect.poll(() => f.workspace.adapters.codex.commands.findLast(command => command.type === 'send' && command.threadId === sessionId)).toMatchObject({
    text: WATCHER_WAKE_UP_PROMPT, watcherNews: expect.stringContaining(`Use requestId ${watch.id}`) })
  expect(await f.call('unwatch_thread', { target })).toMatchObject({ status: 'ok', watched: false })
  expect(f.service.wakeDueAll([news])).toEqual([false])
  expect(f.service.state().news).toEqual([])
  expect(f.service.state().watchedThreads.find(row => row.target.threadId === target.threadId)?.watched).not.toBe(true)
})

it('takes a watch with watch_thread only while answering the user’s own message, and keeps sending under the user’s watch', async () => {
  const f = await fixture(), target = await f.create()
  const sends = () => f.workspace.adapters.codex.commands.filter(command => command.type === 'send' && command.threadId !== undefined).length
  // On its own initiative, with no message from the user: nothing is watched.
  expect(await f.call('watch_thread', { target })).toMatchObject({ status: 'refused', code: 'REQUEST_NOT_ACTIVE' })
  expect(f.service.state().standingWatches ?? []).toEqual([])
  // Asked in the user's message: the watch is taken.
  await f.request()
  expect(await f.call('watch_thread', { target })).toMatchObject({ status: 'ok' })
  expect(await f.call('unwatch_thread', { target })).toMatchObject({ status: 'ok', watched: false })
  // A wake-up or any other message that is not the user's request answers nothing: no watch from it.
  const master = f.native(f.watcherId())
  master.messages.push({ id: randomUUID(), role: 'user', text: 'Synthetic Sotto news', createdAt: new Date().toISOString() })
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  expect(await f.call('watch_thread', { target })).toMatchObject({ status: 'refused', code: 'REQUEST_NOT_ACTIVE' })
  expect(f.service.state().standingWatches ?? []).toEqual([])
  // The user's own Watch still gives the thread to Watcher, which sends under it without asking again.
  await f.service.watchThread({ target })
  const watch = f.service.state().standingWatches![0]!
  const before = sends()
  expect(await f.call('send_to_thread', { requestId: watch.id, retryKey: randomUUID(), target, text: 'Synthetic standing continuation', delivery: 'now' })).toMatchObject({ status: 'ok' })
  expect(sends()).toBe(before + 1)
})

/**
 * The user's steer into Watcher's running turn, which the provider takes as the turn's newest user message. This fake has no
 * read that confirms a steer, so the coordinator may call it unconfirmed; it was dispatched all the same.
 */
async function steerIn(f: Awaited<ReturnType<typeof fixture>>, draftId: string, text: string, shown = true) {
  const codex = f.workspace.adapters.codex
  if (vi.isMockFunction(codex.execute)) vi.mocked(codex.execute).mockRestore()
  const execute = codex.execute.bind(codex)
  vi.spyOn(codex, 'execute').mockImplementation(async command => {
    if (command.type !== 'steer') return execute(command)
    codex.commands.push(structuredClone(command))
    if (shown) {
      const master = codex.state.threads.find(thread => thread.id === command.threadId)!
      master.messages.push({ id: command.messageId, commandId: command.commandId, role: 'user', text: command.text, createdAt: new Date().toISOString() }); master.lastUserMessageId = command.messageId
      codex.emit()
    }
    return { accepted: true }
  })
  const before = codex.commands.filter(command => command.type === 'steer').length
  await f.control.commandShell({ type: 'steer', threadId: f.watcherId(), draftId, text })
  const steers = codex.commands.filter(command => command.type === 'steer')
  expect(steers).toHaveLength(before + 1)
  const steer = steers.at(-1)
  if (steer?.type !== 'steer') throw new Error('The steer was not sent')
  return steer
}

it('lets Watcher take a watch for a message the user steered into its turn on the user’s request (#1188)', async () => {
  const f = await fixture(), target = await f.create(), requestId = await f.request()
  const draftId = randomUUID(), text = 'Synthetic steer: watch that thread too'
  const steer = await steerIn(f, draftId, text)
  expect(steer.text).toBe(text)
  expect(f.service.state().requests.find(request => request.id === requestId)).toMatchObject({ state: 'active', userFollowups: [{ draftId, messageId: steer.messageId }] })
  expect(await f.call('watch_thread', { target })).toMatchObject({ status: 'ok' })
})

/** Sotto's news of a watched thread's question, sent to Watcher through its queue as the coordinator sends it; Watcher's turn on it then runs. */
async function startNews(f: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  const watched = await f.create()
  await f.control.commandShell({ type: 'manual-send', threadId: watched.threadId, draftId: randomUUID(), text: 'Synthetic existing turn' })
  await f.finish(watched.threadId)
  expect(await f.service.watchThread({ target: watched })).toMatchObject({ status: 'ok' })
  f.native(watched.threadId).requests = [{ id: 'synthetic-card', kind: 'question', text: 'Synthetic question', options: [] }]
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  await vi.waitFor(() => expect(f.service.state().news?.some(event => event.kind === 'needs-user')).toBe(true), { timeout: 30_000 })
  const event = f.service.state().news!.find(item => item.kind === 'needs-user')!
  // Real adapters publish the native head even when the master has no open message window.
  const master = f.native(f.watcherId())
  master.lastUserMessageId = master.messages.findLast(message => message.role === 'user')?.id
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  await f.control.deliverWakeUp(f.watcherId(), { source: 'watcher', watcher: f.service.state().current!.target, events: [event], omitted: 0 }, { tool: false })
  const sessionId = f.workspace.registry.byThread(f.watcherId())!.sessionId
  await vi.waitFor(() => expect(f.workspace.adapters.codex.commands.some(command => command.type === 'send' && command.threadId === sessionId && command.text === WATCHER_WAKE_UP_PROMPT)).toBe(true), { timeout: 30_000 })
  const sent = f.workspace.adapters.codex.commands.findLast(command => command.type === 'send' && command.text === WATCHER_WAKE_UP_PROMPT)
  if (sent?.type !== 'send') throw new Error('The news was not sent')
  // The provider runs the news turn and has not yet published the news message as its newest head: Watcher's own record
  // of what it sent says whose turn it is.
  await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  await vi.waitFor(() => expect(f.control.get().host.threads.find(thread => thread.id === f.watcherId())?.status).toBe('running'), { timeout: 30_000 })
  expect(isWatcherWakeUpTurn(f.control.get().host.threads.find(thread => thread.id === f.watcherId())!)).toBe(false)
  await vi.waitFor(() => expect(f.control.watcherWakeUpTurn(f.watcherId())).toBe(true), { timeout: 30_000 })
  return sent.messageId
}
/** Ends Watcher's turn and returns the user's message the queue sends next, once the provider published it as the newest. */
async function deliverQueued(f: Awaited<ReturnType<typeof fixture>>, text: string) {
  const master = f.native(f.watcherId())
  master.lastUserMessageId = master.messages.findLast(message => message.role === 'user')?.id
  await f.finish(f.watcherId())
  await vi.waitFor(() => expect(f.workspace.adapters.codex.commands.some(command => command.type === 'send' && command.text.startsWith(text))).toBe(true), { timeout: 30_000 })
  const sent = f.workspace.adapters.codex.commands.find(command => command.type === 'send' && command.text.startsWith(text))
  if (sent?.type !== 'send') throw new Error('The message was not sent')
  f.native(f.watcherId()).lastUserMessageId = sent.messageId
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  return sent
}

it('lets the user steer Watcher’s news turn, under a request of its own that Watcher can act on at once (#1188)', async () => {
  const f = await fixture(), target = await f.create()
  const earlier = await f.request(); await f.finish(f.watcherId())
  await startNews(f)
  expect(f.control.watcherWakeUpTurn(f.watcherId())).toBe(true)
  // The user steers from Watcher's window, so Watcher's conversation is what the window shows.
  await f.control.command({ type: 'observe-threads', threadIds: [f.watcherId()] })
  const draftId = randomUUID(), text = 'Synthetic: watch that thread again'
  const steer = await steerIn(f, draftId, text)
  // The steer opens a request of its own, rooted in its own message, and carries that request's line after the words.
  const request = f.service.state().requests.find(item => item.rootUserMessageId === steer.messageId)!
  expect(request).toMatchObject({ state: 'active', participants: [] })
  expect(request.id).not.toBe(earlier)
  expect(steer.text).toBe(text + watcherRequestLine(watcherRequestNote(request.id, f.control.hostId()!)))
  // Every copy of the message shows the words alone.
  await vi.waitFor(() => expect(f.control.get().host.threads.find(thread => thread.id === f.watcherId())!.messages.find(message => message.id === steer.messageId)?.text).toBe(text))
  // Watcher may act on it while the news turn runs: watch, and start under the new request.
  expect(await f.call('watch_thread', { target })).toMatchObject({ status: 'ok' })
  expect(await f.call('start_thread', { requestId: request.id, retryKey: randomUUID(), project: { hostId: f.control.hostId()!, projectId: f.project.id },
    modelId: f.model.id, title: 'Synthetic worker for the steer', workingCopy: { kind: 'shared' }, firstPrompt: 'Synthetic work' })).toMatchObject({ status: 'ok' })
  // A second steer into the same turn continues that request, and carries no line of its own.
  const secondDraft = randomUUID(), second = await steerIn(f, secondDraft, 'Synthetic: and the release checks')
  expect(second.text).toBe('Synthetic: and the release checks')
  expect(f.service.state().requests.find(item => item.id === request.id)!.userFollowups).toContainEqual({ draftId: secondDraft, messageId: second.messageId })
  expect(f.service.state().requests.filter(item => item.rootUserMessageId === second.messageId)).toEqual([])
})

it('lets Watcher act on a steer into a news turn it recovered, before the provider shows the steer (#1188)', async () => {
  const f = await fixture(), target = await f.create()
  await f.request(); await f.finish(f.watcherId())
  await startNews(f)
  // Sotto restarted while the news turn ran: this run has sent Watcher nothing.
  Reflect.set(f.service, 'lastSend', undefined)
  const steer = await steerIn(f, randomUUID(), 'Synthetic: watch that thread', false)
  const request = f.service.state().requests.find(item => item.rootUserMessageId === steer.messageId)!
  expect(request).toMatchObject({ state: 'active' })
  expect(await f.call('watch_thread', { target })).toMatchObject({ status: 'ok' })
})

it('queues a message while Watcher reads news though the last request holds all the messages it can (#1188)', async () => {
  const f = await fixture(), requestId = await f.request()
  await f.finish(f.watcherId())
  await f.control.updateWatcher(record => {
    record.requests.find(item => item.id === requestId)!.userFollowups = Array.from({ length: 1_000 }, () => ({ draftId: randomUUID(), messageId: randomUUID() }))
  })
  await startNews(f)
  const draftId = randomUUID(), text = 'Synthetic: one more thing'
  expect((await f.control.commandShell({ type: 'queue-followup', threadId: f.watcherId(), draftId, text })).error).toBeNull()
  const sent = await deliverQueued(f, text)
  const request = f.service.state().requests.find(item => item.rootUserMessageId === sent.messageId)!
  expect(request).toMatchObject({ state: 'active' })
  expect(request.id).not.toBe(requestId)
})

it('gives a message queued while Watcher reads news a request of its own, though the last request is still active (#1188)', async () => {
  const f = await fixture(), requestId = await f.request()
  // A worker the request started keeps it active.
  expect(await f.call('start_thread', { requestId, retryKey: randomUUID(), project: { hostId: f.control.hostId()!, projectId: f.project.id },
    modelId: f.model.id, title: 'Synthetic started worker', workingCopy: { kind: 'shared' }, firstPrompt: 'Synthetic work' })).toMatchObject({ status: 'ok' })
  await f.finish(f.watcherId())
  await startNews(f)
  const draftId = randomUUID(), text = 'Synthetic: start the release checks too'
  expect((await f.control.commandShell({ type: 'queue-followup', threadId: f.watcherId(), draftId, text })).error).toBeNull()
  expect(f.service.state().requests.find(request => request.id === requestId)).toMatchObject({ state: 'active' })
  expect(f.service.state().requests.find(request => request.id === requestId)!.userFollowups ?? []).not.toContainEqual(expect.objectContaining({ draftId }))
  const sent = await deliverQueued(f, text)
  const request = f.service.state().requests.at(-1)!
  expect(request.id).not.toBe(requestId)
  expect(request).toMatchObject({ state: 'active', rootUserMessageId: sent.messageId })
})

it('has no watched-count cap and no starts cap, and standing sends go alongside starts (#1183)', async () => {
  const f = await fixture(), requestId = await f.request()
  for (let index = 0; index < 10; index++) expect(await f.service.watchThread({ target: await f.create() })).toMatchObject({ status: 'ok' })
  expect(f.service.state().standingWatches).toHaveLength(10)
  expect(f.service.startsInFlight()).toBe(0)
  const start = () => ({ requestId, retryKey: randomUUID(), project: { hostId: f.control.hostId()!, projectId: f.project.id },
    modelId: f.model.id, title: 'Synthetic started worker', workingCopy: { kind: 'shared' }, firstPrompt: 'Synthetic work' })
  expect(await f.call('start_thread', start())).toMatchObject({ status: 'ok' })
  expect(await f.call('start_thread', start())).toMatchObject({ status: 'ok' })
  expect(f.service.startsInFlight()).toBe(2)
  const watch = f.service.state().standingWatches![0]!
  expect(await f.call('send_to_thread', { requestId: watch.id, retryKey: randomUUID(), target: watch.target, text: 'Synthetic continuation', delivery: 'now' }))
    .toMatchObject({ status: 'ok', limits: { promptCount: 1 } })
})

it('bounds standing prompts by Watcher turn, retains retries across turns, and never revives a stopped scope', async () => {
  const f = await fixture(), target = await f.create()
  await f.service.watchThread({ target })
  const watch = f.service.state().standingWatches![0]!
  const first = { requestId: watch.id, retryKey: randomUUID(), target, text: 'Synthetic first continuation', delivery: 'now' }
  const receipt = await f.call('send_to_thread', first)
  expect(receipt).toMatchObject({ status: 'ok', limits: { promptCount: 1 } })
  await f.finish(target.threadId)
  for (let count = 2; count <= 4; count++) {
    expect(await f.call('send_to_thread', { ...first, retryKey: randomUUID() })).toMatchObject({ status: 'ok', limits: { promptCount: count } })
    await f.finish(target.threadId)
  }
  expect(await f.call('send_to_thread', { ...first, retryKey: randomUUID() })).toMatchObject({ code: 'PROMPT_LIMIT' })
  const scope = f.service.state().requests.find(request => request.standingWatchId === watch.id)!
  await f.control.updateWatcher(record => { const request = record.requests.find(item => item.id === scope.id)!; request.state = 'stopped'; request.closedAt = new Date().toISOString() })
  expect(await f.call('send_to_thread', { ...first, retryKey: randomUUID() })).toMatchObject({ code: 'REQUEST_NOT_ACTIVE' })
  await f.request()
  expect(await f.call('send_to_thread', first)).toMatchObject({ receipt: receipt.status === 'ok' ? receipt.receipt : undefined })
  const renewed = await f.call('send_to_thread', { ...first, retryKey: randomUUID() })
  expect(renewed, JSON.stringify(renewed)).toMatchObject({ status: 'ok', limits: { promptCount: 1 } })
  expect(f.service.state().requests.find(request => request.id === scope.id)?.state).toBe('stopped')
})

it('shares four prompts across ordinary and standing origins without renewing for steer, late turn IDs or restart', async () => {
  const f = await fixture(), requestId = await f.request(), target = await f.create()
  await f.service.watchThread({ target })
  const watch = f.service.state().standingWatches![0]!
  const inputs = []
  for (let count = 1; count <= 4; count++) {
    const input = { requestId: count % 2 ? requestId : watch.id, retryKey: randomUUID(), target, text: 'Synthetic mixed-origin prompt', delivery: 'now' }
    inputs.push(input)
    expect(await f.call('send_to_thread', input)).toMatchObject({ status: 'ok' })
    await f.finish(target.threadId)
  }
  const master = f.native(f.watcherId())
  master.lastTurn = { id: 'synthetic-late-master-turn', status: 'running' }
  master.messages.push({ id: randomUUID(), role: 'user', text: 'Synthetic master steer', createdAt: new Date().toISOString() })
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  const originalBudget = f.control.watcherRecord().operations[0]!.promptTurnId
  master.lastTurn = { id: 'synthetic-replacement-master-turn', status: 'running' }
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  expect(f.control.watcherRecord().promptTurns!.at(-1)!.id).toBe(originalBudget)
  await f.restart()
  for (const origin of [requestId, watch.id]) expect(await f.call('send_to_thread', { ...inputs[0], requestId: origin, retryKey: randomUUID() }))
    .toMatchObject({ status: 'refused', code: 'PROMPT_LIMIT' })
  expect(await f.call('send_to_thread', inputs[0])).toMatchObject({ status: 'ok' })
  expect(f.workspace.adapters.codex.commands.filter(command => command.type === 'send' && command.text === 'Synthetic mixed-origin prompt')).toHaveLength(4)
  await f.finish(f.watcherId()); await f.request()
  expect(await f.call('send_to_thread', { ...inputs[0], retryKey: randomUUID() })).toMatchObject({ status: 'ok', limits: { promptCount: 1 } })
})

it('keeps the exhausted turn budget when a new Watcher Send fails its intent save before any host write', async () => {
  const f = await fixture(), target = await f.create()
  await f.request(); await f.service.watchThread({ target })
  const watch = f.service.state().standingWatches![0]!
  for (let count = 1; count <= 4; count++) {
    expect(await f.call('send_to_thread', { requestId: watch.id, retryKey: randomUUID(), target, text: 'Synthetic exhausted standing prompt', delivery: 'now' })).toMatchObject({ status: 'ok' })
    await f.finish(target.threadId)
  }
  await f.finish(f.watcherId())
  const budget = f.control.watcherRecord().promptTurns!.at(-1)!.id
  const storage = f.control as unknown as { persist(): Promise<void>; outbox: { type: string; threadId?: string }[] }
  const persist = storage.persist.bind(storage)
  let failed = false
  const saving = vi.spyOn(storage, 'persist').mockImplementation(async () => {
    if (!failed && storage.outbox.some(item => item.type === 'send' && item.threadId === f.watcherId())) {
      failed = true; throw new Error('Synthetic Watcher intent storage failure')
    }
    await persist()
  })
  try {
    expect((await f.control.commandShell({ type: 'manual-send', threadId: f.watcherId(), draftId: randomUUID(), text: 'Synthetic unwritten master instruction' })).error).not.toBeNull()
    expect(failed).toBe(true)
    expect(f.workspace.adapters.codex.commands.some(command => command.type === 'send' && command.text.startsWith('Synthetic unwritten master instruction'))).toBe(false)
    expect(f.control.watcherRecord().promptTurns!.at(-1)!.id).toBe(budget)
    expect(await f.call('send_to_thread', { requestId: watch.id, retryKey: randomUUID(), target, text: 'Synthetic forbidden fifth prompt', delivery: 'now' }))
      .toMatchObject({ status: 'refused', code: 'PROMPT_LIMIT' })
  } finally { saving.mockRestore() }
})

it('keeps the exhausted turn budget when the native writer refuses a new Watcher Send before writing', async () => {
  const f = await fixture(), target = await f.create()
  await f.request(); await f.service.watchThread({ target })
  const watch = f.service.state().standingWatches![0]!
  for (let count = 1; count <= 4; count++) {
    expect(await f.call('send_to_thread', { requestId: watch.id, retryKey: randomUUID(), target, text: 'Synthetic exhausted native prompt', delivery: 'now' })).toMatchObject({ status: 'ok' })
    await f.finish(target.threadId)
  }
  await f.finish(f.watcherId())
  const budget = f.control.watcherRecord().promptTurns!.at(-1)!.id
  const execute = f.workspace.adapters.codex.execute.bind(f.workspace.adapters.codex)
  const refusing = vi.spyOn(f.workspace.adapters.codex, 'execute').mockImplementation(async command => {
    if (command.type === 'send' && command.text.startsWith('Synthetic native refused master instruction')) throw new Error('Synthetic definite native pre-write refusal')
    return execute(command)
  })
  try {
    expect((await f.control.commandShell({ type: 'manual-send', threadId: f.watcherId(), draftId: randomUUID(), text: 'Synthetic native refused master instruction' })).error).not.toBeNull()
    expect(f.workspace.adapters.codex.commands.some(command => command.type === 'send' && command.text.startsWith('Synthetic native refused master instruction'))).toBe(false)
    expect(f.control.watcherRecord().promptTurns!.at(-1)!.id).toBe(budget)
    expect(await f.call('send_to_thread', { requestId: watch.id, retryKey: randomUUID(), target, text: 'Synthetic forbidden native fifth prompt', delivery: 'now' }))
      .toMatchObject({ status: 'refused', code: 'PROMPT_LIMIT' })
  } finally { refusing.mockRestore() }
})

it('retains a fresh turn budget after an uncertain but written Watcher Send and restart', async () => {
  const f = await fixture(), target = await f.create()
  await f.request(); await f.service.watchThread({ target })
  const watch = f.service.state().standingWatches![0]!
  for (let count = 1; count <= 4; count++) {
    expect(await f.call('send_to_thread', { requestId: watch.id, retryKey: randomUUID(), target, text: 'Synthetic prior uncertain prompt', delivery: 'now' })).toMatchObject({ status: 'ok' })
    await f.finish(target.threadId)
  }
  await f.finish(f.watcherId())
  const budget = f.control.watcherRecord().promptTurns!.at(-1)!.id
  const execute = f.workspace.adapters.codex.execute.bind(f.workspace.adapters.codex)
  const losingAck = vi.spyOn(f.workspace.adapters.codex, 'execute').mockImplementation(async command => {
    const result = await execute(command)
    return command.type === 'send' && command.text.startsWith('Synthetic written uncertain master instruction')
      ? { accepted: false, uncertain: true, error: 'Synthetic lost acknowledgement' } : result
  })
  try { await f.control.commandShell({ type: 'manual-send', threadId: f.watcherId(), draftId: randomUUID(), text: 'Synthetic written uncertain master instruction' }) }
  finally { losingAck.mockRestore() }
  expect(f.workspace.adapters.codex.commands.filter(command => command.type === 'send' && command.text.startsWith('Synthetic written uncertain master instruction'))).toHaveLength(1)
  expect(f.control.watcherRecord().promptTurns!.at(-1)!.id).not.toBe(budget)
  await f.restart()
  expect(await f.call('send_to_thread', { requestId: watch.id, retryKey: randomUUID(), target, text: 'Synthetic uncertain fresh budget', delivery: 'now' }))
    .toMatchObject({ status: 'ok', limits: { promptCount: 1 } })
})

it('opens the new turn budget from an exact authored master echo before execute returns', async () => {
  const f = await fixture(), target = await f.create()
  await f.request(); await f.service.watchThread({ target })
  const watch = f.service.state().standingWatches![0]!
  for (let count = 1; count <= 4; count++) {
    expect(await f.call('send_to_thread', { requestId: watch.id, retryKey: randomUUID(), target, text: 'Synthetic prior echo prompt', delivery: 'now' })).toMatchObject({ status: 'ok' })
    await f.finish(target.threadId)
  }
  await f.finish(f.watcherId())
  const budget = f.control.watcherRecord().promptTurns!.at(-1)!.id
  const authored = deferred<void>(), release = deferred<void>(), execute = f.workspace.adapters.codex.execute.bind(f.workspace.adapters.codex)
  const held = vi.spyOn(f.workspace.adapters.codex, 'execute').mockImplementation(async command => {
    const result = await execute(command)
    if (command.type === 'send' && command.text.startsWith('Synthetic authored master echo')) { authored.resolve(); await release.promise }
    return result
  })
  let completed = false
  const masterSend = f.control.commandShell({ type: 'manual-send', threadId: f.watcherId(), draftId: randomUUID(), text: 'Synthetic authored master echo' })
    .then(result => { completed = true; return result })
  try {
    await authored.promise
    await f.control.commandShell({ type: 'refresh', provider: 'codex' })
    expect(completed).toBe(false)
    expect(f.control.watcherRecord().promptTurns!.at(-1)!.id).not.toBe(budget)
    expect(await f.call('send_to_thread', { requestId: watch.id, retryKey: randomUUID(), target, text: 'Synthetic before-ack worker prompt', delivery: 'now' }))
      .toMatchObject({ status: 'ok', limits: { promptCount: 1 } })
    release.resolve()
    expect((await masterSend).error).toBeNull()
  } finally { release.resolve(); await masterSend; held.mockRestore() }
})

it('retains all legacy standing prompt charges from stopped scopes until a trusted new Watcher Send', async () => {
  const f = await fixture(), target = await f.create()
  await f.service.watchThread({ target })
  const watch = f.service.state().standingWatches![0]!
  for (let count = 1; count <= 4; count++) {
    expect(await f.call('send_to_thread', { requestId: watch.id, retryKey: randomUUID(), target, text: 'Synthetic legacy standing prompt', delivery: 'now' })).toMatchObject({ status: 'ok' })
    await f.finish(target.threadId)
  }
  await f.control.updateWatcher(record => {
    const scope = record.requests.find(request => request.standingWatchId === watch.id)!
    scope.state = 'stopped'; scope.closedAt = new Date().toISOString()
    for (const operation of record.operations) { delete operation.promptTurnId; delete operation.promptRefunded }
    delete record.promptTurns
  })
  await f.restart()
  expect(await f.call('send_to_thread', { requestId: watch.id, retryKey: randomUUID(), target, text: 'Synthetic forbidden legacy fifth prompt', delivery: 'now' }))
    .toMatchObject({ status: 'refused', code: 'PROMPT_LIMIT' })
  expect(f.workspace.adapters.codex.commands.some(command => command.type === 'send' && command.text === 'Synthetic forbidden legacy fifth prompt')).toBe(false)
  await f.request()
  expect(await f.call('send_to_thread', { requestId: watch.id, retryKey: randomUUID(), target, text: 'Synthetic trusted new turn', delivery: 'now' }))
    .toMatchObject({ status: 'ok', limits: { promptCount: 1 } })
})

it('keeps a queued user continuation on its original request after a standing automation scope exists', async () => {
  const f = await fixture(), requestId = await f.request(), target = await f.create(), draftId = randomUUID()
  await f.service.watchThread({ target })
  const watch = f.service.state().standingWatches![0]!
  expect(await f.call('send_to_thread', { requestId: watch.id, retryKey: randomUUID(), target, text: 'Synthetic standing scope', delivery: 'now' })).toMatchObject({ status: 'ok' })
  const scopeId = f.service.state().requests.find(request => request.standingWatchId === watch.id)!.id
  expect((await f.control.commandShell({ type: 'queue-followup', threadId: f.watcherId(), draftId, text: 'Synthetic original continuation' })).error).toBeNull()
  expect(f.service.state().requests.find(request => request.id === requestId)?.userFollowups).toEqual([{ draftId }])
  expect(f.service.state().requests.find(request => request.id === scopeId)?.userFollowups).toBeUndefined()
  await f.finish(f.watcherId())
  await expect.poll(() => f.native(f.watcherId()).messages.at(-1)?.text.startsWith('Synthetic original continuation')).toBe(true)
  expect(f.service.state().requests.find(request => request.id === requestId)?.userFollowups).toMatchObject([{ draftId, messageId: expect.any(String) }])
})

it('refuses delayed original-request delivery after owning-host unwatch, including a legacy packet without an assignment ID', async () => {
  const master = await fixture(), worker = await fixture(true), target = await worker.create(), clientId = randomUUID(), requestId = await master.request()
  const entered = deferred<void>(), release = deferred<void>()
  let delayed: WatcherHostControl | undefined
  const remote: WatcherRemoteHosts = {
    hosts: () => [{ hostId: target.hostId, connected: true, reads: true, control: true, standingWatch: true, permissionCeiling: 'approval-required' }],
    snapshot: () => worker.control.watcherSnapshot(),
    read: (_hostId, request) => worker.service.readRemote(request, clientId, () => undefined),
    control: async (_hostId, request) => { delayed = request; entered.resolve(); await release.promise; return worker.service.admitRemote(request, clientId, () => undefined) },
    subscribe: () => () => undefined,
  }
  master.service.useRemoteHosts(remote)
  await master.service.watchThread({ target })
  const sending = master.call('send_to_thread', { requestId, retryKey: randomUUID(), target, text: 'Synthetic delayed original request', delivery: 'now' })
  await entered.promise
  expect(delayed!.request.standingWatchId).toBeUndefined()
  expect(delayed!.operation.standingWatchId).toBe(master.service.state().standingWatches![0]!.id)
  expect(await master.service.unwatchThread({ target })).toMatchObject({ status: 'ok' })
  release.resolve()
  expect(await sending).toMatchObject({ status: 'refused', code: 'REQUEST_NOT_ACTIVE' })
  const legacy = structuredClone(delayed!); delete legacy.operation.standingWatchId
  expect(await worker.service.admitRemote(legacy, clientId, () => undefined)).toMatchObject({ status: 'refused', code: 'REQUEST_NOT_ACTIVE' })
  expect(worker.workspace.adapters.codex.commands.filter(command => command.type === 'send' && command.text === 'Synthetic delayed original request')).toHaveLength(0)
})

it.each([
  ['stop_thread', false], ['stop_thread', true], ['settle_thread', false], ['settle_thread', true],
] as const)('fences the first delayed ordinary %s packet after unwatch (legacy=%s)', async (action, legacy) => {
  const master = await fixture(), worker = await fixture(true), target = await worker.create(), clientId = randomUUID(), requestId = await master.request()
  const captured = deferred<WatcherHostControl>(), release = deferred<void>()
  const remote: WatcherRemoteHosts = {
    hosts: () => [{ hostId: target.hostId, connected: true, reads: true, control: true, standingWatch: true, permissionCeiling: 'approval-required' }],
    snapshot: () => worker.control.watcherSnapshot(),
    read: (_hostId, request) => worker.service.readRemote(request, clientId, () => undefined),
    control: async (_hostId, request) => {
      const packet = structuredClone(request)
      if (legacy) delete packet.operation.standingWatchId
      captured.resolve(packet); await release.promise
      return worker.service.admitRemote(packet, clientId, () => undefined)
    },
    subscribe: () => () => undefined,
  }
  master.service.useRemoteHosts(remote); await master.service.watchThread({ target })
  const operation = master.call(action, { requestId, retryKey: randomUUID(), target })
  const packet = await captured.promise
  expect(packet.request.standingWatchId).toBeUndefined()
  expect(await master.service.unwatchThread({ target })).toMatchObject({ status: 'ok' })
  await worker.control.commandShell({ type: 'manual-send', threadId: target.threadId, draftId: randomUUID(), text: 'Synthetic user work after unwatch' })
  if (action === 'settle_thread') await worker.finish(target.threadId)
  const interrupts = worker.workspace.adapters.codex.commands.filter(command => command.type === 'interrupt').length
  try {
    release.resolve()
    expect(await operation).toMatchObject({ status: 'refused', code: 'REQUEST_NOT_ACTIVE' })
    expect(worker.control.watcherRecord().operations.some(item => item.id === packet.operation.id)).toBe(false)
    expect(worker.workspace.adapters.codex.commands.filter(command => command.type === 'interrupt')).toHaveLength(interrupts)
    expect(worker.control.watcherSnapshot().threads.find(thread => thread.id === target.threadId)?.workspaceSettledAt ?? null).toBeNull()
    if (action === 'stop_thread') expect(worker.native(target.threadId).status).toBe('running')
  } finally { release.resolve(); await operation }
})

it.each(['stop_thread', 'settle_thread'] as const)('rechecks a bound %s assignment at the local writer after withdrawal', async action => {
  const f = await fixture(), target = await f.create(), requestId = await f.request()
  await f.control.commandShell({ type: 'manual-send', threadId: target.threadId, draftId: randomUUID(), text: 'Synthetic existing local work' })
  if (action === 'settle_thread') await f.finish(target.threadId)
  await f.service.watchThread({ target })
  const entered = deferred<void>(), release = deferred<void>()
  const execute = f.workspace.host.executeFromWatcher.bind(f.workspace.host)
  const settle = f.workspace.host.setWorkspaceSettled.bind(f.workspace.host)
  const writing = action === 'stop_thread'
    ? vi.spyOn(f.workspace.host, 'executeFromWatcher').mockImplementation(async (command, guard) => {
      if (command.type === 'interrupt') { entered.resolve(); await release.promise }
      return execute(command, guard)
    })
    : vi.spyOn(f.workspace.host, 'setWorkspaceSettled').mockImplementation(async (...args) => {
      entered.resolve(); await release.promise
      return settle(...args)
    })
  const operation = f.call(action, { requestId, retryKey: randomUUID(), target })
  try {
    await entered.promise
    expect(await f.service.unwatchThread({ target })).toMatchObject({ status: 'ok' })
    release.resolve()
    expect(await operation).toMatchObject({ status: 'refused', code: 'REQUEST_NOT_ACTIVE' })
    expect(f.workspace.adapters.codex.commands.some(command => command.type === 'interrupt')).toBe(false)
    expect(f.control.watcherSnapshot().threads.find(thread => thread.id === target.threadId)?.workspaceSettledAt ?? null).toBeNull()
  } finally { release.resolve(); await operation; writing.mockRestore() }
})

it.each(['stop_thread', 'settle_thread'] as const)('retains local legacy %s withdrawal fences across restart and admits an explicit fresh watch', async action => {
  const f = await fixture(), target = await f.create(), requestId = await f.request()
  await f.control.commandShell({ type: 'manual-send', threadId: target.threadId, draftId: randomUUID(), text: 'Synthetic local user work' })
  if (action === 'settle_thread') await f.finish(target.threadId)
  await f.service.watchThread({ target })
  const old = f.service.state().standingWatches![0]!
  expect(await f.service.unwatchThread({ target })).toMatchObject({ status: 'ok' })
  await f.restart()
  expect(f.control.watcherRecord().watchFences).toContainEqual({ id: old.id, target })
  const commands = structuredClone(f.workspace.adapters.codex.commands)
  expect(await f.call(action, { requestId, retryKey: randomUUID(), target })).toMatchObject({ status: 'refused', code: 'REQUEST_NOT_ACTIVE' })
  expect(f.workspace.adapters.codex.commands).toEqual(commands)
  expect(await f.service.watchThread({ target })).toMatchObject({ status: 'ok' })
  expect(f.service.state().standingWatches![0]!.id).not.toBe(old.id)
  expect(await f.call(action, { requestId, retryKey: randomUUID(), target })).toMatchObject({ status: 'ok' })
})

it('keeps the authenticated owning guard when a read arrives between remote start admission lanes', async () => {
  const master = await fixture(), worker = await fixture(true), clientId = randomUUID(), requestId = await master.request()
  const entered = deferred<void>(), release = deferred<void>(), captured = deferred<WatcherHostControl>()
  const remote: WatcherRemoteHosts = {
    hosts: () => [{ hostId: worker.control.hostId()!, connected: true, reads: true, control: true, standingWatch: true, permissionCeiling: 'approval-required' }],
    snapshot: () => worker.control.watcherSnapshot(),
    read: (_hostId, request) => worker.service.readRemote(request, clientId, () => undefined),
    control: (_hostId, request) => { captured.resolve(structuredClone(request)); return worker.service.admitRemote(request, clientId, () => undefined) },
    subscribe: () => () => undefined,
  }
  master.service.useRemoteHosts(remote)
  const owner = worker.service as unknown as { transaction<T>(work: () => Promise<T>): Promise<T> }
  const transaction = owner.transaction.bind(owner)
  let calls = 0
  const lane = vi.spyOn(owner, 'transaction').mockImplementation(work => {
    if (++calls !== 2) return transaction(work)
    entered.resolve(); return release.promise.then(() => transaction(work))
  })
  const starting = master.call('start_thread', { requestId, retryKey: randomUUID(), project: { hostId: worker.control.hostId()!, projectId: worker.project.id },
    modelId: worker.model.id, title: 'Synthetic admitted guard worker', workingCopy: { kind: 'shared' }, firstPrompt: 'Synthetic admission guard prompt' })
  try {
    const packet = await captured.promise
    await entered.promise
    expect(await worker.service.readRemote({ master: packet.master, standingWatches: [] }, clientId, () => undefined)).toMatchObject({ standingWatches: [] })
    release.resolve()
    const result = await starting
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' } })
    expect(worker.workspace.adapters.codex.commands.filter(command => command.type === 'send' && command.text === 'Synthetic admission guard prompt')).toHaveLength(1)
  } finally { release.resolve(); await starting; lane.mockRestore() }
})

it.each([['admission', 1], ['mutation', 2]] as const)('rechecks legacy owning authority when unwatch wins before the %s lane', async (_phase, blockedCall) => {
  const master = await fixture(), worker = await fixture(true), target = await worker.create(), clientId = randomUUID(), requestId = await master.request()
  const captured = deferred<WatcherHostControl>(), delivery = deferred<unknown>(), blocked = deferred<void>(), release = deferred<void>()
  const remote: WatcherRemoteHosts = {
    hosts: () => [{ hostId: target.hostId, connected: true, reads: true, control: true, standingWatch: true, permissionCeiling: 'approval-required' }],
    snapshot: () => worker.control.watcherSnapshot(),
    read: (_hostId, request) => worker.service.readRemote(request, clientId, () => undefined),
    control: (_hostId, request) => { captured.resolve(structuredClone(request)); return delivery.promise },
    subscribe: () => () => undefined,
  }
  master.service.useRemoteHosts(remote); await master.service.watchThread({ target })
  const sending = master.call('send_to_thread', { requestId, retryKey: randomUUID(), target, text: 'Synthetic legacy admission race', delivery: 'now' })
  const packet = await captured.promise
  delete packet.operation.standingWatchId
  expect(packet.request.standingWatchId).toBeUndefined()
  const owner = worker.service as unknown as { transaction<T>(work: () => Promise<T>): Promise<T> }
  const transaction = owner.transaction.bind(owner)
  let calls = 0
  const lane = vi.spyOn(owner, 'transaction').mockImplementation(work => {
    if (++calls !== blockedCall) return transaction(work)
    blocked.resolve()
    return release.promise.then(() => transaction(work))
  })
  const admitted = worker.service.admitRemote(packet, clientId, () => undefined)
  try {
    await blocked.promise
    expect(await master.service.unwatchThread({ target })).toMatchObject({ status: 'ok' })
    expect(worker.service.state().standingWatches).toEqual([])
    release.resolve()
    const result = await admitted
    delivery.resolve(result)
    expect(result).toMatchObject({ status: 'refused', code: 'REQUEST_NOT_ACTIVE' })
    expect(worker.workspace.adapters.codex.commands.filter(command => command.type === 'send' && command.text === 'Synthetic legacy admission race')).toHaveLength(0)
  } finally {
    release.resolve(); delivery.resolve(await admitted); await sending; lane.mockRestore()
  }
})

it('replays an exact owning receipt after unwatch without admitting the legacy send again', async () => {
  const master = await fixture(), worker = await fixture(true), target = await worker.create(), clientId = randomUUID(), requestId = await master.request()
  let packet: WatcherHostControl | undefined
  const remote: WatcherRemoteHosts = {
    hosts: () => [{ hostId: target.hostId, connected: true, reads: true, control: true, standingWatch: true, permissionCeiling: 'approval-required' }],
    snapshot: () => worker.control.watcherSnapshot(),
    read: (_hostId, request) => worker.service.readRemote(request, clientId, () => undefined),
    control: (_hostId, request) => { packet = structuredClone(request); delete packet.operation.standingWatchId; return worker.service.admitRemote(packet, clientId, () => undefined) },
    subscribe: () => () => undefined,
  }
  master.service.useRemoteHosts(remote); await master.service.watchThread({ target })
  const first = await master.call('send_to_thread', { requestId, retryKey: randomUUID(), target, text: 'Synthetic legacy receipt replay', delivery: 'now' })
  expect(first.status).toBe('ok')
  expect(await master.service.unwatchThread({ target })).toMatchObject({ status: 'ok' })
  const before = structuredClone(worker.control.watcherRecord())
  const replay = await worker.service.admitRemote(packet!, clientId, () => undefined)
  expect(replay).toMatchObject({ status: 'ok', receipt: first.status === 'ok' ? first.receipt : undefined })
  expect(worker.control.watcherRecord()).toEqual(before)
  expect(worker.workspace.adapters.codex.commands.filter(command => command.type === 'send' && command.text === 'Synthetic legacy receipt replay')).toHaveLength(1)
})

it.each(['stop_thread', 'settle_thread'] as const)('replays an exact %s receipt after withdrawal without another mutation', async action => {
  const master = await fixture(), worker = await fixture(true), target = await worker.create(), clientId = randomUUID(), requestId = await master.request()
  await worker.control.commandShell({ type: 'manual-send', threadId: target.threadId, draftId: randomUUID(), text: 'Synthetic existing replay work' })
  if (action === 'settle_thread') await worker.finish(target.threadId)
  let packet: WatcherHostControl | undefined
  const remote: WatcherRemoteHosts = {
    hosts: () => [{ hostId: target.hostId, connected: true, reads: true, control: true, standingWatch: true, permissionCeiling: 'approval-required' }],
    snapshot: () => worker.control.watcherSnapshot(),
    read: (_hostId, request) => worker.service.readRemote(request, clientId, () => undefined),
    control: (_hostId, request) => { packet = structuredClone(request); return worker.service.admitRemote(packet, clientId, () => undefined) },
    subscribe: () => () => undefined,
  }
  master.service.useRemoteHosts(remote); await master.service.watchThread({ target })
  const first = await master.call(action, { requestId, retryKey: randomUUID(), target })
  expect(first.status, JSON.stringify(first)).toBe('ok')
  expect(await master.service.unwatchThread({ target })).toMatchObject({ status: 'ok' })
  const before = structuredClone(worker.control.watcherRecord()), commands = structuredClone(worker.workspace.adapters.codex.commands)
  expect(await worker.service.admitRemote(packet!, clientId, () => undefined))
    .toMatchObject({ status: 'ok', receipt: first.status === 'ok' ? first.receipt : undefined })
  expect(worker.control.watcherRecord()).toEqual(before)
  expect(worker.workspace.adapters.codex.commands).toEqual(commands)
})

it('enforces the same mixed-origin turn budget at the owning host before a fifth packet can dispatch', async () => {
  const master = await fixture(), worker = await fixture(true), target = await worker.create(), clientId = randomUUID(), requestId = await master.request()
  const packets: WatcherHostControl[] = []
  const remote: WatcherRemoteHosts = {
    hosts: () => [{ hostId: target.hostId, connected: true, reads: true, control: true, standingWatch: true, permissionCeiling: 'approval-required' }],
    snapshot: () => worker.control.watcherSnapshot(),
    read: (_hostId, request) => worker.service.readRemote(request, clientId, () => undefined),
    control: (_hostId, request) => { packets.push(structuredClone(request)); return worker.service.admitRemote(request, clientId, () => undefined) },
    subscribe: () => () => undefined,
  }
  master.service.useRemoteHosts(remote); await master.service.watchThread({ target })
  const watch = master.service.state().standingWatches![0]!
  for (let count = 1; count <= 4; count++) {
    expect(await master.call('send_to_thread', { requestId: count % 2 ? requestId : watch.id, retryKey: randomUUID(), target, text: 'Synthetic owning mixed budget', delivery: 'now' }))
      .toMatchObject({ status: 'ok', limits: { promptCount: count } })
    await worker.finish(target.threadId)
  }
  expect(new Set(packets.map(packet => packet.operation.promptTurnId)).size).toBe(1)
  const fifth = structuredClone(packets[0]!), retryKey = randomUUID()
  fifth.call.input.retryKey = retryKey
  Object.assign(fifth.operation, { id: randomUUID(), retryKey, draftId: randomUUID(), messageId: randomUUID(), receiptId: randomUUID(), cardId: randomUUID(),
    digest: createHash('sha256').update(JSON.stringify([fifth.call.name, fifth.call.input])).digest('hex') })
  expect(await worker.service.admitRemote(fifth, clientId, () => undefined)).toMatchObject({ status: 'refused', code: 'PROMPT_LIMIT' })
  expect(worker.workspace.adapters.codex.commands.filter(command => command.type === 'send' && command.text === 'Synthetic owning mixed budget')).toHaveLength(4)
})

it.each(['desktop', 'native'] as const)('keeps watching through a %s user turn and holds sends that are not steers through restart', async origin => {
  const f = await fixture(), target = await f.create()
  await f.service.watchThread({ target })
  const watch = f.service.state().standingWatches![0]!
  const automatic = { requestId: watch.id, retryKey: randomUUID(), target, text: 'Synthetic automatic prompt', delivery: 'now' }
  expect(await f.call('send_to_thread', automatic)).toMatchObject({ status: 'ok' })
  expect(await f.call('send_to_thread', { ...automatic, retryKey: randomUUID(), delivery: 'queue' })).toMatchObject({ status: 'ok', receipt: { deliveryState: 'queued' } })
  if (origin === 'desktop') expect((await f.control.commandShell({ type: 'manual-send', threadId: target.threadId, draftId: randomUUID(), text: 'Synthetic direct user prompt' })).error).toBeNull()
  else {
    const native = f.native(target.threadId)
    native.messages.push({ id: randomUUID(), role: 'user', text: 'Synthetic native user prompt', createdAt: new Date().toISOString() })
    native.status = 'running'; native.lastTurn = { id: randomUUID(), status: 'running' }
    f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  }
  await f.restart()
  expect(f.service.state().standingWatches).toHaveLength(1)
  expect(f.service.state().watchedThreads.find(row => row.target.threadId === target.threadId)).toMatchObject({ watched: true, paused: true })
  for (const delivery of ['now', 'queue']) expect(await f.call('send_to_thread', { ...automatic, retryKey: randomUUID(), delivery, expectedTurnId: f.native(target.threadId).lastTurn?.id }))
    .toMatchObject({ status: 'refused', code: 'THREAD_BUSY' })
  const machineDrafts = new Set(f.control.watcherRecord().operations.filter(operation => operation.target.threadId === target.threadId).map(operation => operation.draftId))
  expect(f.control.shell().followups?.some(item => machineDrafts.has(item.draftId) && item.threadId === target.threadId)).toBe(false)
  await f.finish(target.threadId)
  if (origin === 'desktop') { await expect.poll(() => f.native(target.threadId).messages.at(-1)?.text).toBe('Synthetic direct user prompt'); await f.finish(target.threadId) }
  // The desktop prompt went from the queue, whose entry settles after its turn can already have ended; the pause ends
  // with it (see the held-settle test above), so the wait is for that settle, not for a deadline.
  await expect.poll(() => f.control.hasPendingThreadWork(target.threadId)).toBe(false)
  await expect.poll(() => f.service.state().watchedThreads.find(row => row.target.threadId === target.threadId)?.paused).toBe(false)
  await f.request()
  expect(await f.call('send_to_thread', { ...automatic, retryKey: randomUUID() })).toMatchObject({ status: 'ok' })
})

it('resumes a standing watch after a confirmed fresh desktop turn while the set-aside send stays uncertain', async () => {
  const f = await fixture(), target = await f.create()
  expect(await f.service.watchThread({ target })).toMatchObject({ status: 'ok' })
  const watch = f.service.state().standingWatches![0]!
  const original = { type: 'manual-send' as const, threadId: target.threadId, draftId: randomUUID(), text: 'Synthetic unconfirmed standing-watch prompt' }
  const adapter = f.workspace.adapters.codex, execute = adapter.execute.bind(adapter)
  const spy = vi.spyOn(adapter, 'execute').mockImplementation(async command => {
    if (command.type === 'send' && command.text === original.text) {
      // The write has an unknown outcome and no echo. Keep the real coordinator's outbox and IDs.
      adapter.commands.push(structuredClone(command))
      return { accepted: false, uncertain: true, error: 'Synthetic lost send acknowledgement' }
    }
    return execute(command)
  })
  try { await f.control.commandShell(original) } finally { spy.mockRestore() }
  const oldDelivery = () => f.control.shell().deliveries?.find(item => item.threadId === target.threadId && item.draftId === original.draftId)
  expect(oldDelivery()).toMatchObject({ status: 'uncertain' })
  expect((await f.control.commandShell({ type: 'set-aside-send', threadId: target.threadId, draftId: original.draftId })).error).toBeNull()
  // Setting aside the user's own prompt frees the thread to Watcher too, before any fresh prompt (#1222).
  await expect.poll(() => f.service.state().watchedThreads.find(row => row.target.threadId === target.threadId)?.paused).toBe(false)
  const fresh = { ...original, draftId: randomUUID(), text: 'Synthetic confirmed replacement prompt' }
  expect((await f.control.commandShell(fresh)).error).toBeNull()
  const delivery = f.control.shell().deliveries?.find(item => item.draftId === fresh.draftId)
  expect(delivery).toMatchObject({ status: 'accepted' })
  expect(f.native(target.threadId).messages.at(-1)).toMatchObject({ id: delivery!.messageId, commandId: delivery!.commandId, text: fresh.text })
  expect(oldDelivery()).toMatchObject({ status: 'uncertain', setAside: true, updatesResumed: true })
  expect(f.service.state().watchedThreads.find(row => row.target.threadId === target.threadId)).toMatchObject({ watched: true, paused: true })
  await f.finish(target.threadId)
  const continuation = 'Synthetic standing-watch continuation after recovery'
  expect(await f.call('send_to_thread', { requestId: watch.id, retryKey: randomUUID(), target, text: continuation, delivery: 'now' })).toMatchObject({ status: 'ok' })
  expect(f.service.state().watchedThreads.find(row => row.target.threadId === target.threadId)).toMatchObject({ watched: true, paused: false })
  expect(adapter.commands.filter(command => command.type === 'send' && command.text === continuation)).toHaveLength(1)
  // Checking the old revision must never repeat its native write or reclassify its unknown delivery.
  await f.control.commandShell(original)
  expect(adapter.commands.filter(command => command.type === 'send' && command.text === original.text)).toHaveLength(1)
  expect(adapter.commands.filter(command => command.type === 'send' && command.text === fresh.text)).toHaveLength(1)
  expect(oldDelivery()).toMatchObject({ status: 'uncertain', setAside: true, updatesResumed: true })
})

it('pauses on the unobserved-turn sentinel when the user sends, never on the draft ID', async () => {
  const f = await fixture(), target = await f.create()
  await f.service.watchThread({ target })
  const watch = f.service.state().standingWatches![0]!
  expect(await f.call('send_to_thread', { requestId: watch.id, retryKey: randomUUID(), target, text: 'Synthetic automatic prompt', delivery: 'now' })).toMatchObject({ status: 'ok' })
  // Watcher's turn runs, so the user's prompt waits in the queue and has no message ID yet.
  const draftId = randomUUID()
  expect((await f.control.commandShell({ type: 'manual-send', threadId: target.threadId, draftId, text: 'Synthetic queued user prompt' })).error).toBeNull()
  expect(f.control.watcherRecord().watches![0]!.pausedByUserMessageId).toBe('unobserved-user-turn')
  expect(f.service.state().watchedThreads.find(row => row.target.threadId === target.threadId)?.paused).toBe(true)
})

it('ends the pause once the user’s own queued prompt settles after its turn has already finished', async () => {
  const f = await fixture(), target = await f.create()
  await f.service.watchThread({ target })
  const watch = f.service.state().standingWatches![0]!
  expect(await f.call('send_to_thread', { requestId: watch.id, retryKey: randomUUID(), target, text: 'Synthetic automatic prompt', delivery: 'now' })).toMatchObject({ status: 'ok' })
  // The user's prompt waits behind Watcher's running turn, so it goes from the queue.
  expect((await f.control.commandShell({ type: 'manual-send', threadId: target.threadId, draftId: randomUUID(), text: 'Synthetic queued user prompt' })).error).toBeNull()
  const store = (f.control as unknown as { followupStore: { settle(...args: unknown[]): Promise<unknown> } }).followupStore
  const settle = store.settle.bind(store), held = deferred<void>(), reached = deferred<void>(), saved: Promise<unknown>[] = []
  vi.spyOn(store, 'settle').mockImplementation(async (...args: unknown[]) => { reached.resolve(); await held.promise; const done = settle(...args); saved.push(done); return done })
  await f.finish(target.threadId)
  await expect.poll(() => f.native(target.threadId).messages.at(-1)?.text).toBe('Synthetic queued user prompt')
  await reached.promise
  // The user's turn finishes while its queue entry is still being saved, so Watcher still waits; and the provider has
  // nothing more to say, so no later snapshot comes to end the wait.
  await f.finish(target.threadId)
  expect(f.service.state().watchedThreads.find(row => row.target.threadId === target.threadId)?.paused).toBe(true)
  vi.spyOn(f.service, 'observe').mockImplementation(() => undefined)
  held.resolve()
  await vi.waitFor(() => expect(saved).not.toHaveLength(0))
  await Promise.all(saved)
  expect(f.control.hasPendingThreadWork(target.threadId)).toBe(false)
  await expect.poll(() => f.service.state().watchedThreads.find(row => row.target.threadId === target.threadId)?.paused).toBe(false)
  expect(f.control.watcherRecord().watches![0]!.pausedByUserMessageId).toBeNull()
})

it('never leaves Watcher’s live permission and its saved choice apart when the guard, the save or the provider fails', async () => {
  const f = await fixture()
  const live = () => f.control.watcherSnapshot().threads.find(thread => thread.id === f.watcherId())?.runtimeMode ?? 'approval-required'
  const saved = () => f.control.watcherRecord().lastRuntimeMode
  const before = { live: live(), saved: saved() }
  expect(before.live).toBe('approval-required')
  // The save fails: the live thread is not widened.
  vi.spyOn(f.control, 'updateWatcher').mockRejectedValueOnce(new Error('Synthetic save failure'))
  expect(await f.service.setPermission({ runtimeMode: 'full-access' })).toMatchObject({ status: 'refused' })
  expect({ live: live(), saved: saved() }).toEqual(before)
  // The phone loses Can answer at the save: the same.
  expect(await f.service.setPermission({ runtimeMode: 'full-access' }, () => { throw new Error('Synthetic revoked phone') })).toMatchObject({ status: 'refused' })
  expect({ live: live(), saved: saved() }).toEqual(before)
  // The provider refuses the change: the saved choice goes back too.
  vi.spyOn(f.control, 'commandForWatcherRoom').mockResolvedValueOnce({ ...f.control.shell(), error: 'Synthetic provider refusal' })
  expect(await f.service.setPermission({ runtimeMode: 'full-access' })).toMatchObject({ status: 'refused', code: 'PROVIDER_UNAVAILABLE' })
  expect({ live: live(), saved: saved() }).toEqual(before)
  // And a change that works moves both.
  expect(await f.service.setPermission({ runtimeMode: 'full-access' })).toMatchObject({ status: 'ok' })
  expect({ live: live(), saved: saved() }).toEqual({ live: 'full-access', saved: 'full-access' })
})

it('persists the remembered permission before first creation and permits widening and narrowing', async () => {
  const f = await fixture(false, false)
  expect(await f.service.setPermission({ runtimeMode: 'full-access' })).toMatchObject({ status: 'ok', state: { current: null, runtimeMode: 'full-access' } })
  expect(await f.service.open({ provider: 'codex', modelId: f.model.id })).toMatchObject({ status: 'ok', state: { currentOptions: { runtimeMode: 'full-access' } } })
  for (const runtimeMode of ['auto-accept-edits', 'auto', 'full-access', 'approval-required'] as const) {
    expect(await f.service.setPermission({ runtimeMode })).toMatchObject({ status: 'ok', state: { runtimeMode, currentOptions: { runtimeMode } } })
  }
  await f.service.setPermission({ runtimeMode: 'full-access' }); await f.restart()
  expect(f.service.state()).toMatchObject({ runtimeMode: 'full-access', currentOptions: { runtimeMode: 'full-access' } })
  const record = JSON.parse(await readFile(join(f.f.root, 'agents.json'), 'utf8')) as { watcher: { lastRuntimeMode: string } }
  expect(record.watcher.lastRuntimeMode).toBe('full-access')
})

it('keeps Stop bounded within the current Watcher turn while retaining the standing watch', async () => {
  const f = await fixture(), requestId = await f.request()
  const started = await f.call('start_thread', { requestId, retryKey: randomUUID(), project: { hostId: f.control.hostId()!, projectId: f.project.id },
    modelId: f.model.id, title: 'Synthetic stoppable worker', workingCopy: { kind: 'shared' }, firstPrompt: 'Synthetic worker turn' })
  if (started.status !== 'ok') throw new Error('Synthetic start refused')
  const watch = f.service.state().standingWatches![0]!
  expect(await f.call('stop_thread', { requestId, retryKey: randomUUID(), target: started.target })).toMatchObject({ status: 'ok' })
  await f.finish(started.target.threadId)
  expect(f.service.state().standingWatches).toHaveLength(1)
  expect(await f.call('send_to_thread', { requestId: watch.id, retryKey: randomUUID(), target: started.target, text: 'Synthetic forbidden same-turn restart', delivery: 'now' }))
    .toMatchObject({ status: 'refused', code: 'REQUEST_NOT_ACTIVE' })
})

it('builds a paired desktop\'s projection from the record without copying it, again only once the record changes (#1759)', async () => {
  const master = await fixture(), worker = await fixture(true), target = await worker.create()
  const clientId = randomUUID()
  const remote: WatcherRemoteHosts = {
    hosts: () => [{ hostId: target.hostId, connected: true, reads: true, control: true, standingWatch: true, permissionCeiling: 'approval-required' }],
    snapshot: () => worker.control.watcherSnapshot(),
    read: (_hostId, request) => worker.service.readRemote(request, clientId, () => undefined),
    control: (_hostId, request) => worker.service.admitRemote(request, clientId, () => undefined),
    subscribe: listener => worker.control.subscribe(() => listener(target.hostId)),
  }
  master.service.useRemoteHosts(remote)
  expect(await master.service.watchThread({ target })).toMatchObject({ status: 'ok' })
  const watch = master.service.state().standingWatches![0]!, identity = master.service.state().current!
  expect(await master.call('send_to_thread', { requestId: watch.id, retryKey: randomUUID(), target, text: 'Synthetic projected send', delivery: 'now' })).toMatchObject({ status: 'ok' })
  // The host builds this with every shell it pushes the desktop, so it reads the record rather than copying it.
  const copies = vi.spyOn(worker.control, 'watcherRecord')
  const first = worker.service.remoteProjection(identity, clientId), again = worker.service.remoteProjection(identity, clientId)
  expect(copies).not.toHaveBeenCalled()
  expect(first.operations).toHaveLength(1)
  expect(again.requests).toBe(first.requests)
  expect(again.operations).toBe(first.operations)
  expect(again.revision).toBe(first.revision)
  // Once the record changes, the projection says what it says now.
  copies.mockRestore()
  await worker.finish(target.threadId)
  expect(await master.call('send_to_thread', { requestId: watch.id, retryKey: randomUUID(), target, text: 'Synthetic second projected send', delivery: 'now' })).toMatchObject({ status: 'ok' })
  const changed = worker.service.remoteProjection(identity, clientId)
  expect(changed.operations).toHaveLength(2)
  expect(changed.revision).not.toBe(first.revision)
})

it('syncs watches to the owning host, persists takeover there and refuses withdrawn or old-host identities', async () => {
  const master = await fixture(), worker = await fixture(true), target = await worker.create()
  const clientId = randomUUID()
  let standingWatch = true
  let admitted: WatcherHostControl | undefined
  const remote: WatcherRemoteHosts = {
    hosts: () => [{ hostId: target.hostId, connected: true, reads: true, control: true, standingWatch, permissionCeiling: 'approval-required' }],
    snapshot: () => worker.control.watcherSnapshot(),
    read: (_hostId, request) => worker.service.readRemote(request, clientId, () => undefined),
    control: (_hostId, request) => { admitted = request; return worker.service.admitRemote(request, clientId, () => undefined) },
    subscribe: listener => worker.control.subscribe(() => listener(target.hostId)),
  }
  master.service.useRemoteHosts(remote)
  expect(await master.service.watchThread({ target })).toMatchObject({ status: 'ok' })
  const watch = master.service.state().standingWatches![0]!, identity = master.service.state().current!
  expect(worker.control.watcherRecord().watches).toMatchObject([{ id: watch.id, target, remoteOrigin: { clientId } }])
  const projected = worker.service.remoteProjection(identity, clientId)
  expect(projected.progress).toHaveLength(1)
  const input = { requestId: watch.id, retryKey: randomUUID(), target, text: 'Synthetic paired continuation', delivery: 'now' }
  expect(await master.call('send_to_thread', input)).toMatchObject({ status: 'ok' })
  expect((await worker.control.commandShell({ type: 'manual-send', threadId: target.threadId, draftId: randomUUID(), text: 'Synthetic owning-host user prompt' })).error).toBeNull()
  await worker.restart()
  expect(worker.control.watcherRecord().watches![0]!.pausedByUserMessageId).toBeTruthy()
  for (const delivery of ['now', 'queue']) expect(await master.call('send_to_thread', { ...input, retryKey: randomUUID(), delivery }))
    .toMatchObject({ code: 'THREAD_BUSY' })
  await worker.finish(target.threadId)
  await expect.poll(() => worker.native(target.threadId).messages.at(-1)?.text).toBe('Synthetic owning-host user prompt')
  await worker.finish(target.threadId)
  // The owning host's pause ends once its user's queued prompt has settled, which can follow the end of its turn.
  await expect.poll(() => worker.control.hasPendingThreadWork(target.threadId)).toBe(false)
  await expect.poll(() => worker.control.watcherRecord().watches![0]!.pausedByUserMessageId).toBeNull()
  // A refresh adopts the owning-host fence before a fresh automation scope is admitted.
  const projection = await remote.read(target.hostId, { master: identity }) as WatcherHostProjection
  expect(projection.standingWatches![0]).toMatchObject({ pausedByUserMessageId: null })
  await master.service.watchThread({ target })
  await master.request()
  expect(await master.call('send_to_thread', { ...input, retryKey: randomUUID() })).toMatchObject({ status: 'ok' })
  await master.service.unwatchThread({ target })
  expect(worker.control.watcherRecord().watches).toEqual([])
  expect(await worker.service.readRemote({ master: identity, standingWatches: [watch] }, clientId, () => undefined)).toMatchObject({ code: 'REQUEST_NOT_ACTIVE' })
  standingWatch = false
  expect(await master.service.watchThread({ target })).toMatchObject({ code: 'HOST_FEATURE_UNAVAILABLE' })
  standingWatch = true
  await master.service.watchThread({ target })
  const freshWatch = master.service.state().standingWatches![0]!
  const replacement = { ...identity, target: { ...identity.target, threadId: randomUUID() }, creationOperationId: randomUUID(),
    createdAt: new Date(Date.parse(identity.createdAt) + 1_000).toISOString() }
  expect(await worker.service.readRemote({ master: replacement, standingWatches: [freshWatch] }, clientId, () => undefined))
    .toMatchObject({ standingWatches: [{ id: freshWatch.id, remoteOrigin: { masterCreationOperationId: replacement.creationOperationId } }] })
  for (const standingWatches of [[freshWatch], []]) expect(await worker.service.readRemote({ master: identity, standingWatches }, clientId, () => undefined))
    .toMatchObject({ status: 'refused', code: 'NOT_CURRENT_WATCHER' })
  expect(await worker.service.admitRemote(admitted!, clientId, () => undefined)).toMatchObject({ status: 'refused', code: 'NOT_CURRENT_WATCHER' })
  const emptyReplacement = { ...replacement, target: { ...replacement.target, threadId: randomUUID() }, creationOperationId: randomUUID(),
    createdAt: new Date(Date.parse(replacement.createdAt) + 1_000).toISOString() }
  expect(await worker.service.readRemote({ master: emptyReplacement, standingWatches: [] }, clientId, () => undefined)).toMatchObject({ standingWatches: [] })
  await worker.restart()
  expect(await worker.service.readRemote({ master: replacement, standingWatches: [{ ...freshWatch, id: randomUUID() }] }, clientId, () => undefined))
    .toMatchObject({ status: 'refused', code: 'NOT_CURRENT_WATCHER' })
})

it('rechecks connection guards at management mutations and lets unwatch beat an unfinished owning-host assignment', async () => {
  const master = await fixture(), worker = await fixture(true), target = await master.create()
  const before = master.service.state().runtimeMode
  const guard = () => { throw new Error('Synthetic disconnected phone') }
  expect(await master.service.setPermission({ runtimeMode: 'full-access' }, guard)).toMatchObject({ status: 'refused' })
  expect(await master.service.watchThread({ target }, guard)).toMatchObject({ status: 'refused' })
  expect(master.service.state().runtimeMode).toBe(before)
  expect(master.service.state().standingWatches).toEqual([])
  await master.service.watchThread({ target })
  expect(await master.service.unwatchThread({ target }, guard)).toMatchObject({ status: 'refused' })
  expect(master.service.state().standingWatches).toHaveLength(1)

  const pairedTarget = await worker.create(), clientId = randomUUID(), entered = deferred<void>(), release = deferred<void>()
  let pause = true
  const remote: WatcherRemoteHosts = {
    hosts: () => [{ hostId: pairedTarget.hostId, connected: true, reads: true, control: true, standingWatch: true, permissionCeiling: 'approval-required' }],
    snapshot: () => worker.control.watcherSnapshot(),
    control: (_hostId, request) => worker.service.admitRemote(request, clientId, () => undefined),
    read: async (_hostId, request) => {
      const result = await worker.service.readRemote(request, clientId, () => undefined)
      if (pause && request.standingWatches?.length) { pause = false; entered.resolve(); await release.promise }
      return result
    },
    subscribe: () => () => undefined,
  }
  master.service.useRemoteHosts(remote)
  const assigning = master.service.watchThread({ target: pairedTarget })
  await entered.promise
  expect(master.service.state().standingWatches?.some(watch => watch.target.hostId === pairedTarget.hostId)).toBe(false)
  expect(await master.service.unwatchThread({ target: pairedTarget })).toMatchObject({ status: 'ok' })
  release.resolve()
  expect(await assigning).toMatchObject({ status: 'refused', code: 'TARGET_CHANGED' })
  expect(worker.control.watcherRecord().watches).toEqual([])
  expect(master.service.state().standingWatches?.some(watch => watch.target.hostId === pairedTarget.hostId)).toBe(false)
})

it('keeps a watched thread Watcher’s after the user sends there, under the user’s own request as under the watch', async () => {
  const f = await fixture(), target = await f.create(), requestId = await f.request()
  expect(await f.call('watch_thread', { target })).toMatchObject({ status: 'ok' })
  const watch = f.service.state().standingWatches![0]!
  const row = () => f.service.state().watchedThreads.find(item => item.target.threadId === target.threadId)
  expect(await f.call('send_to_thread', { requestId, retryKey: randomUUID(), target, text: 'Synthetic first brief', delivery: 'now' })).toMatchObject({ status: 'ok' })
  await f.finish(target.threadId)
  expect((await f.control.commandShell({ type: 'manual-send', threadId: target.threadId, draftId: randomUUID(), text: 'Synthetic user prompt' })).error).toBeNull()
  // While the user's turn runs, Watcher can steer it and nothing else, and the thread is still watched.
  expect(row()).toMatchObject({ watched: true, paused: true })
  expect(f.control.watcherRecord().requests.flatMap(request => request.participants).every(participant => participant.state === 'participating')).toBe(true)
  for (const delivery of ['now', 'queue']) expect(await f.call('send_to_thread', { requestId, retryKey: randomUUID(), target, text: 'Synthetic held prompt', delivery }))
    .toMatchObject({ status: 'refused', code: 'THREAD_BUSY' })
  await f.finish(target.threadId)
  await expect.poll(() => f.control.hasPendingThreadWork(target.threadId)).toBe(false)
  await expect.poll(() => row()?.paused).toBe(false)
  // Once it ends, Watcher sends again under the user's request and under the watch.
  expect(await f.call('send_to_thread', { requestId, retryKey: randomUUID(), target, text: 'Synthetic brief after the user', delivery: 'now' })).toMatchObject({ status: 'ok' })
  await f.finish(target.threadId)
  expect(await f.call('send_to_thread', { requestId: watch.id, retryKey: randomUUID(), target, text: 'Synthetic watched brief after the user', delivery: 'now' })).toMatchObject({ status: 'ok' })
  expect(row()).toMatchObject({ watched: true, paused: false })
})

it('steers the user’s own running turn in a watched thread', async () => {
  const f = await fixture(), target = await f.create()
  await f.service.watchThread({ target })
  const watch = f.service.state().standingWatches![0]!
  expect((await f.control.commandShell({ type: 'manual-send', threadId: target.threadId, draftId: randomUUID(), text: 'Synthetic user prompt' })).error).toBeNull()
  const native = f.native(target.threadId)
  native.status = 'running'; native.lastTurn = { id: randomUUID(), status: 'running' }
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  expect(f.service.state().watchedThreads.find(row => row.target.threadId === target.threadId)).toMatchObject({ watched: true, paused: true })
  expect(await f.call('send_to_thread', { requestId: watch.id, retryKey: randomUUID(), target, text: 'Synthetic steer', delivery: 'steer', expectedTurnId: native.lastTurn.id }))
    .toMatchObject({ status: 'ok' })
  expect(f.workspace.adapters.codex.commands.some(command => command.type === 'steer' && command.text === 'Synthetic steer')).toBe(true)
})

it('never stops the user’s own running turn in a watched thread', async () => {
  const f = await fixture(), target = await f.create()
  await f.service.watchThread({ target })
  const watch = f.service.state().standingWatches![0]!
  expect((await f.control.commandShell({ type: 'manual-send', threadId: target.threadId, draftId: randomUUID(), text: 'Synthetic user prompt' })).error).toBeNull()
  const native = f.native(target.threadId)
  native.status = 'running'; native.lastTurn = { id: randomUUID(), status: 'running' }
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  const interrupts = () => f.workspace.adapters.codex.commands.filter(command => command.type === 'interrupt').length
  const before = interrupts()
  expect(await f.call('stop_thread', { requestId: watch.id, retryKey: randomUUID(), target })).toMatchObject({ status: 'refused', code: 'THREAD_BUSY' })
  expect(interrupts()).toBe(before)
  // Nor under the user's earlier request, from a Watcher turn that answers something else, such as news.
  const requestId = await f.request()
  const master = f.native(f.watcherId())
  master.messages.push({ id: randomUUID(), role: 'user', text: 'Synthetic Sotto news', createdAt: new Date().toISOString() })
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  expect(await f.call('stop_thread', { requestId, retryKey: randomUUID(), target })).toMatchObject({ status: 'refused', code: 'THREAD_BUSY' })
  expect(interrupts()).toBe(before)
  // Nothing was fenced for the stops that did not go: the thread is still Watcher's to keep going.
  expect(f.control.watcherRecord().requests.flatMap(request => request.participants).some(participant => participant.automationStopped)).toBe(false)
})

it('gives back a participation an older build took from a thread that is still watched', async () => {
  const f = await fixture(), target = await f.create(), requestId = await f.request()
  expect(await f.call('watch_thread', { target })).toMatchObject({ status: 'ok' })
  expect(await f.call('send_to_thread', { requestId, retryKey: randomUUID(), target, text: 'Synthetic first brief', delivery: 'now' })).toMatchObject({ status: 'ok' })
  await f.finish(target.threadId)
  // What the Vacancy thread's record held: the user's send took the participation away for good.
  // Every participation taken closes the user's request, so the next brief goes under a new one.
  const takeAway = () => f.control.updateWatcher(record => {
    for (const participant of record.requests.flatMap(request => request.participants)) if (participant.target.threadId === target.threadId) {
      participant.state = 'taken-over'; participant.generation += 1; participant.takeover = { reason: 'user-send', at: new Date().toISOString() }
    }
  })
  const states = () => f.control.watcherRecord().requests.flatMap(request => request.participants).filter(participant => participant.target.threadId === target.threadId)
    .map(participant => participant.state)
  await takeAway()
  await f.restart()
  expect(states()).toEqual(states().map(() => 'participating'))
  await f.finish(f.watcherId())
  const next = await f.request()
  const after = await f.call('send_to_thread', { requestId: next, retryKey: randomUUID(), target, text: 'Synthetic brief after restart', delivery: 'now' })
  expect(after, JSON.stringify(after)).toMatchObject({ status: 'ok' })
})

it('keeps a thread the user stopped watching from Watcher until the user hands it back', async () => {
  const f = await fixture(), target = await f.create()
  await f.request()
  expect(await f.call('watch_thread', { target })).toMatchObject({ status: 'ok' })
  // Watcher's own unwatch leaves it free to watch the thread again while it answers the user.
  expect(await f.call('unwatch_thread', { target })).toMatchObject({ status: 'ok', watched: false })
  expect(await f.call('watch_thread', { target })).toMatchObject({ status: 'ok' })
  // The user's Stop watching does not: the same turn, and its continuations, cannot undo it.
  expect(await f.service.unwatchThread({ target })).toMatchObject({ status: 'ok' })
  expect(await f.call('watch_thread', { target })).toMatchObject({ status: 'refused', code: 'REQUEST_NOT_ACTIVE' })
  expect(f.service.state().standingWatches ?? []).toEqual([])
  expect(f.service.state().watchedThreads.find(row => row.target.threadId === target.threadId)?.watched).not.toBe(true)
  // A message the user sends Watcher afterwards hands it back.
  await f.finish(f.watcherId())
  await f.request()
  expect(await f.call('watch_thread', { target })).toMatchObject({ status: 'ok' })
  expect(f.control.watcherRecord().userUnwatches).toBeUndefined()
  // So does Watch, at once.
  expect(await f.service.unwatchThread({ target })).toMatchObject({ status: 'ok' })
  expect(await f.call('watch_thread', { target })).toMatchObject({ status: 'refused', code: 'REQUEST_NOT_ACTIVE' })
  expect(await f.service.watchThread({ target })).toMatchObject({ status: 'ok' })
  expect(f.control.watcherRecord().userUnwatches).toBeUndefined()
  // And the record survives a restart.
  expect(await f.service.unwatchThread({ target })).toMatchObject({ status: 'ok' })
  await f.restart()
  expect(await f.call('watch_thread', { target })).toMatchObject({ status: 'refused', code: 'REQUEST_NOT_ACTIVE' })
})

it('takes the newest user message Watcher’s requests know when its thread is out of view at Stop watching', async () => {
  const f = await fixture(), target = await f.create(), requestId = await f.request()
  expect(await f.call('watch_thread', { target })).toMatchObject({ status: 'ok' })
  const root = f.control.watcherRecord().requests.find(request => request.id === requestId)!.rootUserMessageId
  // Watcher's provider is between snapshots, so its thread is not listed when the user stops watching.
  const snapshot = f.control.watcherSnapshot.bind(f.control), watcherId = f.watcherId()
  const hidden = vi.spyOn(f.control, 'watcherSnapshot').mockImplementation(() => {
    const shown = snapshot()
    return { ...shown, threads: shown.threads.filter(thread => thread.id !== watcherId) }
  })
  expect(await f.service.unwatchThread({ target })).toMatchObject({ status: 'ok' })
  hidden.mockRestore()
  expect(f.control.watcherRecord().userUnwatches).toMatchObject([{ target, watcherHead: root }])
  // The turn answering the message from before Stop watching cannot take the thread back.
  expect(await f.call('watch_thread', { target })).toMatchObject({ status: 'refused', code: 'REQUEST_NOT_ACTIVE' })
})

it.each([['a pull request wake-up', 'a standing watch'], ['a pull request wake-up', 'a request alone'], ['a delegated brief', 'a request alone']] as const)(
  'never takes %s Sotto sent for the user in a thread watched by %s', async (message, kind) => {
    const f = await fixture(), requestId = await f.request()
    const started = await f.call('start_thread', { requestId, retryKey: randomUUID(), project: { hostId: f.control.hostId()!, projectId: f.project.id },
      modelId: f.model.id, title: 'Synthetic worker', workingCopy: { kind: 'shared' }, firstPrompt: 'Synthetic worker turn' })
    if (started.status !== 'ok') throw new Error('Synthetic start refused')
    const target = started.target
    await f.finish(target.threadId)
    // An older paired host's participation has no standing watch.
    if (kind === 'a request alone') await f.control.updateWatcher(record => { record.watches = [] })
    if (message === 'a pull request wake-up') {
      await f.control.deliverWakeUp(target.threadId, { pullRequest: { url: 'https://github.com/o/r/pull/1', number: 1, title: 'Synthetic pull request' },
        startedBy: 'agent', head: 'head-1', changes: [{ kind: 'checks-failed', checks: [{ name: 'build', status: 'failure', url: null }] }], ended: null }, { tool: false })
      await expect.poll(() => f.native(target.threadId).messages.findLast(item => item.role === 'user')?.text).not.toBe('Synthetic worker turn')
    } else {
      // A delegation's brief is known by the message ID delegation gave it, which its hook on the coordinator answers.
      const brief = randomUUID()
      f.control.useDelegation({ userCommand: () => undefined, observe: () => undefined, observedThreadIds: () => [],
        messageIdFor: () => undefined, guardFor: () => undefined, ownsMessage: messageId => messageId === brief })
      f.native(target.threadId).messages.push({ id: brief, role: 'user', text: 'Synthetic delegated brief', createdAt: new Date().toISOString() })
    }
    const native = f.native(target.threadId); native.status = 'running'; native.lastTurn = { id: randomUUID(), status: 'running' }
    f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
    const participants = f.control.watcherRecord().requests.flatMap(request => request.participants).filter(item => item.target.threadId === target.threadId)
    expect(participants.map(item => item.state)).toEqual(participants.map(() => 'participating'))
    expect(f.control.watcherRecord().watches?.[0]?.pausedByUserMessageId ?? null).toBeNull()
    await f.finish(target.threadId)
    const sent = await f.call('send_to_thread', { requestId, retryKey: randomUUID(), target, text: 'Synthetic brief after Sotto’s message', delivery: 'now' })
    expect(sent, JSON.stringify(sent)).toMatchObject({ status: 'ok' })
  })

it('gives a paired thread back to Watcher when its watch reaches the owning host after the user sent there', async () => {
  const master = await fixture(), worker = await fixture(true), target = await worker.create()
  const clientId = randomUUID()
  // While the watch is held back, the desktop's reads reach the host without it, as before the watch had reached it.
  let watchHeld = false, reading = 0
  const remote: WatcherRemoteHosts = {
    hosts: () => [{ hostId: target.hostId, connected: true, reads: true, control: true, standingWatch: true, permissionCeiling: 'approval-required' }],
    snapshot: () => worker.control.watcherSnapshot(),
    read: async (_hostId, request) => {
      reading++
      try { return await worker.service.readRemote(watchHeld ? { ...request, standingWatches: undefined } : request, clientId, () => undefined) }
      finally { reading-- }
    },
    control: (_hostId, request) => worker.service.admitRemote(request, clientId, () => undefined),
    subscribe: listener => worker.control.subscribe(() => listener(target.hostId)),
  }
  master.service.useRemoteHosts(remote)
  expect(await master.service.watchThread({ target })).toMatchObject({ status: 'ok' })
  const watch = master.service.state().standingWatches![0]!, identity = master.service.state().current!
  const requestId = await master.request()
  expect(await master.call('send_to_thread', { requestId, retryKey: randomUUID(), target, text: 'Synthetic paired brief', delivery: 'now' })).toMatchObject({ status: 'ok' })
  await worker.finish(target.threadId)
  // The host holds the participation but, as before the desktop's watch reached it, no watch: the user's send there
  // takes the participation as if the thread were watched for a request alone. The desktop reads the host whenever the
  // host changes, so its reads stop carrying the watch first, and one already on its way lands before the watch goes.
  watchHeld = true
  await expect.poll(() => reading).toBe(0)
  await worker.control.updateWatcher(record => { record.watches = [] })
  expect((await worker.control.commandShell({ type: 'manual-send', threadId: target.threadId, draftId: randomUUID(), text: 'Synthetic owning-host user prompt' })).error).toBeNull()
  const states = () => worker.control.watcherRecord().requests.flatMap(request => request.participants).filter(item => item.target.threadId === target.threadId).map(item => item.state)
  expect(states()).toContain('taken-over')
  await worker.finish(target.threadId)
  await expect.poll(() => worker.control.hasPendingThreadWork(target.threadId)).toBe(false)
  // The watch arrives, and with it the thread is Watcher's again, on the host and then on the desktop.
  expect(await worker.service.readRemote({ master: identity, standingWatches: [watch] }, clientId, () => undefined)).toMatchObject({ hostId: target.hostId })
  watchHeld = false
  expect(states()).toEqual(states().map(() => 'participating'))
  // The user's request closed once its only participation was taken; the watch carries Watcher's next brief.
  await master.finish(master.watcherId())
  const sent = await master.call('send_to_thread', { requestId: watch.id, retryKey: randomUUID(), target, text: 'Synthetic paired brief after the user', delivery: 'now' })
  expect(sent, JSON.stringify(sent)).toMatchObject({ status: 'ok' })
  expect(master.service.state().requests.find(request => request.id === requestId)!.participants
    .find(item => item.target.threadId === target.threadId)).toMatchObject({ state: 'participating' })
})

it('refuses a slash command up front, sending and recording nothing, while a prompt that names a path goes (#1222)', async () => {
  const f = await fixture(), target = await f.create()
  await f.service.watchThread({ target })
  const watch = f.service.state().standingWatches![0]!
  // The thread has no provider session until its first prompt starts one.
  const session = () => f.workspace.registry.byThread(target.threadId)?.sessionId
  const sent = () => f.workspace.adapters.codex.commands.flatMap(command => command.type === 'send' && command.threadId === session() ? [command.text] : [])
  const send = (text: string, delivery = 'now') => f.call('send_to_thread', { requestId: watch.id, retryKey: randomUUID(), target, text, delivery })
  const operations = f.control.watcherRecord().operations.length
  for (const [text, delivery] of [['/compact', 'now'], ['/compact now', 'queue'], ['  /review-pr_2 please', 'now']] as const) {
    expect(await send(text, delivery)).toEqual({ status: 'refused', code: 'SLASH_COMMAND', message: SLASH_COMMAND_REFUSAL, retryable: false })
  }
  expect(sent()).toEqual([])
  expect(f.control.watcherRecord().operations).toHaveLength(operations)
  // Nothing left Watcher, so the thread has no unconfirmed send and nothing holds it.
  expect(f.control.shell().deliveries?.some(item => item.threadId === target.threadId) ?? false).toBe(false)
  expect(f.control.hasPendingThreadWork(target.threadId)).toBe(false)
  expect(f.service.state().watchedThreads.find(row => row.target.threadId === target.threadId)).toMatchObject({ watched: true, paused: false })
  expect(await send('/home/x is the path')).toMatchObject({ status: 'ok' })
  await f.finish(target.threadId)
  expect(await send('see /tmp/foo')).toMatchObject({ status: 'ok' })
  expect(sent()).toEqual(['/home/x is the path', 'see /tmp/foo'])
})

it('lifts a watch an unconfirmed Watcher send paused once the user sets it aside, and says which hold refused a send (#1222)', async () => {
  const f = await fixture(), target = await f.create()
  // The user's own turn comes first, so the thread's newest user message is the user's.
  expect((await f.control.commandShell({ type: 'manual-send', threadId: target.threadId, draftId: randomUUID(), text: 'Synthetic user turn' })).error).toBeNull()
  await f.finish(target.threadId)
  await f.service.watchThread({ target })
  const watch = f.service.state().standingWatches![0]!
  const row = () => f.service.state().watchedThreads.find(item => item.target.threadId === target.threadId)
  const send = (text: string) => f.call('send_to_thread', { requestId: watch.id, retryKey: randomUUID(), target, text, delivery: 'now' })
  const adapter = f.workspace.adapters.codex, execute = adapter.execute.bind(adapter)
  const lost = 'Synthetic send the provider takes as its own command'
  // The provider takes it as a command of its own, as Claude takes /compact: no echo, so Sotto cannot confirm it.
  const spy = vi.spyOn(adapter, 'execute').mockImplementation(async command => {
    if (command.type !== 'send' || command.text !== lost) return execute(command)
    adapter.commands.push(structuredClone(command))
    return { accepted: false, uncertain: true, error: 'Synthetic lost send acknowledgement' }
  })
  let operationId: string
  try {
    const sent = await send(lost)
    expect(sent).toMatchObject({ receipt: { deliveryState: 'uncertain' } })
    operationId = (sent as { receipt: { operationId: string } }).receipt.operationId
  } finally { spy.mockRestore() }
  // Its work runs as a turn whose newest user message is still the user's, so the watch pauses as for the user's turn.
  const native = f.native(target.threadId)
  native.status = 'running'; native.lastTurn = { id: randomUUID(), status: 'running' }
  adapter.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  expect(row()).toMatchObject({ watched: true, paused: true })
  expect(await send('Synthetic send while the turn runs')).toMatchObject({ status: 'refused', code: 'THREAD_BUSY', message: USER_TURN_RUNNING })
  // A steer may go into the user's turn, but the unconfirmed send holds it, and the refusal says so.
  expect(await f.call('send_to_thread', { requestId: watch.id, retryKey: randomUUID(), target, text: 'Synthetic steer while it is unconfirmed', delivery: 'steer' }))
    .toEqual({ status: 'refused', code: 'DELIVERY_UNCERTAIN', message: UNCONFIRMED_SEND_HOLD, retryable: false })
  await f.finish(target.threadId)
  // The turn is over, but the unconfirmed send holds the watch, and the refusal names it rather than a turn.
  expect(row()).toMatchObject({ paused: true })
  expect(await send('Synthetic send while it is unconfirmed')).toEqual({ status: 'refused', code: 'DELIVERY_UNCERTAIN', message: UNCONFIRMED_SEND_HOLD, retryable: false })
  // Continue with a new message, in the thread's own Unconfirmed banner.
  const draftId = f.control.watcherRecord().operations.find(item => item.id === operationId)!.draftId!
  expect((await f.control.commandShell({ type: 'set-aside-send', threadId: target.threadId, draftId })).error).toBeNull()
  // The pause lifts with no provider update and no new watch, and Watcher sends there again.
  await expect.poll(() => row()?.paused).toBe(false)
  expect(f.service.state().standingWatches).toEqual([expect.objectContaining({ id: watch.id })])
  const next = 'Synthetic send after the set-aside'
  expect(await send(next)).toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' } })
  expect(adapter.commands.filter(command => command.type === 'send' && command.text === next)).toHaveLength(1)
  // The set-aside send is never sent again, and nothing claims it arrived.
  expect(adapter.commands.filter(command => command.type === 'send' && command.text === lost)).toHaveLength(1)
  expect(f.control.watcherRecord().operations.find(item => item.id === operationId)!.deliveryState).toBe('uncertain')
  expect(f.control.shell().deliveries?.find(item => item.draftId === draftId)).toMatchObject({ status: 'uncertain', setAside: true })
})
