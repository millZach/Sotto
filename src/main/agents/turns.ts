import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

export const turnRecordSchema = z.object({
  id: z.string(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  source: z.enum(['utterance', 'command', 'supervision']),
  commandType: z.string(),
  threadId: z.string().nullable(),
  providerSessionId: z.string().nullable(),
  projectId: z.string().nullable(),
  timings: z.object({
    speechEndedAt: z.string().datetime().nullable(),
    speechToIntentMs: z.number().int().nonnegative().nullable().default(null),
    speechToFirstFeedbackMs: z.number().int().nonnegative().nullable().default(null),
    intentMs: z.number().int().nonnegative(),
    retrievalMs: z.number().int().nonnegative(),
    delegationMs: z.number().int().nonnegative(),
    totalMs: z.number().int().nonnegative(),
  }),
  retrievedMemoryIds: z.array(z.string()),
  contextTokenEstimate: z.number().int().nonnegative(),
  outcome: z.enum(['completed', 'clarified', 'failed']),
  text: z.string(),
  error: z.string(),
})
export type TurnRecord = z.infer<typeof turnRecordSchema>

export interface ActiveTurn {
  source: TurnRecord['source']
  commandType: string
  startedAt: string
  startedAtMs: number
  speechEndedAt: string | null
  intentMs: number
  retrievalMs: number
  delegationMs: number
  contextTokenEstimate: number
  contextCharacters: number
  threadId: string | null | undefined
  projectId: string | null | undefined
  text: string
  clarified: boolean
}

/** A local estimate: one token per four characters across all turn context. */
export function addTurnContext(turn: ActiveTurn | undefined, text: string): void {
  if (!turn) return
  turn.contextCharacters += text.length
  turn.contextTokenEstimate = Math.ceil(turn.contextCharacters / 4)
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

/** Append-only coordinator turn log. Writes never throw into the command path. */
export class TurnRecorder {
  private readonly directory: string
  private readonly historyEnabled: () => boolean
  private readonly resolveSession: (threadId: string) => { provider: string; sessionId: string } | undefined
  private readonly maxBytes: number
  private readonly maxLines: number

  constructor(options: {
    directory: string
    historyEnabled: () => boolean
    resolveSession: (threadId: string) => { provider: string; sessionId: string } | undefined
    maxBytes?: number
    maxLines?: number
  }) {
    this.directory = options.directory
    this.historyEnabled = options.historyEnabled
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
    speechEndedAt?: string | null
  }): ActiveTurn | undefined {
    try {
      const startedAtMs = Date.now()
      return {
        source: input.source,
        commandType: input.commandType,
        startedAt: new Date(startedAtMs).toISOString(),
        startedAtMs,
        speechEndedAt: input.speechEndedAt ?? null,
        intentMs: 0,
        retrievalMs: 0,
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

  async finish(turn: ActiveTurn | undefined, outcome: TurnRecord['outcome'], error?: string): Promise<void> {
    if (!turn) return
    try {
      const finishedAtMs = Date.now()
      const retain = this.historyEnabled()
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
          // The voice pipeline currently supplies text without a speech-end timestamp.
          speechToIntentMs: null,
          speechToFirstFeedbackMs: null,
          intentMs: turn.intentMs,
          retrievalMs: turn.retrievalMs,
          delegationMs: turn.delegationMs,
          totalMs: Math.max(1, finishedAtMs - turn.startedAtMs),
        },
        retrievedMemoryIds: [],
        contextTokenEstimate: turn.contextTokenEstimate,
        outcome,
        text: retain ? turn.text : '',
        error: retain ? error ?? '' : '',
      }
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
        await writeFile(filePath, newest.length > 0 ? `${newest.join('\n')}\n` : '', 'utf8')
      }
    } catch {
      // Recording must never throw into the command path.
    }
  }

  async recent(limit: number): Promise<TurnRecord[]> {
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
