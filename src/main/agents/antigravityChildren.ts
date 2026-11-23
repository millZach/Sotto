import { lstat, open, readdir, readFile, realpath } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { z } from 'zod'
import { MAX_ACTIVITY_TEXT, MAX_SUBAGENT_STEPS, mergeSubagentSteps, type SubagentStep, type SubagentStepKind, type SubagentStepStatus } from '../../shared/agentActivity'
import { buildSubagentStep, humanizeStepTool, shortStepCommand, shortStepPath, stepLine, validIso } from './subagentSteps'

/**
 * What a child agent `agy` launched is doing (parity slice 7 + live child steps), read from its records in Sotto's own
 * Antigravity folder as T3 Code reads them. `agy` 1.5 runs a child detached: its `invoke_subagent` call ends at once and
 * the child works on in a conversation of its own. Read live on 1.5.14 (November 21–22, 2026):
 *
 * - `brain/<parent>/.system_generated/subagents/<child>.json` names each child the parent launched, with its `state`.
 * - The child's own inbox, `brain/<child>/.system_generated/messages/<id>.json`, opens with the parent's launch, whose
 *   `sourceMetadata.tool.toolCall.id` is the parent's `invoke_subagent` tool call: the ID Sotto's row is keyed by.
 * - The child's own transcript, `brain/<child>/.system_generated/logs/transcript.jsonl`, appends each `PLANNER_RESPONSE`
 *   (with `model`, `thinking`, and `tool_calls`) and each tool result (`GENERIC`, `status`, `error`, `created_at`) live.
 * - The child answers into the parent's inbox, `brain/<parent>/.system_generated/messages/<id>.json`, `sender` the
 *   child: its `content` is the child's result.
 *
 * A child is done once its answer is in the parent's inbox, and was stopped when its record says it was killed. Only
 * these records are read: plain files, each bounded, in folders whose real path is inside `brain`, so a link never
 * leads a read anywhere else, `agy`'s sign-in among them (ADR-0212's amendment). Nothing is ever written. Every file a
 * pass reads is taken from one budget the pass shares across all its watches, and what a pass did not reach is read in
 * the next, so no pass reads more than its budget however many children and messages there are.
 */

/** Files one pass reads across all its watches, when the caller gives no budget of its own. */
export const CHILD_PASS_FILES = 200
/** A record or message larger than this is not read. */
const MOST_BYTES = 256 * 1024
/** Bytes read from one child transcript per pass. */
const TRANSCRIPT_POLL_BYTES = 256 * 1024
/** A single transcript line longer than this is skipped unread. */
const TRANSCRIPT_LINE_BYTES = 1024 * 1024
/** Maximum total bytes read from one child transcript across all passes. */
const TRANSCRIPT_MAX_BYTES = 32 * 1024 * 1024
const NEWLINE = 0x0a

const conversationId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/u)
const childRecordSchema = z.object({ conversationId, state: z.string().max(64).optional() }).passthrough()
const messageSchema = z.object({
  sender: z.string().max(64), content: z.string().optional(), timestamp: z.string().max(64).optional(),
  sourceMetadata: z.object({ tool: z.object({ toolCall: z.object({ id: z.string().max(512) }).passthrough() }).passthrough() }).passthrough().optional(),
}).passthrough()
const transcriptToolCallSchema = z.object({
  name: z.string().min(1).max(200),
  args: z.record(z.string(), z.unknown()).optional(),
}).passthrough()
const transcriptLineSchema = z.object({
  step_index: z.number().int().nonnegative().optional(),
  type: z.string().max(64).optional(),
  status: z.string().max(64).optional(),
  created_at: z.string().max(64).optional(),
  model: z.string().max(256).optional(),
  thinking: z.string().optional(),
  error: z.string().optional(),
  tool_calls: z.array(transcriptToolCallSchema).max(64).optional(),
}).passthrough()
type Message = z.infer<typeof messageSchema>
type TranscriptLine = z.infer<typeof transcriptLineSchema>
type TranscriptToolCall = z.infer<typeof transcriptToolCallSchema>

/** What Sotto knows of a child: the conversation it runs in, whether it is done, its live steps, and its answer. */
export interface AntigravityChild {
  readonly conversationId: string
  readonly status: 'running' | 'completed' | 'interrupted' | 'unknown'
  readonly message?: string
  readonly completedAt?: string
  readonly model?: string
  readonly steps?: readonly SubagentStep[]
  readonly stepsTotal?: number
}

