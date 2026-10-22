import type { AgentHostSnapshot, AgentQuestionAnswers, AgentRequest, AgentThread } from '../../shared/agents'
import { settledIn } from './finishedUnread'
import { questionValues } from './nativeRequests'
import { newestReply, requestWords, type PageSearch } from './questionPages'
import { isSottoRequest, SOTTO_REQUEST_PREFIX } from './sottoRequests'

/** What Sotto answers a prototype question with when it found no page that opens (ADR-0108), word for word. */
export const PROTOTYPE_SEND_BACK_NOTE = 'Sotto held this question because it is about a prototype but names no page that opens. The user has not seen it. Ask it again with the prototype\'s file path in this folder or its loopback address, and make sure the page opens.'
/** How long after a send-back the thread's next question counts as its answer to the note, before Sotto shows its own copy. */
export const PROTOTYPE_SEND_BACK_WINDOW_MS = 60_000
/**
 * The longest a question is held while its pages are looked for. A search that has not finished by then shows the
 * question as ADR-0085 always did, so no question waits unseen for a search that never ends.
 */
export const PROTOTYPE_HOLD_MAX_MS = 30_000
/**
 * How long Sotto waits for the provider to say it took the note. Past it the provider cannot say, and the question shows,
 * marked link missing (ADR-0108); a confirmation that comes later is still heard, but never hides the question again.
 */
export const PROTOTYPE_SEND_BACK_CONFIRM_MS = 10_000
/** Sotto's own copy of a question it sent back: a Sotto request (ADR-0035) named after the original. */
export const PROTOTYPE_QUESTION_COPY_PREFIX = `${SOTTO_REQUEST_PREFIX}prototype-question:`

const PROTOTYPE_WORDS = /\b(?:prototypes?|mock[-‐‑ ]?ups?)\b/iu

/** Whether a question is about a prototype (ADR-0108): its words, or the reply before it, say prototype or mock-up. */
export function aboutPrototype(request: AgentRequest, reply?: string): boolean {
  return requestWords(request).some(words => PROTOTYPE_WORDS.test(words)) || (reply !== undefined && PROTOTYPE_WORDS.test(reply))
}

/** The answer that sends a question back, or undefined when it cannot carry the note: a question that only takes listed choices. */
export type PrototypeSendBack = { readonly answer: string; readonly questionAnswers?: AgentQuestionAnswers }
export function sendBackAnswer(request: AgentRequest): PrototypeSendBack | undefined {
  if (request.kind !== 'question') return undefined
  const questions = request.questions ?? []
  if (!questions.length) return { answer: PROTOTYPE_SEND_BACK_NOTE }
  if (questions.some(question => !question.allowFreeText || question.unavailableReason)) return undefined
  return { answer: PROTOTYPE_SEND_BACK_NOTE, questionAnswers: Object.fromEntries(questions.map(question => [question.id, { optionIds: [], text: PROTOTYPE_SEND_BACK_NOTE }])) }
}

export const isPrototypeQuestionCopy = (requestId: string): boolean => requestId.startsWith(PROTOTYPE_QUESTION_COPY_PREFIX)

/** Sotto's copy of a question it sent back: its words, choices and questions, under their own IDs, marked link missing. */
function copyOf(original: AgentRequest): AgentRequest {
  return { id: `${PROTOTYPE_QUESTION_COPY_PREFIX}${original.id}`.slice(0, 512), kind: 'question', text: original.text, options: original.options,
    ...(original.questions ? { questions: original.questions } : {}), linkMissing: true }
}

/**
 * Where one provider question stands. `held` while its pages are looked for; `next` is the thread's first question after
 * a send-back, held the same way; `sending` while the note goes; `sent-back` once the provider took it, hidden until the
 * provider puts the question away. `shown` and `link-missing` are what every client sees.
 */
type QuestionState = 'held' | 'next' | 'sending' | 'sent-back' | 'shown' | 'link-missing'
const HIDDEN: ReadonlySet<QuestionState> = new Set(['held', 'next', 'sending', 'sent-back'])

/** The minute after a send-back. Until the provider takes the note it has no end. */
interface Minute { readonly original: AgentRequest; cancel?: () => void }

