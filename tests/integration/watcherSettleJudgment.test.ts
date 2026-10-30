// @vitest-environment node
// Watcher decides when a watched thread is finished (October 29, 2026). Sotto never settles one by itself; settle_thread
// refuses what Sotto can see is unfinished, and while Settle without asking is off, a settle the user has not agreed to.
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { WatcherService } from '../../src/main/agents/watcher'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import { toldAtStart } from '../../src/main/agents/babysitNews'
import type { AgentThread } from '../../src/shared/agents'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture(on = true, babysittingRetired = false) {
  const workspace = await workspaceFixture()
  cleanups.push(workspace.remove)
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' },
    control: { watcherEnabled: true, historyEnabled: () => true } })
  const setting = { on }
  const service = new WatcherService({ directory: f.root, host: workspace.host, control: f.control, historyEnabled: () => true,
    ordinaryBatch: { quietMs: 50, maxMs: 200 }, settleWithoutAsking: () => setting.on, settledLookAfterMs: 0, ...babysittingRetired ? { babysittingRetired } : {} })
  const tools = new WatcherToolServer(service)
  workspace.host.useWatcherTools(tools)
  cleanups.push(async () => { service.close(); await tools.close(); f.control.dispose(); await f.control.closed(); await workspace.stop() })
  await f.control.start(); await f.control.commandShell({ type: 'connect', provider: 'codex' }); await service.recover()
  const model = f.control.watcherSnapshot().models.find(item => item.providerId === 'codex')!
  const project = f.control.watcherSnapshot().projects.find(item => item.providerId === 'codex')!
  expect(await service.open({ provider: 'codex', modelId: model.id })).toMatchObject({ status: 'ok' })
  const watcherId = service.state().current!.target.threadId
  const native = (threadId: string): AgentThread => workspace.adapters.codex.state.threads.find(thread => thread.id === workspace.registry.byThread(threadId)!.sessionId)!
  const emit = async () => { workspace.adapters.codex.emit(); await f.control.commandShell({ type: 'refresh', provider: 'codex' }) }
  const endTurn = async (threadId: string) => {
    const thread = native(threadId)
    thread.messages.push({ id: randomUUID(), role: 'assistant', text: 'Synthetic reply', createdAt: new Date().toISOString() })
    thread.lastTurn = { id: thread.messages.findLast(message => message.role === 'user')?.id ?? randomUUID(), status: 'completed' }
    thread.status = 'idle'
    await emit()
  }
  /** A thread the user started and sent one turn, handed to Watcher with Watch. */
  const watched = async () => {
    const threadId = randomUUID()
    expect((await f.control.commandShell({ type: 'create-thread', threadId, projectId: project.id, modelId: model.id,
      title: 'Synthetic worker', runtimeMode: 'approval-required', workingCopy: 'shared' })).error).toBeNull()
    expect((await f.control.commandShell({ type: 'manual-send', threadId, draftId: randomUUID(), text: 'Synthetic work' })).error).toBeNull()
    const target = { hostId: f.control.hostId()!, threadId }
    expect(await service.watchThread({ target })).toMatchObject({ status: 'ok' })
    return target
  }
  const thread = (threadId: string) => f.control.watcherSnapshot().threads.find(item => item.id === threadId)!
  const settled = (threadId: string) => Boolean(thread(threadId).workspaceSettledAt)
  const watching = (threadId: string) => (f.control.watcherRecord().watches ?? []).some(watch => watch.target.threadId === threadId)
  /** Watcher is told the thread's news in a turn of its own: that turn starts, and then ends. */
  const watcherHears = async () => {
    await vi.waitFor(() => expect(native(watcherId).status).toBe('running'), { timeout: 15_000 })
    await endTurn(watcherId)
  }
  /** The user's own message to Watcher, which opens the request settle_thread names. */
  const request = async () => {
    expect((await f.control.commandShell({ type: 'manual-send', threadId: watcherId, draftId: randomUUID(), text: 'Synthetic Watcher user request' })).error).toBeNull()
    return service.state().requests.at(-1)!.id
  }
  const settle = async (requestId: string, target: { hostId: string; threadId: string }, extra: Record<string, unknown> = {}) =>
    (await tools.call(watcherId, 'settle_thread', { requestId, retryKey: randomUUID(), target, ...extra })).structuredContent as { status: string; code?: string; message?: string }
  const links = workspace.host as unknown as { linkPullRequestRecord(threadId: string, pullRequest: { number: number; url: string; title: string; state: string }, source: string): unknown }
  return { ...f, workspace, service, tools, setting, native, emit, endTurn, watched, thread, settled, watching, watcherHears, watcherId, request, settle, links }
}

