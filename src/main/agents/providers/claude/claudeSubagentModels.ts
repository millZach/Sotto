import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { MAX_SUBAGENT_STEPS, mergeSubagentSteps, type SubagentStep, type SubagentStepKind } from '../../../../shared/agentActivity'
import { buildSubagentStep, humanizeStepTool, shortStepCommand, shortStepPath, stepLine, validIso } from '../../subagentSteps'
import { object } from './claudeProtocol'
import { claudeText } from './claudeSessionLog'

/**
 * Where a Claude subagent keeps its own transcript under its parent session's folder: a spawned agent
 * files `subagents/agent-<agentId>.jsonl`, a workflow's agent `subagents/workflows/<runId>/agent-<agentId>.jsonl`.
 * Checked against Claude Code 2.1.280; see docs/verification/subagent-model-from-transcript.md.
 */
export type ClaudeSubagentTranscript = { readonly agentId: string; readonly runId?: string | undefined }
/** An agent whose row still has no model, and whether it has stopped (so its transcript is finished). */
export interface ClaudeModelTarget { readonly id: string; readonly transcript: ClaudeSubagentTranscript; readonly settled: boolean }
/** An agent whose own transcript is tailed for live child steps and (if missing) its resolved model. */
export interface ClaudeTranscriptTarget {
  readonly id: string
  readonly assignmentId?: string | undefined
  readonly transcript: ClaudeSubagentTranscript
  readonly settled: boolean
  readonly needsModel: boolean
}
/** Incremental update read from a Claude subagent's own transcript. */
export interface ClaudeSubagentTranscriptUpdate {
  readonly model?: string
  readonly steps?: readonly SubagentStep[]
  readonly stepsTotal?: number
}
/** Native agent and run identifiers are short tokens. Anything else is not a file name Sotto will build. */
export const CLAUDE_TRANSCRIPT_ID = /^[A-Za-z0-9_-]{1,128}$/u
/** Transcript files opened per thread per poll, across every agent still being tailed. */
export const MAX_SUBAGENT_TRANSCRIPTS = 16
/** Bytes read from one file per poll. The first assistant line follows the task and a few attachments. */
const POLL_BYTES = 256 * 1024
/** A line longer than this is skipped unread: an assistant line that names a model or tool call is far smaller. */
const LINE_BYTES = 1024 * 1024
/** Bytes read from one file in all before model-only scanning gives up; the model sits near the top or nowhere. */
const FILE_BYTES = 8 * 1024 * 1024
/** Maximum total bytes tailed from one subagent transcript across all passes. */
const TRANSCRIPT_MAX_BYTES = 16 * 1024 * 1024
/** Reads after an agent stops before its transcript is given up: the file can trail the notification. */
const SETTLED_ATTEMPTS = 3
const NEWLINE = 0x0a

interface FileState { offset: number; pending: Buffer[]; pendingBytes: number; skipping: boolean; done: boolean }
interface TargetState { files: Map<string, FileState>; attempts: number; abandoned: boolean }

const isWithin = (parent: string, child: string): boolean => {
  const within = relative(parent, child)
  return Boolean(within) && !within.startsWith('..') && !isAbsolute(within)
}

function firstInput(input: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (!input) return undefined
  for (const key of keys) {
    const value = stepLine(input[key])
    if (value) return value
  }
  return undefined
}

