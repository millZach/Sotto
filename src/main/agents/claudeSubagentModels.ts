import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { object } from './claudeProtocol'

/**
 * Where a Claude subagent keeps its own transcript under its parent session's folder: a spawned agent
 * files `subagents/agent-<agentId>.jsonl`, a workflow's agents `subagents/workflows/<runId>/agent-<id>.jsonl`.
 * Checked against Claude Code 2.1.280; see docs/verification/subagent-model-from-transcript.md.
 */
export type ClaudeSubagentTranscript = { readonly agentId: string } | { readonly runId: string }
/** An agent whose row still has no model, and whether it has stopped (so its transcript is finished). */
export interface ClaudeModelTarget { readonly id: string; readonly transcript: ClaudeSubagentTranscript; readonly settled: boolean }
/** Native agent and run identifiers are short tokens. Anything else is not a file name Sotto will build. */
export const CLAUDE_TRANSCRIPT_ID = /^[A-Za-z0-9_-]{1,128}$/u
/** Transcript files opened per thread per poll, across every agent still missing a model. */
export const MAX_SUBAGENT_TRANSCRIPTS = 16
/** A workflow row names at most this many of its agents' models. */
export const MAX_WORKFLOW_MODELS = 4
/** Bytes read from one file per poll. The first assistant line follows the task and a few attachments. */
const POLL_BYTES = 256 * 1024
/** A line longer than this is skipped unread: an assistant line that names a model is far smaller. */
const LINE_BYTES = 1024 * 1024
/** Bytes read from one file in all before it is given up; the model sits near the top or nowhere. */
const FILE_BYTES = 8 * 1024 * 1024
/** Reads after an agent stops before its transcript is given up: the file can trail the notification. */
const SETTLED_ATTEMPTS = 3
const AGENT_FILE = /^agent-[A-Za-z0-9_-]{1,128}\.jsonl$/u
const NEWLINE = 0x0a

interface FileState { offset: number; pending: Buffer[]; pendingBytes: number; skipping: boolean; done: boolean }
interface TargetState { files: Map<string, FileState>; attempts: number; abandoned: boolean }

/** Joins what a workflow's agents ran on, keeping the order they were first seen and a short list. */
export function claudeWorkflowModels(known: string | undefined, reported: readonly string[]): string | undefined {
  const models = [...new Set([...(known ? known.split(', ') : []), ...reported].filter(Boolean))].slice(0, MAX_WORKFLOW_MODELS)
  return models.length ? models.join(', ') : undefined
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
      const files = await this.files(sessionFolder, target.transcript)
      const models: string[] = []
      for (const path of files.slice(0, budget)) {
        budget--
        let file = state.files.get(path)
        if (!file) state.files.set(path, file = { offset: 0, pending: [], pendingBytes: 0, skipping: false, done: false })
        const model = await firstModel(path, file)
        if (model) models.push(model)
      }
      const model = 'runId' in target.transcript ? claudeWorkflowModels(undefined, models) : models[0]
      if (model) { found.set(target.id, model); this.targets.delete(target.id); continue }
      // A stopped agent's transcript is finished; a few more reads cover a file written just after the notice.
      if (target.settled && ++state.attempts >= SETTLED_ATTEMPTS) { state.abandoned = true; state.files.clear() }
    }
    return found
  }

  private async files(sessionFolder: string, transcript: ClaudeSubagentTranscript): Promise<string[]> {
    const subagents = join(sessionFolder, 'subagents')
    if ('agentId' in transcript) return CLAUDE_TRANSCRIPT_ID.test(transcript.agentId) ? [join(subagents, `agent-${transcript.agentId}.jsonl`)] : []
    if (!CLAUDE_TRANSCRIPT_ID.test(transcript.runId)) return []
    const run = join(subagents, 'workflows', transcript.runId)
    const names = await readdir(run).catch(() => [] as string[])
    return names.filter(name => AGENT_FILE.test(name)).sort().map(name => join(run, name))
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
