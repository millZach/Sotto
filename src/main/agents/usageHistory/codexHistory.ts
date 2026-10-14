import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { UsageTokens } from '../../../shared/threadUsage'
import { USAGE_CLIENTS, type UsageClient, type UsageHistoryCursor, type UsageTokenObservation } from '../../../shared/usageDashboard'
import { codexEntryKey, nativeUsageKey } from '../nativeUsage'
import { byFileName, dated, historyFileName, historyFiles, identity, object, readHistoryFile, type HistoryBatch, type HistoryFile, type HistoryFileReader } from './files'
import { usageHistoryCursorKey, usageHistoryMessageId, usageHistoryRecordKey, usageHistoryThreadId, type UsageHistorySink } from './sink'

/**
 * Codex's own session rollouts on this computer: `<CODEX_HOME>/sessions/**\/rollout-*.jsonl` and
 * `archived_sessions` (ADR-0080). Each line is parsed, its numbers, instant, served model and client kept, and the
 * line dropped.
 *
 * Forked and sub-agent rollouts begin with a copy of their parent's history, with or without the parent's own
 * `session_meta`. Every record is attributed to the session that produced it (the parent the rollout names, a copied
 * meta, a usage record's own `thread_id`), so a copy is the parent's row under the parent's identity and counts once.
 * The copy ends at the first running total its parent never had; a parent the pass has not read is read for its
 * running totals first, numbers only. `subagent_history_start_ordinal` is not that boundary: on the checked laptop it
 * equalled each rollout's whole line count while its copy ended far sooner.
 *
 * Newer rollouts report each request twice: a `token_usage_record` and, just after it, a `token_count` with the same
 * request figures. That `token_count` is skipped; every other one (a session's history from before Codex wrote
 * records) is its own request.
 */
export interface CodexHistoryOptions {
  /** `CODEX_HOME`, as the adapter finds it. */
  readonly home: string
  /** Each native thread Sotto owns, by Codex thread ID, to the adapter's own thread ID. */
  readonly owned: ReadonlyMap<string, string>
}

const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
const PARENT_DEPTH_MAX = 8
/** A first line longer than this is not a session's meta worth reading for its parent. */
const META_LINE_MAX_BYTES = 16 * 1024 * 1024

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
const fields = (value: unknown): (number | null)[] => {
  const row = object(value)
  return [row.input_tokens, row.cached_input_tokens, row.output_tokens, row.reasoning_output_tokens, row.total_tokens].map(field => count(field) ?? null)
}
/** One request's own figures, exact enough that only the same request repeats them next to each other. */
const figures = (last: unknown): string => JSON.stringify(fields(last))
/** A request's running totals and its own figures, exact enough that within one session only a copy repeats them. */
const tuple = (total: unknown, last: unknown): string => JSON.stringify([fields(total), fields(last)])

interface WaitingTurn { readonly turn: string; readonly at: string; readonly session: Session }
interface FileState {
  own: ({ id: Session } & SessionMeta) | undefined
  /** The sessions whose copied history this file is in, innermost last, until its own work begins. */
  copied: Session[]
  /** The current turn's own ID. It is never saved: a resumed reading reads again from the line that opened it. */
  turn: string | undefined
  /** This state's saved form just before the line that opened the current turn, and that line's first byte. */
  mark: { readonly at: number; readonly saved: SavedState } | undefined
  model: string | undefined
  /** The request figures of the record just before, which the `token_count` after it repeats. */
  afterRecord: string | undefined
  /** The last `token_count`'s running total and figures, which Codex repeats at a turn's edge; kept across passes. */
  lastCount: string | undefined
  /** This reading began at the file's first line. */
  fresh: boolean
  /** The rollout names a session it was forked or spawned from, so it may begin with that session's history. */
  derived: boolean
  /** Lines before this reading's start. */
  base: number
  readonly turnModels: Map<string, string>
  readonly turnOwners: Map<string, Session>
  readonly waiting: WaitingTurn[]
}
/** Version 1 saved the current turn's own ID; a cursor it saved is read again from the file's start. */
const stateSchemaVersion = 2
/** What a cursor keeps between passes: hashed sessions, numbers and a model name, never a native ID. */
interface SavedState {
  readonly v: number
  readonly own: { readonly id: Session; readonly client: UsageClient; readonly sub: boolean; readonly parent?: Session }
  readonly copied?: Session[]
  readonly derived?: boolean
  readonly after?: string
  readonly lines: number
  readonly model?: string
}
function savedState(state: FileState, own: NonNullable<FileState['own']>, lines: number): SavedState {
  return { v: stateSchemaVersion, own: { id: own.id, client: own.client, sub: own.subAgent, ...(own.parent ? { parent: own.parent } : {}) },
    ...(state.copied.length > 0 ? { copied: [...state.copied] } : {}), ...(state.derived ? { derived: true } : {}),
    ...(state.afterRecord !== undefined ? { after: state.afterRecord } : {}), ...(state.lastCount !== undefined ? { last: state.lastCount } : {}), lines, ...(state.model ? { model: state.model } : {}) }
}