it('never settles a finished watched thread by itself, whatever the setting says', async () => {
  const f = await fixture(), target = await f.watched()
  await f.endTurn(target.threadId)
  // Done by every fact Sotto can see, and Watcher has heard so and rests: still Watcher's to judge.
  await f.watcherHears()
  f.service.settingsChanged()
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(f.settled(target.threadId)).toBe(false)
  expect(f.watching(target.threadId)).toBe(true)
})

it('settles without asking while the setting is on, and stops watching what it settled', async () => {
  const f = await fixture(), target = await f.watched()
  await f.endTurn(target.threadId)
  const requestId = await f.request()
  // The look that ends a settled thread's watch runs at once here, and waits for this settle to finish first.
  expect(await f.settle(requestId, target)).toMatchObject({ status: 'ok' })
  expect(f.settled(target.threadId)).toBe(true)
  await vi.waitFor(() => expect(f.watching(target.threadId)).toBe(false))
})

it('refuses a settle the user has not agreed to while the setting is off, and takes one they agreed to', async () => {
  const f = await fixture(false), target = await f.watched()
  await f.endTurn(target.threadId)
  const requestId = await f.request()
  const refused = await f.settle(requestId, target)
  expect(refused).toMatchObject({ status: 'refused', code: 'ASK_USER_FIRST' })
  expect(refused.message).toContain('question card')
  expect(f.settled(target.threadId)).toBe(false)
  // userAgreed is true or absent: anything else is refused as the schema refuses any wrong argument.
  expect(await f.settle(requestId, target, { userAgreed: false })).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
  expect(await f.settle(requestId, target, { userAgreed: true })).toMatchObject({ status: 'ok' })
  expect(f.settled(target.threadId)).toBe(true)
  // The agreement is this computer's alone: the operation it recorded is the call without it.
  const operation = f.control.watcherRecord().operations.findLast(item => item.action === 'settle')!
  expect(JSON.stringify(operation)).not.toContain('userAgreed')
})

it('says in read_state whether Watcher may settle without asking, and lists no pending settles', async () => {
  const f = await fixture()
  const read = async () => (await f.tools.call(f.watcherId, 'read_state', {})).structuredContent as Record<string, unknown>
  expect(await read()).toMatchObject({ settleWithoutAsking: true })
  f.setting.on = false
  const off = await read()
  expect(off).toMatchObject({ settleWithoutAsking: false })
  expect(off).not.toHaveProperty('pendingSettles')
})

it('refuses to settle a thread whose linked pull request is open, and settles it once that pull request merges', async () => {
  const f = await fixture(), target = await f.watched()
  const pullRequest = { url: 'https://github.com/example/synthetic/pull/7', number: 7, title: 'Synthetic change', state: 'open' }
  f.links.linkPullRequestRecord(target.threadId, pullRequest, 'agent')
  await f.endTurn(target.threadId)
  const requestId = await f.request()
  // Agreeing does not lift what Sotto can see: an open pull request holds the settle either way.
  const refused = await f.settle(requestId, target, { userAgreed: true })
  expect(refused).toMatchObject({ status: 'refused', code: 'THREAD_BUSY' })
  expect(refused.message).toContain(pullRequest.url)
  f.links.linkPullRequestRecord(target.threadId, { ...pullRequest, state: 'merged' }, 'agent')
  await f.emit()
  expect(await f.settle(requestId, target)).toMatchObject({ status: 'ok' })
})