interface ThreadRecord {
  readonly questions: Map<string, { state: QuestionState; readonly since: number }>
  /**
   * Questions sent back, newest last, with what each is when a snapshot that lost track of it reads it again: hidden while
   * the provider took the note, or link missing once it showed because the provider could not say. Never sent again.
   */
  readonly sentBack: Map<string, 'sent-back' | 'link-missing'>
  minute?: Minute
  copy?: AgentRequest
}

const SENT_BACK_KEPT = 20

export interface PrototypeQuestionsOptions {
  /** Where the search for a question's pages stands: QuestionPages' answer for `request:<ID>`. */
  readonly searched: (threadId: string, source: string) => PageSearch | undefined
  /** Answers the question with the note, as Sotto. True once the provider took it; false or a throw when it did not. */
  readonly sendBack: (threadId: string, request: AgentRequest, answer: PrototypeSendBack) => Promise<boolean>
  /** Called when what the threads show changed outside a snapshot, so the coordinator takes its snapshot again. */
  readonly changed: () => void
  readonly now?: () => number
  /** Runs `run` after `ms`; returns what cancels it. Injectable so tests own the clock. */
  readonly timer?: (run: () => void, ms: number) => () => void
}

/** A timer that never holds Sotto open. */
export const startTimer = (run: () => void, ms: number): (() => void) => {
  const timer = setTimeout(run, ms)
  timer.unref?.()
  return () => clearTimeout(timer)
}

/**
 * Checked prototype questions (ADR-0108). A provider's question about a prototype is held out of its thread while
 * Sotto looks for its pages: no client, Watcher or alert sees it. With a working page it shows. Without one Sotto sends
 * it back once with a fixed note, and keeps it hidden until the provider puts it away. The thread's next question within
 * a minute shows, marked link missing when it still has no working page; when none comes, Sotto shows its own copy of
 * the original, marked link missing, and the user's answer to it goes to the thread as the user's message.
 *
 * All of it is in memory: a restart shows whatever the provider still has. It runs on the coordinator of the host that
 * runs the thread, after the question pages and the prototype-ready mark are applied, so both still read the question.
 */
export class PrototypeQuestions {
  private readonly records = new Map<string, ThreadRecord>()
  /** Each thread this put out, to the thread it was given: a snapshot taken again holds the questions this hid. */
  private readonly given = new WeakMap<AgentThread, AgentThread>()
  private readonly now: () => number
  private readonly timer: (run: () => void, ms: number) => () => void

  constructor(private readonly options: PrototypeQuestionsOptions) {
    this.now = options.now ?? Date.now
    this.timer = options.timer ?? startTimer
  }

  /**
   * The snapshot as it was given before this hid or added anything. The coordinator takes its own published snapshot
   * again when something changes outside the host, and a question hidden there is still the provider's.
   */
  restore(snapshot: AgentHostSnapshot): AgentHostSnapshot {
    if (!this.records.size) return snapshot
    let threads: AgentThread[] | undefined
    for (let index = 0; index < snapshot.threads.length; index++) {
      const given = this.given.get(snapshot.threads[index]!)
      if (given) (threads ??= [...snapshot.threads])[index] = given
    }
    return threads ? { ...snapshot, threads } : snapshot
  }

  /** The snapshot as clients see it. Threads with nothing to change keep their own object, and so does the snapshot. */
  decorate(snapshot: AgentHostSnapshot): AgentHostSnapshot {
    const settled = settledIn(snapshot)
    let threads: AgentThread[] | undefined
    for (let index = 0; index < snapshot.threads.length; index++) {
      const thread = snapshot.threads[index]!
      const next = this.shown(thread, settled(thread))
      if (next !== thread) {
        this.given.set(next, thread)
        ;(threads ??= [...snapshot.threads])[index] = next
      }
    }
    if (this.records.size) {
      const present = new Set(snapshot.threads.map(thread => thread.id))
      for (const [id, record] of this.records) if (!present.has(id)) { record.minute?.cancel?.(); this.records.delete(id) }
    }
    return threads ? { ...snapshot, threads } : snapshot
  }

  /** Whether a thread has a question the provider still waits on that no client sees: it still has a request. */
  holds(threadId: string): boolean {
    const record = this.records.get(threadId)
    if (!record) return false
    for (const question of record.questions.values()) if (HIDDEN.has(question.state)) return true
    return false
  }

