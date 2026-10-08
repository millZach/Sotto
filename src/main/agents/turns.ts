import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { AgentVoiceTiming } from '../../shared/agents'
import { SEND_STAGE_FIELDS, type SendStageClock, type SendStageField } from './sendStages'

/** A send's stage durations (`SendStageTimings`): absent from older records and from every turn that sent nothing. */
const stageMs = z.number().int().nonnegative().nullable().optional()
const sendStageShape = Object.fromEntries(SEND_STAGE_FIELDS.map(field => [field, stageMs])) as Record<SendStageField, typeof stageMs>

export const turnRecordSchema = z.object({
  id: z.string(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  source: z.enum(['utterance', 'command', 'supervision', 'wake-up']),
  commandType: z.string(),
  threadId: z.string().nullable(),
  providerSessionId: z.string().nullable(),
  projectId: z.string().nullable(),
  timings: z.object({
    speechEndedAt: z.string().datetime().nullable(),
    voicePhase: z.enum(['cold', 'warm']).nullable().default(null),
    speechEndBasis: z.literal('detector-frame-received').nullable().default(null),
    feedbackBasis: z.literal('main-state-published').nullable().default(null),
    retrievalCount: z.number().int().nonnegative().default(0),
    speechToIntentMs: z.number().int().nonnegative().nullable().default(null),
    speechToFirstFeedbackMs: z.number().int().nonnegative().nullable().default(null),
    intentMs: z.number().int().nonnegative(),
    retrievalMs: z.number().int().nonnegative(),
    delegationMs: z.number().int().nonnegative(),
    totalMs: z.number().int().nonnegative(),
  }).extend(sendStageShape),
  retrievedMemoryIds: z.array(z.string()),
  contextTokenEstimate: z.number().int().nonnegative(),
  outcome: z.enum(['completed', 'clarified', 'failed']),
  failureCode: z.enum(['action-failed', 'reasoning-failed', 'provider-failed', 'storage-failed', 'unknown']).nullable().default(null),
})
export type TurnRecord = z.infer<typeof turnRecordSchema>

export interface ActiveTurn {
  source: TurnRecord['source']
  commandType: string
  startedAt: string
  startedAtMs: number
  speechEndedAt: string | null
  voiceTiming?: AgentVoiceTiming
  intentResolvedAtMs?: number
  firstFeedbackAtMs?: number
  retrievalCount: number
  intentMs: number
  retrievalMs: number
  retrievedMemoryIds: string[]
  delegationMs: number
  /** When the coordinator received the command this turn carries out (`performance.now()`): where a send's admission starts. */
  receivedAt?: number
  /** A send's stopwatch, from Send to the reply's first output. Only turns that send a prompt carry one. */
  stages?: SendStageClock
  contextTokenEstimate: number
  contextCharacters: number
  threadId: string | null | undefined
  projectId: string | null | undefined
  text: string
  clarified: boolean
  failureCode?: NonNullable<TurnRecord['failureCode']>
}

/** A local estimate: one token per four characters across all turn context. */
export function addTurnContext(turn: ActiveTurn | undefined, text: string): void {
  if (!turn) return
  turn.contextCharacters += text.length
  turn.contextTokenEstimate = Math.ceil(turn.contextCharacters / 4)
}

/** Clock reversal or a missing milestone is missing evidence, never a zero-ms pass. */
function speechElapsed(speechEndedAt: string | null, milestone: number | undefined): number | null {
  if (speechEndedAt === null || milestone === undefined) return null
  const elapsed = milestone - Date.parse(speechEndedAt)
  return Number.isFinite(elapsed) && elapsed >= 0 ? Math.round(elapsed) : null
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

/** Append-only coordinator turn log. Writes never throw into the command path. */
export class TurnRecorder {
  private scrubbed = false
  private lane: Promise<void> = Promise.resolve()
  /** Records of sends waiting for their first output (`finish`). */
  private readonly pending = new Set<Promise<void>>()
  private readonly directory: string
  private readonly resolveSession: (threadId: string) => { provider: string; sessionId: string } | undefined
  private readonly maxBytes: number
  private readonly maxLines: number

  constructor(options: {
    directory: string
    resolveSession: (threadId: string) => { provider: string; sessionId: string } | undefined
    maxBytes?: number
    maxLines?: number
  }) {
    this.directory = options.directory
    this.resolveSession = options.resolveSession
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024
    this.maxLines = options.maxLines ?? 1000
  }

  path(): string {
    return join(this.directory, 'turns.jsonl')
  }

  begin(input: {
    source: TurnRecord['source']
    commandType: string
    text: string
    threadId?: string | null
    projectId?: string | null
    voiceTiming?: AgentVoiceTiming
    speechEndedAt?: string | null
  }): ActiveTurn | undefined {
    try {
      const startedAtMs = Date.now()
      return {
        source: input.source,
        commandType: input.commandType,
        startedAt: new Date(startedAtMs).toISOString(),
        startedAtMs,
        speechEndedAt: input.voiceTiming?.speechEndedAt ?? input.speechEndedAt ?? null,
        ...(input.voiceTiming ? { voiceTiming: input.voiceTiming } : {}),
        retrievalCount: 0,
        intentMs: 0,
        retrievalMs: 0,
        retrievedMemoryIds: [],
        delegationMs: 0,
        contextTokenEstimate: 0,
        contextCharacters: 0,
        threadId: input.threadId,
        projectId: input.projectId,
        text: input.text,
        clarified: false,
      }
    } catch {
      // Clock or instrumentation failures must not prevent coordinator work.
      return undefined
    }
  }

  /**
   * Record the turn. Most records are written before this resolves. A send whose client confirmed the prompt waits
   * for the reply's first output, or for watching it to stop (`SendStageClock.untilFirstOutput`), and is written
   * then; this resolves at once and `drain` waits for it. Either way the finish time and `totalMs` are now.
   */
  async finish(turn: ActiveTurn | undefined, outcome: TurnRecord['outcome']): Promise<void> {
    if (!turn) return
    try {
      const finishedAtMs = Date.now()
      const stages = turn.stages
      if (stages && outcome !== 'failed' && stages.awaitsFirstOutput()) {
        // The record holds no text; the prompt need not stay in memory while it waits for the first output.
        turn.text = ''
        const pending: Promise<void> = stages.untilFirstOutput().then(() => this.write(turn, outcome, finishedAtMs))
          .catch(() => undefined).finally(() => { this.pending.delete(pending) })
        this.pending.add(pending)
        return
      }
      stages?.close()
      await this.write(turn, outcome, finishedAtMs)
    } catch {
      // Recording must never throw into the command path.
    }
  }

  /** Wait for the records of sends still waiting for their first output. */
  async drain(): Promise<void> { await Promise.allSettled([...this.pending]) }

  private async write(turn: ActiveTurn, outcome: TurnRecord['outcome'], finishedAtMs: number): Promise<void> {
    const threadId = turn.threadId ?? null
    const record: TurnRecord = {
      id: randomUUID(),
      startedAt: turn.startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      source: turn.source,
      commandType: turn.commandType,
      threadId,
      providerSessionId: (threadId ? this.resolveSession(threadId)?.sessionId : undefined) ?? null,
      projectId: turn.projectId ?? null,
      timings: {
        speechEndedAt: turn.speechEndedAt,
        voicePhase: turn.voiceTiming?.phase ?? null,
        speechEndBasis: turn.voiceTiming?.basis ?? null,
        feedbackBasis: turn.firstFeedbackAtMs === undefined ? null : 'main-state-published',
        retrievalCount: turn.retrievalCount,
        speechToIntentMs: speechElapsed(turn.speechEndedAt, turn.intentResolvedAtMs),
        speechToFirstFeedbackMs: speechElapsed(turn.speechEndedAt, turn.firstFeedbackAtMs),
        intentMs: turn.intentMs,
        retrievalMs: turn.retrievalMs,
        delegationMs: turn.delegationMs,
        totalMs: Math.max(1, finishedAtMs - turn.startedAtMs),
        // Only a turn whose prompt reached its host has send stages; one refused before then carries none.
        ...(turn.stages?.has('dispatched') ? turn.stages.durations() : {}),
      },
      retrievedMemoryIds: turn.retrievedMemoryIds,
      contextTokenEstimate: turn.contextTokenEstimate,
      outcome,
      failureCode: outcome === 'failed' ? turn.failureCode ?? 'action-failed' : null,
    }
    await this.enqueue(async () => {
      await this.scrub()
      await mkdir(this.directory, { recursive: true })
      const filePath = this.path()
      await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8')
      if ((await stat(filePath)).size > this.maxBytes) {
        const lines = (await readFile(filePath, 'utf8')).split(/\r?\n/u).filter(line => line.length > 0)
        // Keep the newest lines, then drop the oldest until the file sits at half the cap,
        // so the next append does not trigger another full rewrite.
        const newest = lines.slice(-this.maxLines)
        let bytes = newest.reduce((total, line) => total + Buffer.byteLength(line, 'utf8') + 1, 0)
        while (newest.length > 1 && bytes > this.maxBytes / 2) bytes -= Buffer.byteLength(newest.shift()!, 'utf8') + 1
        await this.replace(newest.length > 0 ? `${newest.join('\n')}\n` : '')
      }
    })
  }

  /** Remove legacy content before the recorder is used, even when no new turn finishes. */
  async initialize(): Promise<void> {
    await this.enqueue(() => this.scrub())
  }

  private async retryLocked<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try { return await operation() } catch (error) {
        if (attempt >= 3 || (!hasErrorCode(error, 'EPERM') && !hasErrorCode(error, 'EBUSY'))) throw error
        await delay(50)
      }
    }
  }

  private async scrub(): Promise<void> {
    if (this.scrubbed) return
    try {
      let contents: string
      try { contents = await this.retryLocked(() => readFile(this.path(), 'utf8')) } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) throw error
        this.scrubbed = true
        return
      }
      const lines: string[] = []
      for (const line of contents.split(/\r?\n/u)) {
        if (!line) continue
        try {
          const record = turnRecordSchema.safeParse(JSON.parse(line))
          if (record.success) {
            if (record.data.outcome === 'failed' && record.data.failureCode === null) record.data.failureCode = 'unknown'
            lines.push(JSON.stringify(record.data))
          }
        } catch { /* Discard corrupt legacy lines rather than retaining unknown content. */ }
      }
      const cleaned = lines.length ? `${lines.join('\n')}\n` : ''
      if (cleaned !== contents) await this.retryLocked(() => this.replace(cleaned))
    } catch {
      try { await rm(this.path(), { force: true }) } catch {
        throw new Error('Sotto could not remove text from old turn records or delete the file. Close other apps using turns.jsonl, then restart Sotto. Diagnostic records may be lost.')
      }
    }
    this.scrubbed = true
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const pending = this.lane.then(operation)
    this.lane = pending.catch(() => {})
    return pending
  }

  private async replace(contents: string): Promise<void> {
    const temporary = `${this.path()}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, contents, 'utf8')
      await rename(temporary, this.path())
    } finally {
      await rm(temporary, { force: true })
    }
  }

  async recent(limit: number): Promise<TurnRecord[]> {
    await this.initialize()
    let contents: string
    try {
      contents = await readFile(this.path(), 'utf8')
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return []
      throw error
    }
    const records: TurnRecord[] = []
    for (const line of contents.split(/\r?\n/u)) {
      if (!line) continue
      try {
        const parsed = turnRecordSchema.safeParse(JSON.parse(line))
        if (parsed.success) records.push(parsed.data)
      } catch {
        // Skip a corrupt line so one bad record cannot hide the rest.
      }
    }
    return records.reverse().slice(0, limit)
  }
}
