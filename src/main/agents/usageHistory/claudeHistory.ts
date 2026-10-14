import { join } from 'node:path'
import type { UsageTokens } from '../../../shared/threadUsage'
import type { UsageHistoryPrompt, UsageTokenObservation } from '../../../shared/usageDashboard'
import { claudeTokens, nativeUsageKey } from '../nativeUsage'
import { dated, identity, object, readHistoryFolders, type HistoryBatch, type HistoryFile, type HistoryFileReader } from './files'
import { usageHistoryMessageId, usageHistoryRecordKey, usageHistoryThreadId, type UsageHistorySink } from './sink'

/**
 * Claude Code's own session transcripts on this computer: `<home>/projects/<project>/<session>.jsonl` and each
 * session's `subagents/*.jsonl` (ADR-0080). A line is parsed, its numbers, instant and served model kept, and the
 * line dropped. Prompts are counted only for sessions Sotto does not own; Sotto's own prompts come from its store.
 */
export interface ClaudeHistoryOptions {
  /** Claude Code's home, as the adapter finds it. */
  readonly home: string
  /** Each native session Sotto owns, by Claude session ID, to the adapter's own thread ID. */
  readonly owned: ReadonlyMap<string, string>
}

const SYNTHETIC = '<synthetic>'
const WRAPPERS = ['<command-', '<local-command', 'Caveat:']

interface Attribution { readonly owned?: string; readonly threadId: string }
interface PendingMessage { attribution: Attribution; model: string; tokens: UsageTokens; at: string; subAgent: boolean }
interface WaitingPrompt { threadId: string; messageId: string; at: string }
interface FileState {
  readonly subFile: boolean
  readonly fallbackSession: string | undefined
  model: string | undefined
  readonly pending: Map<string, PendingMessage>
  readonly waiting: WaitingPrompt[]
}

/** What one pass remembers across files: a message or prompt copied into another file counts once. */
class PassMemory {
  readonly messages = new Map<string, Attribution>()
  readonly prompts = new Set<string>()
}

function humanText(content: unknown): boolean {
  const plain = (text: string): boolean => text.trim().length > 0 && !WRAPPERS.some(wrapper => text.trimStart().startsWith(wrapper))
  if (typeof content === 'string') return plain(content)
  if (!Array.isArray(content)) return false
  let text = false
  for (const block of content) {
    const entry = object(block)
    if (entry.type === 'tool_result') return false
    if (entry.type === 'text' && typeof entry.text === 'string' && plain(entry.text)) text = true
  }
  return text
}

function promptOf(prompt: WaitingPrompt, modelId: string): UsageHistoryPrompt {
  return { providerId: 'claude', threadId: prompt.threadId, messageId: prompt.messageId, modelId, at: prompt.at, kind: 'user', source: 'outside', client: 'claude-code' }
}

function maxTokens(previous: UsageTokens, next: UsageTokens): UsageTokens {
  const merged: UsageTokens = { ...next }
  for (const field of Object.keys(previous) as (keyof UsageTokens)[]) {
    const old = previous[field]
    if (old !== undefined && (merged[field] === undefined || merged[field]! < old)) merged[field] = old
  }
  return merged
}

