import { useEffect, useSyncExternalStore } from 'react'
import type { AgentConnection } from '../agents/AgentContext'
import { sendThreadRevision } from '../agents/ThreadComposer'
import { describeThreads } from '../agents/threadFacts'

/**
 * What the first entry holds before Watcher exists (the plan, section 6): the message, the model and effort picked
 * for it, and how far starting has got. It is the window's, not the room's, so leaving the room while main creates
 * Watcher keeps the message, and it goes to the new Watcher once, whether or not the room is open when its thread
 * arrives. The draft store keeps drafts by thread, and there is no thread until `open` answers, so the window keeps it
 * in its own session too: a reload finds it as it was. Once there is a thread, the message is Watcher's draft and is
 * sent from there.
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

/** Where the window's session keeps the first message, so a reload does not lose it. Gone once it is sent. */
export const FIRST_MESSAGE_KEY = 'sotto.watcher.firstMessage'
const BLANK: FirstMessage = { text: '', modelId: '', effort: null, phase: 'writing', error: null }
const listeners = new Set<() => void>()
const emit = (): void => { for (const listener of [...listeners]) listener() }

function session(): Storage | null {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage } catch { return null }
}

/**
 * Whether the message was read back while starting or started, before this window saw main's answer: if main then
 * says there is no Watcher, starting did not finish, and the message goes back to the composer rather than wait.
 */
let resumed = false
/**
 * Whether the message went back to the composer that way. Main may still have been creating Watcher when it answered,
 * so if Watcher then appears, the message becomes its draft, unsent, rather than vanish with the first entry.
 */
let returned = false

/** The message as the session kept it. A kept start resumes as started; nothing kept, or anything unreadable, is blank. */
function restored(): FirstMessage {
  resumed = false
  let raw: string | null = null
  try { raw = session()?.getItem(FIRST_MESSAGE_KEY) ?? null } catch { /* A session that cannot be read keeps nothing. */ }
  if (raw === null) return BLANK
  try {
    const kept = JSON.parse(raw) as Partial<Record<keyof FirstMessage, unknown>>
    if (typeof kept.text !== 'string' || typeof kept.modelId !== 'string' || (kept.effort !== null && typeof kept.effort !== 'string')
      || !['writing', 'starting', 'started'].includes(kept.phase as string)) return BLANK
    const starting = kept.phase !== 'writing' && kept.text.trim() !== ''
    resumed = starting
    return { text: kept.text, modelId: kept.modelId, effort: kept.effort as string | null, phase: starting ? 'started' : 'writing', error: null }
  } catch { return BLANK }
}

function keep(): void {
  const store = session()
  if (store === null) return
  try {
    if (current.text === '' && current.phase === 'writing') store.removeItem(FIRST_MESSAGE_KEY)
    else store.setItem(FIRST_MESSAGE_KEY, JSON.stringify({ text: current.text, modelId: current.modelId, effort: current.effort, phase: current.phase }))
  } catch { /* Kept in this window until it reloads, as before. */ }
}

let current = restored()

export const firstMessage = {
  get: (): FirstMessage => current,
  update(patch: Partial<FirstMessage>): void {
    current = { ...current, ...patch }
    if (patch.phase !== undefined) { resumed = false; returned = false }
    keep()
    emit()
  },
  /** The message waiting for Watcher, taken once: whoever takes it sends it, and a second take finds nothing. */
  take(): string | null {
    if (current.phase !== 'started') return null
    const text = current.text.trim()
    current = BLANK
    resumed = false
    returned = false
    keep()
    emit()
    return text === '' ? null : text
  },
  /** A message that went back to the composer after a reload, taken once to become Watcher's draft; null otherwise. */
  takeReturned(): string | null {
    if (!returned || current.phase !== 'writing') return null
    const text = current.text.trim()
    current = BLANK
    returned = false
    keep()
    emit()
    return text === '' ? null : text
  },
  /**
   * Main answered with no Watcher. A message read back as started was starting when the window reloaded, and starting
   * did not finish: it goes back to the composer, with nothing sent.
   */
  noWatcher(): void {
    if (!resumed || current.phase !== 'started') return
    resumed = false
    returned = true
    current = { ...current, phase: 'writing' }
    keep()
    emit()
  },
  /** Reads the message back from the window's session, as a reloaded window does. */
  reload(): void { current = restored(); returned = false; emit() },
  /** Back to an empty first entry, for a test's fresh window. */
  clear(): void { current = BLANK; resumed = false; returned = false; keep(); emit() },
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
    if (agents === null || state === null || watcherThreadId === null) return
    // Gone back to the composer while main was still creating Watcher: it is Watcher's draft now, sent by the user.
    // The room names Watcher's thread only once the window has it.
    if (phase === 'writing') {
      const kept = firstMessage.takeReturned()
      if (kept !== null) agents.threadDrafts.edit(watcherThreadId, { text: kept })
      return
    }
    if (phase !== 'started') return
    const row = describeThreads(state, Date.now()).find(item => item.thread.id === watcherThreadId)
    if (row === undefined) return
    const text = firstMessage.take()
    if (text === null) return
    agents.threadDrafts.edit(row.thread.id, { text })
    void sendThreadRevision(agents.threadDrafts, row, agents.command, performance.now())
  }, [phase, agents, state, watcherThreadId])
}
