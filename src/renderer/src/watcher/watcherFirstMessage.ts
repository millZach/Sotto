import { useEffect, useSyncExternalStore } from 'react'
import type { AgentConnection } from '../agents/AgentContext'
import { sendThreadRevision } from '../agents/ThreadComposer'
import { describeThreads } from '../agents/threadFacts'

/**
 * What the first entry holds before Watcher exists (the plan, section 6): the message, the model and effort picked
 * for it, and how far starting has got. It is the window's, not the room's, so leaving the room while main creates
 * Watcher keeps the message, and it goes to the new Watcher once, whether or not the room is open when its thread
 * arrives. A reload loses it until Watcher exists: the draft store keeps drafts by thread, and there is no thread
 * until `open` answers. Once there is, the message is Watcher's draft and is sent from there.
 */
export interface FirstMessage {
  readonly text: string
  /** The model picked for Watcher, or empty for the first one offered. */
  readonly modelId: string
  /** The effort picked, or null for the model's default. */
  readonly effort: string | null
  /**
   * `writing` while it is in the composer; `starting` while main creates Watcher; `started` once main has, until the
   * message goes to Watcher's thread.
   */
  readonly phase: 'writing' | 'starting' | 'started'
  /** Why Watcher did not start, in main's words or Sotto's; the message stays. */
  readonly error: string | null
}

const BLANK: FirstMessage = { text: '', modelId: '', effort: null, phase: 'writing', error: null }
let current = BLANK
const listeners = new Set<() => void>()
const emit = (): void => { for (const listener of [...listeners]) listener() }

export const firstMessage = {
  get: (): FirstMessage => current,
  update(patch: Partial<FirstMessage>): void {
    current = { ...current, ...patch }
    emit()
  },
  /** The message waiting for Watcher, taken once: whoever takes it sends it, and a second take finds nothing. */
  take(): string | null {
    if (current.phase !== 'started') return null
    const text = current.text.trim()
    current = BLANK
    emit()
    return text === '' ? null : text
  },
  /** Back to an empty first entry, for a test's fresh window. */
  clear(): void { current = BLANK; emit() },
  subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } },
}

export function useFirstMessage(): FirstMessage {
  return useSyncExternalStore(firstMessage.subscribe, firstMessage.get, firstMessage.get)
}

/**
 * Sends the first message to Watcher once main has created it and its thread is in the window, through the
 * composer's own send, from wherever the window is. The room provider runs it, so it outlives the room.
 */
export function useFirstMessageDelivery(agents: AgentConnection | null, watcherThreadId: string | null): void {
  const phase = useFirstMessage().phase
  const state = agents?.state ?? null
  useEffect(() => {
    if (phase !== 'started' || agents === null || state === null || watcherThreadId === null) return
    const row = describeThreads(state, Date.now()).find(item => item.thread.id === watcherThreadId)
    if (row === undefined) return
    const text = firstMessage.take()
    if (text === null) return
    agents.threadDrafts.edit(row.thread.id, { text })
    void sendThreadRevision(agents.threadDrafts, row, agents.command, performance.now())
  }, [phase, agents, state, watcherThreadId])
}
