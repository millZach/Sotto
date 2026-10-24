// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage } from '../../../src/shared/agents'
import { agentThreadPromptsSchema, THREAD_PROMPT_REPLY_HEAD, THREAD_PROMPT_TEXT } from '../../../src/shared/threadPrompts'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import { ThreadStore } from '../../../src/main/agents/threadStore'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })

async function opened(turns: AgentMessage[]) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-thread-prompts-'))
  cleanup.push(async () => {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('sotto-thread-prompts-')) throw new Error('Unexpected test directory')
    await rm(directory, { recursive: true, force: true })
  })
  const adapter = new FakeProviderHost()
  const host = new WorkspaceHost(adapter, directory, () => true)
  cleanup.push(async () => { host.disconnect(); await host.privacyChanged().catch(() => undefined); host.dispose() })
  await host.initialize()
  await host.connect()
  adapter.state.threads[0]!.messages = turns
  adapter.emit()
  await host.snapshot()
  // The pane comes back to the thread, so its window is the newest ten turns again.
  host.observeThreads([])
  host.observeThreads(['session-workshop'])
  return { host, thread: () => host.workspaceSnapshot().threads.find(item => item.id === 'session-workshop')! }
}

const at = (index: number): string => new Date(Date.UTC(2026, 9, 24, 10, 0, index)).toISOString()
function conversation(turns: number, reply: (index: number) => string = index => `Reply ${index}`): AgentMessage[] {
  return Array.from({ length: turns }, (_, index) => [
    { id: `u${index}`, role: 'user' as const, text: `Prompt ${index}`, createdAt: at(index * 3) },
    // A turn's working note comes before the reply with words; an empty message is no reply.
    { id: `n${index}`, role: 'assistant' as const, text: `Working on ${index}`, createdAt: at(index * 3 + 1) },
    { id: `a${index}`, role: 'assistant' as const, text: reply(index), createdAt: at(index * 3 + 2) },
    { id: `e${index}`, role: 'assistant' as const, text: '  ', createdAt: at(index * 3 + 2) },
  ]).flat()
}

describe('the prompts above a pane’s window, for the message scrubber (ADR-0109)', () => {
  it('reads every message sent before the window, oldest first, each with its turn’s last reply with words', async () => {
    const { host, thread } = await opened(conversation(60))
    const first = thread().messages[0]!
    expect(first.id).toBe('u50')
    expect(thread().earlierAvailable).toBe(true)
    const read = host.threadPrompts('session-workshop', first.id)!
    expect(agentThreadPromptsSchema.parse(read)).toEqual(read)
    expect(read.prompts.map(prompt => prompt.id)).toEqual(Array.from({ length: 50 }, (_, index) => `u${index}`))
    expect(read.prompts[7]).toEqual({ id: 'u7', createdAt: at(21), text: 'Prompt 7', reply: { id: 'a7', text: 'Reply 7' } })
    // What the window holds is the window's; nothing before the first message is nothing at all.
    expect(host.threadPrompts('session-workshop', 'u0')).toEqual({ prompts: [] })
    expect(host.threadPrompts('session-workshop', 'not-in-the-store')).toEqual({ prompts: [] })
    expect(host.threadPrompts('no-such-thread', 'u50')).toBeNull()
    // It is read on request, and what the pane is published does not grow with it.
    expect(thread().messages).toHaveLength(40)
  })

  it('carries only the start of a long message, and the start and end of a long reply', async () => {
    const long = (index: number): string => `${'Opening words. '.repeat(60)}\n\n${'Middle words. '.repeat(400)}\n\nShould the pill wait 150 ms before it shows, for turn ${index}?`
    const turns = conversation(12, long)
    turns[0] = { ...turns[0]!, text: `${'x'.repeat(THREAD_PROMPT_TEXT - 1)}😀 and more after it`, attachments: [{ id: 'one', name: 'one.png', mimeType: 'image/png', sizeBytes: 4 }, { id: 'two', name: 'two.png', mimeType: 'image/png', sizeBytes: 4 }] }
    const { host, thread } = await opened(turns)
    const [prompt] = host.threadPrompts('session-workshop', thread().messages[0]!.id)!.prompts
    // The cut never leaves half a character.
    expect(prompt!.text).toBe('x'.repeat(THREAD_PROMPT_TEXT - 1))
    expect(prompt!.attachments).toBe(2)
    const reply = prompt!.reply!.text
    expect(reply.startsWith('Opening words. ')).toBe(true)
    expect(reply.length).toBeLessThan(THREAD_PROMPT_REPLY_HEAD * 2 + 3)
    expect(reply.endsWith('Should the pill wait 150 ms before it shows, for turn 0?')).toBe(true)
    expect(reply).not.toContain('Middle words. Middle words. Middle words. Middle words. Middle words. Middle words. Middle words. Middle words. Middle words. Middle words. Middle words. Middle words. Middle words. Middle words. Middle words. Middle words. Middle words. Middle words. Middle words. Middle words. Middle words. Middle words. Middle words. Middle words. Middle words. Middle words. Middle words. Middle words. Middle words. Middle words.')
  })

  it('leaves a wake-up out, with the reply that answered it', async () => {
    const { host, thread } = await opened(conversation(20))
    vi.spyOn(ThreadStore.prototype, 'wakeUps').mockReturnValue(new Set(['u4']))
    const prompts = host.threadPrompts('session-workshop', thread().messages[0]!.id)!.prompts
    expect(prompts.map(prompt => prompt.id)).toEqual(['u0', 'u1', 'u2', 'u3', 'u5', 'u6', 'u7', 'u8', 'u9'])
    expect(prompts[3]!.reply?.id).toBe('a3')
  })

  it('widens the window back to a pressed prompt, and leaves it be for one the store does not hold', async () => {
    const { host, thread } = await opened(conversation(60))
    await host.loadEarlierMessages('session-workshop', 'u3')
    expect(thread().messages[0]!.id).toBe('u3')
    expect(thread().earlierAvailable).toBe(true)
    // A prompt already in the window narrows nothing.
    await host.loadEarlierMessages('session-workshop', 'u40')
    expect(thread().messages[0]!.id).toBe('u3')
    await host.loadEarlierMessages('session-workshop', 'not-in-the-store')
    expect(thread().messages[0]!.id).toBe('u3')
    // Show earlier messages still adds twenty turns.
    await host.loadEarlierMessages('session-workshop')
    expect(thread().messages[0]!.id).toBe('u0')
    expect(thread().earlierAvailable).toBeUndefined()
  })
})