/** What one pass remembers across files. */
class PassMemory {
  readonly responses = new Set<string>()
  /** Records with no response ID, by session and figures. */
  readonly recordTuples = new Set<string>()
  readonly turns = new Set<string>()
  constructor(
    /** Learns running totals and counts nothing: a parent read only to tell where a fork's copy ends. */
    readonly learning = false,
    readonly metas = new Map<Session, SessionMeta>(),
    /** Every running total met this pass, by the session it belongs to; true once this pass counted it. */
    readonly totals = new Map<Session, Map<string, boolean>>(),
    /** Sessions whose whole rollout this pass has read, so every running total they have is in `totals`. */
    readonly loaded = new Set<Session>(),
    /** The session each running total met this pass belongs to, whichever file it was read in. */
    readonly holders = new Map<string, Session>(),
  ) {}
  learner(): PassMemory { return new PassMemory(true, this.metas, this.totals, this.loaded, this.holders) }
  totalsOf(session: Session): Map<string, boolean> {
    let found = this.totals.get(session)
    if (!found) { found = new Map(); this.totals.set(session, found) }
    return found
  }
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
  const current = (state: FileState): Session | undefined => state.copied.at(-1) ?? state.own?.id
  const observation = (who: Owner, entry: string, turn: string | undefined, model: string | undefined, tokens: UsageTokens, at: string): UsageTokenObservation => {
    const partial = tokens.input === undefined || tokens.output === undefined
    const base = { providerId: 'codex' as const, modelId: model ?? 'unknown', tokens: { ...tokens }, at, phase: 'replay' as const, partial, origin: 'history' as const,
      ...(who.subAgent ? { subAgent: true } : {}) }
    if (who.owned !== undefined) {
      return { ...base, threadId: who.owned, recordKey: nativeUsageKey('codex', 'row', who.owned, entry),
        ...(turn !== undefined ? { groupKey: nativeUsageKey('codex', 'group', who.owned, turn) } : {}) }
    }
    return { ...base, threadId: who.threadId, recordKey: usageHistoryRecordKey('codex', who.threadId, entry),
      source: who.client === 'sotto' ? 'sotto' : 'outside', ...(who.client === 'sotto' ? {} : { client: who.client }) }
  }
  const modelOf = (state: FileState, turn: string | undefined): string | undefined => (turn !== undefined ? state.turnModels.get(turn) : undefined) ?? state.model
  return {
    needles: [Buffer.from('"session_meta"'), Buffer.from('"turn_context"'), Buffer.from('token_usage_record'), Buffer.from('"token_count"'), Buffer.from('"task_started"')],
    start(_file, saved): FileState {
      const state: FileState = { own: undefined, copied: [], turn: undefined, mark: undefined, model: undefined, afterRecord: undefined, lastCount: undefined,
        fresh: saved === undefined, derived: false, base: 0, turnModels: new Map(), turnOwners: new Map(), waiting: [] }
      try {
        const value = object(saved === undefined ? undefined : JSON.parse(saved))
        const own = object(value.own)
        if (value.v === stateSchemaVersion && typeof own.id === 'string' && own.id.length > 0) {
          const client = typeof own.client === 'string' && (USAGE_CLIENTS as readonly string[]).includes(own.client) ? own.client as UsageClient : 'other'
          state.own = { id: own.id, client, subAgent: own.sub === true, ...(typeof own.parent === 'string' ? { parent: own.parent } : {}) }
          if (!memory.metas.has(state.own.id)) memory.metas.set(state.own.id, state.own)
          // The first readers saved one copied session as a string.
          const copied: unknown[] = typeof value.copied === 'string' ? [value.copied] : Array.isArray(value.copied) ? value.copied : []
          state.copied = copied.filter((session): session is string => typeof session === 'string' && session.length > 0).slice(-PARENT_DEPTH_MAX)
          state.base = count(value.lines) ?? 0; state.derived = value.derived === true
          if (typeof value.after === 'string' && value.after.length <= 256) state.afterRecord = value.after
          if (typeof value.last === 'string' && value.last.length <= 512) state.lastCount = value.last
          if (typeof value.model === 'string' && value.model.length > 0) state.model = value.model
        }
      } catch { /* A fresh start. */ }
      return state
    },
    line(text, state, batch, index, offset): void {
      let frame: Record<string, unknown>
      try { frame = object(JSON.parse(text)) } catch { return }
      const payload = object(frame.payload)
      const line = state.base + index
      if (frame.type === 'session_meta') {
        const nativeId = identity(payload.id) ? payload.id : identity(payload.session_id) ? payload.session_id : undefined
        if (nativeId === undefined) return
        const id = sessionOf(nativeId)
        const meta = sessionMeta(payload)
        if (!memory.metas.has(id)) memory.metas.set(id, meta)
        if (state.own === undefined) {
          state.own = { id, ...meta }
          // Read from its first line to its last in this pass, before any other file.
          if (state.fresh && line === 0) memory.loaded.add(id)
          // A fork or subagent rollout begins with a copy of the session it came from, whether or not that session's
          // own header is copied too (older rollouts leave it out). The copy ends at the first running total that
          // session never had, so a child that copied nothing leaves it at its first count.
          const source = identity(payload.forked_from_id) ? sessionOf(payload.forked_from_id) : meta.parent
          state.derived = source !== undefined && source !== id
          if (state.derived && state.fresh && line === 0) state.copied = [source!]
        } else if (id === state.own.id) state.copied = []
        else if (!state.copied.includes(id) && state.copied.length < PARENT_DEPTH_MAX) state.copied.push(id)
        return
      }
      const own = state.own
      if (own === undefined) return
      const at = dated(frame.timestamp)
      // A resumed reading begins again at the line that opened the current turn, so the turn's own ID is never saved.
      const opens = (turn: string): void => { if (turn !== state.turn) state.mark = { at: offset, saved: savedState(state, own, line) } }
      if (frame.type === 'turn_context') {
        const model = typeof payload.model === 'string' && payload.model.length > 0 ? payload.model : undefined
        if (identity(payload.turn_id)) { opens(payload.turn_id); state.turn = payload.turn_id }
        if (model !== undefined) { state.model = model; if (state.turn !== undefined) state.turnModels.set(state.turn, model) }
        return
      }
      const kind = frame.type === 'event_msg' ? payload.type : frame.type === 'token_usage_record' || payload.type === 'token_usage_record' ? 'token_usage_record' : undefined
      if (kind === 'task_started') {
        if (!identity(payload.turn_id)) return
        opens(payload.turn_id)
        state.turn = payload.turn_id
        const session = current(state)
        if (at !== undefined && session !== undefined && !memory.learning) state.waiting.push({ turn: payload.turn_id, at, session })
        return
      }
      if (kind === 'token_usage_record') {
        const last = payload.usage ?? payload.turn_token_usage
        state.afterRecord = figures(last)
        const thread = identity(payload.thread_id) ? sessionOf(payload.thread_id) : current(state)
        if (thread === undefined) return
        if (thread === own.id) state.copied = []
        else if (state.copied.includes(thread)) state.copied = state.copied.slice(0, state.copied.indexOf(thread) + 1)
        const turn = identity(payload.turn_id) ? payload.turn_id : state.turn
        if (turn !== undefined) state.turnOwners.set(turn, thread)
        if (memory.learning || at === undefined) return
        const response = identity(payload.response_id) ? payload.response_id : undefined
        // A response is one request wherever it is copied; equal figures in two responses are two requests.
        if (response !== undefined) { if (memory.responses.has(response)) return; memory.responses.add(response) } else {
          const key = JSON.stringify([thread, tuple(payload.thread_token_usage, last)])
          if (memory.recordTuples.has(key)) return
          memory.recordTuples.add(key)
        }
        const tokens = rolloutTokens(last)
        if (!Object.values(tokens).some(value => value !== undefined)) return
        const entry = response !== undefined ? `response:${response}`
          : payload.thread_token_usage !== undefined && turn !== undefined ? codexEntryKey(turn, rolloutTokens(payload.thread_token_usage)) : undefined
        if (entry === undefined) return
        const who = owner(thread, own)
        // Sotto's live ledger keyed a thread's rows by the running total its token_count events carry, which
        // thread_token_usage does not always equal, so a Sotto thread's rows come from those events.
        if (who.owned !== undefined) return
        batch.tokens.push(observation(who, entry, turn, modelOf(state, turn), tokens, at))
        return
      }
      if (kind === 'token_count') {
        const info = object(payload.info)
        if (info.total_token_usage === undefined || info.last_token_usage === undefined) return
        const key = tuple(info.total_token_usage, info.last_token_usage)
        // A repeat of the count just before adds nothing, whether or not this pass read that count.
        if (key === state.lastCount) return
        state.lastCount = key
        const paired = state.afterRecord !== undefined && state.afterRecord === figures(info.last_token_usage)
        state.afterRecord = undefined
        // A running total the copied session never had is the end of its copy.
        while (state.copied.length > 0 && memory.totals.get(state.copied.at(-1)!)?.has(key) !== true) state.copied.pop()
        const session = current(state)
        if (session === undefined) return
        if (state.turn !== undefined && !state.turnOwners.has(state.turn)) state.turnOwners.set(state.turn, session)
        // A subagent's named parent is not always the session its history came from (a nested subagent can name the
        // thread at the top), so in a forked or spawned rollout a total some other session read this pass already
        // holds is a copy of that session. Unrelated sessions with equal figures are never forks of each other.
        const holder = memory.holders.get(key)
        if (state.derived && state.copied.length === 0 && holder !== undefined && holder !== session) {
          const mine = memory.totalsOf(own.id); if (!mine.has(key)) mine.set(key, false)
          return
        }
        if (holder === undefined) memory.holders.set(key, session)
        const totals = memory.totalsOf(session)
        const seen = totals.get(key)
        // A total this file holds as a copy is part of its own history too, counted elsewhere, so a subagent of this
        // session that copies it in turn still knows it for a copy (Codex app subagents nest).
        if (session !== own.id) { const mine = memory.totalsOf(own.id); if (!mine.has(key)) mine.set(key, false) }
        if (memory.learning) { if (seen === undefined) totals.set(key, false); return }
        // Counted already in this pass, or a copy of a session whose own reading counts it.
        if (seen === true || (seen === false && state.copied.length > 0)) return
        totals.set(key, true)
        if (at === undefined) return
        const last = rolloutTokens(info.last_token_usage)
        if (!Object.values(last).some(value => value !== undefined)) return
        const who = owner(session, own)
        // The record just before reported this request; a Sotto thread's rows come from these events alone.
        if (paired && who.owned === undefined) return
        const entry = who.owned !== undefined ? codexEntryKey(state.turn, rolloutTokens(info.total_token_usage)) : `count:${key}`
        batch.tokens.push(observation(who, entry, state.turn, modelOf(state, state.turn), last, at))
      }
    },
    settle(state, batch: HistoryBatch): void {
      if (state.own !== undefined) {
        for (const waiting of state.waiting) {
          if (memory.turns.has(waiting.turn)) continue
          memory.turns.add(waiting.turn)
          const session = state.turnOwners.get(waiting.turn) ?? waiting.session
          const who = owner(session, state.own)
          // Sotto's own prompts come from its thread store; a sub-agent's turns are never prompts.
          if (who.owned !== undefined || who.subAgent || who.client === 'sotto') continue
          batch.prompts.push({ providerId: 'codex', threadId: who.threadId, messageId: usageHistoryMessageId('codex', waiting.turn),
            modelId: state.turnModels.get(waiting.turn) ?? state.model ?? 'unknown', at: waiting.at, kind: 'user', source: 'outside', client: who.client })
        }
      }
      state.waiting.length = 0
      // Only the current turn's model is needed to resume; earlier turns are settled.
      for (const turn of [...state.turnModels.keys()]) if (turn !== state.turn) state.turnModels.delete(turn)
      for (const turn of [...state.turnOwners.keys()]) if (turn !== state.turn) state.turnOwners.delete(turn)
    },
    save(state, lines): string | undefined {
      if (state.own === undefined) return undefined
      // Inside a turn, keep the state its opening line met: the next reading learns the turn from that line again.
      if (state.turn !== undefined && state.mark !== undefined) return JSON.stringify({ ...state.mark.saved, at: state.mark.at })
      return JSON.stringify(savedState(state, state.own, state.base + lines))
    },
    resumeAt(saved): number | undefined {
      try {
        const value = object(JSON.parse(saved))
        return value.v === stateSchemaVersion ? count(value.at) : 0
      } catch { return 0 }
    },
  }
}