interface TranscriptFileIdentity {
  readonly dev: bigint
  readonly ino: bigint
  readonly birthtimeNs: bigint
}

/** Incremental bounded cursor over `brain/<child>/.system_generated/logs/transcript.jsonl`. */
export interface AntigravityChildTranscriptState {
  offset: number
  identity?: TranscriptFileIdentity | undefined
  partial: Buffer[]
  partialBytes: number
  skipping: boolean
  done: boolean
  steps: SubagentStep[]
  stepsTotal: number
  pendingToolIds: string[]
  stepIdByIndex: Map<number, string>
  seenLines: number
  model?: string | undefined
}

const blankTranscriptState = (): AntigravityChildTranscriptState => ({
  offset: 0, partial: [], partialBytes: 0, skipping: false, done: false,
  steps: [], stepsTotal: 0, pendingToolIds: [], stepIdByIndex: new Map(), seenLines: 0,
})

/**
 * What one watch has learned so far, so each read does only new work: the child's conversation once found, the
 * children ruled out because their launch named another call, where the search for the child goes on from, the
 * parent's inbox files already read whole, and the incremental cursor for the child's live transcript.
 */
export interface AntigravityChildReading {
  childConversation?: string
  readonly ruledOut: Set<string>
  readonly readAnswers: Set<string>
  resumeAt?: string | undefined
  transcript?: AntigravityChildTranscriptState | undefined
}
export const antigravityChildReading = (): AntigravityChildReading => ({ ruledOut: new Set(), readAnswers: new Set() })
/** The files a pass may still read, shared by every watch the pass reads. */
export interface AntigravityReadBudget { left: number }

const generated = (appData: string, conversation: string, ...rest: string[]) => join(appData, 'brain', conversation, '.system_generated', ...rest)

const isWithin = (parent: string, child: string): boolean => {
  const within = relative(parent, child)
  return Boolean(within) && !within.startsWith('..') && !isAbsolute(within)
}

/** The `.json` files in a folder inside `brain`, by name in order, or none when its real path leads elsewhere. */
async function jsonNames(brain: string, directory: string): Promise<string[]> {
  try {
    const real = await realpath(directory)
    if (!isWithin(brain, real)) return []
    return (await readdir(real)).filter(name => name.endsWith('.json')).sort()
  } catch { return [] }
}

/** One file read from the budget: undefined when the budget is spent, or the file is not a plain, readable, valid one. */
async function readJson<T>(path: string, schema: z.ZodType<T>, budget: AntigravityReadBudget): Promise<T | undefined> {
  if (budget.left <= 0) return undefined
  budget.left--
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size > MOST_BYTES) return undefined
    const parsed = schema.safeParse(JSON.parse(await readFile(path, 'utf8')))
    return parsed.success ? parsed.data : undefined
  } catch { return undefined }
}

function firstArg(args: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (!args) return undefined
  for (const key of keys) {
    const value = stepLine(args[key])
    if (value) return value
  }
  return undefined
}