it('refuses to settle a thread that babysits a pull request it never linked, until Restart stopped threads retires babysitting', async () => {
  for (const retired of [false, true]) {
    const f = await fixture(true, retired), target = await f.watched()
    // Babysitting is Sotto's own record on the thread; one started on a pull request another agent opened is no link.
    const startedAt = new Date().toISOString()
    await f.workspace.host.changeBabysitting(target.threadId, () => [{ url: 'https://github.com/example/synthetic/pull/9', number: 9,
      startedBy: 'agent', startedAt, told: toldAtStart(startedAt) }])
    await f.endTurn(target.threadId)
    expect(await f.settle(await f.request(), target)).toMatchObject(retired ? { status: 'ok' } : { status: 'refused', code: 'THREAD_BUSY' })
  }
})

it('refuses to settle a thread while a thread it delegated to has an open pull request', async () => {
  const f = await fixture(), parent = await f.watched(), child = await f.watched()
  await f.workspace.host.setDelegatedBy(child.threadId, parent.threadId)
  expect(await f.service.unwatchThread({ target: child }, undefined, 'watcher')).toMatchObject({ status: 'ok' })
  const pullRequest = { url: 'https://github.com/example/synthetic/pull/11', number: 11, title: 'Synthetic delegated change', state: 'open' }
  f.links.linkPullRequestRecord(child.threadId, pullRequest, 'agent')
  await f.endTurn(child.threadId); await f.endTurn(parent.threadId)
  await vi.waitFor(() => expect(f.thread(child.threadId).delegatedBy).toBe(parent.threadId))
  const requestId = await f.request()
  expect(await f.settle(requestId, parent)).toMatchObject({ status: 'refused', code: 'THREAD_BUSY' })
  f.links.linkPullRequestRecord(child.threadId, { ...pullRequest, state: 'closed' }, 'agent')
  await f.emit()
  expect(await f.settle(requestId, parent)).toMatchObject({ status: 'ok' })
})

it('stops watching a thread the user settles, and restoring it does not watch it again (October 28, 2026)', async () => {
  const f = await fixture(false), target = await f.watched()
  await f.endTurn(target.threadId)
  expect((await f.control.commandShell({ type: 'settle-thread', threadId: target.threadId })).error).toBeNull()
  await vi.waitFor(() => expect(f.watching(target.threadId)).toBe(false), { timeout: 15_000 })
  // Not the user's Stop watching: Watcher may watch it again when the user asks, without the user handing it back.
  expect(f.control.watcherRecord().userUnwatches ?? []).toEqual([])
  expect((await f.control.commandShell({ type: 'restore-thread', threadId: target.threadId })).error).toBeNull()
  await f.emit(); await new Promise(resolve => setTimeout(resolve, 100))
  expect(f.watching(target.threadId)).toBe(false)
})

it('keeps the watch the user gives a thread that is already settled', async () => {
  const f = await fixture(false), threadId = randomUUID()
  const model = f.control.watcherSnapshot().models.find(item => item.providerId === 'codex')!, project = f.control.watcherSnapshot().projects.find(item => item.providerId === 'codex')!
  expect((await f.control.commandShell({ type: 'create-thread', threadId, projectId: project.id, modelId: model.id,
    title: 'Synthetic worker', runtimeMode: 'approval-required', workingCopy: 'shared' })).error).toBeNull()
  expect((await f.control.commandShell({ type: 'settle-thread', threadId })).error).toBeNull()
  expect(await f.service.watchThread({ target: { hostId: f.control.hostId()!, threadId } })).toMatchObject({ status: 'ok' })
  await f.emit(); await new Promise(resolve => setTimeout(resolve, 100))
  expect(f.watching(threadId)).toBe(true)
})
