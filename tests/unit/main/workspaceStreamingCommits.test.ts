// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ThreadHostEvent } from '../../../src/main/agents/host'
import { ThreadStore } from '../../../src/main/agents/threadStore'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import type { ThreadEvent } from '../../../src/shared/threadEvents'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'

/** A provider that says what changed, event by event, as the native adapters do. */
class EventProvider extends FakeProviderHost {
  private readonly events = new Set<(event: ThreadHostEvent) => void>()
  subscribeEvents(listener: (event: ThreadHostEvent) => void): () => void {
    this.events.add(listener)
    return () => this.events.delete(listener)
  }
  publish(event: ThreadEvent, threadId = 'session-workshop'): void {
    for (const listener of this.events) listener({ threadId, event })
  }
}

const at = '2026-10-13T00:00:00.000Z'
const added = (id: string, text: string): ThreadEvent => ({ kind: 'message-added', at, message: { id, role: 'assistant', text, createdAt: at } })
const appended = (messageId: string, appendText: string): ThreadEvent => ({ kind: 'message-text-appended', at, messageId, appendText })

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture(streamingPublishCost = true) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-streaming-commits-'))
  cleanup.push(async () => {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('sotto-streaming-commits-')) throw new Error('Unexpected test directory')
    await rm(directory, { recursive: true, force: true })
  })
  const adapter = new EventProvider()
  const host = new WorkspaceHost(adapter, directory, () => true, undefined, false, streamingPublishCost)
  cleanup.push(async () => { host.disconnect(); host.dispose() })
  await host.initialize()
  await host.connect()
  return { directory, adapter, host }
}

/** What the file itself holds, read through a second connection: nothing a commit has not reached. */
function storedText(directory: string, threadId: string): string[] {
  const disk = new ThreadStore(join(directory, 'threads.sqlite'))
  disk.open()
  try { return disk.readMessages(threadId).messages.map(message => message.text) }
  finally { disk.close() }
}

describe('streamed appends on the write window (#991)', () => {
  it('writes as stable always has while the Owl feature is off: every publish, nothing folded', async () => {
    const { directory, adapter, host } = await fixture(false)
    host.observeThreads(['session-workshop'])
    adapter.publish(added('reply', 'First'))
    adapter.publish(appended('reply', ' streamed'))
    adapter.publish(appended('reply', ' words'))
    host.workspaceSnapshot()
    expect(storedText(directory, 'session-workshop')).toEqual(['First streamed words'])
    expect(host.eventsAfter(0, 'session-workshop').map(row => row.event.kind))
      .toEqual(['message-added', 'message-text-appended', 'message-text-appended'])
    expect(host.flushEvents('session-workshop')).toBe(true)
  })
  it('shows a pane its reply at once while the appends commit folded at the flush', async () => {
    const { directory, adapter, host } = await fixture()
    host.observeThreads(['session-workshop'])
    adapter.publish(added('reply', 'First'))
    host.workspaceSnapshot()
    adapter.publish(appended('reply', ' streamed'))
    adapter.publish(appended('reply', ' words'))
    adapter.publish(appended('reply', ' arrive'))
    const shown = host.workspaceSnapshot().threads.find(thread => thread.id === 'session-workshop')!
    expect(shown.messages).toMatchObject([{ id: 'reply', text: 'First streamed words arrive' }])
    expect(shown.summary?.lastAssistant?.text).toBe('First streamed words arrive')
    // The store has only what the publish committed: the opening message, none of the appends yet.
    expect(storedText(directory, 'session-workshop')).toEqual(['First'])

    await host.flush()
    expect(storedText(directory, 'session-workshop')).toEqual(['First streamed words arrive'])
    const stored = host.eventsAfter(0, 'session-workshop')
    expect(stored.map(row => row.event.kind)).toEqual(['message-added', 'message-text-appended'])
    expect(stored[1]?.event).toMatchObject({ appendText: ' streamed words arrive' })
  })

  it('commits at once when an event that is not an append lands behind the held words', async () => {
    const { directory, adapter, host } = await fixture()
    host.observeThreads(['session-workshop'])
    adapter.publish(added('reply', 'First'))
    host.workspaceSnapshot()
    adapter.publish(appended('reply', ' more'))
    adapter.publish(added('next', 'Another message'))
    host.workspaceSnapshot()
    expect(storedText(directory, 'session-workshop')).toEqual(['First more', 'Another message'])
  })

  it('lays held appends over the summary of a thread no pane is watching', async () => {
    const { adapter, host } = await fixture()
    host.observeThreads(['session-workshop'])
    adapter.publish(added('reply', 'First'))
    host.workspaceSnapshot()
    host.observeThreads([])
    adapter.publish(appended('reply', ' while unwatched'))
    const shown = host.workspaceSnapshot().threads.find(thread => thread.id === 'session-workshop')!
    expect(shown.messages).toEqual([])
    expect(shown.summary?.lastAssistant?.text).toBe('First while unwatched')
  })

  it('says whether the store holds everything, so a cursor is never saved past uncommitted words', async () => {
    const { adapter, host } = await fixture()
    host.observeThreads(['session-workshop'])
    adapter.publish(added('reply', 'First'))
    adapter.publish(appended('reply', ' held'))
    expect(host.flushEvents('session-workshop')).toBe(true)
    expect(host.threadMessages('session-workshop')).toMatchObject([{ text: 'First held' }])

    const failing = vi.spyOn(ThreadStore.prototype, 'appendBatches')
      .mockImplementation(() => { throw new Error('Synthetic unavailable storage') })
    adapter.publish(appended('reply', ' unsaved'))
    expect(host.flushEvents('session-workshop')).toBe(false)
    failing.mockRestore()
    await expect.poll(() => host.flushEvents('session-workshop'), { timeout: 10_000 }).toBe(true)
    expect(host.threadMessages('session-workshop')).toMatchObject([{ text: 'First held unsaved' }])
  })
})
