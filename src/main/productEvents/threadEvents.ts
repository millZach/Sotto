import type { AgentThread } from '../../shared/agents'
import type { UsageTokens } from '../../shared/threadUsage'
import { publicModelId } from '../agents/usageRates'
import { PRODUCT_EVENT_EFFORTS, type ProductEventName, type ProductEventProperties } from './schema'

type StartedBy = ProductEventProperties<'thread.started'>['startedBy']
type Speed = NonNullable<ProductEventProperties<'turn.completed'>['speed']>
export interface ProductEventRecorder {
  record<E extends ProductEventName>(event: E, properties: ProductEventProperties<E>): void
  featureUsed(feature: ProductEventProperties<'feature.used'>['feature']): void
}

interface TurnSeen {
  /** When its start was seen. Absent for a turn already running when Sotto started, whose length is unknown: it is not counted. */
  readonly at: number | undefined
  /** The thread's token totals as the turn began, read again at its end for what the turn spent. */
  readonly tokens: UsageTokens | undefined
  /** The thread's first turn, which begins from nothing rather than from totals not read yet. */
  readonly first: boolean
}

const EFFORTS: ReadonlySet<string> = new Set(PRODUCT_EVENT_EFFORTS)

/**
 * Turns the thread changes the coordinator is handed into `thread.started` and `turn.completed` (ADR-0179). It runs on the
 * update path, so each thread a change names costs a few look-ups, and the event itself goes on a later tick, since who
 * started a thread can look further than an update may. It reads one thread's own record and nothing of what the thread
 * says, and each event is checked against its schema on the way out.
 *
 * A thread counts when one Sotto made begins its first turn, so a draft nobody sent is not counted and a session found in
 * a provider's history is not either. A turn counts when Sotto saw it start and end, so reading history back sends nothing.
 * It errs toward counting too few: a turn whose outcome is lost, as a reconnect can lose it, is not counted, and neither is
 * one that starts and ends inside one publication, or a fork's first turn after a restart before it was sent. Two rare
 * cases read wrong the other way. A turn replaced while running counts as one with its replacement, since that is what a
 * steer does on Claude, so Muse recovering a lost turn gives the new one the old one's start. And Grok's history can read
 * back an old turn as running if it shrinks and a poll stops between that turn's pages, which counts it again.
 */
export class ThreadProductEvents {
  private readonly drafts = new Set<string>()
  private readonly startedAwaitingTurn = new Set<string>()
  private readonly turns = new Map<string, TurnSeen>()
  private baselined = false

  constructor(private readonly options: {
    readonly recorder: ProductEventRecorder
    /** Asked on a later tick, never during an update, so it may look further than an update could afford. */
    startedBy(thread: AgentThread): StartedBy
    now?(): number
    /** Runs work after this update. A later tick, unless a test says otherwise. */
    later?(work: () => void): void
  }) {}

  /** The threads one update named, and those it removed. */
  track(threads: Iterable<AgentThread>, gone: Iterable<string>): void {
    for (const id of gone) this.forget(id)
    for (const thread of threads) this.read(thread)
  }

  /** Every thread the coordinator holds, on a whole snapshot. The first of them is what was already so when Sotto started. */
  trackAll(threads: readonly AgentThread[]): void {
    if (this.drafts.size > 0 || this.startedAwaitingTurn.size > 0 || this.turns.size > 0) {
      const listed = new Set(threads.map(thread => thread.id))
      for (const held of [this.drafts, this.startedAwaitingTurn, this.turns]) for (const id of held.keys()) if (!listed.has(id)) this.forget(id)
    }
    for (const thread of threads) this.read(thread)
    this.baselined = true
  }

  private forget(id: string): void {
    this.drafts.delete(id); this.startedAwaitingTurn.delete(id); this.turns.delete(id)
  }