/** Builds a bounded `SubagentStep` from a Claude `tool_use` / `server_tool_use` / `mcp_tool_use` block. */
export function claudeToolStep(blockId: string, name: string, input: Record<string, unknown> | undefined, startedAt?: string): SubagentStep {
  let kind: SubagentStepKind = 'tool'
  let title = humanizeStepTool(name)
  let detail: string | undefined
  let mono = false

  if (/^(?:Bash|PowerShell|Shell)$/u.test(name)) {
    kind = 'command'
    title = 'Run'
    detail = shortStepCommand(firstInput(input, ['command', 'description']))
    mono = true
  } else if (name === 'Read') {
    kind = 'read'
    title = 'Read'
    detail = shortStepPath(firstInput(input, ['file_path', 'path']))
    mono = true
  } else if (/^(?:Write|Edit|MultiEdit|NotebookEdit)$/u.test(name)) {
    kind = 'file-change'
    title = name === 'Write' ? 'Write' : 'Edit'
    detail = shortStepPath(firstInput(input, ['file_path', 'notebook_path', 'path']))
    mono = true
  } else if (/^(?:Grep|Glob|LS)$/u.test(name)) {
    kind = 'search'
    title = 'Search'
    detail = firstInput(input, ['pattern', 'path'])
    mono = true
  } else if (name === 'WebSearch' || name === 'WebFetch') {
    kind = 'search'
    title = name === 'WebSearch' ? 'Web search' : 'Fetch'
    detail = firstInput(input, ['query', 'url'])
    mono = name === 'WebFetch'
  } else if (/^Todo(?:Write|Update)$/u.test(name) || /^Task(?:Create|Update|List|Get)$/u.test(name)) {
    kind = 'plan'
    title = 'Plan'
    detail = firstInput(input, ['subject', 'activeForm', 'description'])
    mono = false
  } else if (/^(?:Agent|Task)$/u.test(name)) {
    kind = 'tool'
    title = 'Subagent'
    detail = firstInput(input, ['description', 'prompt'])
    mono = false
  } else {
    detail = firstInput(input, ['description', 'file_path', 'path', 'command', 'query', 'url'])
  }

  return buildSubagentStep({ id: `claude-step-${blockId}`, kind, status: 'running', title, detail, mono, startedAt })
}

/**
 * Reads the model a Claude subagent ran on from the first assistant line of its own transcript, for the
 * agents the stream never named one for. Only `message.model` is kept: the task, the reply and every
 * other line are scanned past as bytes and never leave this reader. Nothing here logs.
 */
export class ClaudeSubagentModels {
  private readonly targets = new Map<string, TargetState>()
  private pending: Promise<unknown> = Promise.resolve()

  /**
   * One pass over the targets in the order given, bounded in files and bytes. Returns the models it found
   * by agent id. Passes queue behind each other: the timer and a snapshot can both ask, and two passes
   * sharing a file's read position would scan the same bytes twice.
   */
  read(sessionFolder: string, targets: readonly ClaudeModelTarget[]): Promise<Map<string, string>> {
    const pass = this.pending.then(() => this.pass(sessionFolder, targets))
    this.pending = pass.catch(() => undefined)
    return pass
  }

  private async pass(sessionFolder: string, targets: readonly ClaudeModelTarget[]): Promise<Map<string, string>> {
    const found = new Map<string, string>()
    const wanted = new Set(targets.map(target => target.id))
    for (const id of this.targets.keys()) if (!wanted.has(id)) this.targets.delete(id)
    let budget = MAX_SUBAGENT_TRANSCRIPTS
    for (const target of targets) {
      if (budget <= 0) break
      let state = this.targets.get(target.id)
      if (!state) this.targets.set(target.id, state = { files: new Map(), attempts: 0, abandoned: false })
      if (state.abandoned) continue
      const path = transcriptPath(sessionFolder, target.transcript)
      if (!path) continue
      budget--
      let file = state.files.get(path)
      if (!file) state.files.set(path, file = { offset: 0, pending: [], pendingBytes: 0, skipping: false, done: false })
      const model = await firstModel(path, file)
      if (model) { found.set(target.id, model); this.targets.delete(target.id); continue }
      // A stopped agent's transcript is finished; a few more reads cover a file written just after the notice.
      if (target.settled && ++state.attempts >= SETTLED_ATTEMPTS) { state.abandoned = true; state.files.clear() }
    }
    return found
  }
}

interface TranscriptTailState {
  path: string
  assignmentId?: string | undefined
  file: FileState
  attempts: number
  abandoned: boolean
  model?: string | undefined
  steps: SubagentStep[]
  stepsTotal: number
  seenLines: number
}

