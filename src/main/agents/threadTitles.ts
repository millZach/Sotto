import { isVisualMessage, isWatcherKind, threadSummaryOf, type AgentHostSnapshot, type AgentMessage, type AgentState, type AgentThread } from '../../shared/agents'
import { isThreadArchived } from '../../shared/threadActivity'
import type { ThreadTitleExchange } from '../llm/threadTitle'
import type { AgentHost } from './host'
import { watcherWakeUpsAsShown } from './watcherNews'

/** How long closing waits for a thread title still being written, so it is saved (#980). Quit never waits longer for one. */
export const TITLE_WRITE_CLOSING_WAIT_MS = 2_000

/** A thread still on the stand-in or a provider's name; absent on threads saved before Sotto recorded it. */
function carriesDefaultTitle(thread: AgentThread): boolean {
  return thread.titleSource === undefined || thread.titleSource === 'default'
}
/** How often a thread's name may be written again, and how often the threads are looked at for it. */
const TITLE_REFRESH_MS = 60 * 60_000
const TITLE_REFRESH_SWEEP_MS = 5 * 60_000
/** At most this many names are asked for in one sweep, so a sweep after a busy hour stays a trickle of side calls. */
const TITLE_REFRESHES_PER_SWEEP = 5

/**
 * Something the user said: a user message with words in it that is not one of Sotto's wake-ups, such as the restart
 * note (`wakeUp`), whose words are Sotto's and never name a thread.
 */
function userSaid(message: AgentMessage): boolean {
  return message.role === 'user' && message.wakeUp !== true && message.text.trim().length > 0
}

/** A thread's first message and its newest exchange, what an hourly name is written from; null until a reply follows. */
function currentExchange(messages: readonly AgentMessage[]): ThreadTitleExchange | null {
  const said = (message: AgentMessage): boolean => message.text.trim().length > 0
  const first = messages.find(userSaid)
  const reply = messages.findLastIndex(message => message.role === 'assistant' && !isVisualMessage(message) && said(message))
  if (!first || reply === -1) return null
  const prompt = messages.slice(0, reply).findLastIndex(userSaid)
  if (prompt === -1) return null
  const newest = { prompt: messages[prompt]!.text, reply: messages[reply]!.text }
  return messages[prompt] === first ? newest : { ...newest, opening: first.text }
}

/**
 * The first thing asked of a thread and the first answer it got, the only content a generated title is
 * written from. Automatic naming needs the thread to be at its first exchange and settled: a running turn
 * has no finished reply yet, and a thread that has moved on was named or left alone long ago. A requested
 * Regenerate still reads the same first exchange out of a longer history.
 */
function firstExchange(thread: AgentThread, trigger: 'automatic' | 'requested', messages: readonly AgentMessage[]): ThreadTitleExchange | null {
  if (trigger === 'automatic' && thread.status === 'running') return null
  // A first-message title says Sotto saw this thread begin, so a steer or a queued follow-up sent during the
  // first turn does not stop it being named; any other thread is named only while it has said one thing.
  if (trigger === 'automatic' && thread.titledFromFirstMessage !== true && messages.filter(message => message.role === 'user' && message.wakeUp !== true).length !== 1) return null
  const prompt = messages.findIndex(userSaid)
  if (prompt === -1) return null
  // A visual's message is Sotto's words about a drawing, not the agent's reply, so a title is never written from it.
  const reply = messages.slice(prompt + 1).find(message => message.role === 'assistant' && !isVisualMessage(message) && message.text.trim().length > 0)
  if (!reply) return null
  return { prompt: messages[prompt]!.text, reply: reply.text }
}

/** What thread titles need from the coordinator, which owns the threads they name. */
export interface ThreadTitlesContext {
  state(): Pick<AgentState, 'host'>
  disposed(): boolean
  /** A thread's whole history, as the coordinator reads it. */
  history(thread: AgentThread): readonly AgentMessage[]
  acceptSnapshot(snapshot: AgentHostSnapshot): void
  persist(): Promise<void>
  /** Read at each use, as the coordinator reads them. */
  readonly dependencies: {
    readonly host: Pick<AgentHost, 'renameThread'>
    readonly historyEnabled?: () => boolean
    readonly writeThreadTitle?: (threadId: string, exchange: ThreadTitleExchange) => Promise<string | null>
    readonly writeFirstMessageTitle?: (prompt: string) => Promise<string | null>
    readonly logFailure?: (code: 'thread-title-failed', detail: 'failed') => void
  }
}

/**
 * The names Sotto writes for threads (ADR-0026): a first-message title the moment a new thread's first message is in, a
 * generated title once its first reply lands, a fresh one at most hourly as it goes on, and Regenerate on request. A name
 * the user typed is never replaced. Closing waits a little for a name still being written (#980).
 */
