import { join } from 'node:path'
import type { UsageTokens } from '../../../shared/threadUsage'
import { USAGE_CLIENTS, type UsageClient, type UsageTokenObservation } from '../../../shared/usageDashboard'
import { codexEntryKey, nativeUsageKey } from '../nativeUsage'
import { readHistoryFolders, type HistoryBatch, type HistoryFileReader } from './files'
import { usageHistoryRecordKey, usageHistoryThreadId, type UsageHistorySink } from './sink'

/**
 * Codex's own session rollouts on this computer: `<CODEX_HOME>/sessions/**\/rollout-*.jsonl` and
 * `archived_sessions` (ADR-0080). Each line is parsed, its numbers, instant, served model and client kept, and the
 * line dropped.
 *
 * Forked and sub-agent rollouts begin with a copy of their parent's history, the parent's own `session_meta`
 * included. Every record is attributed to the session that produced it (the copied meta, a usage record's own
 * `thread_id`), so a copy is the parent's row under the parent's identity and counts once; one pass also skips any
 * response or running total it already read.
 */
export interface CodexHistoryOptions {
  /** `CODEX_HOME`, as the adapter finds it. */
  readonly home: string
  /** Each native thread Sotto owns, by Codex thread ID, to the adapter's own thread ID. */
  readonly owned: ReadonlyMap<string, string>
}

const object = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
const dated = (value: unknown): string | undefined => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && /^[^\s\p{Cc}]+$/u.test(value)
const PARENT_DEPTH_MAX = 8

/** The app that started a Codex session, as its rollout's `session_meta.originator` names it. */
export function codexClient(originator: unknown): UsageClient {
  switch (originator) {
    case 'sotto': return 'sotto'
    case 'codex_exec': return 'codex-exec'
    case 'Codex Desktop': return 'codex-app'
    case 'codex-tui': case 'codex_cli_rs': return 'codex-cli'
    case 'codex_vscode': return 'codex-ide'
    case 't3code_desktop': return 't3-code'
    case 'Claude Code': return 'codex-in-claude-code'
    default: return 'other'
  }
}

/**
 * A session as this reader holds it: its namespaced, non-reversible identity, never the native ID, so nothing the
 * reader saves in a cursor names a native session.
 */
type Session = string
const sessionOf = (nativeId: string): Session => usageHistoryThreadId('codex', nativeId)
interface SessionMeta { readonly client: UsageClient; readonly subAgent: boolean; readonly parent?: Session | undefined }
function sessionMeta(payload: Record<string, unknown>): SessionMeta {
  const source = payload.source
  const named = typeof source === 'object' && source !== null && !Array.isArray(source)
    && Object.keys(source).some(key => /^sub_?agent$/iu.test(key))
  const parent = identity(payload.parent_thread_id) ? sessionOf(payload.parent_thread_id) : undefined
  return { client: codexClient(payload.originator), parent,
    subAgent: payload.thread_source === 'subagent' || payload.thread_source === 'guardian_review' || named || source === 'subagent' || parent !== undefined }
}

/** Codex's token figures as the ledger keys them: input already includes the cached subset. */
function rolloutTokens(value: unknown): UsageTokens {
  const row = object(value)
  return { input: count(row.input_tokens), output: count(row.output_tokens), cached: count(row.cached_input_tokens), cacheWrite: count(row.cache_write_input_tokens) }
}
/** A request's running totals and its own figures, exact enough that only a copy repeats them. */
function tuple(total: unknown, last: unknown): string {
  const fields = (value: unknown): (number | null)[] => {
    const row = object(value)
    return [row.input_tokens, row.cached_input_tokens, row.output_tokens, row.reasoning_output_tokens, row.total_tokens].map(field => count(field) ?? null)
  }
  return JSON.stringify([fields(total), fields(last)])
}

