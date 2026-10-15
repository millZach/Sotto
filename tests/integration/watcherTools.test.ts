// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { WatcherService } from '../../src/main/agents/watcher'
import { watcherMessageRequests, watcherRequestLine, watcherRequestNote, watcherTextAsTyped } from '../../src/main/agents/watcherRequestNote'
import { watcherDisplayPrompt } from '../../src/main/agents/watcherMessageDisplay'
import { WATCHER_WAKE_UP_PROMPT } from '../../src/main/agents/watcherNews'
import { watcherWakeUpNote } from '../../src/main/agents/wakeUp'
import type { QueuedFollowup } from '../../src/main/agents/followups'
import { WatcherPhoneService } from '../../src/main/agents/watcherPhone'
import { RESUME_NOTE } from '../../src/shared/restartResume'
import type { ProviderId } from '../../src/shared/agents'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import { watcherToolSchemas } from '../../src/shared/watcher'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { deferred } from '../fixtures/deferred'
import { PIXEL_PNG } from '../fixtures/stagedImages'
import { initializeGitRepository } from '../fixtures/gitRepository'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture(history = true) {
  const workspace = await workspaceFixture(undefined, { history })
  cleanups.push(workspace.remove)
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host,
    credentialOptions: { mode: 'unavailable' }, control: { historyEnabled: () => history, watcherEnabled: true } })
  let limit = 4
  const service = new WatcherService({ directory: f.root, host: workspace.host, control: f.control,
    historyEnabled: () => history, limit: () => limit })
  const tools = new WatcherToolServer(service)
  workspace.host.useWatcherTools(tools)
  cleanups.push(async () => { service.close(); await tools.close(); f.control.dispose(); await f.control.closed(); await workspace.stop() })
  await f.control.start()
  await f.control.commandShell({ type: 'connect', provider: 'codex' })
  await service.recover()
  const model = f.control.shell().host.models.find(item => item.providerId === 'codex')!
  const project = f.control.shell().host.projects.find(item => item.providerId === 'codex')!
  const opened = await service.open({ provider: 'codex', modelId: model.id })
  expect(opened).toMatchObject({ status: 'ok' })
  const id = service.state().current!.target.threadId
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
    setLimit: (value: number) => { limit = value }, finish: async (threadId: string) => {
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
      watchedThreads: before.watchedThreads, requests: before.requests, receipts: before.receipts,
      inFlight: before.inFlight, inFlightLimit: before.inFlightLimit })
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