/** A rollout's first line, if it is its session's meta: the session and the sessions it was copied from. */
interface RolloutHead { readonly id: string; readonly parents: readonly string[] }
async function rolloutHead(path: string): Promise<RolloutHead | undefined> {
  let handle
  try { handle = await open(path, 'r') } catch { return undefined }
  try {
    const chunks: Buffer[] = []
    let read = 0
    for (;;) {
      const chunk = Buffer.alloc(64 * 1024)
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, read)
      if (bytesRead === 0) break
      const end = chunk.subarray(0, bytesRead).indexOf(0x0a)
      chunks.push(chunk.subarray(0, end === -1 ? bytesRead : end))
      read += bytesRead
      if (end !== -1) break
      if (read > META_LINE_MAX_BYTES) return undefined
    }
    const frame = object(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    const payload = object(frame.payload)
    if (frame.type !== 'session_meta') return undefined
    const id = identity(payload.id) ? payload.id : identity(payload.session_id) ? payload.session_id : undefined
    if (id === undefined) return undefined
    const parents = [...new Set([payload.forked_from_id, payload.parent_thread_id].filter(identity))].filter(parent => parent !== id)
    return { id, parents }
  } catch { return undefined } finally { await handle.close() }
}

/** A sink that keeps nothing: a parent read for its running totals alone. */
const discard: UsageHistorySink = { tokens: () => undefined, prompts: () => undefined, cursor: () => undefined, setCursors: () => undefined }