/**
 * Incrementally tails Claude subagent transcripts under `<sessionFolder>/subagents/` to extract both the
 * agent's resolved `message.model` and its live tool/thinking steps (`tool_use`, `tool_result`, `thinking`),
 * bounded in files per poll, bytes per poll, line length and total file bytes. Verifies every file is a plain
 * non-symlink file whose real path stays inside `<sessionFolder>/subagents`. Nothing is ever written or logged.
 */
export class ClaudeSubagentTranscripts {
  private readonly targets = new Map<string, TranscriptTailState>()
  private pending: Promise<unknown> = Promise.resolve()
  private cursor = 0

  read(sessionFolder: string, targets: readonly ClaudeTranscriptTarget[]): Promise<Map<string, ClaudeSubagentTranscriptUpdate>> {
    const pass = this.pending.then(() => this.pass(sessionFolder, targets))
    this.pending = pass.catch(() => undefined)
    return pass
  }

  private async pass(sessionFolder: string, targets: readonly ClaudeTranscriptTarget[]): Promise<Map<string, ClaudeSubagentTranscriptUpdate>> {
    const updates = new Map<string, ClaudeSubagentTranscriptUpdate>()
    const wanted = new Set(targets.map(target => target.id))
    for (const id of this.targets.keys()) if (!wanted.has(id)) this.targets.delete(id)
    if (!targets.length) { this.cursor = 0; return updates }
    let subagentsReal: string
    try { subagentsReal = await realpath(join(sessionFolder, 'subagents')) } catch { return updates }
    let budget = MAX_SUBAGENT_TRANSCRIPTS
    // Rotate the starting offset across polls so >16 concurrent running agents never starve older agents.
    const start = this.cursor % targets.length
    let visited = 0
    for (; visited < targets.length && budget > 0; visited++) {
      const target = targets[(start + visited) % targets.length]!
      const path = transcriptPath(sessionFolder, target.transcript)
      if (!path) continue
      let state = this.targets.get(target.id)
      if (!state || state.path !== path) {
        state = {
          path,
          assignmentId: target.assignmentId,
          file: { offset: 0, pending: [], pendingBytes: 0, skipping: false, done: false },
          attempts: 0, abandoned: false, steps: [], stepsTotal: 0, seenLines: 0,
        }
        this.targets.set(target.id, state)
      } else if (target.assignmentId !== undefined && state.assignmentId !== target.assignmentId) {
        // Resumed agent on the same transcript file: start the new assignment with a clean step list
        // while keeping the file offset so only the resumed run's newly appended lines are counted.
        state.assignmentId = target.assignmentId
        state.steps = []
        state.stepsTotal = 0
        state.attempts = 0
        state.abandoned = false
      } else if (!target.settled && state.abandoned) {
        state.abandoned = false
        state.attempts = 0
      }
      if (state.abandoned) continue
      budget--
      const changed = await tailTranscript(subagentsReal, path, state)
      if (changed) {
        updates.set(target.id, {
          ...(state.model && target.needsModel ? { model: state.model } : {}),
          ...(state.steps.length ? { steps: state.steps.slice(-MAX_SUBAGENT_STEPS), stepsTotal: state.stepsTotal } : {}),
        })
        if (target.settled) state.attempts = 0
      } else if (target.settled && ++state.attempts >= SETTLED_ATTEMPTS) {
        state.abandoned = true
      }
    }
    this.cursor = (start + visited) % targets.length
    return updates
  }
}

/** The one file an agent's transcript is, or nothing when an identifier is not a native token. */
function transcriptPath(sessionFolder: string, transcript: ClaudeSubagentTranscript): string | undefined {
  if (!CLAUDE_TRANSCRIPT_ID.test(transcript.agentId) || (transcript.runId !== undefined && !CLAUDE_TRANSCRIPT_ID.test(transcript.runId))) return undefined
  const subagents = join(sessionFolder, 'subagents')
  return join(...(transcript.runId !== undefined ? [subagents, 'workflows', transcript.runId] : [subagents]), `agent-${transcript.agentId}.jsonl`)
}