function stepFromToolCall(id: string, call: TranscriptToolCall, startedAt: string | undefined): SubagentStep {
  const name = call.name.trim()
  const lower = name.toLowerCase()
  const args = call.args
  let kind: SubagentStepKind = 'tool'
  let title = humanizeStepTool(name)
  let detail: string | undefined
  let mono = false

  if (lower === 'run_command' || lower === 'execute_command' || lower === 'bash' || lower === 'shell') {
    kind = 'command'
    title = 'Run'
    detail = shortStepCommand(firstArg(args, ['CommandLine', 'commandLine', 'command', 'toolSummary']))
    mono = true
  } else if (lower === 'read_file' || lower === 'view_file' || lower === 'view_file_outline' || lower === 'view_code_item' || lower === 'read_resource') {
    kind = 'read'
    title = 'Read'
    detail = shortStepPath(firstArg(args, ['Path', 'AbsolutePath', 'path', 'Uri', 'uri']))
    mono = true
  } else if (lower === 'edit_file' || lower === 'replace_file_content' || lower === 'multi_replace_file_content') {
    kind = 'file-change'
    title = 'Edit'
    detail = shortStepPath(firstArg(args, ['Path', 'TargetFile', 'path', 'file_path']))
    mono = true
  } else if (lower === 'write_file' || lower === 'write_to_file') {
    kind = 'file-change'
    title = 'Write'
    detail = shortStepPath(firstArg(args, ['Path', 'TargetFile', 'path', 'file_path']))
    mono = true
  } else if (lower === 'search_web') {
    kind = 'search'
    title = 'Web search'
    detail = firstArg(args, ['query', 'Query'])
    mono = false
  } else if (lower === 'grep_search' || lower === 'find_by_name' || lower === 'list_dir' || lower === 'glob' || lower === 'grep') {
    kind = 'search'
    title = 'Search'
    detail = firstArg(args, ['Query', 'query', 'Pattern', 'pattern', 'SearchPath', 'DirectoryPath', 'path'])
    mono = true
  } else if (lower === 'invoke_subagent' || lower === 'start_subagent') {
    kind = 'tool'
    title = 'Subagent'
    detail = firstArg(args, ['Role', 'role', 'Prompt', 'prompt'])
    mono = false
  } else {
    detail = firstArg(args, ['toolSummary', 'description', 'Description', 'Path', 'path', 'query', 'Query', 'url', 'Url', 'Action', 'action', 'TaskId'])
  }

  return buildSubagentStep({ id, kind, status: 'running', title, detail, mono, startedAt })
}

function transcriptStatus(raw: string | undefined): SubagentStepStatus {
  switch (raw?.toUpperCase()) {
    case 'DONE': case 'COMPLETED': case 'SUCCESS': return 'completed'
    case 'ERROR': case 'FAILED': return 'failed'
    case 'CANCELLED': case 'CANCELED': case 'INTERRUPTED': case 'KILLED': return 'interrupted'
    case 'RUNNING': case 'IN_PROGRESS': case 'PENDING': return 'running'
    default: return 'completed'
  }
}

function consumeTranscriptLine(state: AntigravityChildTranscriptState, rawLine: Buffer): void {
  let parsed: TranscriptLine
  try {
    const result = transcriptLineSchema.safeParse(JSON.parse(rawLine.toString('utf8')))
    if (!result.success) return
    parsed = result.data
  } catch { return }

  const lineOrdinal = state.seenLines++
  const stepIdx = parsed.step_index ?? lineOrdinal
  const at = validIso(parsed.created_at)
  const type = parsed.type?.toUpperCase()

  if (type === 'USER_INPUT' || type === 'SYSTEM_MESSAGE' || type === 'CHECKPOINT') return

  if (type === 'PLANNER_RESPONSE') {
    if (parsed.model && parsed.model.trim()) state.model = parsed.model.trim().slice(0, 256)
    const incoming: SubagentStep[] = []
    if (parsed.thinking && parsed.thinking.trim() && !parsed.tool_calls?.length) {
      incoming.push(buildSubagentStep({
        id: `agy-step-${stepIdx}-think`,
        kind: 'reasoning',
        status: transcriptStatus(parsed.status),
        title: 'Thinking',
        detail: stepLine(parsed.thinking),
        mono: false,
        startedAt: at,
        completedAt: at,
      }))
    }
    if (parsed.tool_calls?.length) {
      for (const [index, call] of parsed.tool_calls.entries()) {
        const id = `agy-step-${stepIdx}-tool-${index}`
        const step = stepFromToolCall(id, call, at)
        incoming.push(step)
        state.pendingToolIds.push(id)
      }
    }
    if (incoming.length) {
      const merged = mergeSubagentSteps(state.steps, incoming, state.stepsTotal)
      state.steps = merged.steps
      state.stepsTotal = merged.total
    }
    return
  }

  // Tool result entry (`GENERIC` or typed tool step): match by `step_index` if updated, else FIFO against `pendingToolIds`.
  const status = transcriptStatus(parsed.status)
  let targetId = parsed.step_index !== undefined ? state.stepIdByIndex.get(parsed.step_index) : undefined
  if (!targetId && state.pendingToolIds.length) {
    targetId = state.pendingToolIds.shift()
    if (targetId && parsed.step_index !== undefined) {
      state.stepIdByIndex.set(parsed.step_index, targetId)
      if (state.stepIdByIndex.size > MAX_SUBAGENT_STEPS * 2) state.stepIdByIndex.delete(state.stepIdByIndex.keys().next().value!)
    }
  }
  if (!targetId) return
  const existing = state.steps.find(step => step.id === targetId)
  if (!existing) return
  const updated = buildSubagentStep({
    ...existing,
    status,
    ...(status !== 'running' && at ? { completedAt: at } : {}),
    ...(status === 'failed' && parsed.error ? { error: parsed.error } : {}),
  })
  const merged = mergeSubagentSteps(state.steps, [updated], state.stepsTotal)
  state.steps = merged.steps
  state.stepsTotal = merged.total
}

