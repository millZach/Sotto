// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import { WorktreeCleanup } from '../../../src/main/agents/worktreeCleanup'
import { DEFAULT_WORKTREE_CLEANUP } from '../../../src/shared/settings'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'
import type { ThreadHostEvent } from '../../../src/main/agents/host'
import type { ThreadEvent } from '../../../src/shared/threadEvents'
import { expectWithinBudget, PERF_ASSERT } from '../../fixtures/perfBudget'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })

/** A provider that says what changed, the way every adapter's message log does. */
class EventProviderHost extends FakeProviderHost {
  private readonly eventListeners = new Set<(event: ThreadHostEvent) => void>()
  subscribeEvents(listener: (event: ThreadHostEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => { this.eventListeners.delete(listener) }
  }
  publish(threadId: string, event: ThreadEvent): void {
    for (const listener of this.eventListeners) listener({ threadId, event })
  }
}

async function fixture<T extends FakeProviderHost = FakeProviderHost>(adapter: T = new FakeProviderHost() as T) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-workspace-flood-'))
  const host = new WorkspaceHost(adapter, root)
  cleanup.push(async () => {
    host.disconnect()
    await host.privacyChanged()
    host.dispose()
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-workspace-flood-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  })
  await host.initialize()
  await host.connect()
  return { root, adapter, host }
}

/** One turn of the event loop, the way a real adapter's events arrive. */
const tick = () => new Promise<void>(resolve => { setTimeout(resolve, 0) })

