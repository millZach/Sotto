// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WatcherService } from '../../src/main/agents/watcher'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import { watcherToolSchemas } from '../../src/shared/watcher'
import type { ProviderId } from '../../src/shared/agents'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { deferred } from '../fixtures/deferred'
import { followupStoreOf } from '../fixtures/followupQueue'

/**
 * New Watcher (ADR-0073): a new Watcher on the current one's own provider, model, effort and permission mode, through the
 * same replacement a provider change makes, over the fake providers. The last conversation goes to Watcher history with
 * its tools revoked, workers, receipts and standing watches carry on, and its handover is offered. A refusal sends
 * nothing and changes nothing.
 */
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close() })

async function fixture() {
  const workspace = await workspaceFixture(undefined, { history: true })
  cleanups.push(workspace.remove)
  // Watcher may run with more than Ask for approval here, so the permission it carries over is one a test can tell apart.
  workspace.adapters.codex.state.models[0]!.runtimeModes = ['approval-required', 'auto-accept-edits']
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' },
    control: { watcherEnabled: true, historyEnabled: () => true } })
  const revoke = vi.fn()
  const service = new WatcherService({ directory: f.root, host: workspace.host, control: f.control, historyEnabled: () => true, revoke })
  const tools = new WatcherToolServer(service); workspace.host.useWatcherTools(tools)
  cleanups.push(async () => { service.close(); await tools.close(); await f.dispose(); await workspace.stop() })
  await f.control.start()
  await f.control.commandShell({ type: 'connect', provider: 'codex' })
  await service.recover()
  const model = f.control.shell().host.models.find(item => item.providerId === 'codex')!
  const project = f.control.shell().host.projects.find(item => item.providerId === 'codex')!
  expect(await service.open({ provider: 'codex', modelId: model.id, reasoningEffort: 'high' })).toMatchObject({ status: 'ok' })
  const first = service.state().current!.target
  const native = (threadId: string) => {
    const binding = workspace.registry.byThread(threadId)!
    return workspace.adapters[binding.provider as 'codex' | 'claude'].state.threads.find(thread => thread.id === binding.sessionId)!
  }
  const refresh = async (provider: ProviderId = 'codex') => { workspace.adapters[provider as 'codex'].emit(); await f.control.commandShell({ type: 'refresh', provider }) }
  const finish = async (threadId: string) => {
    const thread = native(threadId)
    thread.status = 'idle'; thread.lastTurn = { id: randomUUID(), status: 'completed' }
    await refresh(workspace.registry.byThread(threadId)!.provider as ProviderId)
  }
  /** The user's words to the current Watcher, whose turn then runs until `reply`. */
  const send = async (text: string) => {
    const threadId = service.state().current!.target.threadId
    expect((await f.control.commandShell({ type: 'manual-send', threadId, draftId: randomUUID(), text })).error).toBeNull()
    await f.control.commandShell({ type: 'observe-threads', threadIds: [threadId] })
  }
  const reply = async (text: string) => {
    const threadId = service.state().current!.target.threadId
    native(threadId).messages.push({ id: randomUUID(), role: 'assistant', text, createdAt: new Date().toISOString() })
    await finish(threadId)
  }
  /** One finished exchange in the current Watcher: the user's words, then its reply. */
  const exchange = async (text: string, answer: string) => { await send(text); await reply(answer) }
  const call = async (name: keyof typeof watcherToolSchemas, input: unknown) => {
    const result = await tools.call(service.state().current!.target.threadId, name, input)
    return watcherToolSchemas[name].output.parse(result.structuredContent)
  }
  const creates = () => workspace.adapters.codex.commands.filter(command => command.type === 'create-thread').length
  /** A worker Watcher starts during its turn, for the request the user's last message began. */
  const startWorker = async (title: string) => {
    await tools.call(service.state().current!.target.threadId, 'read_state', {})
    const started = await call('start_thread', { requestId: service.state().requests.at(-1)!.id, retryKey: randomUUID(),
      project: { hostId: f.control.hostId()!, projectId: project.id }, modelId: model.id, title, workingCopy: { kind: 'shared' }, firstPrompt: `${title}, please.` })
    if (started.status !== 'ok' || !('target' in started)) throw new Error(`start refused: ${JSON.stringify(started)}`)
    return started.target
  }
  return { ...f, workspace, service, tools, revoke, first, model, project, native, refresh, finish, send, reply, exchange, call, creates, startWorker }
}

