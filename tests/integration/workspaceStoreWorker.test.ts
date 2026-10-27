// @vitest-environment node
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { StoreWorker } from '../../src/main/agents/storeWorker'
import type { ThreadStoreWriter } from '../../src/main/agents/threadStoreWriter'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { builtStoreWorker } from '../fixtures/storeWorker'
import { added, appended, answer, cleanUp, cleanup, EventProvider, runEquivalence, shown, storedMessages, WORKSHOP } from '../fixtures/storeWriterEquivalence'

/**
 * The workspace over the store worker as the build compiles it (#1457, step 2 of docs/plans/store-worker.md): the same
 * seeded operations as step 1's run, through the writer on main and through the worker, and what quitting, a failed
 * commit and a worker that goes do to what the user sees and to the file.
 */
describe('the workspace over the store worker', () => {
  let worker: Awaited<ReturnType<typeof builtStoreWorker>>
  beforeAll(async () => { worker = await builtStoreWorker() }, 120_000)
  afterAll(async () => { await worker?.dispose() })
  afterEach(cleanUp)

  /** A workspace over the built worker, one provider streaming events. */
  async function workspace(timing?: { busyTimeoutMs?: number }) {
    const directory = await mkdtemp(join(tmpdir(), 'sotto-store-writer-'))
    cleanup.push(async () => { await rm(directory, { recursive: true, force: true }) })
    const adapter = new EventProvider()
    const project = join(directory, 'project')
    await mkdir(project)
    adapter.state.projects[0]!.path = project
    const host = new WorkspaceHost(adapter, directory, () => true, undefined, false, false, true, undefined, { path: worker.path, ...(timing ? { timing } : {}) })
    cleanup.push(async () => { host.disconnect(); await host.close().catch(() => undefined) })
    await host.initialize()
    await host.connect()
    host.observeThreads([WORKSHOP])
    const inside = host as unknown as { writes: ThreadStoreWriter; threadStore: { readonly worker: StoreWorker | undefined } }
    return { directory, adapter, host, writes: inside.writes, store: inside.threadStore }
  }

  it.each([1457, 1026, 2026, 3])('leaves the same rows and shows the same threads as the writer on main over a seeded run (seed %i)', async seed => {
    await runEquivalence(seed, { worker: worker.path })
  }, 120_000)

  it('commits everything posted before quitting, and the worker closes before main', async () => {
    const { adapter, host, directory, store } = await workspace()
    expect(store.worker).toBeDefined()
    adapter.publish(added('reply', 'Said before quitting'))
    host.workspaceSnapshot()
    adapter.publish(appended('reply', ', and this'))
    adapter.publish(added('later', 'Behind the batch in flight'))
    host.recordAnswer(WORKSHOP, answer('request-1'))
    host.disconnect()
    await host.close()
    expect(storedMessages(directory)).toMatchObject([{ id: 'reply', text: 'Said before quitting, and this' }, { id: 'later' }])
  })

  it('shows the history-save notice when a commit fails, and retries it a second later until it lands', async () => {
    const { adapter, host, directory, writes } = await workspace({ busyTimeoutMs: 50 })
    await writes.confirmed()
    const holder = new DatabaseSync(join(directory, 'threads.sqlite'), { timeout: 5_000 })
    holder.exec('BEGIN IMMEDIATE')
    adapter.publish(added('reply', 'Kept through a failed save'))
    host.workspaceSnapshot()
    await host.flush()
    await writes.confirmed()
    expect(host.workspaceSnapshot().error).toBeDefined()
    // What the pane shows does not wait for the file.
    expect(shown(host).messages.map(item => item.id)).toEqual(['reply'])
    holder.exec('COMMIT'); holder.close()
    for (let waited = 0; storedMessages(directory).length === 0; waited++) {
      if (waited > 200) throw new Error('The retry never landed')
      await delay(50)
    }
    await writes.confirmed()
    expect(host.workspaceSnapshot().error).toBeUndefined()
    expect(storedMessages(directory).map(item => item.text)).toEqual(['Kept through a failed save'])
  }, 60_000)

  it('finishes on main what the worker had not committed when it goes, and keeps streaming there', async () => {
    const { adapter, host, directory, store, writes } = await workspace()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    adapter.publish(added('reply', 'Before'))
    host.workspaceSnapshot()
    await writes.confirmed()
    adapter.publish(appended('reply', ' and during'))
    adapter.publish(added('next', 'Next'))
    await host.flush()
    void store.worker!.terminate()
    adapter.publish(added('after', 'After'))
    await host.flush()
    for (let waited = 0; store.worker !== undefined; waited++) {
      if (waited > 200) throw new Error('The worker never went')
      await delay(20)
    }
    await host.flush()
    await writes.confirmed()
    expect(warn).toHaveBeenCalledWith('thread-store-worker-lost')
    expect(shown(host).messages.map(item => item.text)).toEqual(['Before and during', 'Next', 'After'])
    host.disconnect()
    await host.close()
    expect(storedMessages(directory).map(item => item.text)).toEqual(['Before and during', 'Next', 'After'])
  })
})