function takeLine(state: AntigravityChildTranscriptState, tail: Buffer): Buffer | undefined {
  const skipped = state.skipping
  const line = skipped ? undefined : state.partial.length ? Buffer.concat([...state.partial, tail], state.partialBytes + tail.length) : tail
  state.partial = []
  state.partialBytes = 0
  state.skipping = false
  return line && line.length <= TRANSCRIPT_LINE_BYTES ? line : undefined
}

function keepPartial(state: AntigravityChildTranscriptState, bytes: Buffer): void {
  if (state.skipping) return
  state.partialBytes += bytes.length
  if (state.partialBytes > TRANSCRIPT_LINE_BYTES) {
    state.partial = []
    state.partialBytes = 0
    state.skipping = true
    return
  }
  state.partial.push(Buffer.from(bytes))
}

function sameIdentity(a: TranscriptFileIdentity | undefined, b: TranscriptFileIdentity): boolean {
  if (!a) return false
  if (a.ino || b.ino) return a.dev === b.dev && a.ino === b.ino
  return a.dev === b.dev && a.birthtimeNs === b.birthtimeNs
}

/**
 * Incrementally reads new lines from `brain/<child>/.system_generated/logs/transcript.jsonl`, strictly enforcing
 * realpath containment inside `brain`, non-symlink plain file checks, per-pass byte budget, and total file cap.
 */
async function readChildTranscript(
  brain: string,
  appData: string,
  child: string,
  reading: AntigravityChildReading,
  budget: AntigravityReadBudget,
): Promise<void> {
  if (budget.left <= 0) return
  const state = reading.transcript ?? (reading.transcript = blankTranscriptState())
  if (state.done) return

  const logsDir = generated(appData, child, 'logs')
  let logsReal: string
  try {
    const dirInfo = await lstat(logsDir)
    if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) return
    logsReal = await realpath(logsDir)
    if (!isWithin(brain, logsReal)) return
  } catch { return }

  const transcriptPath = join(logsReal, 'transcript.jsonl')
  let info: { isFile(): boolean; isSymbolicLink(): boolean; size: bigint; dev: bigint; ino: bigint; birthtimeNs: bigint }
  try {
    info = await lstat(transcriptPath, { bigint: true })
    if (!info.isFile() || info.isSymbolicLink()) return
    const fileReal = await realpath(transcriptPath)
    if (!isWithin(brain, fileReal)) return
  } catch { return }

  const size = Number(info.size)
  const identity: TranscriptFileIdentity = { dev: info.dev, ino: info.ino, birthtimeNs: info.birthtimeNs }
  const replaced = state.identity !== undefined && !sameIdentity(state.identity, identity)
  if (replaced || size < state.offset) {
    Object.assign(state, blankTranscriptState(), { identity })
  }
  if (!replaced && state.identity && size === state.offset) return

  budget.left--
  const handle = await open(transcriptPath, 'r').catch(() => undefined)
  if (!handle) return
  try {
    const opened = await handle.stat({ bigint: true })
    const openedIdentity: TranscriptFileIdentity = { dev: opened.dev, ino: opened.ino, birthtimeNs: opened.birthtimeNs }
    if (!sameIdentity(identity, openedIdentity)) return
    state.identity = openedIdentity
    const fileSize = Number(opened.size)
    if (fileSize < state.offset) {
      Object.assign(state, blankTranscriptState(), { identity: openedIdentity })
    }
    const end = Math.min(fileSize, state.offset + TRANSCRIPT_POLL_BYTES, TRANSCRIPT_MAX_BYTES)
    while (state.offset < end) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, end - state.offset))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, state.offset)
      if (!bytesRead) break
      state.offset += bytesRead
      let start = 0
      for (let newline = chunk.indexOf(NEWLINE, 0); newline >= 0 && newline < bytesRead; newline = chunk.indexOf(NEWLINE, start)) {
        const line = takeLine(state, chunk.subarray(start, newline))
        start = newline + 1
        if (line && line.length) consumeTranscriptLine(state, line)
      }
      if (start < bytesRead) keepPartial(state, chunk.subarray(start, bytesRead))
    }
    if (state.offset >= TRANSCRIPT_MAX_BYTES) state.done = true
  } catch { /* File may rotate or be mid-write; retry next pass. */ }
  finally { await handle.close().catch(() => undefined) }
}

