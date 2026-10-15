import { join } from 'node:path'
import { z } from 'zod'
import { isThreadProviderConnected, type AgentState, type AgentThread } from '../../shared/agents'
import { isResumeNoteText, RESUMES_IN_A_ROW_MAX, type RestartNews } from '../../shared/restartResume'
import { isThreadClosed, isThreadTurnRunning, isWorkspaceThreadSettled } from '../../shared/threadActivity'
import { AtomicJsonStore } from '../storage/atomicJsonStore'

/** A record older than this is cleared unsent when Sotto starts (ADR-0076 decision 4). */
export const RESUME_RECORD_MAX_AGE_MS = 7 * 24 * 60 * 60_000
const WORKING_MAX = 500

const workingSchema = z.object({
  threadId: z.string().min(1).max(512),
  /** When the turn started, or when the turn it resumes did. */
  since: z.iso.datetime(),
  /** How many times in a row the thread has been resumed: 0 for a turn of the user's or the agent's own. */
  resumes: z.number().int().min(0).max(RESUMES_IN_A_ROW_MAX),
  /** Its resume note is saved in the thread's follow-up queue, which sends it; it is not handed over again. */
  queued: z.literal(true).optional(),
}).strict()
const fileSchema = z.object({ version: z.literal(1), working: z.array(workingSchema).max(WORKING_MAX) }).strict()
type Working = z.infer<typeof workingSchema>
type ResumeFile = z.infer<typeof fileSchema>
const EMPTY: ResumeFile = { version: 1, working: [] }

export interface RestartResumeOptions {
  readonly directory: string
  /** The coordinator: read for its threads, and handed each resume note as a wake-up. */
  readonly control: {
    get(): AgentState
    subscribe(listener: (state: AgentState) => void): () => void
    deliverWakeUp(threadId: string, news: RestartNews, options: { readonly tool: boolean }): Promise<void>
  }
  /** The setting, asked once at start: off, the record is cleared and nothing is sent. */
  readonly enabled: () => boolean
  /** Whether the thread has Sotto's pull request tools, for babysitting news a note may be folded with. */
  readonly tool: (threadId: string) => boolean
  /** A gated thread keeps its saved record unchanged until the owning feature is available again. */
  readonly preservesDormantThread?: (threadId: string) => boolean
  readonly now?: () => number
}

/**
 * Resuming threads after a restart (ADR-0076). While Sotto runs it records, in `restart-resume.json`, each thread a
 * connected provider reports running, and drops it when that turn ends however it ends. The record stops changing as
 * soon as Sotto starts closing, so what closing stops is still there at the next start, as it is after a crash. Then each
 * recorded thread is handed the resume note as a wake-up once its provider is back and reports it not running, at most
 * three times in a row. It keeps thread IDs and times only.
 */
export class RestartResume {
  private readonly store: AtomicJsonStore<ResumeFile>
  private readonly working = new Map<string, Working>()
  /** Threads the last close stopped, waiting for their provider to be back before the note goes. */
  private readonly pending = new Set<string>()
  private readonly delivering = new Set<string>()
  /** Hand-overs under way, which closing waits for, so a note saved in the queue is recorded as queued. */
  private readonly handing = new Set<Promise<void>>()
  /** Threads whose resume note the coordinator is sending, with the resumes the turn it starts counts. */
  private readonly sending = new Map<string, number>()
  private readonly now: () => number
  private off: (() => void) | undefined
  private frozen = false
  private saved = JSON.stringify(EMPTY.working)
  private writing: Promise<void> | undefined

  constructor(private readonly options: RestartResumeOptions) {
    this.now = options.now ?? Date.now
    this.store = new AtomicJsonStore(join(options.directory, 'restart-resume.json'), input => fileSchema.parse(input), () => ({ ...EMPTY, working: [] }))
  }

  /** Reads what the last close stopped, then follows the coordinator. Called before the coordinator starts. */
  async start(): Promise<void> {
    const file = await this.store.read().catch(() => EMPTY)
    this.saved = JSON.stringify(file.working)
    const resume = this.options.enabled()
    const oldest = this.now() - RESUME_RECORD_MAX_AGE_MS
    for (const item of file.working) {
      // A hidden provider is parked, not stopped, expired or deleted by this build.
      if (this.dormant(item.threadId)) { this.working.set(item.threadId, item); continue }
      if (!resume || !(Date.parse(item.since) >= oldest)) continue
      if (item.queued) { this.working.set(item.threadId, item); continue }
      // A fourth stop in a row leaves the thread for the user.
      if (item.resumes >= RESUMES_IN_A_ROW_MAX) continue
      this.working.set(item.threadId, item)
      this.pending.add(item.threadId)
    }
    this.save()
    this.off = this.options.control.subscribe(state => this.observe(state))
    this.observe(this.options.control.get())
  }

  /**
   * Sotto is closing: the record keeps what is working now, and nothing closing does to a thread changes it. A hand-over
   * already under way finishes first, and the record is written once more, so the file is what this run last knew.
   */
  async freeze(): Promise<void> {
    this.frozen = true
    this.off?.()
    this.off = undefined
    await Promise.allSettled([...this.handing])
    this.save()
    await this.writing
  }

