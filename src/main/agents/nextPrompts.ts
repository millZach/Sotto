import { isVisualMessage, lastUserMessageIdOf, type AgentMessage, type AgentThread } from '../../shared/agents'
import type { NextPrompt, NextPromptEntry } from '../../shared/nextPrompt'
import { isThreadClosed, isThreadTurnRunning } from '../../shared/threadActivity'
import { NEXT_PROMPT_EXCHANGES, parseNextPrompt, type NextPromptExchange } from '../llm/nextPrompt'

/** How many threads' next prompts are held; the oldest goes first. */
export const NEXT_PROMPTS_HELD = 200

/** What the coordinator tells the next prompts as it reads each update: cheap, and never a copy of anything. */
export interface NextPromptHooks {
  /**
   * A thread began work, or main accepted something the user sent it while `sentAt` (from `sending`) was its generation:
   * whatever was suggested then is over. A send accepted after its own turn already ended lets go of nothing newer.
   */
  started(threadId: string, sentAt?: number): void
  /** The thread's generation as a send is admitted, read from this record alone, never from the thread list. */
  sending(threadId: string): number | undefined
  /** A thread that was working is idle with nothing waiting on the user. */
  finished(thread: AgentThread): void
  /** The threads some client shows now: one that finished unseen is asked for then. */
  shown?(threadIds: readonly string[]): void
}

export interface NextPromptsDependencies {
  /** The side call, gated by the user's switch: the raw reply, or null when nothing was written. `signal` gives up on it. */
  readonly write: (threadId: string, exchanges: readonly NextPromptExchange[], signal: AbortSignal) => Promise<string | null>
  /** The thread as the coordinator holds it now, with the messages a window has it hold in memory. */
  readonly thread: (threadId: string) => AgentThread | undefined
  /** The thread's history from the store, read only when a client shows a thread that finished unseen: a user's action. */
  readonly history?: (thread: AgentThread) => readonly AgentMessage[]
  /** Local history off means no thread content is kept, so none is sent for this either, as with titles. */
  readonly historyEnabled?: () => boolean
  /** Each change, for the window. */
  readonly publish: (entry: NextPromptEntry) => void
  /** Stable event names only; never a prompt, a reply or a suggestion. */
  readonly log?: (event: 'next-prompt-failed unreadable' | 'next-prompt-failed error') => void
  readonly defer?: (run: () => void) => void
}

interface Held {
  /** Bumped by every start and finish: an answer for an older one is dropped. */
  generation: number
  /** The side call in flight, aborted when a start or a newer finish supersedes it. */
  asking?: AbortController
  /** The generation of a finish that was asked nothing because no window held its messages; showing the thread asks it. */
  unseen?: number
  entry?: NextPromptEntry & { prompt: NextPrompt }
}

/**
 * The thread's last exchanges, oldest first, when its newest message is the agent's answer with words in it; null when
 * the turn did not end on an answer. A visual's message is Sotto's words about a drawing, not the agent's reply.
 */
export function recentExchanges(messages: readonly AgentMessage[], max = NEXT_PROMPT_EXCHANGES): NextPromptExchange[] | null {
  const exchanges: NextPromptExchange[] = []
  let reply: string[] = []
  for (let index = messages.length - 1; index >= 0 && exchanges.length < max; index--) {
    const message = messages[index]!
    if (message.role === 'assistant') {
      if (!isVisualMessage(message) && message.text.trim() !== '') reply.unshift(message.text)
      continue
    }
    if (exchanges.length === 0 && reply.length === 0) return null
    exchanges.unshift({ prompt: message.text, reply: reply.join('\n\n') })
    reply = []
  }
  if (reply.length > 0 && exchanges.length < max) exchanges.unshift({ prompt: '', reply: reply.join('\n\n') })
  return exchanges.length > 0 ? exchanges : null
}

/** The turn answered a wake-up Sotto sent, by the host's own record of the send, never by its text. */
function answersWakeUp(thread: AgentThread): boolean {
  const id = lastUserMessageIdOf(thread)
  return id !== null && (thread.wakeUpMessageIds?.includes(id) === true || thread.messages.some(message => message.id === id && message.wakeUp === true))
}

/**
 * Next prompts for this computer's threads (ADR-0132). When a turn ends, the thread's own provider is asked on the side
 * (ADR-0026) what the user will most likely type next; the answer is held in memory for that thread and told to the
 * window. A start, a send or a newer finish lets go of it, and an answer that lands after one of those is dropped.
 * Nothing is saved, and nothing here sends anything to a thread.
 */
export class NextPrompts implements NextPromptHooks {
  private readonly held = new Map<string, Held>()
  private readonly defer: (run: () => void) => void
  private closed = false

  constructor(private readonly dependencies: NextPromptsDependencies) {
    this.defer = dependencies.defer ?? (run => { setTimeout(run, 0) })
  }