export class ThreadTitles {
  /** The message count a thread's first exchange was last looked for at, so it is looked for once per arrival. */
  private readonly titleChecked = new Map<string, number>()
  /** Threads already asked about this run, so a failure is not retried on every provider frame. */
  private readonly titled = new Set<string>()
  /** When each thread's name was last written or first seen this run, and its message count then (ADR-0026, hourly names). */
  private readonly titleNamedAt = new Map<string, { readonly at: number; readonly count: number }>()
  private titleRefreshTimer: ReturnType<typeof setInterval> | null = null
  private readonly titleWrites = new Set<Promise<void>>()
  /** Set once closing has stopped waiting for title writes: a title that comes back after the final save is let go. */
  private titleWritesLetGo = false
  private letGoOfTitleWrites!: () => void
  /** Settles when closing lets go of the title writes still running, so nothing that waits on one waits longer. */
  private readonly titleWritesReleased = new Promise<null>(resolve => { this.letGoOfTitleWrites = () => resolve(null) })
  /** Closing's one wait for title writes, so the runtime and `closed()` share the same two seconds. */
  private closingTitleWait: Promise<void> | undefined
  /** Threads seen this run with nothing said yet: their first message, when it comes, gives them a first-message title. */
  private readonly awaitingFirstMessage = new Set<string>()

  constructor(private readonly context: ThreadTitlesContext) {}

  private get state(): ReturnType<ThreadTitlesContext['state']> { return this.context.state() }
  private get disposed(): boolean { return this.context.disposed() }

