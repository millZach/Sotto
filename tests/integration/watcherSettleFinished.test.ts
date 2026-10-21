// @vitest-environment node
// Settle finished threads: Watcher settles a thread it watches once its work is done and it has heard so, then stops
// watching it, and leaves alone anything still running, waiting on the user or holding an open pull request.
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { WatcherService } from '../../src/main/agents/watcher'
import { WatcherToolServer } from '../../src/main/agents/watcherTools'
import type { AgentThread } from '../../src/shared/agents'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture(on = true) {
  const workspace = await workspaceFixture()
  cleanups.push(workspace.remove)
  const f = await agentControlFixture({ directory: workspace.root, host: workspace.host, credentialOptions: { mode: 'unavailable' },
    control: { watcherEnabled: true, historyEnabled: () => true } })
  const setting = { on }
  const log = vi.fn()
  const service = new WatcherService({ directory: f.root, host: workspace.host, control: f.control, historyEnabled: () => true,
    ordinaryBatch: { quietMs: 50, maxMs: 200 }, settleFinished: () => setting.on, settleFinishedAfterMs: 0, log })
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
  return { ...f, workspace, service, setting, log, native, emit, endTurn, watched, thread, settled, watching, watcherHears, watcherId }
}

it('settles a finished watched thread once Watcher has heard and rested, then stops watching it, quietly', async () => {
  const f = await fixture(), target = await f.watched()
  await f.endTurn(target.threadId)
  // The thread is done, but Watcher has not heard so: its news goes to Watcher first, and Watcher may act on it.
  await f.watcherHears()
  await vi.waitFor(() => expect(f.settled(target.threadId)).toBe(true), { timeout: 15_000 })
  await vi.waitFor(() => expect(f.watching(target.threadId)).toBe(false))
  await vi.waitFor(() => expect(f.log).toHaveBeenCalledWith('watcher-thread-auto-settled'))
  // Quiet: no notice for the user, and nothing more sent to Watcher.
  expect(f.control.shell().notice ?? null).not.toBe('Moved to Settled.')
  expect(f.native(f.watcherId).status).toBe('idle')
  // Watcher's own stop, not the user's: Watcher may watch it again when asked, without the user handing it back.
  expect(f.control.watcherRecord().userUnwatches ?? []).toEqual([])
})

it('waits while Watcher\'s own turn runs, and settles nothing while the setting is off until it is turned on', async () => {
  const f = await fixture(false), target = await f.watched()
  await f.endTurn(target.threadId)
  await vi.waitFor(() => expect(f.native(f.watcherId).status).toBe('running'), { timeout: 15_000 })
  // Watcher is still reading the news.
  f.setting.on = true; f.service.settingsChanged()
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(f.settled(target.threadId)).toBe(false)
  // Off before Watcher rests: once it has heard and rests, nothing is settled.
  f.setting.on = false; f.service.settingsChanged()
  await f.endTurn(f.watcherId); await f.emit()
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(f.settled(target.threadId)).toBe(false)
  expect(f.watching(target.threadId)).toBe(true)
  // Turned on, a thread that already qualifies is settled straight away.
  f.setting.on = true; f.service.settingsChanged()
  await vi.waitFor(() => expect(f.settled(target.threadId)).toBe(true), { timeout: 15_000 })
  expect(f.watching(target.threadId)).toBe(false)
})

it('leaves a thread with an open card, background work or sub-agents it cannot see the end of alone', async () => {
  const f = await fixture(), carded = await f.watched(), busy = await f.watched(), unknown = await f.watched()
  f.native(carded.threadId).requests = [{ id: randomUUID(), kind: 'question', title: 'Synthetic question', body: 'Which one?', options: [] } as unknown as AgentThread['requests'][number]]
  await f.endTurn(carded.threadId)
  f.native(busy.threadId).backgroundWork = [{ id: randomUUID(), kind: 'shell', title: 'Synthetic watcher', startedAt: new Date().toISOString() }] as unknown as AgentThread['backgroundWork']
  await f.endTurn(busy.threadId)
  // A sub-agent a restart could not see end may still be running: unknown work is not none.
  const summaries = f.workspace.host as unknown as { subagentSummaries: Map<string, NonNullable<AgentThread['subagentSummary']>> }
  summaries.subagentSummaries.set(unknown.threadId, { total: 1, working: 0, completed: 0, failed: 0, interrupted: 0, unknown: 1 })
  await f.endTurn(unknown.threadId)
  await f.watcherHears()
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(f.settled(carded.threadId)).toBe(false)
  expect(f.settled(busy.threadId)).toBe(false)
  expect(f.thread(unknown.threadId).subagentSummary?.unknown).toBe(1)
  expect(f.settled(unknown.threadId)).toBe(false)
  expect(f.watching(carded.threadId)).toBe(true)
  expect(f.watching(busy.threadId)).toBe(true)
})

it('leaves a thread whose pull request is still open alone, and settles it once that pull request merges', async () => {
  const f = await fixture(), target = await f.watched()
  // The workspace keeps a thread's pull request links and brings them up to date with what GitHub says.
  const links = f.workspace.host as unknown as { linkPullRequestRecord(threadId: string, pullRequest: { number: number; url: string; title: string; state: string; draft?: boolean }, source: string): unknown }
  const pullRequest = { url: 'https://github.com/example/synthetic/pull/7', number: 7, title: 'Synthetic change', state: 'open' }
  links.linkPullRequestRecord(target.threadId, pullRequest, 'agent')
  await f.endTurn(target.threadId)
  await f.watcherHears()
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(f.settled(target.threadId)).toBe(false)
  expect(f.watching(target.threadId)).toBe(true)
  // The merge is news too. The fake provider does not end Watcher's turns as a provider does, so a second wake-up never
  // goes here; Watcher is taken to have heard it, which is what the settle waits for.
  vi.spyOn(f.service.wakes, 'heardAllOf').mockReturnValue(true)
  links.linkPullRequestRecord(target.threadId, { ...pullRequest, state: 'merged' }, 'agent')
  await f.emit()
  await vi.waitFor(() => expect(f.settled(target.threadId)).toBe(true), { timeout: 15_000 })
  expect(f.watching(target.threadId)).toBe(false)
})

