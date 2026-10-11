// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { WatcherService } from '../../src/main/agents/watcher'
import type { ProviderId } from '../../src/shared/agents'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import { watcherToolSchemas } from '../../src/shared/watcher'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { deferred } from '../fixtures/deferred'

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
  return { ...f, workspace, service, tools, id, requestId, model, project, start, call,
    setLimit: (value: number) => { limit = value }, finish: async (threadId: string) => {
      const binding = workspace.registry.byThread(threadId)!
      const native = workspace.adapters[binding.provider as keyof typeof workspace.adapters]
      const thread = native.state.threads.find(item => item.id === binding.sessionId)!
      thread.status = 'idle'; thread.lastTurn = { id: randomUUID(), status: 'completed' }; native.emit()
      await f.control.commandShell({ type: 'refresh', provider: binding.provider as ProviderId })
    } }
}

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

it('opens an unchanged busy Watcher and keeps a queued user follow-up in its original request budget', async () => {
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
    .toMatchObject({ status: 'ok', limits: { promptCount: 2 } })
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

it('keeps a lost acknowledgement uncertain, retains its slot and never resends on a retry', async () => {
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
  expect(f.service.state().inFlight).toBe(1)
  expect(JSON.parse(await readFile(join(f.root, 'agents.json'), 'utf8')).watcher.operations.at(-1).deliveryState).toBe('uncertain')
  const count = spy.mock.calls.length
  expect(await f.call('send_to_thread', input)).toEqual(result)
  expect(spy.mock.calls).toHaveLength(count)
  expect(written).toBeDefined()
  await original(written!)
  await f.control.commandShell({ type: 'refresh', provider: 'codex' })
  expect(await f.call('send_to_thread', input)).toMatchObject({ status: 'ok', receipt: { deliveryState: 'accepted' } })
})

it('refuses a request appearing during the read before dispatch and holds the waiting target slot', async () => {
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
  await f.call('send_to_thread', { requestId: f.requestId, retryKey: randomUUID(), target: first.target, delivery: 'now', text: 'synthetic_request_race' })
  spy.mockRestore()
  expect(f.workspace.adapters.codex.commands.some(item => item.type === 'send' && item.text === 'synthetic_request_race')).toBe(false)
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