function reader(options: ClaudeHistoryOptions, memory: PassMemory): HistoryFileReader<FileState> {
  // One identity per session, shared by every message the pass remembers from it.
  const sessions = new Map<string, Attribution>()
  const attribution = (session: string): Attribution => {
    let known = sessions.get(session)
    if (known === undefined) {
      const owned = options.owned.get(session)
      known = owned === undefined ? { threadId: usageHistoryThreadId('claude', session) } : { owned, threadId: owned }
      sessions.set(session, known)
    }
    return known
  }
  const observation = (messageId: string, row: PendingMessage): UsageTokenObservation => {
    const partial = row.tokens.input === undefined || row.tokens.output === undefined
    if (row.attribution.owned !== undefined) {
      const id = row.attribution.owned
      return { providerId: 'claude', threadId: id, recordKey: nativeUsageKey('claude', 'row', id, messageId),
        groupKey: nativeUsageKey('claude', 'group', id, messageId), modelId: row.model, tokens: { ...row.tokens }, at: row.at,
        phase: 'replay', partial, origin: 'history', ...(row.subAgent ? { subAgent: true } : {}) }
    }
    return { providerId: 'claude', threadId: row.attribution.threadId, recordKey: usageHistoryRecordKey('claude', row.attribution.threadId, messageId),
      modelId: row.model, tokens: { ...row.tokens }, at: row.at, phase: 'replay', partial, origin: 'history',
      source: 'outside', client: 'claude-code', ...(row.subAgent ? { subAgent: true } : {}) }
  }
  return {
    needles: [Buffer.from('"usage"'), Buffer.from('"type":"user"')],
    start(file: HistoryFile, saved: string | undefined): FileState {
      const parts = file.relativePath.split('/')
      const subFile = parts.includes('subagents')
      // A sub-agent transcript sits in its session's own folder; its lines name the session too.
      const fallback = subFile ? parts[parts.indexOf('subagents') - 1] : parts.at(-1)?.replace(/\.jsonl$/u, '')
      let model: string | undefined
      try { const value = object(saved === undefined ? undefined : JSON.parse(saved)); if (typeof value.m === 'string') model = value.m } catch { /* A fresh start. */ }
      return { subFile, fallbackSession: identity(fallback) ? fallback : undefined, model, pending: new Map(), waiting: [] }
    },
    line(text: string, state: FileState, batch: HistoryBatch): void {
      // Tool results and sub-agent turns are never prompts and carry no usage: skip them before parsing a large line.
      if (!text.includes('"type":"assistant"') && (state.subFile || text.includes('"tool_result"') || text.includes('"isSidechain":true'))) return
      let frame: Record<string, unknown>
      try { frame = object(JSON.parse(text)) } catch { return }
      const session = identity(frame.sessionId) ? frame.sessionId : state.fallbackSession
      if (session === undefined) return
      const at = dated(frame.timestamp)
      if (at === undefined) return
      const sidechain = state.subFile || frame.isSidechain === true
      const message = object(frame.message)
      if (frame.type === 'assistant' && message.usage !== undefined && identity(message.id)) {
        const model = typeof message.model === 'string' && message.model.length > 0 ? message.model : 'unknown'
        if (model === SYNTHETIC) return
        const tokens = claudeTokens(message.usage)
        if (!Object.values(tokens).some(value => value !== undefined && value > 0)) return
        let owner = memory.messages.get(message.id)
        if (owner === undefined) { owner = attribution(session); memory.messages.set(message.id, owner) }
        const previous = state.pending.get(message.id)
        state.pending.set(message.id, previous
          ? { ...previous, tokens: maxTokens(previous.tokens, tokens), at: previous.at < at ? previous.at : at }
          : { attribution: owner, model, tokens, at, subAgent: sidechain })
        if (!sidechain) {
          state.model = model
          // A prompt is attributed to the model that answered it, the next main-chain reply.
          for (const prompt of state.waiting.splice(0)) batch.prompts.push(promptOf(prompt, model))
        }
        return
      }
      if (frame.type !== 'user' || sidechain || frame.isMeta === true || message.role !== 'user' || !identity(frame.uuid)) return
      if (options.owned.has(session) || memory.prompts.has(frame.uuid)) return
      if (!humanText(message.content)) return
      memory.prompts.add(frame.uuid)
      state.waiting.push({ threadId: usageHistoryThreadId('claude', session), messageId: usageHistoryMessageId('claude', frame.uuid), at })
    },
    settle(state: FileState, batch: HistoryBatch): void {
      for (const [messageId, row] of state.pending) batch.tokens.push(observation(messageId, row))
      state.pending.clear()
      for (const prompt of state.waiting.splice(0)) batch.prompts.push(promptOf(prompt, state.model ?? 'unknown'))
    },
    save(state: FileState): string | undefined { return state.model === undefined ? undefined : JSON.stringify({ m: state.model }) },
  }
}

/** One pass over Claude Code's transcripts, resuming each file from its cursor. */
export async function scanClaudeHistory(options: ClaudeHistoryOptions, sink: UsageHistorySink, signal: AbortSignal): Promise<void> {
  await readHistoryFolders('claude', [{ root: join(options.home, 'projects'), prefix: 'projects',
    accept: (name: string) => name.endsWith('.jsonl') }], reader(options, new PassMemory()), sink, signal)
}
