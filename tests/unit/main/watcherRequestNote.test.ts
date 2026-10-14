// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { watcherTextAsTyped, watcherMessagesAsTyped } from '../../../src/main/agents/watcherRequestNote'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread } from '../../../src/shared/agents'

/** The footer exactly as main appends it to the user's text. */
const footer = (requestId = randomUUID(), hostId = randomUUID(), projects = ['native:claude:project:' + randomUUID(), 'native:codex:project:' + randomUUID()]) =>
  `\n\n[Sotto Watcher request: ${requestId}. Local host: ${hostId}. Use this requestId for sotto_threads mutations. Known project IDs: ${projects.join(', ')}. Call list_projects for choices.]`

describe('Watcher messages as typed', () => {
  it('takes only the exact Sotto-made footer off an older message', () => {
    const typed = 'Check the release notes.\n\nThen tell me what is missing.'
    expect(watcherTextAsTyped(typed + footer())).toBe(typed)
    expect(watcherTextAsTyped(typed + footer(undefined, undefined, []))).toBe(typed)
    // An image sent with no words carried the footer alone.
    expect(watcherTextAsTyped(footer().slice(2))).toBe('')
    expect(watcherTextAsTyped(footer())).toBe('')
  })

  it('leaves every other text alone, including text that only looks like the footer', () => {
    const near = [
      'Plain words',
      // Not at the end of the message.
      `Before${footer()}\n\nAfter`,
      // Not Sotto's request or host identities.
      `Typed\n\n[Sotto Watcher request: abc. Local host: def. Use this requestId for sotto_threads mutations. Known project IDs: x. Call list_projects for choices.]`,
      // Words changed.
      `Typed${footer()}`.replace('Use this requestId', 'Use the requestId'),
      // Not on its own paragraph.
      `Typed ${footer().slice(2)}`,
    ]
    for (const text of near) expect(watcherTextAsTyped(text)).toBe(text)
  })

  it('shows Watcher’s own conversations as typed and no other thread’s', () => {
    const typed = 'Synthetic instruction'
    const thread = (kind: AgentThread['kind'], role: 'user' | 'assistant' = 'user'): AgentThread => ({ id: randomUUID(), projectId: 'project', title: 'T',
      modelId: 'model', status: 'idle', requests: [], ...(kind ? { kind } : {}), messages: [{ id: randomUUID(), role, text: typed + footer(), createdAt: new Date().toISOString() }] })
    const snapshot: AgentHostSnapshot = { ...EMPTY_AGENT_HOST, threads: [thread('watcher'), thread('watcher-history'), thread('project'), thread(undefined), thread('watcher', 'assistant')] }
    const shown = watcherMessagesAsTyped(snapshot)
    expect(shown.threads.map(row => row.messages[0]!.text)).toEqual([typed, typed,
      ...snapshot.threads.slice(2).map(row => row.messages[0]!.text)])
    expect(snapshot.threads[0]!.messages[0]!.text).not.toBe(typed)
    // Ordinary threads keep their objects; nothing is copied when no Watcher message carries the footer.
    expect(shown.threads[2]).toBe(snapshot.threads[2])
    expect(watcherMessagesAsTyped(shown).threads[0]).toBe(shown.threads[0])
    const clean = { ...EMPTY_AGENT_HOST, threads: [shown.threads[0]!] }
    expect(watcherMessagesAsTyped(clean)).toBe(clean)
  })

  it('takes Sotto’s line off once, however often the shown snapshot is taken again', () => {
    // A user who typed a footer of their own keeps it: only the last line, Sotto's, comes off.
    const typed = `Synthetic quoted${footer()}`, provider = { id: randomUUID(), role: 'user' as const, text: typed + footer(), createdAt: new Date().toISOString() }
    const snapshot: AgentHostSnapshot = { ...EMPTY_AGENT_HOST, threads: [{ id: randomUUID(), projectId: 'project', title: 'T', modelId: 'model', status: 'idle',
      requests: [], kind: 'watcher', messages: [provider] }] }
    const shown = watcherMessagesAsTyped(snapshot)
    expect(shown.threads[0]!.messages[0]!.text).toBe(typed)
    expect(watcherMessagesAsTyped(shown)).toBe(shown)
    // The provider's same message, handed over again, is shown as the same copy.
    expect(watcherMessagesAsTyped({ ...snapshot }).threads[0]!.messages[0]).toBe(shown.threads[0]!.messages[0])
  })
})