/** Tails new bytes from a single Claude subagent transcript, returning true when model or steps changed. */
async function tailTranscript(subagentsReal: string, path: string, state: TranscriptTailState): Promise<boolean> {
  if (state.file.done) return false
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) return false
    const fileReal = await realpath(path)
    if (!isWithin(subagentsReal, fileReal)) return false
  } catch { return false }

  const handle = await open(path, 'r').catch(() => undefined)
  if (!handle) return false
  const beforeModel = state.model
  const beforeSignature = stepSignature(state.steps, state.stepsTotal)
  try {
    const size = (await handle.stat()).size
    if (size < state.file.offset) {
      state.file = { offset: 0, pending: [], pendingBytes: 0, skipping: false, done: false }
      state.steps = []
      state.stepsTotal = 0
      state.seenLines = 0
    }
    if (size === state.file.offset) return false
    const end = Math.min(size, state.file.offset + POLL_BYTES, TRANSCRIPT_MAX_BYTES)
    while (state.file.offset < end) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, end - state.file.offset))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, state.file.offset)
      if (!bytesRead) break
      state.file.offset += bytesRead
      let start = 0
      for (let newline = chunk.indexOf(NEWLINE, 0); newline >= 0 && newline < bytesRead; newline = chunk.indexOf(NEWLINE, start)) {
        const line = take(state.file, chunk.subarray(start, newline))
        start = newline + 1
        if (line && line.length) consumeClaudeLine(state, line)
      }
      if (start < bytesRead) keep(state.file, chunk.subarray(start, bytesRead))
    }
    if (state.file.offset >= TRANSCRIPT_MAX_BYTES) state.file.done = true
  } catch { /* Mid-write or transient error; retry next poll. */ }
  finally { await handle.close().catch(() => undefined) }
  return state.model !== beforeModel || stepSignature(state.steps, state.stepsTotal) !== beforeSignature
}

function stepSignature(steps: readonly SubagentStep[], total: number): string {
  let sig = `${total}:${steps.length}`
  for (const step of steps) {
    sig += `\n${step.id}|${step.status}|${step.title}|${step.detail ?? ''}|${step.error ?? ''}|${step.exitCode ?? ''}|${step.completedAt ?? ''}`
  }
  return sig
}

