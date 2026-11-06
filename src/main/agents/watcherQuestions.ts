import { randomUUID } from 'node:crypto'
import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { WatcherThreadTarget } from '../../shared/watcher'
import { SETTLE_CHOICES, SETTLE_IT, WATCHER_QUESTIONS_KEPT, watcherQuestionSchema, type WatcherAskInput, type WatcherQuestion } from '../../shared/watcherQuestions'
import { AtomicJsonStore } from '../storage/atomicJsonStore'

const FILE = 'watcher-questions.json'
const fileSchema = z.object({ version: z.literal(1), questions: z.array(watcherQuestionSchema).max(WATCHER_QUESTIONS_KEPT) }).strict()
type File = z.infer<typeof fileSchema>
const empty = (): File => ({ version: 1, questions: [] })
const sameTarget = (left: WatcherThreadTarget, right: WatcherThreadTarget): boolean => left.hostId === right.hostId && left.threadId === right.threadId
const NONE: readonly WatcherQuestion[] = Object.freeze([])

/**
 * Watcher's own questions (#2228, ADR-0073, November 5, 2026), newest last. Watcher's words for the user and the user's
 * choice, which nothing else holds, so they are saved while Keep local history is on, as Watcher's conversation is;
 * with it off they stay in memory, and a restart loses them. Every change replaces the list, so the room is handed the
 * same array until something changed.
 */
export class WatcherQuestions {
  private readonly store: AtomicJsonStore<File>
  private questions: readonly WatcherQuestion[] = NONE
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly directory: string, private readonly historyEnabled: () => boolean, private readonly now: () => string = () => new Date().toISOString()) {
    this.store = new AtomicJsonStore(join(directory, FILE), input => fileSchema.parse(input), empty)
  }
  private inTurn<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => undefined).then(work)
    this.tail = next
    return next
  }
  private save(): Promise<void> {
    return this.historyEnabled() ? this.store.write({ version: 1, questions: [...this.questions] }) : Promise.resolve()
  }
  private replace(next: readonly WatcherQuestion[]): Promise<void> {
    this.questions = next.length ? Object.freeze(next.slice(-WATCHER_QUESTIONS_KEPT)) : NONE
    return this.save().catch(() => undefined)
  }
  /** What was saved. A file that cannot be read gives none: Watcher still has its question in its own conversation. */
  load(): Promise<void> {
    return this.inTurn(async () => {
      const saved = this.historyEnabled() ? (await this.store.read().catch(empty)).questions : []
      this.questions = saved.length ? Object.freeze(saved) : NONE
    })
  }
  /** Every question, the same array until one changes. */
  all(): readonly WatcherQuestion[] { return this.questions }
  /** A question by its ID. */
  get(id: string): WatcherQuestion | undefined { return this.questions.find(question => question.id === id) }
  /** The questions a Watcher conversation asked that still wait on the user. */
  open(watcherThreadId: string): WatcherQuestion[] {
    return this.questions.filter(question => question.watcherThreadId === watcherThreadId && question.state === 'open')
  }
  /** Puts a question's card before the user. A settle question takes Sotto's own two choices. */
  ask(watcherThreadId: string, input: WatcherAskInput): Promise<WatcherQuestion> {
    return this.inTurn(async () => {
      const question: WatcherQuestion = { id: randomUUID(), watcherThreadId, question: input.question,
        options: input.settle ? SETTLE_CHOICES.map(option => ({ ...option })) : input.options!.map(option => ({ ...option })),
        ...input.settle ? { settle: input.settle } : {}, state: 'open', at: this.now() }
      // Asking again about the same settle replaces the earlier card, so one thread has one settle question.
      const kept = input.settle ? this.questions.map(item => item.state === 'open' && item.watcherThreadId === watcherThreadId && item.settle && sameTarget(item.settle, input.settle!)
        ? { ...item, state: 'closed' as const, endedAt: question.at } : item) : this.questions
      await this.replace([...kept, question])
      return question
    })
  }
  /** The user's choice. Undefined when the question no longer waits, so nothing is told twice. */
  answer(id: string, choice: string): Promise<WatcherQuestion | undefined> {
    return this.inTurn(async () => {
      const question = this.get(id)
      if (!question || question.state !== 'open' || !question.options.some(option => option.label === choice)) return undefined
      const answered: WatcherQuestion = { ...question, state: 'answered', choice, endedAt: this.now() }
      await this.replace(this.questions.map(item => item.id === id ? answered : item))
      return answered
    })
  }
  /** A new Watcher took over: the last one's open questions close, and go in its handover. */
  close(watcherThreadId: string): Promise<WatcherQuestion[]> {
    return this.inTurn(async () => {
      const closing = this.open(watcherThreadId)
      if (!closing.length) return []
      const at = this.now(), ids = new Set(closing.map(question => question.id))
      await this.replace(this.questions.map(item => ids.has(item.id) ? { ...item, state: 'closed' as const, endedAt: at } : item))
      return closing
    })
  }
  /**
   * Whether the user picked Settle it on this Watcher's card for this thread, and no settle has used that answer yet.
   * One answer agrees one settle, so a thread restored and finished again is asked again.
   */
  agreedSettle(watcherThreadId: string, target: WatcherThreadTarget): boolean {
    return this.questions.some(item => item.watcherThreadId === watcherThreadId && item.state === 'answered' && item.choice === SETTLE_IT
      && item.spent !== true && item.settle !== undefined && sameTarget(item.settle, target))
  }
  /** A settle went under the user's Settle it: that answer agreed it, and agrees no other. */
  spendSettle(watcherThreadId: string, target: WatcherThreadTarget): Promise<void> {
    return this.inTurn(async () => {
      if (!this.agreedSettle(watcherThreadId, target)) return
      await this.replace(this.questions.map(item => item.watcherThreadId === watcherThreadId && item.state === 'answered' && item.choice === SETTLE_IT
        && item.settle !== undefined && sameTarget(item.settle, target) ? { ...item, spent: true as const } : item))
    })
  }
  /** Keep local history changed: turned off, nothing of this stays on disk and this run keeps it in memory; turned on, it is saved. */
  privacyChanged(): Promise<void> {
    return this.inTurn(async () => {
      if (this.historyEnabled()) { await this.save(); return }
      const names = await readdir(this.directory).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[]
        throw error
      })
      await Promise.all(names.filter(name => name === FILE || name.startsWith(`${FILE}.`)).map(name => unlink(join(this.directory, name)).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })))
    })
  }
}
