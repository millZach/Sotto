// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'
import { expectWithinBudget, PERF_ASSERT } from '../../fixtures/perfBudget'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-workspace-flood-'))
  const adapter = new FakeProviderHost()
  const host = new WorkspaceHost(adapter, root)
  cleanup.push(async () => {
    host.disconnect()
    await host.privacyChanged()
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
})