describe('New Watcher', () => {
  it('starts a new Watcher on the same choices, keeps workers and watches, and offers the handover', async () => {
    const f = await fixture()
    expect(await f.service.setPermission({ runtimeMode: 'auto-accept-edits' })).toMatchObject({ status: 'ok' })
    // A worker Watcher started, finished, and still watched; its receipt stays in the record.
    await f.send('Start a thread to fix the footer links.')
    // The provider reports the effort and permission mode in force, as the real adapters do; the fake keeps neither itself.
    Object.assign(f.native(f.first.threadId), { reasoningEffort: 'high', runtimeMode: 'auto-accept-edits' })
    await f.refresh()
    const started = { target: await f.startWorker('Footer links') }
    await f.reply('Started Footer links.')
    await f.finish(started.target.threadId)
    const watchesBefore = f.service.state().standingWatches, receiptsBefore = f.service.state().receipts.map(receipt => receipt.id)
    expect(watchesBefore?.map(watch => watch.target)).toContainEqual(started.target)

    const result = await f.service.startNew()
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'ok' })
    const room = f.service.state(), next = room.current!
    expect(next).toMatchObject({ provider: 'codex' })
    expect(next.target).not.toEqual(f.first)
    // The same provider, model, effort and permission mode, read from the last Watcher itself.
    expect(room.currentOptions).toMatchObject({ modelId: f.model.id, reasoningEffort: 'high', runtimeMode: 'auto-accept-edits' })
    expect(f.control.watcherSnapshot().threads.find(thread => thread.id === next.target.threadId))
      .toMatchObject({ kind: 'watcher', providerId: 'codex', modelId: f.model.id, reasoningEffort: 'high', runtimeMode: 'auto-accept-edits' })
    // The last conversation is Watcher history, its tools revoked.
    expect(room.history.map(identity => identity.target)).toEqual([f.first])
    expect(f.revoke).toHaveBeenCalledWith(f.first.threadId)
    expect(f.control.shell().host.threads.find(thread => thread.id === f.first.threadId)?.kind).toBe('watcher-history')
    // Workers, receipts and standing watches carry on.
    expect(room.standingWatches).toEqual(watchesBefore)
    expect(room.receipts.map(receipt => receipt.id)).toEqual(receiptsBefore)
    expect(room.watchedThreads.find(row => row.target.threadId === started.target.threadId)).toMatchObject({ watched: true })
    // The handover of the last one is offered, from the same provider.
    expect(room.handover).toMatchObject({ source: f.first, provider: 'codex' })
    expect(room.handover!.counts.carried).toBeGreaterThan(0)
    const read = f.service.readHandover()
    expect(read).toMatchObject({ status: 'ok' })
    expect(read.status === 'ok' && read.text).toContain('Start a thread to fix the footer links.')
  })

  it('refuses with no Watcher, and for a Watcher that has said nothing, changing nothing', async () => {
    const f = await fixture()
    const creates = f.creates()
    expect(await f.service.startNew()).toMatchObject({ status: 'refused', message: 'This Watcher is new, so there is nothing to hand over yet. Nothing was changed.' })
    expect(f.service.state()).toMatchObject({ current: { target: f.first }, history: [], handover: null })
    expect(f.creates()).toBe(creates)
    expect(f.revoke).not.toHaveBeenCalled()

    const fresh = await fixture()
    await fresh.control.updateWatcher(record => { record.current = null })
    expect(await fresh.service.startNew()).toMatchObject({ status: 'refused', code: 'NOT_CURRENT_WATCHER' })
  })

  it('waits only for Watcher’s own turn, and hands its queued send and its worker still working to the new Watcher (#1325, #1735)', async () => {
    const f = await fixture()
    await f.send('Check the release.')
    const started = { target: await f.startWorker('Release check') }
    const queued = await f.call('send_to_thread', { requestId: f.service.state().requests.at(-1)!.id, retryKey: randomUUID(), target: started.target,
      delivery: 'queue', text: 'Add the release notes too.' })
    if (queued.status !== 'ok' || !('receipt' in queued)) throw new Error(`queue refused: ${JSON.stringify(queued)}`)
    expect(queued.receipt.deliveryState).toBe('queued')
    // Watcher's own turn holds it, and the refusal says to stop it.
    f.native(f.first.threadId).status = 'running'; await f.refresh()
    const creates = f.creates()
    expect(await f.service.startNew()).toMatchObject({ status: 'refused', code: 'THREAD_BUSY',
      message: 'Watcher is working. Stop its turn, then start a new Watcher. Nothing was changed.' })
    expect(f.service.state()).toMatchObject({ current: { target: f.first }, history: [], handover: null, newWatcher: 'busy' })
    expect(f.creates()).toBe(creates)
    expect(f.revoke).not.toHaveBeenCalled()
    await f.reply('Started Release check and queued the notes.')
    // Resting, nothing else holds it: the send queued behind the worker's turn and the worker still working go with it.
    expect(f.service.state().newWatcher).toBe('available')
    expect(f.service.startsInFlight()).toBe(1)
    expect(await f.service.startNew()).toMatchObject({ status: 'ok', state: { history: [{ target: f.first }] } })
    expect(f.service.state().current!.target).not.toEqual(f.first)
    expect(f.service.startsInFlight()).toBe(1)
    // The handover names the send still to go, which the new Watcher can read by its operation.
    const handover = f.service.readHandover()
    if (handover.status !== 'ok') throw new Error('handover unreadable')
    expect(handover.text).toContain('Starts and sends made before you that have not gone yet')
    expect(handover.text).toContain(`A send to “Release check”, queued behind its turn (operation ${queued.receipt.operationId})`)
    expect(handover.text).toContain('The threads you watch and what each waits on:')
    // When the worker's turn ends, the send goes once, from the new Watcher, under the receipt it was queued with.
    await f.finish(started.target.threadId)
    await vi.waitFor(() => expect(f.control.watcherRecord().operations.find(item => item.id === queued.receipt.operationId)!.deliveryState).toBe('accepted'))
    expect(f.native(started.target.threadId).messages.filter(message => message.role === 'user' && message.text.includes('Add the release notes too.'))).toHaveLength(1)
    // The new Watcher acts under the request the last one worked on, which is its own now.
    const inherited = f.service.state().requests.find(item => item.watcher.threadId === f.first.threadId && item.state === 'active')
    if (!inherited) throw new Error('the last Watcher’s request is no longer active')
    expect(await f.call('stop_thread', { requestId: inherited.id, retryKey: randomUUID(), target: started.target })).toMatchObject({ status: 'ok' })
    await f.finish(started.target.threadId)
    expect(f.service.startsInFlight()).toBe(0)
  })

  it('starts while Watcher waits on its own card: stops that turn, hands the question over and moves the user’s queued message, paused (#1735)', async () => {
    const f = await fixture()
    await f.exchange('Watch the release.', 'Watching it.')
    await f.send('Which branch should the release use?')
    const request = f.service.state().requests.at(-1)!
    // Watcher asks the user on a card of its own, and the user queues another message behind that turn.
    const native = f.native(f.first.threadId)
    native.status = 'running'
    native.requests = [{ id: 'watcher-card', kind: 'question', text: 'Which branch?', options: [],
      questions: [{ id: 'branch', question: 'Release from main or from release/1.4?', options: [{ id: 'main', label: 'main' }], multiSelect: false, allowFreeText: true }] }]
    await f.refresh()
    const queuedDraft = randomUUID()
    expect((await f.control.commandShell({ type: 'queue-followup', threadId: f.first.threadId, draftId: queuedDraft, text: 'Also tag it.' })).error).toBeNull()
    // Queued behind Watcher's turn, it is recorded as a continuation of the request that turn answers.
    expect(f.service.state().requests.find(item => item.id === request.id)!.userFollowups?.map(item => item.draftId)).toContain(queuedDraft)
    // And has half a message written in Watcher's box.
    expect((await f.control.commandShell({ type: 'save-thread-draft', threadId: f.first.threadId, draftId: randomUUID(), text: 'And check the changelog', composer: 'manual' })).error).toBeNull()
    expect(f.service.state().newWatcher).toBe('available')
    const interrupts = () => f.workspace.adapters.codex.commands.filter(command => command.type === 'interrupt').length
    const before = interrupts()
    expect(await f.service.startNew()).toMatchObject({ status: 'ok', state: { history: [{ target: f.first }] } })
    const next = f.service.state().current!.target
    // The last Watcher's turn was stopped, which closes its card. That is not the user's Stop: the request it worked on ends
    // as a finished turn's does, and nothing it queued is fenced.
    expect(interrupts()).toBe(before + 1)
    expect(f.service.state().requests.find(item => item.id === request.id)!.state).not.toBe('stopped')
    // The user's queued message moved to the new Watcher's queue, paused, and nothing went to the last one. Watcher's sends
    // steer by default, so it may have been on its way into the stopped turn at the press; then it moves once it comes back.
    await vi.waitFor(() => {
      const queue = f.control.shell().followups ?? []
      expect(queue.filter(item => item.threadId === f.first.threadId && !item.wakeUp)).toEqual([])
      expect(queue.find(item => item.text === 'Also tag it.')).toMatchObject({ threadId: next.threadId, status: 'paused',
        error: 'This was waiting for the last Watcher. Resume the queue to send it to this one, or remove it.' })
      // It no longer continues the last Watcher's request: sent to the new one, it starts a request the new one's tools take.
      expect(f.service.state().requests.some(item => item.userFollowups?.some(followup => followup.draftId === queuedDraft))).toBe(false)
    })
    expect(native.messages.some(message => message.text.includes('Also tag it.'))).toBe(false)
    // The new Watcher's note says both, and the handover carries the question in its own words.
    // What was written in the last Watcher's box waits, unsent, in the new one's.
    const drafts = f.control.get().threadDrafts ?? []
    expect(drafts.find(draft => draft.threadId === next.threadId)?.text).toBe('And check the changelog')
    expect(drafts.some(draft => draft.threadId === f.first.threadId)).toBe(false)
    await vi.waitFor(() => expect(f.service.state().carried).toEqual({ questionClosed: true, moved: 1, unconfirmed: false, draftMoved: true, cannotStop: [] }))
    const handover = f.service.readHandover()
    if (handover.status !== 'ok') throw new Error('handover unreadable')
    expect(handover.text).toContain('Its turn was stopped and the card closed unanswered, so ask again if it still matters:\n- Release from main or from release/1.4?')
    expect(handover.text).toContain('One message the user wrote to the last Watcher had not gone. It waits, paused, in your queue')
  })

  it('starts anyway when the turn waiting on Watcher’s card cannot be stopped, and says the card may still be open (#1735)', async () => {
    const f = await fixture()
    await f.exchange('Watch the release.', 'Watching it.')
    await f.send('Which branch should the release use?')
    const native = f.native(f.first.threadId)
    native.status = 'running'
    native.requests = [{ id: 'watcher-card', kind: 'question', text: 'Release from main?', options: [] }]
    await f.refresh()
    const fromWatcher = f.control.commandFromWatcher.bind(f.control)
    vi.spyOn(f.control, 'commandFromWatcher').mockImplementation(async (command, origin) => {
      if (command.type === 'interrupt') throw new Error('synthetic-stalled-provider')
      return fromWatcher(command, origin)
    })
    expect(await f.service.startNew()).toMatchObject({ status: 'ok', state: { history: [{ target: f.first }] } })
    expect(f.service.state().carried).toMatchObject({ questionClosed: false, questionOpen: true })
    const handover = f.service.readHandover()
    if (handover.status !== 'ok') throw new Error('handover unreadable')
    expect(handover.text).toContain('Its turn could not be stopped, so its card may still be open in that conversation')
    expect(handover.text).toContain('- Release from main?')
  })

  it('keeps the closed card’s question for the handover when the first try fails before saving anything (#1735)', async () => {
    const f = await fixture()
    await f.exchange('Watch the release.', 'Watching it.')
    await f.send('Which branch should the release use?')
    const native = f.native(f.first.threadId)
    native.status = 'running'
    native.requests = [{ id: 'watcher-card', kind: 'question', text: 'Release from main?', options: [] }]
    await f.refresh()
    // The first try stops the turn, which closes the card, then fails before the new Watcher is saved.
    const update = f.control.updateWatcher.bind(f.control)
    const failing = vi.spyOn(f.control, 'updateWatcher').mockImplementationOnce(async () => { throw new Error('synthetic-write-failure') })
    expect(await f.service.startNew()).toMatchObject({ status: 'refused' })
    failing.mockImplementation(update)
    native.requests = []; native.status = 'idle'; native.lastTurn = { id: randomUUID(), status: 'interrupted' }; await f.refresh()
    expect(f.control.watcherRecord().creation).toBeNull()
    // The second try finds no card, and still hands the first one's question over.
    expect(await f.service.startNew()).toMatchObject({ status: 'ok', state: { history: [{ target: f.first }] } })
    expect(f.service.state().carried).toMatchObject({ questionClosed: true })
    const handover = f.service.readHandover()
    if (handover.status !== 'ok') throw new Error('handover unreadable')
    expect(handover.text).toContain('- Release from main?')
  })

  it('moves a message that was still being sent at the press once it comes back unsent, to whichever Watcher is current, and its note counts it (#1735)', async () => {
    const f = await fixture()
    await f.exchange('Watch the release.', 'Watching it.')
    const store = followupStoreOf(f.control)
    // A message to the last Watcher is still being written to its provider when the press's moment ends.
    const sending = vi.spyOn(f.control, 'watcherFollowupSending').mockReturnValue(false)
    expect(await f.service.startNew()).toMatchObject({ status: 'ok' })
    const second = f.service.state().current!.target
    await store.enqueue({ threadId: f.first.threadId, draftId: randomUUID(), text: 'Late words', attachments: [] })
    await (store as unknown as { change(update: (state: { items: { text: string; status: string }[] }) => void): Promise<void> }).change(state => {
      state.items.find(item => item.text === 'Late words')!.status = 'dispatching'
    })
    sending.mockImplementation(threadId => threadId === f.first.threadId)
    ;(f.service as unknown as { lateQueue: unknown[] }).lateQueue = [f.first]
    // Another replacement comes before it settles: the message still goes to the Watcher that is current when it does.
    await f.exchange('Then the notes.', 'On it.')
    expect(await f.service.startNew()).toMatchObject({ status: 'ok' })
    const third = f.service.state().current!.target
    expect(third).not.toEqual(second)
    // It fails to send, and comes back to the last Watcher's queue, unsent.
    await (store as unknown as { change(update: (state: { items: { text: string; status: string }[] }) => void): Promise<void> }).change(state => {
      state.items.find(item => item.text === 'Late words')!.status = 'failed'
    })
    // A message sent at once that failed is put back in the last Watcher's box, while the user is already writing in the
    // new one's.
    expect((await f.control.commandShell({ type: 'save-thread-draft', threadId: f.first.threadId, draftId: randomUUID(), text: 'Late box words', composer: 'manual' })).error).toBeNull()
    expect((await f.control.commandShell({ type: 'save-thread-draft', threadId: third.threadId, draftId: randomUUID(), text: 'Already typing', composer: 'manual' })).error).toBeNull()
    sending.mockReturnValue(false)
    await f.control.commandShell({ type: 'observe-threads', threadIds: [third.threadId] })
    await vi.waitFor(() => expect(store.peek().items.find(item => item.text === 'Late words')).toMatchObject({ threadId: third.threadId, status: 'paused' }))
    // What the user is writing stays; the late words wait in the new Watcher's queue, paused, and the note counts both.
    await vi.waitFor(() => expect(f.service.state().carried).toMatchObject({ moved: 2 }))
    expect(f.control.get().threadDrafts?.find(draft => draft.threadId === third.threadId)?.text).toBe('Already typing')
    expect(store.peek().items.find(item => item.text === 'Late box words')).toMatchObject({ threadId: third.threadId, status: 'paused' })
    expect(f.control.get().threadDrafts?.some(draft => draft.threadId === f.first.threadId)).toBe(false)
  })

  it('refuses when Watcher’s model is not ready or its permission mode is not the one in force', async () => {
    const f = await fixture()
    await f.exchange('Watch the release.', 'Watching it.')
    const creates = f.creates()
    const snapshot = f.control.watcherSnapshot.bind(f.control)
    const notReady = vi.spyOn(f.control, 'watcherSnapshot').mockImplementation(() => {
      const shown = snapshot()
      return { ...shown, models: shown.models.map(model => ({ ...model, ready: false })) }
    })
    expect(await f.service.startNew()).toMatchObject({ status: 'refused', code: 'PROVIDER_UNAVAILABLE', message: 'Watcher’s model is not ready. Connect its provider and try again.' })
    notReady.mockRestore()
    // The saved choice says one mode and the thread reports another: nothing is started on either.
    f.native(f.first.threadId).runtimeMode = 'approval-required'; await f.refresh()
    await f.control.updateWatcher(record => { record.lastRuntimeMode = 'auto-accept-edits' })
    expect(await f.service.startNew()).toMatchObject({ status: 'refused', code: 'PERMISSION_NOT_COMPARABLE' })
    expect(f.service.state()).toMatchObject({ current: { target: f.first }, history: [], handover: null })
    expect(f.creates()).toBe(creates)
  })

  it('finishes a New Watcher stopped part-way, and then offers the handover of the same provider’s last Watcher', async () => {
    const f = await fixture()
    await f.exchange('Watch the footer links thread.', 'Watching Footer links.')
    const original = f.control.commandForWatcherRoom.bind(f.control)
    let failed = false
    const spy = vi.spyOn(f.control, 'commandForWatcherRoom').mockImplementation(async (command, guard) => {
      if (command.type === 'create-thread' && !failed) { failed = true; return { ...f.control.get(), error: 'Codex did not start.' } }
      return original(command, guard)
    })
    expect(await f.service.startNew()).toMatchObject({ status: 'refused', code: 'PROVIDER_UNAVAILABLE' })
    expect(f.service.state().handover).toBeNull()
    expect(f.control.watcherRecord().creation).not.toBeNull()
    expect(await f.service.startNew()).toMatchObject({ status: 'ok', state: { current: { provider: 'codex' } } })
    spy.mockRestore()
    expect(f.control.watcherRecord().creation).toBeNull()
    expect(f.service.state().handover).toMatchObject({ source: f.first, provider: 'codex', counts: { carried: 2 } })
  })

  it('tells the room what New Watcher would answer, with a worker start still working after Watcher’s turn', async () => {
    const f = await fixture()
    // Nothing said yet: nothing to hand over.
    expect(f.service.state().newWatcher).toBe('empty')
    await f.send('Check the release.')
    expect(f.service.state().newWatcher).toBe('busy')
    const worker = await f.startWorker('Release check')
    await f.reply('Started Release check.')
    expect(f.control.watcherSnapshot().threads.find(thread => thread.id === f.first.threadId)?.status).toBe('idle')
    // Watcher's own turn is over: the start it made, still working, holds nothing back (#1325).
    expect(f.service.startsInFlight()).toBe(1)
    expect(f.service.state().newWatcher).toBe('available')
    await f.finish(worker.threadId)
    expect(f.service.state().newWatcher).toBe('available')
  })

  it('refuses New Watcher while a change of Watcher’s model is under way, creating nothing', async () => {
    const f = await fixture()
    f.workspace.adapters.codex.state.models.push({ ...f.workspace.adapters.codex.state.models[0]!, id: 'fake:other', name: 'Other model' })
    await f.refresh()
    await f.exchange('Watch the release.', 'Watching it.')
    const other = f.control.shell().host.models.find(item => item.providerId === 'codex' && item.id !== f.model.id)!
    const original = f.control.commandForWatcherRoom.bind(f.control)
    const entered = deferred(), released = deferred()
    const spy = vi.spyOn(f.control, 'commandForWatcherRoom').mockImplementation(async (command, guard) => {
      if (command.type === 'configure-thread') { entered.resolve(); await released.promise }
      return original(command, guard)
    })
    try {
      const changing = f.service.open({ provider: 'codex', modelId: other.id })
      await entered.promise
      const creates = f.creates()
      expect(await f.service.startNew()).toEqual({ status: 'refused', code: 'THREAD_BUSY', message: 'Wait for Watcher to finish changing before starting a new one.', retryable: true })
      released.resolve()
      // The open settles with its own answer, which New Watcher's press never took.
      expect(await changing).not.toEqual(expect.objectContaining({ message: 'Wait for Watcher to finish changing before starting a new one.' }))
      expect(f.service.state()).toMatchObject({ current: { target: f.first }, history: [], handover: null })
      expect(f.creates()).toBe(creates)
    } finally { released.resolve(); spy.mockRestore() }
  })

  it('refuses an open during New Watcher, and a second press joins the first', async () => {
    const f = await fixture()
    f.workspace.adapters.codex.state.models.push({ ...f.workspace.adapters.codex.state.models[0]!, id: 'fake:other', name: 'Other model' })
    await f.refresh()
    await f.exchange('Watch the release.', 'Watching it.')
    const other = f.control.shell().host.models.find(item => item.providerId === 'codex' && item.id !== f.model.id)!
    const original = f.control.commandForWatcherRoom.bind(f.control)
    const entered = deferred(), released = deferred()
    let created = 0
    const spy = vi.spyOn(f.control, 'commandForWatcherRoom').mockImplementation(async (command, guard) => {
      if (command.type === 'create-thread') { created++; entered.resolve(); await released.promise }
      return original(command, guard)
    })
    try {
      const first = f.service.startNew()
      await entered.promise
      expect(await f.service.open({ provider: 'codex', modelId: other.id })).toEqual({ status: 'refused', code: 'THREAD_BUSY',
        message: 'Wait for the new Watcher to start before changing its model.', retryable: true })
      const second = f.service.startNew()
      expect(second).toBe(first)
      released.resolve()
      expect(await first).toMatchObject({ status: 'ok', state: { history: [{ target: f.first }], currentOptions: { modelId: f.model.id } } })
      expect(created).toBe(1)
    } finally { released.resolve(); spy.mockRestore() }
  })

  it('tells the room a creation stopped part-way only once nothing is finishing it', async () => {
    const f = await fixture()
    await f.exchange('Watch the footer links thread.', 'Watching Footer links.')
    expect(f.service.state().creationStopped).toBe(false)
    const original = f.control.commandForWatcherRoom.bind(f.control)
    const entered = deferred(), released = deferred()
    let attempt = 0
    const published: boolean[] = []
    const unsubscribe = f.service.subscribe(() => { published.push(f.service.state().creationStopped === true) })
    const spy = vi.spyOn(f.control, 'commandForWatcherRoom').mockImplementation(async (command, guard) => {
      if (command.type === 'create-thread' && ++attempt === 1) return { ...f.control.get(), error: 'Codex did not start.' }
      if (command.type === 'create-thread' && attempt === 2) { entered.resolve(); await released.promise }
      return original(command, guard)
    })
    try {
      expect(await f.service.startNew()).toMatchObject({ status: 'refused' })
      // Stopped, and the room is told once the press has settled.
      expect(f.service.state().creationStopped).toBe(true)
      expect(published.at(-1)).toBe(true)
      // While a retry is finishing it, it has not stopped.
      const retry = f.service.startNew()
      await entered.promise
      expect(f.service.state().creationStopped).toBe(false)
      released.resolve()
      expect(await retry).toMatchObject({ status: 'ok', state: { creationStopped: false } })
      expect(f.service.state().creationStopped).toBe(false)
      expect(published.at(-1)).toBe(false)
    } finally { released.resolve(); spy.mockRestore(); unsubscribe() }
  })

  it('a same-provider replacement finished through open offers the handover; a model change after it offers none', async () => {
    const f = await fixture()
    f.workspace.adapters.codex.state.models.push({ ...f.workspace.adapters.codex.state.models[0]!, id: 'fake:other', name: 'Other model' })
    await f.refresh()
    await f.exchange('Watch the release.', 'Watching it.')
    const original = f.control.commandForWatcherRoom.bind(f.control)
    let failed = false
    const spy = vi.spyOn(f.control, 'commandForWatcherRoom').mockImplementation(async (command, guard) => {
      if (command.type === 'create-thread' && !failed) { failed = true; return { ...f.control.get(), error: 'Codex did not start.' } }
      return original(command, guard)
    })
    expect(await f.service.startNew()).toMatchObject({ status: 'refused' })
    // Open with the choice the creation was saved with finishes it, as it finishes a provider change.
    const pending = f.control.watcherRecord().creation!
    const reopened = await f.service.open({ provider: 'codex', modelId: pending.modelId!, ...(pending.reasoningEffort ? { reasoningEffort: pending.reasoningEffort } : {}) })
    expect(reopened, JSON.stringify(reopened)).toMatchObject({ status: 'ok' })
    spy.mockRestore()
    expect(f.service.state().handover).toMatchObject({ source: f.first, provider: 'codex' })
    expect(f.service.dismissHandover()).toMatchObject({ status: 'ok', state: { handover: null } })
    // Changing the model on the same provider makes no new Watcher and no history, so nothing is offered again.
    const other = f.control.shell().host.models.find(item => item.providerId === 'codex' && item.id !== f.model.id)!
    const current = f.service.state().current!.target
    expect(await f.service.open({ provider: 'codex', modelId: other.id })).toMatchObject({ status: 'ok' })
    expect(f.service.state()).toMatchObject({ current: { target: current }, history: [{ target: f.first }], handover: null })
  })

  it('a first Watcher whose creation stopped part-way offers no handover once finished', async () => {
    const workspace = await workspaceFixture(undefined, { history: true })
    cleanups.push(workspace.remove)
    const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' },
      control: { watcherEnabled: true, historyEnabled: () => true } })
    const service = new WatcherService({ directory: f.root, host: workspace.host, control: f.control, historyEnabled: () => true })
    const tools = new WatcherToolServer(service); workspace.host.useWatcherTools(tools)
    cleanups.push(async () => { service.close(); await tools.close(); await f.dispose(); await workspace.stop() })
    await f.control.start()
    await f.control.commandShell({ type: 'connect', provider: 'codex' })
    await service.recover()
    const model = f.control.shell().host.models.find(item => item.providerId === 'codex')!
    const original = f.control.commandForWatcherRoom.bind(f.control)
    let failed = false
    vi.spyOn(f.control, 'commandForWatcherRoom').mockImplementation(async (command, guard) => {
      if (command.type === 'create-thread' && !failed) { failed = true; return { ...f.control.get(), error: 'Codex did not start.' } }
      return original(command, guard)
    })
    expect(await service.open({ provider: 'codex', modelId: model.id })).toMatchObject({ status: 'refused' })
    const finished = await service.startNew()
    expect(finished, JSON.stringify(finished)).toMatchObject({ status: 'ok' })
    expect(service.state()).toMatchObject({ history: [], handover: null })
  })
})