  /** Whether `requestId` is Sotto's copy of a question it sent back, waiting in that thread. */
  isCopy(threadId: string, requestId: string): boolean { return this.records.get(threadId)?.copy?.id === requestId }

  /**
   * The user's answer to Sotto's copy, as the message the thread is sent: the question quoted, then the choices'
   * labels and any words. Throws, in words the user can act on, when the copy is gone or the answer is empty.
   */
  copyAnswer(threadId: string, requestId: string, answer: string, questionAnswers?: AgentQuestionAnswers): string {
    const copy = this.records.get(threadId)?.copy
    if (!copy || copy.id !== requestId) throw new Error('This request is no longer pending. Refresh the thread.')
    const questions = copy.questions ?? []
    const answers: { question: string; value: string }[] = []
    if (questions.length && questionAnswers) {
      const values = questionValues(copy, questionAnswers)
      for (const question of questions) if (values[question.id]?.length) answers.push({ question: question.question, value: values[question.id]!.join(', ') })
    } else {
      const words = answer.trim()
      const value = copy.options.find(option => option.id === words)?.label ?? words
      if (value) answers.push({ question: questions.length === 1 ? questions[0]!.question : copy.text, value })
    }
    if (!answers.length) throw new Error('Answer the question before sending. Nothing was sent.')
    if (answers.length === 1) return `Answer to your earlier question "${answers[0]!.question}": ${answers[0]!.value}`
    return ['Answers to your earlier questions:', ...answers.map(item => `"${item.question}": ${item.value}`)].join('\n')
  }

  /** Puts the copy away once its answer is on its way; returns it, so a send that fails can put it back. */
  withdrawCopy(threadId: string, requestId: string): AgentRequest | undefined {
    const record = this.records.get(threadId)
    const copy = record?.copy
    if (!record || copy?.id !== requestId) return undefined
    delete record.copy
    return copy
  }

  /** Puts a withdrawn copy back, unless the thread asked something new meanwhile. */
  putBackCopy(threadId: string, copy: AgentRequest): void {
    const record = this.records.get(threadId)
    if (!record || record.copy || record.minute || [...record.questions.values()].some(question => question.state !== 'sent-back')) return
    record.copy = copy
  }

  private shown(thread: AgentThread, closed: boolean): AgentThread {
    let record = this.records.get(thread.id)
    if (!record) {
      if (thread.kind === 'watcher' || thread.kind === 'watcher-history' || !thread.requests.some(asked)) return thread
      record = { questions: new Map(), sentBack: new Map() }
      this.records.set(thread.id, record)
    }
    // An archived or settled thread is quiet: it holds nothing new, and Sotto's copy goes.
    if (closed) { this.endMinute(record); delete record.copy }
    let reply: string | undefined | null = null
    const replyBefore = (): string | undefined => {
      if (reply === null) reply = thread.messages.length ? newestReply(thread.messages) : thread.summary?.lastAssistant?.text
      return reply
    }
    let changed = false
    const requests: AgentRequest[] = []
    const present = new Set<string>()
    for (const request of thread.requests) {
      // A copy a snapshot still carries is put back below, as it stands now.
      if (isPrototypeQuestionCopy(request.id)) { changed = true; continue }
      if (!asked(request)) { requests.push(request); continue }
      present.add(request.id)
      const state = this.stateOf(thread.id, record, request, closed, replyBefore)
      if (HIDDEN.has(state)) { changed = true; continue }
      if (state === 'link-missing' && request.linkMissing !== true) { changed = true; requests.push({ ...request, linkMissing: true }); continue }
      requests.push(request)
    }
    for (const id of record.questions.keys()) if (!present.has(id)) record.questions.delete(id)
    if (record.copy) { requests.push(record.copy); changed = true }
    if (!record.questions.size && !record.minute && !record.copy && !record.sentBack.size) this.records.delete(thread.id)
    return changed ? { ...thread, requests } : thread
  }

