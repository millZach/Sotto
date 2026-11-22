// @vitest-environment node
/**
 * Selecting a thread must return and publish immediately without waiting behind in-flight `agents.json` or
 * `watcher-record.json` writes (#2733): active selection still saves in the background, drains cleanly on `closed()`,
 * and reports storage errors when live without rejecting navigation.
 */
import { randomUUID } from 'node:crypto'
import { readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { agentControlFixture } from '../../fixtures/agentControlFixture'
import { deferred } from '../../fixtures/deferred'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(rename).mockReset().mockImplementation(actual.rename)
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup() {
  const host = new E2EAgentHost()
  const f = await agentControlFixture({ host, reasoner: e2eAgentReasoner, credentialOptions: { mode: 'unavailable' } })
  cleanups.push(f.dispose)
  await f.control.start()
  await f.control.command({ type: 'connect' })
  return f
}

async function readSavedSelection(directory: string): Promise<{ activeThreadId: string | null; activeProjectId: string | null }> {
  const raw = JSON.parse(await readFile(join(directory, 'agents.json'), 'utf8')) as {
    activeThreadId?: string | null
    activeProjectId?: string | null
  }
  return { activeThreadId: raw.activeThreadId ?? null, activeProjectId: raw.activeProjectId ?? null }
}

describe('non-blocking persistence on select-thread (#2733)', () => {
  it('returns and publishes while an agents.json write is in flight, then persists the selection once it finishes', async () => {
    const f = await setup()
    await f.control.command({ type: 'select-thread', threadId: 'workshop' })
    await vi.waitFor(async () => expect((await readSavedSelection(f.directory)).activeThreadId).toBe('workshop'))

    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const writeEntered = deferred<void>()
    const releaseWrite = deferred<void>()
    let heldFirst = false
    vi.mocked(rename).mockImplementation(async (oldPath, newPath) => {
      if (!heldFirst && String(newPath).endsWith('agents.json')) {
        heldFirst = true
        writeEntered.resolve()
        await releaseWrite.promise
      }
      return actual.rename(oldPath, newPath)
    })

    // Hold an in-flight agents.json write inside AtomicJsonStore's serialized operation queue.
    const savingDraft = f.control.command({
      type: 'save-thread-draft',
      threadId: 'workshop',
      draftId: randomUUID(),
      text: 'Draft holding the store write',
    })
    await writeEntered.promise

    const published: Array<string | null> = []
    const unsubscribe = f.control.subscribe(state => published.push(state.activeThreadId))
    try {
      // select-thread must settle while the held agents.json write is still unresolved.
      const reply = await f.control.command({ type: 'select-thread', threadId: 'docs' })
      expect(reply.error).toBeNull()
      expect(reply.activeThreadId).toBe('docs')
      expect(reply.activeProjectId).toBe('project')
      expect(published).toContain('docs')
    } finally {
      unsubscribe()
      releaseWrite.resolve()
    }
    await savingDraft

    // Once the held write releases, the background persist saves the selected thread to agents.json.
    await vi.waitFor(async () => expect(await readSavedSelection(f.directory)).toEqual({
      activeThreadId: 'docs',
      activeProjectId: 'project',
    }))
  })

  it('returns while a watcher-record.json write is in flight, then persists the selection', async () => {
    const f = await setup()
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const watcherEntered = deferred<void>()
    const releaseWatcher = deferred<void>()
    let heldWatcher = false
    vi.mocked(rename).mockImplementation(async (oldPath, newPath) => {
      if (!heldWatcher && String(newPath).endsWith('watcher-record.json')) {
        heldWatcher = true
        watcherEntered.resolve()
        await releaseWatcher.promise
      }
      return actual.rename(oldPath, newPath)
    })

    // Mutate Watcher's record so watcher-record.json holds an in-flight write.
    const updatingWatcher = f.control.watcherRecords.update(record => {
      record.wakeEventIds = [...(record.wakeEventIds ?? []), 'wake-in-flight']
    })
    await watcherEntered.promise

    try {
      const reply = await f.control.command({ type: 'select-thread', threadId: 'docs' })
      expect(reply.error).toBeNull()
      expect(reply.activeThreadId).toBe('docs')
    } finally {
      releaseWatcher.resolve()
    }
    await updatingWatcher

    await vi.waitFor(async () => expect((await readSavedSelection(f.directory)).activeThreadId).toBe('docs'))
  })

  it('drains the selected thread to disk on closed() so a restart restores it', async () => {
    const f = await setup()
    await f.control.command({ type: 'select-thread', threadId: 'docs' })
    await f.control.closed()

    const restarted = f.create()
    await restarted.start()
    expect(restarted.get().activeThreadId).toBe('docs')
    expect(restarted.get().activeProjectId).toBe('project')
  })

  it('coalesces same-tick select-thread calls and saves the newest selection', async () => {
    const f = await setup()
    const writeSpy = vi.spyOn(AtomicJsonStore.prototype, 'write')
    writeSpy.mockClear()

    const [first, second] = await Promise.all([
      f.control.command({ type: 'select-thread', threadId: 'workshop' }),
      f.control.command({ type: 'select-thread', threadId: 'docs' }),
    ])
    expect(first.activeThreadId).toBe('docs')
    expect(second.activeThreadId).toBe('docs')

    await vi.waitFor(async () => expect((await readSavedSelection(f.directory)).activeThreadId).toBe('docs'))
    expect(writeSpy).toHaveBeenCalledTimes(1)
  })

  it('surfaces a storage failure after select-thread without rejecting navigation or leaking after dispose', async () => {
    const f = await setup()
    const failWrite = deferred<void>()
    vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementationOnce(async () => {
      await failWrite.promise
      throw new Error('Disk is full')
    })

    const reply = await f.control.command({ type: 'select-thread', threadId: 'docs' })
    expect(reply.activeThreadId).toBe('docs')
    expect(reply.error).toBeNull()

    failWrite.resolve()
    await vi.waitFor(() => expect(f.control.get().error).toBe(
      'Agent state could not be saved. Your drafts are kept in this session. Restore access to local storage and retry.',
    ))

    // Disposing right after select-thread never triggers a stray write or unhandled rejection.
    const disposedWrite = vi.spyOn(AtomicJsonStore.prototype, 'write')
    disposedWrite.mockClear()
    const selectAfter = f.control.command({ type: 'select-thread', threadId: 'workshop' })
    f.control.dispose()
    await selectAfter
    await new Promise<void>(resolve => queueMicrotask(resolve))
    expect(disposedWrite).not.toHaveBeenCalled()
  })
})
