// @vitest-environment node
/**
 * A Grok reply streams as chunks on top of the thread's durable history. Each chunk used to copy every held
 * message and re-read them all into the message log, so a chunk cost grew with the thread (#771). A chunk
 * on a reply the log already holds is an append now, whatever the thread holds.
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GrokAcpHost } from '../../../src/main/agents/grok'
import { ThreadMessageLog } from '../../../src/main/agents/threadMessageLog'
import type { AgentMessage } from '../../../src/shared/agents'
import type { ThreadHostEvent } from '../../../src/main/agents/host'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-grok-append-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true })
  }
})

/** The adapter's private parts this test drives: a thread's alias, owning process and history, and its update handler. */
interface GrokInternals {
  aliases: Record<string, unknown>
  processes: Map<string, { rpc: { close(): void } }>
  histories: Map<string, { offset: number; total: number; messages: AgentMessage[]; activities: []; events: Set<string>; statusEvents: Set<string>; status: 'running' }>
  record(id: string, status: 'running'): void
  frame(frame: { method: string; params: unknown }, rpc: unknown): Promise<void>
  usage: { flushed(): Promise<void> }
  disconnect(): void
}

/** A Grok thread holding `held` messages, the last of them the prompt the reply below answers. */
async function threadHolding(held: number) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-grok-append-')); roots.push(root)
  const adapter = new GrokAcpHost(root, { executable: process.execPath })
  const internals = adapter as unknown as GrokInternals
  const sessionId = randomUUID()
  internals.aliases.thread = { grokSessionId: sessionId, projectId: 'project', cwd: root, title: 'Thread', modelId: 'grok-test', settingsConfirmed: true,
    createdAt: '2026-10-06T00:00:00.000Z', origins: [], answeredRequestIds: [] }
  const messages: AgentMessage[] = Array.from({ length: held }, (_, index) => ({ id: `m-${index}`, role: index % 2 === 0 ? 'user' : 'assistant',
    text: `Message ${index}`, createdAt: new Date(Date.parse('2026-10-06T00:00:00.000Z') + index * 1000).toISOString() }))
  if (messages.at(-1)!.role !== 'user') messages.push({ id: 'prompt', role: 'user', text: 'The prompt', createdAt: '2026-10-07T00:00:00.000Z' })
  internals.histories.set('thread', { offset: 0, total: messages.length, messages, activities: [], events: new Set(), statusEvents: new Set(), status: 'running' })
  internals.record('thread', 'running')
  // Streaming updates belong to the thread's own RPC. This unit fixture supplies that identity
  // without starting a provider process; an unowned RPC cannot update the thread.
  const rpc = { close: vi.fn() }
  internals.processes.set('thread', { rpc })
  const events: ThreadHostEvent[] = []
  adapter.subscribeEvents(event => events.push(event))
  const chunk = (text: string) => internals.frame({ method: 'session/update', params: { sessionId, _meta: { promptId: 'turn', streamStartMs: 1 },
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } }, rpc)
  return { adapter, internals, events, chunk, prompt: messages.at(-1)!.id }
}

describe('a Grok reply streaming onto a thread', () => {
  it('records each chunk after the first as an append, at a cost that does not grow with the messages held', async () => {
    const work: Record<number, { set: number; add: number; appends: number; searched: number }> = {}
    for (const held of [10, 2_000]) {
      const f = await threadHolding(held)
      await f.chunk('Ind')
      expect(f.events.map(item => item.event.kind)).toEqual(['message-added'])
      const set = vi.spyOn(ThreadMessageLog.prototype, 'set')
      const add = vi.spyOn(ThreadMessageLog.prototype, 'add')
      const appendText = vi.spyOn(ThreadMessageLog.prototype, 'appendText')
      // Any list searched while a chunk lands: the held messages are never walked to find the reply.
      const find = vi.spyOn(Array.prototype, 'find')
      for (const text of ['igo', ' it', ' is', '.']) await f.chunk(text)
      const searched = Math.max(0, ...find.mock.contexts.map(list => (list as unknown[]).length))
      work[held] = { set: set.mock.calls.length, add: add.mock.calls.length, appends: appendText.mock.calls.length, searched: searched >= held ? held : 0 }
      expect(f.events.slice(1).map(item => item.event)).toEqual(['igo', ' it', ' is', '.'].map(appendText => expect.objectContaining({ kind: 'message-text-appended', appendText })))
      expect((await f.adapter.snapshot()).threads.find(thread => thread.id === 'thread')?.messages.at(-1)?.text).toBe('Indigo it is.')
      vi.restoreAllMocks()
      f.internals.disconnect(); await f.internals.usage.flushed()
    }
    // No re-read of the thread for any chunk: the same work whether the thread holds ten messages or two thousand.
    expect(work[10]).toEqual({ set: 0, add: 0, appends: 4, searched: 0 })
    expect(work[2_000]).toEqual(work[10])
  })

  it('still re-reads the thread for a chunk on a reply the log holds other words for', async () => {
    const f = await threadHolding(4)
    await f.chunk('Ind')
    // The durable history caught up with more than the live stream has seen.
    const history = f.internals.histories.get('thread')!
    const replyId = (f.events[0]!.event as { message: AgentMessage }).message.id
    history.messages.push({ id: replyId, role: 'assistant', text: 'Indigo, written down', createdAt: '2026-10-07T00:00:01.000Z' })
    f.internals.record('thread', 'running')
    const set = vi.spyOn(ThreadMessageLog.prototype, 'set')
    await f.chunk('igo')
    expect(set).toHaveBeenCalledTimes(1)
    f.internals.disconnect(); await f.internals.usage.flushed()
  })
})