  private stateOf(threadId: string, record: ThreadRecord, request: AgentRequest, closed: boolean, replyBefore: () => string | undefined): QuestionState {
    let entry = record.questions.get(request.id)
    if (!entry) {
      const sent = record.sentBack.get(request.id)
      if (sent) entry = { state: sent, since: this.now() }
      else {
        // A new question answers the note, or puts Sotto's copy away: the thread asked again.
        const answersNote = record.minute !== undefined
        this.endMinute(record)
        delete record.copy
        const state: QuestionState = closed ? 'shown' : answersNote ? 'next' : aboutPrototype(request, replyBefore()) ? 'held' : 'shown'
        entry = { state, since: this.now() }
        if (state === 'held' || state === 'next') this.timer(() => this.options.changed(), PROTOTYPE_HOLD_MAX_MS)
      }
      record.questions.set(request.id, entry)
    }
    if (entry.state === 'sending' && (closed || this.now() - entry.since >= PROTOTYPE_HOLD_MAX_MS)) this.unconfirmed(record, request.id)
    if (entry.state !== 'held' && entry.state !== 'next') return entry.state
    const search = this.options.searched(threadId, `request:${request.id}`)
    if (search?.finished) {
      if (search.working.length) entry.state = 'shown'
      else if (entry.state === 'next' || closed) entry.state = 'link-missing'
      else {
        const answer = sendBackAnswer(request)
        if (!answer) entry.state = 'link-missing'
        else { entry.state = 'sending'; this.send(threadId, record, request, answer) }
      }
    } else if (closed || this.now() - entry.since >= PROTOTYPE_HOLD_MAX_MS) entry.state = 'shown'
    return entry.state
  }

  /** Sends the question back once. The thread's next question answers the note from now on, though the minute starts once the provider took it. */
  private send(threadId: string, record: ThreadRecord, request: AgentRequest, answer: PrototypeSendBack): void {
    record.sentBack.set(request.id, 'sent-back')
    if (record.sentBack.size > SENT_BACK_KEPT) record.sentBack.delete(record.sentBack.keys().next().value!)
    const minute: Minute = { original: request }
    record.minute = minute
    // A provider that has not said in time cannot say: the question shows, and what it says later is still heard.
    const cancelDeadline = this.timer(() => {
      if (this.records.get(threadId) !== record || record.questions.get(request.id)?.state !== 'sending') return
      this.unconfirmed(record, request.id)
      this.options.changed()
    }, PROTOTYPE_SEND_BACK_CONFIRM_MS)
    // Never from inside a snapshot: the coordinator is still taking it.
    void Promise.resolve().then(() => this.options.sendBack(threadId, request, answer)).catch(() => false).then(taken => {
      cancelDeadline()
      if (this.records.get(threadId) !== record) return
      const entry = record.questions.get(request.id)
      if (!taken) {
        // The note did not go: the user answers the question as it is, marked link missing.
        record.sentBack.delete(request.id)
        if (entry?.state === 'sending') entry.state = 'link-missing'
        if (record.minute === minute) delete record.minute
      } else {
        if (entry?.state === 'sending') entry.state = 'sent-back'
        if (record.minute === minute) minute.cancel = this.timer(() => this.minuteEnded(threadId, minute), PROTOTYPE_SEND_BACK_WINDOW_MS)
      }
      this.options.changed()
    })
  }

  /**
   * No question came in the minute. Sotto shows its own copy of the original, marked link missing; a provider still
   * waiting on the original shows that instead, as it is the one the provider will take an answer to.
   */
  private minuteEnded(threadId: string, minute: Minute): void {
    const record = this.records.get(threadId)
    if (!record || record.minute !== minute) return
    delete record.minute
    const waiting = record.questions.get(minute.original.id)
    if (waiting) waiting.state = 'link-missing'
    else record.copy = copyOf(minute.original)
    this.options.changed()
  }

  /**
   * The provider has not said whether it took the note: the question shows, marked link missing, and stays shown whatever
   * it says later. The minute stays open, so a question the thread asks after a note that did go is not sent back again.
   */
  private unconfirmed(record: ThreadRecord, requestId: string): void {
    const entry = record.questions.get(requestId)
    if (entry?.state === 'sending') entry.state = 'link-missing'
    if (record.sentBack.has(requestId)) record.sentBack.set(requestId, 'link-missing')
  }

  private endMinute(record: ThreadRecord): void {
    record.minute?.cancel?.()
    delete record.minute
  }
}

const asked = (request: AgentRequest): boolean => request.kind === 'question' && !isSottoRequest(request.id)