interface WaitingTurn { readonly turn: string; readonly at: string; readonly session: Session }
interface PendingCount { readonly session: Session; readonly turn: string | undefined; readonly model: string | undefined; readonly total: UsageTokens; readonly last: UsageTokens; readonly at: string }
interface FileState {
  own: ({ id: Session } & SessionMeta) | undefined
  /** The session whose copied history this file is in, until its own work begins. */
  copied: Session | undefined
  ordinal: number | undefined
  turn: string | undefined
  model: string | undefined
  /** This rollout reports per-request records, so its older `token_count` events are not read as well. */
  records: boolean
  /** Lines before this reading's start, for the copied-history ordinal. */
  base: number
  readonly turnModels: Map<string, string>
  readonly turnOwners: Map<string, Session>
  readonly waiting: WaitingTurn[]
  readonly counts: PendingCount[]
}
const stateSchemaVersion = 1

/** What one pass remembers across files. */
class PassMemory {
  readonly metas = new Map<Session, SessionMeta>()
  readonly responses = new Set<string>()
  /** Running totals, apart for each kind of event: a request's `token_count` and its record repeat the same totals. */
  readonly tuples = new Set<string>()
  readonly recordTuples = new Set<string>()
  readonly turns = new Set<string>()
}

interface Owner { readonly owned?: string; readonly threadId: string; readonly client: UsageClient; readonly subAgent: boolean }