function consumeClaudeLine(state: TranscriptTailState, line: Buffer): void {
  // Fast prefilter: only assistant/user lines carry model, tool_use, thinking, or tool_result.
  if (!line.includes('"assistant"') && !line.includes('"user"')) return
  let entry: Record<string, unknown> | undefined
  try { entry = object(JSON.parse(line.toString('utf8'))) } catch { return }
  if (!entry) return
  const lineIdx = state.seenLines++
  const at = validIso(entry.timestamp)
  const msg = object(entry.message)
  const content = msg?.content

  if (entry.type === 'assistant') {
    const model = msg?.model
    if (!state.model && typeof model === 'string' && model && model !== '<synthetic>') state.model = model.slice(0, 512)
    if (!Array.isArray(content)) return
    const msgId = typeof msg?.id === 'string' ? msg.id : `line-${lineIdx}`
    const incoming: SubagentStep[] = []
    let hasToolUse = false
    for (const value of content) {
      const block = object(value)
      if (!block) continue
      if (['tool_use', 'server_tool_use', 'mcp_tool_use'].includes(String(block.type)) && typeof block.id === 'string' && typeof block.name === 'string') {
        hasToolUse = true
        incoming.push(claudeToolStep(block.id, block.name, object(block.input), at))
      }
    }
    if (!hasToolUse) {
      for (const [pos, value] of content.entries()) {
        const block = object(value)
        if (!block || (block.type !== 'thinking' && block.type !== 'redacted_thinking')) continue
        const words = typeof block.thinking === 'string' ? stepLine(block.thinking) : undefined
        if (!words) continue
        incoming.push(buildSubagentStep({
          id: `claude-step-think-${msgId}-${pos}`,
          kind: 'reasoning',
          status: 'completed',
          title: 'Thinking',
          detail: words,
          mono: false,
          startedAt: at,
          completedAt: at,
        }))
      }
    }
    if (incoming.length) {
      const merged = mergeSubagentSteps(state.steps, incoming, state.stepsTotal)
      state.steps = merged.steps
      state.stepsTotal = merged.total
    }
    return
  }

  if (entry.type === 'user' && Array.isArray(content)) {
    const updates: SubagentStep[] = []
    for (const value of content) {
      const block = object(value)
      if (!block || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      const id = `claude-step-${block.tool_use_id}`
      const prior = state.steps.find(step => step.id === id)
      if (!prior) continue
      const failed = block.is_error === true
      updates.push(buildSubagentStep({
        ...prior,
        status: failed ? 'failed' : 'completed',
        ...(at ? { completedAt: at } : {}),
        ...(failed ? { error: stepLine(claudeText(block.content)) } : {}),
      }))
    }
    if (updates.length) {
      const merged = mergeSubagentSteps(state.steps, updates, state.stepsTotal)
      state.steps = merged.steps
      state.stepsTotal = merged.total
    }
  }
}

/** Scans on from where the last poll stopped, for the first assistant line's model. Never throws. */
async function firstModel(path: string, file: FileState): Promise<string | undefined> {
  if (file.done) return undefined
  const handle = await open(path, 'r').catch(() => undefined)
  if (!handle) return undefined
  try {
    const size = (await handle.stat()).size
    const end = Math.min(size, file.offset + POLL_BYTES)
    while (file.offset < end) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, end - file.offset))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, file.offset)
      if (!bytesRead) break
      file.offset += bytesRead
      // UTF-8 never places a newline byte inside a multi-byte character, so lines split cleanly as bytes.
      let start = 0
      for (let newline = chunk.indexOf(NEWLINE, 0); newline >= 0 && newline < bytesRead; newline = chunk.indexOf(NEWLINE, start)) {
        const line = take(file, chunk.subarray(start, newline))
        start = newline + 1
        const model = line && assistantModel(line)
        if (model) { file.done = true; return model }
      }
      if (start < bytesRead) keep(file, chunk.subarray(start, bytesRead))
    }
    if (file.offset >= FILE_BYTES) file.done = true
    return undefined
  } catch { return undefined } finally { await handle.close().catch(() => undefined) }
}

/** Completes the line in progress, or nothing when it ran past the line limit and was skipped. */
function take(file: FileState, tail: Buffer): Buffer | undefined {
  const skipped = file.skipping
  const line = skipped ? undefined : file.pending.length ? Buffer.concat([...file.pending, tail]) : tail
  file.pending = []; file.pendingBytes = 0; file.skipping = false
  return line && line.length <= LINE_BYTES ? line : undefined
}

function keep(file: FileState, bytes: Buffer): void {
  if (file.skipping) return
  file.pendingBytes += bytes.length
  if (file.pendingBytes > LINE_BYTES) { file.pending = []; file.pendingBytes = 0; file.skipping = true; return }
  file.pending.push(Buffer.from(bytes))
}

function assistantModel(line: Buffer): string | undefined {
  // A cheap prefilter: a line without a quoted "assistant" cannot be an assistant entry, so it is not
  // parsed at all. A task or tool line that quotes the word is parsed, but only its type and model are read.
  if (!line.includes('"assistant"')) return undefined
  try {
    const entry = object(JSON.parse(line.toString('utf8')))
    const model = entry?.type === 'assistant' ? object(entry.message)?.model : undefined
    // Claude Code files its own error notices as assistant lines from a `<synthetic>` model.
    return typeof model === 'string' && model && model !== '<synthetic>' ? model.slice(0, 512) : undefined
  } catch { return undefined }
}
