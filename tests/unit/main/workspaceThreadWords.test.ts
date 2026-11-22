// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentMessage } from '../../../src/shared/agents'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import type { ThreadStore } from '../../../src/main/agents/threadStore'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function opened(messages: AgentMessage[]) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-thread-words-host-'))
  cleanup.push(async () => {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('sotto-thread-words-host-')) throw new Error('Unexpected test directory')
    await rm(directory, { recursive: true, force: true })
  })
  const adapter = new FakeProviderHost()
  const host = new WorkspaceHost(adapter, directory, { historyEnabled: () => true })
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

  it('settles newly published messages before calling the thread-words accelerator and filters by host visibility', async () => {
    const { host, adapter, store } = await opened([
      { id: 'u0', role: 'user', text: 'Initial message.', createdAt: at },
    ])
    const later = new Date(Date.UTC(2026, 10, 19, 10, 1)).toISOString()
    let calls = 0
    host.useThreadWordsAccelerator(async query => {
      calls++
      // Simulate an external read-only SQLite reader (like sotto-engine --accelerator) reading threads.sqlite
      // directly, plus returning a thread the host no longer lists to confirm visibility filtering still runs.
      const direct = store.threadWords(query)
      return {
        found: [
          ...direct.found,
          { threadId: 'deleted-thread', messageId: 'gone', role: 'assistant', quote: 'Should be filtered out', more: 0 },
        ],
      }
    })

    // Publish a new message immediately before searching — it sits in WorkspaceHost's coalesced write queue
    // until threadWords() calls settled(undefined, true).
    adapter.state.threads[0]!.messages = [
      ...adapter.state.threads[0]!.messages,
      { id: 'a1', role: 'assistant', text: 'Freshly published accelerator canary phrase.', createdAt: later },
    ]
    adapter.emit()

    const result = await host.threadWords('accelerator canary')
    expect(calls).toBe(1)
    expect(result).toEqual({
      found: [{
        threadId: 'session-workshop',
        messageId: 'a1',
        role: 'assistant',
        quote: 'Freshly published accelerator canary phrase.',
        more: 0,
      }],
    })

    // Returning undefined falls back transparently to TypeScript's store read.
    host.useThreadWordsAccelerator(async () => undefined)
    expect(await host.threadWords('accelerator canary')).toEqual(result)
  })
})
