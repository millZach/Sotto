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

  it('waits only for Watcher’s own work and says what holds it, while a worker still working and an unconfirmed delivery carry on (#1325)', async () => {
    const f = await fixture()
    await f.send('Check the release.')
    const started = { target: await f.startWorker('Release check') }
    await f.reply('Started Release check.')
    const unchanged = async (message: string) => {
      const creates = f.creates()
      expect(await f.service.startNew()).toMatchObject({ status: 'refused', code: 'THREAD_BUSY', message })
      expect(f.service.state()).toMatchObject({ current: { target: f.first }, history: [], handover: null })
      expect(f.creates()).toBe(creates)
      expect(f.revoke).not.toHaveBeenCalled()
    }
    // Watcher's own turn.
    f.native(f.first.threadId).status = 'running'; await f.refresh()
    await unchanged('Watcher is working. Wait for this turn to finish, or stop it, then start a new Watcher. Nothing was changed.')
    await f.finish(f.first.threadId)
    // A send queued behind a working thread, in the record main reads: a new Watcher could not send it.
    const read = f.control.watcherRecord.bind(f.control)
    const queued = vi.spyOn(f.control, 'watcherRecord').mockImplementation(() => {
      const record = read(); record.operations.at(-1)!.deliveryState = 'queued'; return record
    })
    await unchanged('Watcher has a message queued for a thread that is still working, which a new Watcher could not send. Wait until it has gone, or stop it with Stop all, then start a new Watcher. Nothing was changed.')
    queued.mockRestore()
    // A start still working, whose delivery is not confirmed yet either, holds nothing: it carries on after the replacement.
    expect(f.service.startsInFlight()).toBe(1)
    const uncertain = vi.spyOn(f.control, 'watcherRecord').mockImplementation(() => {
      const record = read(); record.operations.at(-1)!.deliveryState = 'uncertain'; return record
    })
    expect(await f.service.startNew()).toMatchObject({ status: 'ok', state: { history: [{ target: f.first }] } })
    uncertain.mockRestore()
    expect(f.service.state().current!.target).not.toEqual(f.first)
    expect(f.service.startsInFlight()).toBe(1)
    await f.finish(started.target.threadId)
    expect(f.service.startsInFlight()).toBe(0)
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
    const unsubscribe = f.service.subscribe(state => { published.push(state.creationStopped === true) })
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