  started(threadId: string, sentAt?: number): void {
    const held = this.held.get(threadId)
    if (!held || (sentAt !== undefined && held.generation !== sentAt)) return
    this.supersede(held)
    this.letGo(threadId, held)
  }

  finished(thread: AgentThread): void {
    // A turn the user stopped or that failed did not end on an answer. A past Watcher conversation takes no more messages,
    // Watcher answering Sotto's own news answered nothing the user typed, and a delegated thread's next message comes from
    // the thread that delegated to it (ADR-0081), not the user.
    if (this.closed || thread.kind === 'watcher-history' || thread.kind === 'watcher' && answersWakeUp(thread) || thread.delegatedBy !== undefined
      || thread.lastTurn?.status === 'interrupted' || thread.lastTurn?.status === 'failed') return
    const held = this.hold(thread.id)
    this.supersede(held)
    this.letGo(thread.id, held)
    const generation = held.generation
    // Read and asked after the update that ended the turn has been published, never on the update path itself.
    this.defer(() => { void this.ask(thread.id, generation) })
  }

  shown(threadIds: readonly string[]): void {
    if (this.closed) return
    for (const id of threadIds) {
      const held = this.held.get(id)
      if (held?.unseen === undefined) continue
      const generation = held.unseen
      delete held.unseen
      if (generation === held.generation && !held.entry && !held.asking) this.defer(() => { void this.ask(id, generation, true) })
    }
  }

  sending(threadId: string): number | undefined { return this.held.get(threadId)?.generation }

  /** What is held now, for a window that has just loaded. */
  list(): NextPromptEntry[] {
    return [...this.held.values()].flatMap(held => held.entry ? [held.entry] : [])
  }

  close(): void {
    this.closed = true
    for (const held of this.held.values()) held.asking?.abort()
  }

  /** A new generation: the side call asked for the old one is told to stop, so it costs nothing more. */
  private supersede(held: Held): void {
    held.generation += 1
    delete held.unseen
    held.asking?.abort()
    delete held.asking
  }

  private async ask(threadId: string, generation: number, fromHistory = false): Promise<void> {
    if (this.closed || this.dependencies.historyEnabled?.() === false) return
    const before = this.dependencies.thread(threadId)
    if (!before || !this.quiet(before) || this.held.get(threadId)?.generation !== generation) return
    // At a turn's end, only what the coordinator already holds in memory: a thread no window is showing carries its summary
    // alone, and its history is not read from the store then. Such a thread is asked once a client shows it, from the store.
    const messages = fromHistory ? this.dependencies.history?.(before) ?? before.messages : before.messages
    if (!fromHistory && messages.length === 0) { this.held.get(threadId)!.unseen = generation; return }
    const exchanges = recentExchanges(messages)
    if (!exchanges) return
    const anchor = lastUserMessageIdOf(before) ?? ''
    const held = this.held.get(threadId)!
    const asking = held.asking = new AbortController()
    let reply: string | null
    try { reply = await this.dependencies.write(threadId, exchanges, asking.signal) }
    catch { if (!asking.signal.aborted) this.dependencies.log?.('next-prompt-failed error'); return }
    finally { if (held.asking === asking) delete held.asking }
    if (reply === null || asking.signal.aborted) return
    const prompt = parseNextPrompt(reply)
    if (!prompt) { this.dependencies.log?.('next-prompt-failed unreadable'); return }
    // The generation guard: a send, a new turn or a newer finish since this was asked means it answers a turn that is over.
    const after = this.dependencies.thread(threadId)
    if (this.closed || this.held.get(threadId) !== held || held.generation !== generation || !after || !this.quiet(after) || (lastUserMessageIdOf(after) ?? '') !== anchor) return
    held.entry = { threadId, afterUserMessageId: anchor, prompt }
    this.dependencies.publish(held.entry)
  }

  /** At rest with nothing waiting on the user, and still the user's to write to. */
  private quiet(thread: AgentThread): boolean {
    return !isThreadTurnRunning(thread) && thread.status === 'idle' && thread.requests.length === 0 && !thread.archivedAt && !isThreadClosed(thread)
  }

  private hold(threadId: string): Held {
    let held = this.held.get(threadId)
    if (held) { this.held.delete(threadId); this.held.set(threadId, held); return held }
    this.held.set(threadId, held = { generation: 0 })
    for (const [id, oldest] of this.held) {
      if (this.held.size <= NEXT_PROMPTS_HELD) break
      this.held.delete(id)
      oldest.asking?.abort()
      if (oldest.entry) this.dependencies.publish({ threadId: id, afterUserMessageId: oldest.entry.afterUserMessageId, prompt: null })
    }
    return held
  }

  private letGo(threadId: string, held: Held): void {
    if (!held.entry) return
    const { afterUserMessageId } = held.entry
    delete held.entry
    this.dependencies.publish({ threadId, afterUserMessageId, prompt: null })
  }
}