describe('workspace publish coalescing', () => {
  it('does not copy thread histories for the cleanup settlement observer during provider updates', async () => {
    const f = await fixture()
    const sweeper = new WorktreeCleanup({ host: f.host, rules: () => DEFAULT_WORKTREE_CLEANUP })
    cleanup.push(() => sweeper.close())
    const snapshot = vi.spyOn(f.host, 'workspaceSnapshot')
    sweeper.start()
    await sweeper.request()

    f.adapter.state.threads[0]!.title = 'Provider update with cleanup listening'
    f.adapter.state.threads[0]!.messages.push({ id: 'retained-message', role: 'assistant', text: 'Retained history', createdAt: new Date().toISOString() })
    f.adapter.emit()

    expect(snapshot).not.toHaveBeenCalled()
    expect(f.host.workspaceSnapshot().threads[0]!.messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'retained-message', text: 'Retained history' })]))
  })

  it('reports initial, restored and inherited settlement and stops after unsubscribe', async () => {
    const f = await fixture()
    const [first, second] = f.host.workspaceSnapshot().threads
    await f.host.setWorkspaceSettled('thread', first!.id, true)
    const changed = vi.fn()
    const unsubscribe = f.host.subscribeSettledThreads(changed)
    expect(changed).toHaveBeenLastCalledWith([first!.id])

    await f.host.setWorkspaceSettled('thread', first!.id, false)
    expect(changed).toHaveBeenLastCalledWith([])
    await f.host.setWorkspaceSettled('project', first!.projectId, true)
    expect(changed).toHaveBeenLastCalledWith([first!.id, second!.id])
    // Restoring a thread does not override its project's settlement.
    await f.host.setWorkspaceSettled('thread', first!.id, false)
    expect(changed).toHaveBeenLastCalledWith([first!.id, second!.id])
    await f.host.setWorkspaceSettled('project', first!.projectId, false)
    expect(changed).toHaveBeenLastCalledWith([])

    unsubscribe()
    changed.mockClear()
    await f.host.setWorkspaceSettled('thread', first!.id, true)
    expect(changed).not.toHaveBeenCalled()
  })

  it('requests cleanup only for newly settled threads, including a restored thread settled again', async () => {
    const f = await fixture()
    const first = f.host.workspaceSnapshot().threads[0]!
    await f.host.setWorkspaceSettled('thread', first.id, true)
    const sweeper = new WorktreeCleanup({ host: f.host, rules: () => ({ ...DEFAULT_WORKTREE_CLEANUP, onSettle: true }) })
    cleanup.push(() => sweeper.close())
    const request = vi.spyOn(sweeper, 'request')
    sweeper.start()
    expect(request).toHaveBeenCalledTimes(1)
    await sweeper.request()
    request.mockClear()

    await f.host.setWorkspaceSettled('thread', first.id, false)
    expect(request).not.toHaveBeenCalled()
    await f.host.setWorkspaceSettled('thread', first.id, true)
    expect(request).toHaveBeenCalledTimes(1)
    await f.host.setWorkspaceSettled('thread', first.id, true)
    expect(request).toHaveBeenCalledTimes(1)
    await f.host.setWorkspaceSettled('project', first.projectId, true)
    expect(request).toHaveBeenCalledTimes(2)
    await f.host.setWorkspaceSettled('project', first.projectId, false)
    expect(request).toHaveBeenCalledTimes(2)

    sweeper.dispose()
    await f.host.setWorkspaceSettled('project', first.projectId, true)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('turns a flood of adapter snapshots into a handful of publishes and one write', async () => {
    const f = await fixture()
    const write = vi.spyOn(AtomicJsonStore.prototype, 'write')
    let published = 0
    f.host.subscribe(() => { published += 1 })

    const started = performance.now()
    for (let index = 0; index < 2_000; index += 1) {
      f.adapter.state.threads[0]!.title = `Working ${index}`
      f.adapter.emit()
      if (index === 0) expect(published).toBe(1) // the first of a burst is immediate, so feedback stays instant
      if (index % 20 === 19) await tick()
    }
    const elapsed = performance.now() - started

    // Every publish copies the whole workspace, so the count of publishes is the count of copies. What holds
    // on any machine is the shape: never more than one publish per 16 ms window and one write per 250 ms
    // window, however long the burst took. The absolute counts (a handful, and one) describe the burst at
    // its measured 100 ms and are only asserted with the stopwatch budgets switched on.
    const windows = (ms: number) => Math.ceil(elapsed / ms) + 2
    expect(published).toBeGreaterThan(0)
    expect(published).toBeLessThanOrEqual(windows(16))
    expect(write.mock.calls.length).toBeLessThanOrEqual(windows(250))
    expectWithinBudget(elapsed, 1_500, '2,000 adapter snapshots through the workspace host')
    if (PERF_ASSERT) { expect(published).toBeLessThanOrEqual(24); expect(write.mock.calls.length).toBeLessThanOrEqual(1) }

    // The settled state is the last one, and the burst leaves no write waiting that the last one did not cover.
    await expect.poll(async () => JSON.parse(await readFile(join(f.root, 'workspace.json'), 'utf8')).snapshot.threads[0].title).toBe('Working 1999')
    const writes = write.mock.calls.length
    expect(writes).toBeLessThanOrEqual(windows(250))
    if (PERF_ASSERT) expect(writes).toBe(1)
    expect(f.host.workspaceSnapshot().threads[0]?.title).toBe('Working 1999')
  })

  it('keeps one write per window when the disk is slow and the provider keeps publishing', async () => {
    const f = await fixture()
    const write = AtomicJsonStore.prototype.write
    // A write that takes longer than the burst between two of them, the way a loaded runner's disk does.
    const slow = vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(async function (this: AtomicJsonStore<unknown>, value: unknown) {
      await new Promise<void>(resolve => { setTimeout(resolve, 30) })
      return write.call(this, value)
    })
    // The provider keeps publishing for longer than a window and a write together, so writes overlap the flood.
    const started = performance.now()
    let index = 0
    while (performance.now() - started < 700) {
      f.adapter.state.threads[0]!.title = `Working ${index}`
      f.adapter.emit()
      index += 1
      await tick()
    }
    const last = `Working ${index - 1}`
    await expect.poll(async () => JSON.parse(await readFile(join(f.root, 'workspace.json'), 'utf8')).snapshot.threads[0].title, { timeout: 5_000 }).toBe(last)
    const elapsed = performance.now() - started
    // Before the flush loop was paced, a state dirtied during a slow write was written again at once, so a
    // flood met a slow disk with a write per write's length rather than one per window.
    expect(slow.mock.calls.length).toBeLessThanOrEqual(Math.ceil(elapsed / 250) + 2)
  })

  it('still writes and publishes a user command before that command returns', async () => {
    const f = await fixture()
    const write = vi.spyOn(AtomicJsonStore.prototype, 'write')
    const published: string[] = []
    f.host.subscribe(snapshot => { published.push(snapshot.threads[0]?.title ?? '') })

    f.adapter.state.threads[0]!.title = 'From the provider'
    f.adapter.emit()
    await f.host.renameThread(f.adapter.state.threads[0]!.id, 'Named by hand')

    expect(published.at(-1)).toBe('Named by hand')
    expect(write).toHaveBeenCalledTimes(1) // the waiting provider write was covered by this one
    expect(JSON.parse(await readFile(join(f.root, 'workspace.json'), 'utf8')).snapshot.threads[0].title).toBe('Named by hand')
  })

  it('publishes a message’s first words at once inside a window, and holds the chunks after them for it', async () => {
    const f = await fixture(new EventProviderHost())
    const id = f.adapter.state.threads[0]!.id
    let published = 0
    f.host.subscribe(() => { published += 1 })
    const at = new Date().toISOString()
    // Everything below up to the first wait runs inside one task, so no window can close while it does.
    f.adapter.publish(id, { kind: 'message-added', at, message: { id: 'prompt', role: 'user', text: 'Which colour?', createdAt: at } })
    expect(published).toBe(1)
    f.adapter.publish(id, { kind: 'message-added', at, message: { id: 'reply', role: 'assistant', text: 'Ind', createdAt: at } })
    expect(published).toBe(2)
    for (const appendText of ['igo', ' it', ' is.']) f.adapter.publish(id, { kind: 'message-text-appended', at, messageId: 'reply', appendText })
    expect(published).toBe(2)
    // The reply's first words already cut this window short, so a new record waits for its end with the chunks.
    f.adapter.state.threads[0]!.activities = [{ id: 'run', turnId: 'prompt', sequence: 0, kind: 'command', title: 'Run', status: 'running' }]
    f.adapter.emit()
    expect(published).toBe(2)
    await expect.poll(() => published).toBe(3)
    // In the window the trailing publish started, a new record is an opening change and goes at once; a change to it is not.
    f.adapter.state.threads[0]!.activities = [...f.adapter.state.threads[0]!.activities!, { id: 'read', turnId: 'prompt', sequence: 1, kind: 'command', title: 'Read', status: 'running' }]
    f.adapter.emit()
    expect(published).toBe(4)
    f.adapter.state.threads[0]!.activities = f.adapter.state.threads[0]!.activities!.map(record => ({ ...record, output: 'ok' }))
    f.adapter.emit()
    expect(published).toBe(4)
    await expect.poll(() => published).toBe(5)
  })

  it('publishes a read that records hundreds of messages in one task twice, not once a message', async () => {
    const f = await fixture(new EventProviderHost())
    const id = f.adapter.state.threads[0]!.id
    let published = 0
    f.host.subscribe(() => { published += 1 })
    const at = new Date().toISOString()
    // A transcript catch-up or a history read hands the log every unseen message in the same task.
    for (let index = 0; index < 300; index++) {
      f.adapter.publish(id, { kind: 'message-added', at, message: { id: `read-${index}`, role: index % 2 ? 'assistant' : 'user', text: `Message ${index}`, createdAt: at } })
    }
    // The first opens a window and the second cuts it short; the other 298 ride its end.
    expect(published).toBe(2)
    await expect.poll(() => published).toBe(3)
    await tick(); await new Promise<void>(resolve => { setTimeout(resolve, 40) })
    expect(published).toBe(3)
    expect((await f.host.snapshot()).threads.find(thread => thread.id === id)?.messages.at(-1)?.id).toBe('read-299')
  })
})