/**
 * The child that the parent's `invoke_subagent` tool call `toolCallId` launched, or undefined when the records do not
 * (yet) name one or the budget ran out before they did. `reading` carries what earlier passes of the same watch learned.
 */
export async function readAntigravityChild(appData: string, parent: string, toolCallId: string, reading: AntigravityChildReading = antigravityChildReading(),
  budget: AntigravityReadBudget = { left: CHILD_PASS_FILES }): Promise<AntigravityChild | undefined> {
  if (!conversationId.safeParse(parent).success) return undefined
  let brain: string
  try { brain = await realpath(join(appData, 'brain')) } catch { return undefined }
  if (!reading.childConversation) {
    // A child's record is named for its conversation, so the candidates are known without reading a record.
    const candidates = (await jsonNames(brain, generated(appData, parent, 'subagents'))).map(name => name.slice(0, -'.json'.length))
      .filter(name => conversationId.safeParse(name).success && !reading.ruledOut.has(name))
    // The search goes on from the child it reached last, by name: the list shrinks as children are ruled out.
    const from = Math.max(0, reading.resumeAt === undefined ? 0 : candidates.findIndex(name => name >= reading.resumeAt!))
    for (let step = 0; step < candidates.length && !reading.childConversation; step++) {
      const at = (from + step) % candidates.length, candidate = candidates[at]!, inbox = generated(appData, candidate, 'messages')
      let launched = false, complete = true
      for (const name of await jsonNames(brain, inbox)) {
        if (budget.left <= 0) { complete = false; break }
        const message = await readJson(join(inbox, name), messageSchema, budget)
        if (message?.sender !== parent || !message.sourceMetadata) continue
        launched = true
        if (message.sourceMetadata.tool.toolCall.id === toolCallId) { reading.childConversation = candidate; break }
      }
      if (reading.childConversation) break
      // The search goes on from here next pass, so a later child is reached however the earlier ones stand.
      if (!complete) { reading.resumeAt = candidate; return undefined }
      // Ruled out only once its launch names another call: a child whose launch is not written yet is read again.
      if (launched) reading.ruledOut.add(candidate)
      reading.resumeAt = candidates[(at + 1) % candidates.length]
    }
    if (!reading.childConversation) return undefined
  }
  const child = reading.childConversation
  const record = await readJson(generated(appData, parent, 'subagents', `${child}.json`), childRecordSchema, budget)
  await readChildTranscript(brain, appData, child, reading, budget)
  const inbox = generated(appData, parent, 'messages'), answers: Message[] = []
  for (const name of (await jsonNames(brain, inbox)).filter(item => !reading.readAnswers.has(item))) {
    if (budget.left <= 0) break
    const message = await readJson(join(inbox, name), messageSchema, budget)
    // Counted as read only once read whole: a file `agy` is still writing is read again next pass.
    if (!message) continue
    reading.readAnswers.add(name)
    if (message.sender === child && message.content !== undefined) answers.push(message)
  }
  const transcript = reading.transcript
  const extra: Pick<AntigravityChild, 'model' | 'steps' | 'stepsTotal'> = {
    ...(transcript?.model ? { model: transcript.model } : {}),
    ...(transcript?.steps.length ? { steps: transcript.steps.slice(-MAX_SUBAGENT_STEPS), stepsTotal: transcript.stepsTotal } : {}),
  }
  const answer = answers.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? '')).at(-1)
  if (answer) {
    return {
      conversationId: child, status: 'completed', message: answer.content!.slice(0, MAX_ACTIVITY_TEXT),
      ...(answer.timestamp && !Number.isNaN(Date.parse(answer.timestamp)) ? { completedAt: new Date(answer.timestamp).toISOString() } : {}),
      ...extra,
    }
  }
  return { conversationId: child, status: /KILL|CANCEL|TERMINAT/iu.test(record?.state ?? '') ? 'interrupted' : 'running', ...extra }
}