/**
 * Before a fork or sub-agent rollout is read from its start, its parent's running
 * totals must be in the pass's memory, or the copy would look like the fork's own work. A parent this pass has not
 * read whole is read for those totals alone, through the same reader, counting nothing.
 */
class ForkParents {
  private readonly tried = new Set<Session>()
  private readonly learn: HistoryFileReader<FileState>
  constructor(private readonly files: readonly HistoryFile[], options: CodexHistoryOptions, private readonly memory: PassMemory, private readonly signal: AbortSignal) {
    this.learn = reader(options, memory.learner())
  }

  async prepare(file: HistoryFile, cursor: UsageHistoryCursor | undefined): Promise<void> {
    if (cursor !== undefined) {
      // A file already read past its copy, or not changed since, needs nothing.
      if (cursor.state === undefined || !cursor.state.includes('"copied"')) return
      try {
        const info = await stat(file.path)
        if (info.size === cursor.size && Math.max(0, Math.floor(info.mtimeMs)) === cursor.mtimeMs && cursor.offset >= info.size) return
      } catch { return }
    }
    const head = await rolloutHead(file.path)
    if (head === undefined) return
    for (const parent of head.parents) await this.load(parent, 0)
  }

  private async load(nativeId: string, depth: number): Promise<void> {
    const session = sessionOf(nativeId)
    if (depth > PARENT_DEPTH_MAX || this.memory.loaded.has(session) || this.tried.has(session) || this.signal.aborted) return
    this.tried.add(session)
    const found = await this.find(nativeId)
    if (found === undefined) return
    for (const parent of found.head.parents) await this.load(parent, depth + 1)
    if (await readHistoryFile('codex', found.file, this.learn, discard, this.signal)) this.memory.loaded.add(session)
  }