it('enforces distinct target capacity from the current main setting and four prompts per target without replenishing retries', async () => {
  const f = await fixture(); f.setLimit(1)
  const first = await f.call('start_thread', f.start())
  expect(first.status).toBe('ok')
  expect(await f.call('start_thread', f.start())).toMatchObject({ status: 'refused', code: 'IN_FLIGHT_LIMIT' })
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

it('fences a queued machine prompt before a direct user send and preserves user input', async () => {
  const f = await fixture(), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start refused')
  expect(await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target, delivery: 'queue', text: 'synthetic_machine_queued' })).toMatchObject({ status: 'ok' })
  await f.control.commandShell({ type: 'manual-send', threadId: first.target.threadId, draftId: randomUUID(), text: 'synthetic_direct_user' })
  await f.finish(first.target.threadId)
  expect(f.service.state().watchedThreads[0]!.participation[0]).toMatchObject({ state: 'taken-over', takeover: { reason: 'user-send' } })
  await f.finish(f.id)
  await f.control.commandShell({ type: 'manual-send', threadId: f.id, draftId: randomUUID(), text: 'Synthetic new request' })
  const nextRequest = f.service.state().requests.at(-1)!.id
  expect(await f.call('send_to_thread', { requestId: nextRequest, retryKey: randomUUID(), target: first.target, delivery: 'queue', text: 'synthetic_after_takeover' })).toMatchObject({ status: 'refused', code: 'THREAD_TAKEN_OVER' })
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
  expect(f.service.state().watchedThreads[0]!.participation[0]!.state).toBe('taken-over')
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

it('refuses Stop all after a previewed worker is taken over without changing its saved record', async () => {
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
  expect(f.service.state().inFlight).toBe(0)
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
  expect(f.service.state().inFlight).toBe(0)
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
  expect(f.service.state().inFlight).toBe(1)
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


it('keeps stopped user continuations scoped without replenishing the request budget', async () => {
  const f = await fixture(), started = await f.call('start_thread', f.start())
  expect(started.status).toBe('ok')
  const preview = f.service.prepareStopAll()
  if (preview.status !== 'ok') throw new Error('preview refused')
  expect(await f.service.stopAll(preview.confirmationId)).toMatchObject({ status: 'ok' })
  expect((await f.control.commandShell({ type: 'queue-followup', threadId: f.id, draftId: randomUUID(), text: 'Synthetic stopped continuation' })).error).toBeNull()
  const draftId = f.control.shell().followups!.find(item => item.threadId === f.id)!.draftId
  await f.finish(f.id)
  await vi.waitFor(() => expect(f.workspace.adapters.codex.commands.some(item => item.type === 'send' && item.text.startsWith('Synthetic stopped continuation'))).toBe(true))
  expect(f.service.state().requests).toHaveLength(1)
  expect(f.service.state().requests[0]).toMatchObject({ id: f.requestId, state: 'stopped', userFollowups: [{ draftId, messageId: expect.any(String) }] })
  expect(await f.call('start_thread', f.start())).toMatchObject({ status: 'refused', code: 'REQUEST_NOT_ACTIVE' })
})

it('retains an uncertain existing delivery through takeover while admitting an unrelated new start', async () => {
  const f = await fixture(); f.setLimit(1)
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
  expect(f.service.state().watchedThreads[0]!.participation[0]!.state).toBe('taken-over')
  expect(f.service.state().inFlight).toBe(0)
  expect(await f.call('start_thread', f.start())).toMatchObject({ status: 'ok' })
  await original(written!)
  await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  expect(f.service.state().inFlight).toBe(1)
})

it('releases a definitively failed creation reservation and refunds its pre-writer prompt', async () => {
  const f = await fixture(); f.setLimit(1)
  expect(await f.call('start_thread', { ...f.start(), workingCopy: { kind: 'new-worktree' } })).toMatchObject({ status: 'refused', code: 'WORKING_COPY_CHANGED' })
  expect(f.service.state().inFlight).toBe(0)
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
  const recovered = new WatcherService({ directory: f.root, host: f.workspace.host, control: f.control, historyEnabled: () => true, limit: () => 4 })
  cleanups.push(async () => { recovered.close() })
  await recovered.recover()
  expect(recovered.state().recoveryNotice).toBeNull()
  expect(recovered.state().watchedThreads[0]!.participation[0]).toMatchObject({ state: 'taken-over', takeover: { reason: 'native-user-send' } })
  await f.finish(f.id)
  await f.control.commandShell({ type: 'manual-send', threadId: f.id, draftId: randomUUID(), text: 'Synthetic later root request' })
  expect(await recovered.invoke(f.id, 'send_to_thread', { requestId: recovered.state().requests.at(-1)!.id, retryKey: randomUUID(), target: first.target, delivery: 'queue', text: 'Synthetic rejected resumption' }))
    .toMatchObject({ status: 'refused', code: 'THREAD_TAKEN_OVER' })
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
  f.service.userCommand({ type: 'remove-followup', threadId: first.target.threadId, itemId: randomUUID() }, first.target.threadId, false)
  expect(f.service.state().watchedThreads[0]!.participation[0]).toMatchObject({ state: 'taken-over', takeover: { reason: 'user-reconfigure' } })
  const other = await f.call('start_thread', f.start())
  if (other.status !== 'ok' || !('target' in other)) throw new Error('start refused')
  f.service.userCommand({ type: 'git-switch-branch', threadId: other.target.threadId, ref: 'synthetic-branch' }, other.target.threadId, false)
  expect(f.service.state().watchedThreads.find(item => item.target.threadId === other.target.threadId)!.participation[0]!.state).toBe('taken-over')
})

it('keeps preexisting user queues intact when machine Stop interrupts their thread', async () => {
  const f = await fixture()
  await f.control.commandShell({ type: 'create-thread', projectId: f.project.id, title: 'Synthetic user worker', modelId: f.model.id })
  const threadId = f.control.shell().activeThreadId!
  await f.control.commandShell({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'Synthetic user work' })
  await f.control.commandShell({ type: 'queue-followup', threadId, draftId: randomUUID(), text: 'Synthetic preexisting user queue' })
  const queued = f.control.shell().followups!.filter(item => item.threadId === threadId)
  expect(queued).toHaveLength(1)
  expect(await f.call('stop_thread', { requestId: f.requestId, retryKey: randomUUID(), target: { hostId: f.control.hostId()!, threadId } })).toMatchObject({ status: 'ok' })
  expect(f.control.shell().followups!.filter(item => item.threadId === threadId)).toEqual(queued)
  expect(f.workspace.adapters.codex.commands.some(item => item.type === 'send' && item.text === 'Synthetic preexisting user queue')).toBe(false)
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
  expect(f.control.shell().followups!.filter(item => item.threadId === threadId)).toEqual(queued)
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


it('waits for active worker slots before replacing the master provider', async () => {
  const f = await fixture(), first = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first)) throw new Error('start refused')
  await f.finish(f.id)
  await f.control.commandShell({ type: 'connect', provider: 'claude' })
  const model = f.control.watcherSnapshot().models.find(item => item.providerId === 'claude' && item.ready)!
  expect(f.service.state().inFlight).toBe(1)
  expect(await f.service.open({ provider: 'claude', modelId: model.id })).toMatchObject({ status: 'refused', code: 'THREAD_BUSY' })
  expect(f.service.state().current!.target.threadId).toBe(f.id)
  await f.finish(first.target.threadId)
  expect(f.service.state().inFlight).toBe(0)
  expect(await f.service.open({ provider: 'claude', modelId: model.id })).toMatchObject({ status: 'ok' })
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
  expect(f.service.state().inFlight).toBe(1)
  await f.finish(first.target.threadId)
  await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  expect(f.service.state().receipts.at(-1)!.deliveryState).toBe('accepted')
  expect(f.service.state().inFlight).toBe(0)
})

/** Sotto's wake-ups for Watcher are shown nowhere, so these read the coordinator's own queue and the news its send carries. */
const queued = (f: Awaited<ReturnType<typeof fixture>>): readonly QueuedFollowup[] =>
  (f.control as unknown as { followupStore: { peek(): { items: readonly QueuedFollowup[] } } }).followupStore.peek().items
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
  const expected = kind === 'finish' ? 'foreground turn finished' : kind === 'failure' ? 'turn failed' : 'Open this thread to answer'
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
})

it('lets a paused wake-up no one is shown go on by itself once Watcher finishes a turn', async () => {
  const f = await fixture(), started = await f.call('start_thread', f.start())
  if (started.status !== 'ok' || !('target' in started)) throw new Error('start refused')
  await f.finish(started.target.threadId)
  expect(await f.service.watchThread({ target: started.target })).toMatchObject({ status: 'ok' })
  // Watcher is still on the user's request when the worker asks a question, so the news waits.
  f.native(started.target.threadId).requests = [{ id: 'held-card', kind: 'question', text: 'Synthetic question', options: [] }]
  f.workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  await vi.waitFor(() => expect(waitingNews(f)).toContain('Open this thread to answer'), { timeout: 15_000 })
  // The user stops Watcher. Its queue pauses, and no one is shown this wake-up to resume it.
  expect((await f.control.commandShell({ type: 'interrupt', threadId: f.id })).error).toBeNull()
  await vi.waitFor(() => expect(queued(f).find(item => item.threadId === f.id && item.wakeUp)).toMatchObject({ status: 'paused' }))
  expect(f.control.shell().followups?.filter(item => item.threadId === f.id)).toEqual([])
  // Watcher's next turn ends, and the wake-up goes by itself.
  await f.finish(f.id)
  const master = f.workspace.registry.byThread(f.id)!.sessionId
  await vi.waitFor(() => expect(f.workspace.adapters.codex.commands.some(command => command.type === 'send' && command.threadId === master
    && command.watcherNews?.includes('Open this thread to answer'))).toBe(true), { timeout: 15_000 })
})

it('withdraws answered worker news while retaining the user queue before a busy master wake-up', async () => {
  const f = await fixture(), started = await f.call('start_thread', f.start())
  if (started.status !== 'ok' || !('target' in started)) throw new Error('start refused')
  const native = f.workspace.adapters.codex.state.threads.find(thread => thread.id === f.workspace.registry.byThread(started.target.threadId)!.sessionId)!
  native.requests = [{ id: 'answer-before-delivery', kind: 'permission', text: 'private args', options: [] }]; f.workspace.adapters.codex.emit()
  await vi.waitFor(() => expect(waitingNews(f)).toContain('Open this thread to answer'), { timeout: 15_000 })
  await f.control.commandShell({ type: 'queue-followup', threadId: f.id, draftId: randomUUID(), text: 'User continuation first' })
  const items = queued(f).filter(item => item.threadId === f.id)
  expect(items[0]!.text).toBe('User continuation first'); expect(items.at(-1)!.wakeUp).toBe(true)
  // The user's own follow-up shows; Sotto's wake-up behind it does not.
  expect(f.control.shell().followups!.filter(item => item.threadId === f.id).map(item => item.text)).toEqual(['User continuation first'])
  native.requests = []; f.workspace.adapters.codex.emit()
  await vi.waitFor(() => expect(waitingNews(f) ?? '').not.toContain('Open this thread to answer'))
  expect(f.control.shell().followups!.some(item => item.text === 'User continuation first')).toBe(true)
})

it('rechecks answered news after checkpoint preparation and before the provider writer', async () => {
  const f = await fixture(), started = await f.call('start_thread', f.start())
  if (started.status !== 'ok' || !('target' in started)) throw new Error('start refused')
  const native = f.workspace.adapters.codex.state.threads.find(thread => thread.id === f.workspace.registry.byThread(started.target.threadId)!.sessionId)!
  native.requests = [{ id: 'late-answer', kind: 'question', text: 'private question', options: [] }]; f.workspace.adapters.codex.emit()
  await vi.waitFor(() => expect(waitingNews(f)).toContain('Open this thread to answer'), { timeout: 15_000 })
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
    await vi.waitFor(() => expect(waitingNews(f) ?? '').not.toContain('Open this thread to answer'))
    expect(f.workspace.adapters.codex.commands.filter(command => command.type === 'send' && command.threadId === master).slice(before)
      .some(command => command.type === 'send' && (command.text + (command.watcherNews ?? '')).includes('Open this thread to answer'))).toBe(false)
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
  // Recovery must see the stale receipt before any live observation has already refunded it.
  const observation = failure === 'reconciled' ? vi.spyOn(f.service, 'observe').mockImplementation(() => undefined) : undefined
  cleanups.push(async () => { observation?.mockRestore() })
  await f.finish(first.target.threadId)
  await vi.waitFor(() => expect(f.control.shell().followups?.find(item => item.text === input.text)?.status).toBe('failed'))
  if (failure === 'reconciled') expect(f.service.state().requests[0]!.participants[0]!.promptCount).toBe(2)
  if (failure === 'reconciled') await f.control.updateWatcher(record => {
    // Recovery can fence a stale dispatch receipt as uncertain before observing the durable failed queue item.
    record.operations.at(-1)!.deliveryState = 'uncertain'
  })
  observation?.mockRestore()
  await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  expect(f.service.state().receipts.at(-1)?.deliveryState).toBe('failed')
  expect(f.service.state().requests[0]!.participants[0]!.promptCount).toBe(1)
  expect(f.workspace.adapters.codex.commands.some(command => command.type === 'send' && command.text === input.text)).toBe(false)
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
  const result = await f.call('list_threads', { includeSettled: true })
  expect(result.status).toBe('ok')
  if (result.status !== 'ok' || !('rows' in result)) throw new Error('roster refused')
  const row = result.rows.find(item => item.target.threadId === first.target.threadId)!
  expect(row.participation).toHaveLength(100)
  expect(row.participation.at(-1)).toMatchObject({ requestId: latestRequestId, state: 'taken-over', takeover: { reason: 'user-send' } })
  expect(f.control.watcherRecord().requests).toHaveLength(101)
})


it.each([
  { delivery: 'now', limit: 4 }, { delivery: 'queue', limit: 4 }, { delivery: 'steer', limit: 4 }, { delivery: 'now', limit: 1 },
])('refuses $delivery to a settled participant before admission with capacity $limit', async ({ delivery, limit }) => {
  const f = await fixture(), first = await f.call('start_thread', f.start()), second = await f.call('start_thread', f.start())
  if (first.status !== 'ok' || !('target' in first) || second.status !== 'ok') throw new Error('start refused')
  await f.finish(first.target.threadId)
  expect(await f.call('settle_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target })).toMatchObject({ status: 'ok' })
  expect(f.service.state().requests[0]).toMatchObject({ state: 'active', participants: [
    { target: first.target, state: 'relinquished', promptCount: 1 }, { state: 'participating', promptCount: 1 },
  ] })
  f.setLimit(limit)
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

/** A worker's linked pull request and GitHub's read of its checks: news that wakes Watcher on its own. */
function pullRequestNews(f: Awaited<ReturnType<typeof fixture>>, threadId: string) {
  const url = 'https://github.com/synthetic/project/pull/5'
  const links = [{ url, number: 5, title: 'Synthetic pull request', state: 'open' as const, draft: false, source: 'linked' as const, linkedAt: new Date().toISOString() }]
  // The workspace's record holds a thread's links, so a later snapshot keeps them; the coordinator's copy shows them now.
  const record = (f.workspace.host as unknown as { state: { snapshot: { threads: { id: string; pullRequests?: typeof links }[] } } }).state.snapshot
  record.threads.find(thread => thread.id === threadId)!.pullRequests = structuredClone(links)
  f.control.watcherSnapshot().threads.find(thread => thread.id === threadId)!.pullRequests = links
  return { url, read: { url, head: 'synthetic-head', observedAt: new Date().toISOString(), availability: 'available' as const, checks: 'failed' as const, checkCount: 1 } }
}

it.each(['workspace-settled', 'archived', 'missing-hooks', 'disconnected'] as const)('holds pull request news for a %s master and queues it after recovery', async unavailable => {
  const f = await fixture(), started = await f.call('start_thread', f.start())
  if (started.status !== 'ok' || !('target' in started)) throw new Error('start refused')
  const target = f.service.state().current!.target
  const master = f.control.watcherSnapshot().threads.find(thread => thread.id === f.id)!
  expect(f.control.canDeliverWatcherNews(target)).toBe(true) // Busy is queueable.
  expect(f.control.canDeliverWatcherNews({ ...target, hostId: randomUUID() })).toBe(false)
  if (unavailable === 'workspace-settled') master.workspaceSettledAt = new Date().toISOString()
  if (unavailable === 'archived') master.archivedAt = new Date().toISOString()
  if (unavailable === 'missing-hooks') f.control.useWatcher(f.service)()
  if (unavailable === 'disconnected') f.control.watcherSnapshot().connected = false
  expect(f.control.canDeliverWatcherNews(target)).toBe(false)
  const deliver = vi.spyOn(f.control, 'deliverWakeUp')
  f.service.pullRequestObserved(pullRequestNews(f, started.target.threadId).read)
  await f.service.wakes.drained()
  expect(deliver).not.toHaveBeenCalled()
  delete master.workspaceSettledAt; delete master.archivedAt
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
  const restarted = new WatcherService({ directory: f.root, control: f.control, host: f.workspace.host,
    historyEnabled: () => true, limit: () => 4 })
  cleanups.push(async () => restarted.close())
  await restarted.recover(); await restarted.wakes.drained()
  expect(queued(f).find(item => item.id === waiting.id) && waitingNews(f)).toBe(news)
  restarted.pullRequestObserved({ ...read, observedAt: new Date().toISOString() }); await restarted.wakes.drained()
  expect(queued(f).find(item => item.id === waiting.id) && waitingNews(f)).toBe(news)
  expect(f.control.watcherRecord().wakeEventIds).toEqual(ids)
  expect(f.workspace.adapters.codex.commands.filter(command => command.type === 'answer')).toHaveLength(0)
})