it('tries a refused settle once, and again only after the thread finishes another turn', async () => {
  const f = await fixture(), target = await f.watched()
  const settle = vi.spyOn(f.workspace.host, 'setWorkspaceSettled').mockRejectedValueOnce(new Error('Synthetic refusal'))
  await f.endTurn(target.threadId)
  await f.watcherHears()
  await vi.waitFor(() => expect(f.log).toHaveBeenCalledWith('watcher-thread-auto-settle-skipped'), { timeout: 15_000 })
  // Updates keep coming, and it is not asked again for the same turn.
  for (let index = 0; index < 3; index++) { await f.emit(); await new Promise(resolve => setTimeout(resolve, 30)) }
  expect(settle).toHaveBeenCalledTimes(1)
  expect(f.settled(target.threadId)).toBe(false)
  expect(f.watching(target.threadId)).toBe(true)
  // The user sends it more work. As above, Watcher is taken to have heard that turn's end.
  vi.spyOn(f.service.wakes, 'heardAllOf').mockReturnValue(true)
  expect((await f.control.commandShell({ type: 'manual-send', threadId: target.threadId, draftId: randomUUID(), text: 'Synthetic more work' })).error).toBeNull()
  await vi.waitFor(() => expect(f.native(target.threadId).messages.filter(message => message.role === 'user')).toHaveLength(2))
  // While that turn runs, nothing is settled.
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(settle).toHaveBeenCalledTimes(1)
  // Its own finished turn, which the user sent, is settled.
  await f.endTurn(target.threadId)
  await vi.waitFor(() => expect(f.settled(target.threadId)).toBe(true), { timeout: 15_000 })
  expect(settle).toHaveBeenCalledTimes(2)
  expect(f.watching(target.threadId)).toBe(false)
})

it('leaves a finished thread alone while a thread it delegated to still works, and settles it once that work ends', async () => {
  const f = await fixture(), parent = await f.watched(), child = await f.watched()
  // The workspace keeps which thread delegated to which (ADR-0081); here the second thread is marked as the first's.
  const kept = f.workspace.host as unknown as { state: { snapshot: { threads: AgentThread[] } } }
  kept.state.snapshot.threads.find(thread => thread.id === child.threadId)!.delegatedBy = parent.threadId
  expect(await f.service.unwatchThread({ target: child }, undefined, 'watcher')).toMatchObject({ status: 'ok' })
  await f.endTurn(parent.threadId)
  await vi.waitFor(() => expect(f.thread(child.threadId).delegatedBy).toBe(parent.threadId))
  await f.watcherHears()
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(f.thread(child.threadId).status).toBe('running')
  expect(f.settled(parent.threadId)).toBe(false)
  expect(f.watching(parent.threadId)).toBe(true)
  // The delegated thread finishes with a pull request open, which would be settled with its parent: still not done.
  const links = f.workspace.host as unknown as { linkPullRequestRecord(threadId: string, pullRequest: { number: number; url: string; title: string; state: string }, source: string): unknown }
  const pullRequest = { url: 'https://github.com/example/synthetic/pull/9', number: 9, title: 'Synthetic delegated change', state: 'open' }
  links.linkPullRequestRecord(child.threadId, pullRequest, 'agent')
  await f.endTurn(child.threadId)
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(f.settled(parent.threadId)).toBe(false)
  // It merges, but work is still queued for the delegated thread, which would be settled with its parent: still not done.
  const pending = vi.spyOn(f.control, 'hasPendingThreadWork')
  pending.mockImplementation(threadId => threadId === child.threadId)
  links.linkPullRequestRecord(child.threadId, { ...pullRequest, state: 'merged' }, 'agent')
  await f.emit()
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(f.settled(parent.threadId)).toBe(false)
  // Once that work has gone, the parent, with nothing new for Watcher to hear, is settled.
  pending.mockRestore()
  await f.emit()
  await vi.waitFor(() => expect(f.settled(parent.threadId)).toBe(true), { timeout: 15_000 })
  // Watcher stops watching it just after the settle is written.
  await vi.waitFor(() => expect(f.watching(parent.threadId)).toBe(false))
})

it('does not count news as heard while its wake-up is still being saved to Watcher\u2019s queue', async () => {
  const f = await fixture(), target = await f.watched()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const deliver = f.control.deliverWakeUp.bind(f.control)
  const saving = vi.spyOn(f.control, 'deliverWakeUp').mockImplementation(async (...args) => { await held; return deliver(...args) })
  await f.endTurn(target.threadId)
  await vi.waitFor(() => expect(saving).toHaveBeenCalled(), { timeout: 15_000 })
  // The news has left the waiting list but has not reached Watcher's queue: Watcher has not heard it.
  const turnId = f.native(target.threadId).lastTurn!.id
  expect(f.service.wakes.heardAllOf(target, turnId)).toBe(false)
  f.service.settingsChanged()
  await new Promise(resolve => setTimeout(resolve, 200))
  expect(f.settled(target.threadId)).toBe(false)
  release()
  await f.watcherHears()
  await vi.waitFor(() => expect(f.settled(target.threadId)).toBe(true), { timeout: 15_000 })
})
