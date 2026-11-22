// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage } from '../../../src/shared/agents'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import type { ThreadStore } from '../../../src/main/agents/threadStore'
import type { ThreadStoreWriter } from '../../../src/main/agents/threadStoreWriter'
import { DeferredStoreWriter } from '../../fixtures/deferredStoreWriter'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function opened(messages: AgentMessage[], options?: {
  historyEnabled?: () => boolean
  storeWriter?: (store: ThreadStore) => ThreadStoreWriter
}) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-thread-words-host-'))
  cleanup.push(async () => {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('sotto-thread-words-host-')) throw new Error('Unexpected test directory')
    await rm(directory, { recursive: true, force: true })
  })
  const adapter = new FakeProviderHost()
  const host = new WorkspaceHost(adapter, directory, {
    historyEnabled: options?.historyEnabled ?? (() => true),
    ...(options?.storeWriter ? { storeWriter: options.storeWriter } : {}),
  })
  cleanup.push(async () => { host.disconnect(); await host.privacyChanged().catch(() => undefined); host.dispose() })
  await host.initialize()
  await host.connect()
  adapter.state.threads[0]!.messages = messages
  adapter.emit()
  await host.snapshot()
  return { host, adapter, directory, store: (host as unknown as { threadStore: ThreadStore }).threadStore }
}

const at = new Date(Date.UTC(2026, 10, 19, 10)).toISOString()

describe('Search threads’ words on a host', () => {
  it('names the host’s own threads whose messages hold the words, and never a thread it no longer lists', async () => {
    const { host, store } = await opened([
      { id: 'u0', role: 'user', text: 'Make the owl blink every few seconds.', createdAt: at },
      { id: 'a0', role: 'assistant', text: 'The owl blinks on a random 3 to 6 s timer.', createdAt: at },
    ])
    // Words the store still holds of a thread the host does not list, as after a delete.
    store.appendMany('deleted-thread', [{ kind: 'message-added', at, message: { id: 'x', role: 'user', text: 'The owl again', createdAt: at } }])
    expect(await host.threadWords('owl')).toEqual({ found: [{ threadId: 'session-workshop', messageId: 'a0', role: 'assistant', quote: 'The owl blinks on a random 3 to 6 s timer.', more: 1 }] })
    expect(await host.threadWords('a phrase nobody said')).toEqual({ found: [] })
  })

  it('finds a message published just before the search once that write has committed', async () => {
    let writer!: DeferredStoreWriter
    const { host, adapter, store } = await opened([
      { id: 'u0', role: 'user', text: 'Make the owl blink every few seconds.', createdAt: at },
    ], { storeWriter: store => { writer = new DeferredStoreWriter(store); writer.holding = false; return writer } })
    // Closing asks the writer to finish. A writer still holding that would wait out the hook.
    cleanup.push(async () => { writer.holding = false; while (writer.waiting) writer.release() })
    // A write still held is not in the file. The search must wait for it, then read what committed.
    writer.holding = true
    adapter.state.threads[0]!.messages = [
      ...adapter.state.threads[0]!.messages,
      { id: 'u1', role: 'user', text: 'Hang the lantern by the door.', createdAt: at },
    ]
    adapter.emit()
    expect(writer.waiting).toBeGreaterThan(0)
    expect(store.threadWords('lantern').found).toEqual([])
    let askedWhileHeld = false
    host.useThreadWordsAccelerator(async query => {
      askedWhileHeld = writer.waiting > 0
      return {
        found: [
          ...store.threadWords(query).found,
          { threadId: 'deleted-thread', messageId: 'gone', role: 'assistant', quote: 'Should be filtered out', more: 0 },
        ],
      }
    })
    const pending = host.threadWords('lantern')
    while (writer.waiting) writer.release()
    expect(await pending).toEqual({ found: [{ threadId: 'session-workshop', messageId: 'u1', role: 'user', quote: 'Hang the lantern by the door.', more: 0 }] })
    expect(askedWhileHeld).toBe(false)
    host.useThreadWordsAccelerator(async () => undefined)
    expect(await host.threadWords('lantern')).toEqual({ found: [{ threadId: 'session-workshop', messageId: 'u1', role: 'user', quote: 'Hang the lantern by the door.', more: 0 }] })
  })

  it('names only the threads this host lists, and nothing while the store cannot be read', async () => {
    const { host } = await opened([
      { id: 'u0', role: 'user', text: 'Make the owl blink every few seconds.', createdAt: at },
      { id: 'a0', role: 'assistant', text: 'The owl blinks on a random 3 to 6 s timer.', createdAt: at },
    ])
    const listed = { threadId: 'session-workshop', messageId: 'a0', role: 'assistant' as const, quote: 'The owl blinks on a random 3 to 6 s timer.', more: 1 }
    let asked = 0
    host.useThreadWordsAccelerator(async () => {
      asked += 1
      return { found: [listed, { threadId: 'deleted-thread', messageId: 'x', role: 'user', quote: 'The owl again', more: 0 }] }
    })
    expect(await host.threadWords('owl')).toEqual({ found: [listed] })
    ;(host as unknown as { storeUnavailable: boolean }).storeUnavailable = true
    expect(await host.threadWords('owl')).toBeNull()
    expect(asked).toBe(1)
  })

  it('answers nothing, and does not read the file, while a worker’s writes are held', async () => {
    const { host } = await opened([
      { id: 'u0', role: 'user', text: 'Make the owl blink every few seconds.', createdAt: at },
    ], {
      storeWriter: store => {
        const held = new DeferredStoreWriter(store)
        held.holding = false
        return Object.assign(held, { writesHeld: true })
      },
    })
    const search = vi.fn(async () => ({ found: [] }))
    host.useThreadWordsAccelerator(search)
    expect(await host.threadWords('owl')).toBeNull()
    expect(search).not.toHaveBeenCalled()
  })

  it('reads the store when the file read cannot answer, and leaves the file alone when history is off', async () => {
    const { host } = await opened([
      { id: 'u0', role: 'user', text: 'Make the owl blink every few seconds.', createdAt: at },
      { id: 'a0', role: 'assistant', text: 'The owl blinks on a random 3 to 6 s timer.', createdAt: at },
    ])
    const absent = vi.fn(async () => undefined)
    host.useThreadWordsAccelerator(absent)
    expect(await host.threadWords('owl')).toEqual({ found: [{ threadId: 'session-workshop', messageId: 'a0', role: 'assistant', quote: 'The owl blinks on a random 3 to 6 s timer.', more: 1 }] })
    expect(absent).toHaveBeenCalledOnce()

    const { host: memory } = await opened([
      { id: 'u0', role: 'user', text: 'Make the owl blink every few seconds.', createdAt: at },
      { id: 'a0', role: 'assistant', text: 'The owl blinks on a random 3 to 6 s timer.', createdAt: at },
    ], { historyEnabled: () => false })
    const skipped = vi.fn(async () => ({ found: [] }))
    memory.useThreadWordsAccelerator(skipped)
    expect(await memory.threadWords('owl')).toEqual({ found: [{ threadId: 'session-workshop', messageId: 'a0', role: 'assistant', quote: 'The owl blinks on a random 3 to 6 s timer.', more: 1 }] })
    expect(skipped).not.toHaveBeenCalled()
  })
})