  startRefreshing(): void {
    this.titleRefreshTimer = setInterval(() => this.refresh(), TITLE_REFRESH_SWEEP_MS)
    this.titleRefreshTimer.unref?.()
  }
  stopRefreshing(): void {
    if (this.titleRefreshTimer) clearInterval(this.titleRefreshTimer)
    this.titleRefreshTimer = null
  }
  /** A deleted thread is forgotten, so its ID is a stranger again. */
  forget(threadId: string): void { this.titled.delete(threadId); this.titleNamedAt.delete(threadId) }
  /**
   * A thread names itself once, from its first exchange. Only a thread still carrying a stand-in or
   * provider name is named, so a name typed in the New thread dialog or a later rename is left alone,
   * and a thread is only ever asked about once per run: a failure leaves the stand-in name rather than
   * asking again on the next provider frame.
   */
  generate(): void {
    if (!this.context.dependencies.writeThreadTitle || !this.context.dependencies.host.renameThread) return
    // Local history off means Sotto keeps no thread content; none of it is sent to name a thread either.
    if (this.context.dependencies.historyEnabled?.() === false) return
    for (const thread of this.state.host.threads) {
      if (this.titled.has(thread.id) || thread.titleSource === 'user' || thread.titleSource === 'generated') continue
      this.giveFirstMessageTitle(thread)
      // A client shows the first reply while its turn is still running and ends the turn on a later frame
      // that adds no message, so a running thread is not yet checked: checking it would record this count
      // and skip the frame that finishes the turn.
      if (thread.status === 'running') continue
      // A thread's history lives in the store, so read it only when this thread has said something new:
      // otherwise a thread that will never be named would be read on every provider frame.
      const messageCount = threadSummaryOf(thread).messageCount
      if (messageCount < 2 || this.titleChecked.get(thread.id) === messageCount) continue
      this.titleChecked.set(thread.id, messageCount)
      const exchange = firstExchange(thread, 'automatic', watcherWakeUpsAsShown(this.context.history(thread)))
      if (!exchange) continue
      this.titled.add(thread.id)
      this.titleNamedAt.set(thread.id, { at: Date.now(), count: messageCount })
      this.trackTitleWrite(this.writeThreadTitle(thread.id, exchange))
    }
  }
  /**
   * Keeps the name Sotto gave a thread current (ADR-0026, November 1, 2026): at most once an hour, a thread that has said
   * something since its name was last written is named again from its first message and its newest exchange. A name the
   * user typed is never replaced. A thread is first only noted, so starting Sotto asks nothing of any provider, and a
   * sweep asks a few at most. Runs on its own timer, off the update path.
   */
  refresh(): void {
    if (this.disposed || !this.context.dependencies.writeThreadTitle || !this.context.dependencies.host.renameThread) return
    if (this.context.dependencies.historyEnabled?.() === false) return
    const now = Date.now()
    let asked = 0
    for (const thread of this.state.host.threads) {
      // Watcher's threads keep their own names, as they never take a first one.
      if (thread.titleSource === 'user' || isWatcherKind(thread) || isThreadArchived(thread) || thread.status === 'running') continue
      const count = threadSummaryOf(thread).messageCount
      const named = this.titleNamedAt.get(thread.id)
      if (!named) { this.titleNamedAt.set(thread.id, { at: now, count }); continue }
      if (count <= named.count || now - named.at < TITLE_REFRESH_MS || asked >= TITLE_REFRESHES_PER_SWEEP) continue
      this.titleNamedAt.set(thread.id, { at: now, count })
      const exchange = currentExchange(watcherWakeUpsAsShown(this.context.history(thread)))
      if (!exchange) continue
      asked++
      this.titled.add(thread.id)
      this.trackTitleWrite(this.writeThreadTitle(thread.id, exchange))
    }
  }
  /**
   * A thread Sotto saw begin, empty and still on a `default` name, takes the opening words of its first message as
   * soon as that message is in, while the turn still runs. A thread that already had history when this run first
   * saw it, an older or imported one, keeps the name it has.
   */
  private giveFirstMessageTitle(thread: AgentThread): void {
    if (!this.context.dependencies.writeFirstMessageTitle || !carriesDefaultTitle(thread) || thread.titledFromFirstMessage) return
    if (threadSummaryOf(thread).messageCount === 0) { this.awaitingFirstMessage.add(thread.id); return }
    if (!this.awaitingFirstMessage.has(thread.id)) return
    // The first message, even when a steer is already beside it on the frame that brings it.
    const first = this.context.history(thread).find(userSaid)
    if (!first) return
    this.awaitingFirstMessage.delete(thread.id)
    this.trackTitleWrite(this.offerTitle(thread.id, () => this.context.dependencies.writeFirstMessageTitle!(first.text), 'first-message'))
  }
  /** Keeps a title write where closing can wait for it (#980). */
  private trackTitleWrite(pending: Promise<void>): Promise<void> {
    this.titleWrites.add(pending)
    void pending.finally(() => this.titleWrites.delete(pending)).catch(() => undefined)
    return pending
  }
  /** Asks for the name and applies it, unless the thread was renamed by hand while the answer was in flight. */
  private writeThreadTitle(threadId: string, exchange: ThreadTitleExchange): Promise<void> {
    return this.offerTitle(threadId, () => this.context.dependencies.writeThreadTitle!(threadId, exchange), 'generated')
  }
  /**
   * Works out a name Sotto offers a thread and applies it, unless the thread was renamed by hand while it was
   * worked out. A first-message title also yields to a generated one that landed first.
   */
  private async offerTitle(threadId: string, write: () => Promise<string | null>, source: 'generated' | 'first-message'): Promise<void> {
    if (this.disposed) return
    try {
      const title = await Promise.race([write(), this.titleWritesReleased])
      // A write started before Sotto began closing is still applied, and `closed()` saves it (#980).
      if (this.titleWritesLetGo || title === null) return
      const thread = this.state.host.threads.find(item => item.id === threadId)
      if (!thread || thread.titleSource === 'user' || isThreadArchived(thread) || thread.title === title) return
      if (source === 'first-message' && (!carriesDefaultTitle(thread) || thread.titledFromFirstMessage)) return
      this.context.acceptSnapshot(await this.context.dependencies.host.renameThread!(threadId, title, source))
      // Once closing, the final save in `closed()` writes it.
      if (!this.disposed) await this.context.persist()
    } catch {
      // A name Sotto offered to write is never worth an error banner: the thread keeps the name it has.
      this.context.dependencies.logFailure?.('thread-title-failed', 'failed')
    }
  }
  /**
   * Ask again for a thread's name, replacing a generated or stand-in one on explicit request. Answers with the write when
   * one started, and with nothing when there is nothing to name, so the caller goes on in the same turn as before.
   */
  regenerate(threadId: string): Promise<void> | undefined {
    const thread = this.state.host.threads.find(item => item.id === threadId)
    // The same rule as automatic naming: with local history off, no thread content is sent to name it.
    const exchange = thread && this.context.dependencies.historyEnabled?.() !== false ? firstExchange(thread, 'requested', watcherWakeUpsAsShown(this.context.history(thread))) : null
    if (thread && exchange) {
      this.titled.add(thread.id)
      this.titleNamedAt.set(thread.id, { at: Date.now(), count: threadSummaryOf(thread).messageCount })
      return this.trackTitleWrite(this.writeThreadTitle(threadId, exchange))
    }
    return undefined
  }
  /**
   * Waits for the thread titles still being written, at most `TITLE_WRITE_CLOSING_WAIT_MS` (#980). Once disposed, the
   * wait is made once, and a title that takes longer is let go: the thread keeps the name it had, nothing is written
   * after the final save, and a regeneration waiting for it returns. The runtime stops side calls only after this.
   */
  settled(): Promise<void> {
    if (!this.disposed) return this.waitForTitleWrites()
    return this.closingTitleWait ??= this.waitForTitleWrites().then(() => { this.titleWritesLetGo = true; this.letGoOfTitleWrites() })
  }
  private async waitForTitleWrites(): Promise<void> {
    if (this.titleWrites.size === 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const cap = new Promise<void>(resolve => { timer = setTimeout(resolve, TITLE_WRITE_CLOSING_WAIT_MS) })
    try { await Promise.race([Promise.allSettled([...this.titleWrites]), cap]) } finally { clearTimeout(timer) }
  }
}