  /** The coordinator is sending this thread's resume note now: the turn that starts next is the resumed one. */
  noteSending(threadId: string): void {
    if (this.dormant(threadId)) return
    const record = this.working.get(threadId)
    if (!this.frozen && record?.queued) this.sending.set(threadId, record.resumes)
  }
  /** The note did not go after all; the next turn is not its own. */
  noteUnsent(threadId: string): void { if (!this.dormant(threadId)) this.sending.delete(threadId) }

  private dormant(threadId: string): boolean { return this.options.preservesDormantThread?.(threadId) === true }

  private observe(state: AgentState): void {
    if (this.frozen) return
    const host = state.host
    let changed = false
    // A thread gone from a connected host was deleted: nothing will ever resume it.
    if (host.connected) {
      const listed = new Set(host.threads.map(thread => thread.id))
      for (const id of [...this.working.keys()]) {
        if (this.dormant(id) || listed.has(id) || this.delivering.has(id)) continue
        this.working.delete(id); this.pending.delete(id); this.sending.delete(id); changed = true
      }
    }
    for (const thread of host.threads) {
      if (this.dormant(thread.id)) continue
      const connected = host.connected && isThreadProviderConnected(host, thread)
      const running = connected && isThreadTurnRunning(thread)
      const record = this.working.get(thread.id)
      if (this.pending.has(thread.id)) {
        if (!connected) continue
        // The provider carried the turn on by itself, or a turn of the user's went first: it is the record's turn now.
        if (running) { this.pending.delete(thread.id); this.working.set(thread.id, this.started(thread.id, record?.resumes ?? 0)); changed = true }
        else this.deliver(thread, state)
        continue
      }
      if (running) {
        // The turn the resume note started counts the resumes before it; any other, the user's own, starts again from none.
        if (!record || record.queued) {
          this.working.set(thread.id, this.started(thread.id, this.sending.get(thread.id) ?? 0)); this.sending.delete(thread.id); changed = true
        }
      } else if (record && !record.queued && !this.delivering.has(thread.id)) { this.working.delete(thread.id); changed = true }
      // A queued note that left the queue without going, taken out or dropped with the setting, leaves nothing to resume.
      else if (record?.queued && connected && !this.sending.has(thread.id) && !this.delivering.has(thread.id) && !(state.followups ?? []).some(item =>
        item.threadId === thread.id && item.wakeUp === true && isResumeNoteText(item.text))) { this.working.delete(thread.id); changed = true }
    }
    if (changed) this.save()
  }

  private started(threadId: string, resumes: number): Working {
    return { threadId, since: new Date(this.now()).toISOString(), resumes }
  }

  /** Hands the thread its resume note, unless it was settled or archived while Sotto was closed. */
  private deliver(thread: AgentThread, state: AgentState): void {
    if (this.dormant(thread.id) || this.delivering.has(thread.id)) return
    const record = this.working.get(thread.id)
    const project = state.host.projects.find(item => item.id === thread.projectId)
    if (!record || isThreadClosed(thread) || isWorkspaceThreadSettled(thread, project)) {
      this.pending.delete(thread.id); this.working.delete(thread.id); this.save()
      return
    }
    const news: RestartNews = { source: 'restart', since: record.since, resumes: record.resumes + 1 }
    this.delivering.add(thread.id)
    const handing: Promise<void> = this.options.control.deliverWakeUp(thread.id, news, { tool: this.options.tool(thread.id) }).then(
      () => { if (!this.dormant(thread.id)) this.working.set(thread.id, { threadId: thread.id, since: record.since, resumes: news.resumes, queued: true }) },
      // Nothing was queued. A thread that went is dropped; one Sotto closed on is kept for the next start. A thread the
      // read before the note found working carried the turn on by itself, and its record keeps the count.
      () => {
        if (this.frozen || this.dormant(thread.id) || this.working.get(thread.id) !== record) return
        const current = this.options.control.get().host.threads.find(item => item.id === thread.id)
        if (current && isThreadTurnRunning(current)) this.working.set(thread.id, this.started(thread.id, record.resumes))
        else this.working.delete(thread.id)
      },
    ).finally(() => { this.pending.delete(thread.id); this.delivering.delete(thread.id); this.handing.delete(handing); this.save() })
    this.handing.add(handing)
  }

  /** Dormant records keep their places in the bound; this build's newest ordinary records fill what remains. */
  private savedWorking(): Working[] {
    const working = [...this.working.values()]
    const dormant = new Set(working.filter(item => this.dormant(item.threadId)))
    const room = WORKING_MAX - dormant.size
    const ordinary = room > 0 ? working.filter(item => !dormant.has(item)).slice(-room) : []
    const kept = new Set([...dormant, ...ordinary])
    return working.filter(item => kept.has(item))
  }

  private save(): void {
    const working = this.savedWorking()
    const next = JSON.stringify(working)
    if (next === this.saved) return
    this.saved = next
    // A write that fails is tried again at the next change, and at the latest when Sotto closes.
    this.writing = this.store.writeLatest(() => ({ version: 1, working: this.savedWorking() })).catch(() => { this.saved = '' })
  }
}