  /** A rollout's file name ends with its session's ID; its first line says so. */
  private async find(nativeId: string): Promise<{ file: HistoryFile; head: RolloutHead } | undefined> {
    for (const file of this.files) {
      const name = historyFileName(file)
      if (name !== `rollout-${nativeId}.jsonl` && !name.endsWith(`-${nativeId}.jsonl`)) continue
      const head = await rolloutHead(file.path)
      if (head?.id === nativeId) return { file, head }
    }
    return undefined
  }
}

/** One pass over Codex's rollouts, resuming each file from its cursor. */
export async function scanCodexHistory(options: CodexHistoryOptions, sink: UsageHistorySink, signal: AbortSignal): Promise<void> {
  const accept = (name: string): boolean => name.startsWith('rollout-') && name.endsWith('.jsonl')
  const files: HistoryFile[] = []
  for (const prefix of ['sessions', 'archived_sessions']) {
    for (const file of await historyFiles(join(options.home, prefix), accept, signal)) files.push({ path: file.path, relativePath: `${prefix}/${file.relativePath}` })
  }
  // In name order across both folders, so a parent's rollout is read before its forks.
  files.sort(byFileName)
  const memory = new PassMemory()
  const read = reader(options, memory)
  const parents = new ForkParents(files, options, memory, signal)
  for (const file of files) {
    if (signal.aborted) return
    await parents.prepare(file, sink.cursor(usageHistoryCursorKey('codex', file.relativePath)))
    if (!await readHistoryFile('codex', file, read, sink, signal)) return
  }
}