  private read(thread: AgentThread): void {
    const { id } = thread
    if (thread.nativeSessionStarted === false) this.drafts.add(id)
    else if (this.drafts.delete(id)) this.startedAwaitingTurn.add(id)
    const seen = this.turns.get(id)
    if (seen === undefined) {
      if (thread.lastTurn?.status !== 'running') return
      const first = this.startedAwaitingTurn.delete(id)
      // Sent here rather than as the draft stops being one, since its record is whole only once its provider has it.
      if (first) this.send(thread, run => ['thread.started', { ...run, inWorktree: thread.worktree?.mode === 'independent' }])
      this.turns.set(id, { at: this.baselined ? this.now() : undefined, tokens: thread.usage?.total, first })
      if (this.baselined) this.sayFeature(thread)
      return
    }
    // The turn's own status, not the thread's: a steer carried past a turn's end keeps the thread running into the next one.
    if (thread.lastTurn?.status === 'running') return
    this.turns.delete(id)
    // No turn left on the record means its outcome is unknown, and a success is not assumed.
    if (seen.at !== undefined && thread.lastTurn) { const at = seen.at; this.send(thread, run => ['turn.completed', { ...run, ...turnEnd(thread, seen, this.now() - at) }]) }
  }

  /** A turn on a thread Watcher, a delegation, the Council or a swarm started is that feature in use. */
  private sayFeature(thread: AgentThread): void {
    this.afterUpdate(() => {
      const startedBy = this.options.startedBy(thread)
      if (startedBy !== 'user' && startedBy !== 'other') this.options.recorder.featureUsed(startedBy)
    })
  }

  private now(): number { return this.options.now ? this.options.now() : Date.now() }

  /** Nothing here may stop an update, whatever it runs into, now or on the later tick. */
  private afterUpdate(work: () => void): void {
    const guarded = (): void => { try { work() } catch { /* A product event never changes what the thread does. */ } }
    if (this.options.later) this.options.later(guarded); else setImmediate(guarded)
  }

  /** What the event says is read now, from this update's record. Who started the thread is asked after it. */
  private send(thread: AgentThread, event: (run: ThreadRun) => ThreadEvent): void {
    if (thread.providerId === undefined) return
    try {
      const sent = event(threadRun(thread, thread.providerId))
      this.afterUpdate(() => {
        const startedBy = this.options.startedBy(thread)
        if (sent[0] === 'thread.started') this.options.recorder.record(sent[0], { ...sent[1], startedBy }); else this.options.recorder.record(sent[0], { ...sent[1], startedBy })
      })
    } catch { /* A product event never changes what the thread does. */ }
  }
}

type ThreadRun = ReturnType<typeof threadRun>
type ThreadEvent = readonly ['thread.started', Omit<ProductEventProperties<'thread.started'>, 'startedBy'>] | readonly ['turn.completed', Omit<ProductEventProperties<'turn.completed'>, 'startedBy'>]

function threadRun(thread: AgentThread, provider: NonNullable<AgentThread['providerId']>) {
  const model = publicModelId(provider, thread.modelId)
  const effort = thread.reasoningEffort
  return {
    provider,
    ...(model === undefined ? {} : { model }),
    ...(effort !== undefined && EFFORTS.has(effort) ? { effort: effort as (typeof PRODUCT_EVENT_EFFORTS)[number] } : {}),
    ...(thread.runtimeMode === undefined ? {} : { permissionMode: thread.runtimeMode }),
  }
}

function turnEnd(thread: AgentThread, seen: TurnSeen, durationMs: number) {
  const speed: Speed = thread.speed ?? (thread.fastMode ? 'fast' : 'standard')
  const status = thread.lastTurn?.status
  const result = status === 'failed' || thread.status === 'error' ? 'failed' as const : status === 'interrupted' ? 'stopped' as const : 'completed' as const
  // A later thread's totals with no start to take them from would count all of its past as this one turn.
  const tokens = seen.tokens !== undefined || seen.first ? thread.usage?.total : undefined
  const spent = (key: keyof UsageTokens): number | undefined => {
    const end = tokens?.[key]
    if (end === undefined) return undefined
    const amount = end - (seen.tokens?.[key] ?? 0)
    return amount >= 0 ? amount : undefined
  }
  const inputTokens = spent('input'), cachedInputTokens = spent('cached'), outputTokens = spent('output')
  return {
    speed, result, durationMs: Math.max(0, Math.round(durationMs)),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  }
}
