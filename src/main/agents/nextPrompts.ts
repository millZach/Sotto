import { isVisualMessage, type AgentMessage, type AgentThread } from '../../shared/agents'
import type { NextPrompt, NextPromptEntry } from '../../shared/nextPrompt'
import { isThreadClosed, isThreadTurnRunning } from '../../shared/threadActivity'
import { NEXT_PROMPT_EXCHANGES, parseNextPrompt, type NextPromptExchange } from '../llm/nextPrompt'

/** How many threads' next prompts are held; the oldest goes first. */
export const NEXT_PROMPTS_HELD = 200

/** What the coordinator tells the next prompts as it reads each update: cheap, and never a copy of anything. */
export interface NextPromptHooks {
  /** A thread began work, or the user sent it something: whatever was suggested for it is over. */
  started(threadId: string): void
  /** A thread that was working is idle with nothing waiting on the user. */
  finished(thread: AgentThread): void
}

export interface NextPromptsDependencies {
  /** The side call, gated by the user's switch: the raw reply, or null when nothing was written. */
  readonly write: (threadId: string, exchanges: readonly NextPromptExchange[]) => Promise<string | null>
  /** The thread as the coordinator holds it now. */
  readonly thread: (threadId: string) => AgentThread | undefined
  /** The thread's whole history, newest last. */
  readonly history: (thread: AgentThread) => readonly AgentMessage[]
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

/**
 * Next prompts for this computer's threads (ADR-0131). When a turn ends, the thread's own provider is asked on the side
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

  started(threadId: string): void {
    const held = this.held.get(threadId)
    if (!held) return
    held.generation += 1
    this.letGo(threadId, held)
  }

  finished(thread: AgentThread): void {
    // A turn the user stopped or that failed did not end on an answer; Watcher's own threads are its, not the user's.
    if (this.closed || thread.kind === 'watcher' || thread.kind === 'watcher-history' || thread.lastTurn?.status === 'interrupted' || thread.lastTurn?.status === 'failed') return
    const held = this.hold(thread.id)
    held.generation += 1
    this.letGo(thread.id, held)
    const generation = held.generation
    // Read and asked after the update that ended the turn has been published, never on the update path itself.
    this.defer(() => { void this.ask(thread.id, generation) })
  }

  /** What is held now, for a window that has just loaded. */
  list(): NextPromptEntry[] {
    return [...this.held.values()].flatMap(held => held.entry ? [held.entry] : [])
  }

  close(): void { this.closed = true }

  private async ask(threadId: string, generation: number): Promise<void> {
    if (this.closed || this.dependencies.historyEnabled?.() === false) return
    const before = this.dependencies.thread(threadId)
    if (!before || !this.quiet(before) || this.held.get(threadId)?.generation !== generation) return
    const exchanges = recentExchanges(this.dependencies.history(before))
    if (!exchanges) return
    const anchor = before.lastUserMessageId ?? ''
    let reply: string | null
    try { reply = await this.dependencies.write(threadId, exchanges) }
    catch { this.dependencies.log?.('next-prompt-failed error'); return }
    if (reply === null) return
    const prompt = parseNextPrompt(reply)
    if (!prompt) { this.dependencies.log?.('next-prompt-failed unreadable'); return }
    // The generation guard: a send, a new turn or a newer finish since this was asked means it answers a turn that is over.
    const held = this.held.get(threadId)
    const after = this.dependencies.thread(threadId)
    if (this.closed || held?.generation !== generation || !after || !this.quiet(after) || (after.lastUserMessageId ?? '') !== anchor) return
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