function reader(options: CodexHistoryOptions, memory: PassMemory): HistoryFileReader<FileState> {
  const owned = new Map([...options.owned].map(([nativeId, thread]) => [sessionOf(nativeId), thread]))
  const owner = (session: Session, own: FileState['own']): Owner => {
    const meta = memory.metas.get(session) ?? (own?.id === session ? own : undefined)
    const thread = owned.get(session)
    if (thread !== undefined) return { owned: thread, threadId: thread, client: 'sotto', subAgent: false }
    // A sub-agent a Sotto thread started is that thread's work.
    if (meta?.subAgent) {
      let parent = meta.parent
      for (let depth = 0; parent !== undefined && depth < PARENT_DEPTH_MAX; depth++) {
        const parentThread = owned.get(parent)
        if (parentThread !== undefined) return { owned: parentThread, threadId: parentThread, client: 'sotto', subAgent: true }
        parent = memory.metas.get(parent)?.parent
      }
    }
    return { threadId: session, client: meta?.client ?? own?.client ?? 'other', subAgent: meta?.subAgent ?? false }
  }
  const current = (state: FileState): Session | undefined => state.copied ?? state.own?.id
  const observation = (who: Owner, entry: string, turn: string | undefined, model: string | undefined, tokens: UsageTokens, at: string): UsageTokenObservation => {
    const partial = tokens.input === undefined || tokens.output === undefined
    const base = { providerId: 'codex' as const, modelId: model ?? 'unknown', tokens: { ...tokens }, at, phase: 'replay' as const, partial, origin: 'history' as const,
      ...(who.subAgent ? { subAgent: true } : {}) }
    if (who.owned !== undefined) {
      return { ...base, threadId: who.owned, recordKey: nativeUsageKey('codex', 'row', who.owned, entry),
        ...(turn !== undefined ? { groupKey: nativeUsageKey('codex', 'group', who.owned, turn) } : {}) }
    }
    return { ...base, threadId: who.threadId, recordKey: usageHistoryRecordKey('codex', who.threadId, entry),
      source: who.client === 'sotto' ? 'sotto' : 'elsewhere', ...(who.client === 'sotto' ? {} : { client: who.client }) }
  }
  return {
    needles: [Buffer.from('"session_meta"'), Buffer.from('"turn_context"'), Buffer.from('token_usage_record'), Buffer.from('"token_count"'), Buffer.from('"task_started"')],
    start(_file, saved): FileState {
      const state: FileState = { own: undefined, copied: undefined, ordinal: undefined, turn: undefined, model: undefined, records: false, base: 0,
        turnModels: new Map(), turnOwners: new Map(), waiting: [], counts: [] }
      try {
        const value = object(saved === undefined ? undefined : JSON.parse(saved))
        const own = object(value.own)
        if (value.v === stateSchemaVersion && typeof own.id === 'string' && own.id.length > 0) {
          const client = typeof own.client === 'string' && (USAGE_CLIENTS as readonly string[]).includes(own.client) ? own.client as UsageClient : 'other'
          state.own = { id: own.id, client, subAgent: own.sub === true, ...(typeof own.parent === 'string' ? { parent: own.parent } : {}) }
          if (!memory.metas.has(state.own.id)) memory.metas.set(state.own.id, state.own)
          if (typeof value.copied === 'string') state.copied = value.copied
          state.ordinal = count(value.ordinal); state.records = value.records === true; state.base = count(value.lines) ?? 0
          if (identity(value.turn)) state.turn = value.turn
          if (typeof value.model === 'string' && value.model.length > 0) state.model = value.model
        }
      } catch { /* A fresh start. */ }
      return state
    },
    line(text, state, batch, index): void {
      let frame: Record<string, unknown>
      try { frame = object(JSON.parse(text)) } catch { return }
      const payload = object(frame.payload)
      const line = state.base + index
      if (state.copied !== undefined && state.ordinal !== undefined && line > state.ordinal) state.copied = undefined
      if (frame.type === 'session_meta') {
        const nativeId = identity(payload.id) ? payload.id : identity(payload.session_id) ? payload.session_id : undefined
        if (nativeId === undefined) return
        const id = sessionOf(nativeId)
        const meta = sessionMeta(payload)
        if (!memory.metas.has(id)) memory.metas.set(id, meta)
        if (state.own === undefined) {
          state.own = { id, ...meta }
          const ordinal = count(payload.subagent_history_start_ordinal)
          if (ordinal !== undefined) state.ordinal = ordinal
        } else state.copied = id === state.own.id ? undefined : id
        return
      }
      if (state.own === undefined) return
      const at = dated(frame.timestamp)
      if (frame.type === 'turn_context') {
        const model = typeof payload.model === 'string' && payload.model.length > 0 ? payload.model : undefined
        if (identity(payload.turn_id)) state.turn = payload.turn_id
        if (model !== undefined) { state.model = model; if (state.turn !== undefined) state.turnModels.set(state.turn, model) }
        return
      }
      const kind = frame.type === 'event_msg' ? payload.type : frame.type === 'token_usage_record' || payload.type === 'token_usage_record' ? 'token_usage_record' : undefined
      if (kind === 'task_started') {
        if (!identity(payload.turn_id)) return
        state.turn = payload.turn_id
        const session = current(state)
        if (at !== undefined && session !== undefined) state.waiting.push({ turn: payload.turn_id, at, session })
        return
      }
      if (at === undefined) return
      if (kind === 'token_usage_record') {
        state.records = true
        const thread = identity(payload.thread_id) ? sessionOf(payload.thread_id) : current(state)
        if (thread === undefined) return
        if (thread === state.own.id) state.copied = undefined
        const turn = identity(payload.turn_id) ? payload.turn_id : state.turn
        if (turn !== undefined) state.turnOwners.set(turn, thread)
        const response = identity(payload.response_id) ? payload.response_id : undefined
        if (response !== undefined) { if (memory.responses.has(response)) return; memory.responses.add(response) }
        const last = payload.usage ?? payload.turn_token_usage
        const key = tuple(payload.thread_token_usage, last)
        if (payload.thread_token_usage !== undefined) { if (memory.recordTuples.has(key)) return; memory.recordTuples.add(key) }
        const tokens = rolloutTokens(last)
        if (!Object.values(tokens).some(value => value !== undefined)) return
        const entry = payload.thread_token_usage !== undefined && turn !== undefined ? codexEntryKey(turn, rolloutTokens(payload.thread_token_usage))
          : response !== undefined ? `response:${response}` : undefined
        if (entry === undefined) return
        const who = owner(thread, state.own)
        // Sotto's live ledger keyed a thread's rows by the running total its token_count events carry, which
        // thread_token_usage does not always equal, so a Sotto thread's rows come from those events (settle).
        if (who.owned !== undefined) return
        const model = (turn !== undefined ? state.turnModels.get(turn) : undefined) ?? state.model
        batch.tokens.push(observation(who, entry, turn, model, tokens, at))
        return
      }
      if (kind === 'token_count') {
        const info = object(payload.info)
        if (info.total_token_usage === undefined || info.last_token_usage === undefined) return
        const key = tuple(info.total_token_usage, info.last_token_usage)
        if (memory.tuples.has(key)) return
        memory.tuples.add(key)
        // A running total this pass has not seen is this session's own work: its copied history is behind it.
        if (state.copied !== undefined && state.ordinal === undefined) state.copied = undefined
        const session = current(state)
        if (session === undefined) return
        state.counts.push({ session, turn: state.turn, model: (state.turn !== undefined ? state.turnModels.get(state.turn) : undefined) ?? state.model,
          total: rolloutTokens(info.total_token_usage), last: rolloutTokens(info.last_token_usage), at })
      }
    },
    settle(state, batch: HistoryBatch): void {
      if (state.own !== undefined) {
        // Held until now: a rollout with per-request records reports each request there, except for Sotto's own
        // threads, whose rows keep the key the live ledger gave them from these running totals.
        for (const row of state.counts) {
          if (!Object.values(row.last).some(value => value !== undefined)) continue
          const who = owner(row.session, state.own)
          if (state.records && who.owned === undefined) continue
          batch.tokens.push(observation(who, codexEntryKey(row.turn, row.total), row.turn, row.model, row.last, row.at))
        }
        for (const waiting of state.waiting) {
          if (memory.turns.has(waiting.turn)) continue
          memory.turns.add(waiting.turn)
          const session = state.turnOwners.get(waiting.turn) ?? waiting.session
          const who = owner(session, state.own)
          // Sotto's own prompts come from its thread store; a sub-agent's turns are never prompts.
          if (who.owned !== undefined || who.subAgent || who.client === 'sotto') continue
          batch.prompts.push({ providerId: 'codex', threadId: who.threadId, messageId: waiting.turn,
            modelId: state.turnModels.get(waiting.turn) ?? state.model ?? 'unknown', at: waiting.at, kind: 'user', source: 'elsewhere', client: who.client })
        }
      }
      state.counts.length = 0; state.waiting.length = 0
      // Only the current turn's model is needed to resume; earlier turns are settled.
      for (const turn of [...state.turnModels.keys()]) if (turn !== state.turn) state.turnModels.delete(turn)
      for (const turn of [...state.turnOwners.keys()]) if (turn !== state.turn) state.turnOwners.delete(turn)
    },
    save(state, lines): string | undefined {
      if (state.own === undefined) return undefined
      return JSON.stringify({ v: stateSchemaVersion, own: { id: state.own.id, client: state.own.client, sub: state.own.subAgent, ...(state.own.parent ? { parent: state.own.parent } : {}) },
        ...(state.copied ? { copied: state.copied } : {}), ...(state.ordinal !== undefined ? { ordinal: state.ordinal } : {}),
        ...(state.records ? { records: true } : {}), lines: state.base + lines,
        ...(state.turn ? { turn: state.turn } : {}), ...(state.model ? { model: state.model } : {}) })
    },
  }
}

/** One pass over Codex's rollouts, resuming each file from its cursor. */
export async function scanCodexHistory(options: CodexHistoryOptions, sink: UsageHistorySink, signal: AbortSignal): Promise<void> {
  const accept = (name: string): boolean => name.startsWith('rollout-') && name.endsWith('.jsonl')
  await readHistoryFolders('codex', [
    { root: join(options.home, 'sessions'), prefix: 'sessions', accept },
    { root: join(options.home, 'archived_sessions'), prefix: 'archived_sessions', accept },
  ], reader(options, new PassMemory()), sink, signal)
}
