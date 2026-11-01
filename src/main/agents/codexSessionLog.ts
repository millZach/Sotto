import { createHash } from 'node:crypto'
import { open, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { AGENT_MAX_ATTACHMENT_BYTES, type AgentMessage } from '../../shared/agents'
import { CodexRolloutIdentities, rolloutIdentitiesStateSchema, type RolloutIdentity } from './codexMessageIdentity'
import { isAttachedFilesNote, stripAttachedFilesNote } from './attachedFiles'
import { AtomicJsonStore } from '../storage/atomicJsonStore'

export const promptDigest = (text: string): string => createHash('sha256').update(text).digest('hex')
type TextContent = { type: string; text?: string | undefined }[]
/** A message's text items, joined. */
export const textOf = (content?: TextContent): string => (content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n')
/**
 * A user message's text items without one that is exactly the note naming attached files, which Sotto sends apart from
 * the user's words (ADR-0131). Readers use it only when the message's origin recorded an attached file.
 */
export const wordsOf = (content?: TextContent): string => (content ?? [])
  .filter(c => c.type === 'text' && !isAttachedFilesNote(c.text ?? '')).map(c => c.text ?? '').join('\n')
// An authored rollout row can contain the full accepted image batch as base64.
const MAX_ROLLOUT_LINE_BYTES = Math.ceil(AGENT_MAX_ATTACHMENT_BYTES / 3) * 4 + 1024 * 1024
const entrySchema = z.object({ timestamp: z.string(), ordinal: z.number().optional(), type: z.string(), payload: z.unknown() })
const textContent = z.array(z.object({ type: z.string(), text: z.string().optional() }))
const userEvent = z.object({ type: z.string(), id: z.string().optional(), message: z.string().optional(), text: z.string().optional(),
  client_id: z.string().nullish(), images: z.array(z.string()).optional(), local_images: z.array(z.string()).optional(),
  content: textContent.optional(), item: z.object({ type: z.string(), id: z.string().optional(), client_id: z.string().nullish(), content: textContent.optional() }).optional() })
type Tail = { path?: string | undefined; locateAfter: number; locateBackoffMs: number; locateGeneration: number; offset: number; buffer: Buffer[]; bufferedBytes: number; discarding: boolean; own: Map<string, string>; files: Set<string>; seen: Set<string>; identities: CodexRolloutIdentities
  /** Where the line being read began: everything before it has been read whole, and is what a saved position stands for. */
  lineStart: number
  /**
   * The rollout's identity when it was last read. What the tail holds stands for that file only: one found in its place,
   * restored from a saved position or not, is read from its first byte.
   */
  file?: FileIdentity | undefined
  /** Whether the tail has read its rollout to the end once, or holds a saved position that had. */
  caughtUp: boolean
  /** Its saved position: not looked for yet, to be read before the tail first reads, or dealt with. */
  saved: 'unknown' | 'pending' | 'settled'
  /** Read past its saved position, so it is saved again. */
  dirty: boolean
  /** The last read failed, so the next tick reads it again. */
  retry: boolean }
const INITIAL_LOCATE_BACKOFF_MS = 2000
const MAX_LOCATE_BACKOFF_MS = 60_000
/**
 * How long a tail that read on waits before its position is saved. A position saved late costs only a re-read of what
 * came after it at the next start, so a streaming thread saves twice a minute rather than with every line; stopping
 * saves every tail.
 */
const SAVE_DELAY_MS = 30_000

type FileIdentity = { readonly ino?: string | undefined; readonly birthtimeMs?: number | undefined }
function identityOf(stats: { readonly ino: number | bigint; readonly birthtimeMs: number }): FileIdentity {
  return { ...(stats.ino ? { ino: String(stats.ino) } : {}), ...(Number.isFinite(stats.birthtimeMs) ? { birthtimeMs: stats.birthtimeMs } : {}) }
}
/** Some Windows filesystems report no inode; the creation time is then the only identity on offer. */
function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  if (left.ino || right.ino) return Boolean(left.ino && right.ino && left.ino === right.ino)
  return left.birthtimeMs !== undefined && right.birthtimeMs !== undefined && Math.abs(left.birthtimeMs - right.birthtimeMs) < 1
}

/**
 * How far a thread's rollout has been read, saved so a later run reads on from there rather than from the first byte
 * (#992): the start of the first line not yet read whole, the file's identity, and what reading up to there gave, the
 * user messages already reported and each turn's identity rows. A tail restored from it holds what one that read the
 * rollout from its first byte to there holds.
 */
export const rolloutPositionSchema = z.object({ path: z.string(), offset: z.number().int().nonnegative(), ino: z.string().optional(), birthtimeMs: z.number().optional(),
  seen: z.array(z.string()), identities: rolloutIdentitiesStateSchema })
export type RolloutPosition = z.infer<typeof rolloutPositionSchema>
/** Where saved rollout positions are kept, one for each thread, by its Codex thread ID. */
export interface RolloutPositions {
  /** The threads that have a saved position. */
  list(): Promise<ReadonlySet<string>>
  load(threadId: string): Promise<RolloutPosition | undefined>
  save(threadId: string, position: RolloutPosition): Promise<void>
  remove(threadId: string): Promise<void>
}

const savedPositionSchema = rolloutPositionSchema.nullable()
/** A Codex thread ID, which names its saved position's file. */
const CODEX_THREAD_ID = /^[A-Za-z0-9-]+$/u

/** Saved rollout positions as files in one folder, each named by its thread's Codex thread ID and written compact. */
export class RolloutPositionFiles implements RolloutPositions {
  private readonly stores = new Map<string, AtomicJsonStore<RolloutPosition | null>>()
  constructor(private readonly directory: string) {}
  async list(): Promise<ReadonlySet<string>> {
    const names = await readdir(this.directory).catch(() => [] as string[])
    return new Set(names.filter(name => name.endsWith('.json')).map(name => name.slice(0, -'.json'.length)).filter(id => CODEX_THREAD_ID.test(id)))
  }
  async load(threadId: string): Promise<RolloutPosition | undefined> { return (await this.store(threadId)?.read()) ?? undefined }
  async save(threadId: string, position: RolloutPosition): Promise<void> { await this.store(threadId)?.write(position) }
  async remove(threadId: string): Promise<void> {
    if (!CODEX_THREAD_ID.test(threadId)) return
    this.stores.delete(threadId)
    await rm(join(this.directory, `${threadId}.json`), { force: true })
  }
  private store(threadId: string): AtomicJsonStore<RolloutPosition | null> | undefined {
    if (!CODEX_THREAD_ID.test(threadId)) return undefined
    let store = this.stores.get(threadId)
    if (!store) { store = AtomicJsonStore.compact(join(this.directory, `${threadId}.json`), savedPositionSchema.parse, () => null); this.stores.set(threadId, store) }
    return store
  }
}

/**
 * The start of every rollout line Codex writes today: its time, maybe its ordinal, its kind and, for most kinds, its
 * payload's kind. Anchored, so the kinds it finds are the line's own and not a nested object's.
 */
const ROLLOUT_HEAD = /\{"timestamp":"[^"\\]*",(?:"ordinal":\d+,)?"type":"([a-z_]+)"(?:,"payload":\{"type":"([A-Za-z_]+)")?/y
/** The payload's keys with plain values, up to a key that matters: one value never holds another key's text. */
const LEADING_KEYS = String.raw`(?:,"[A-Za-z_]+":(?:"(?:[^"\\]|\\.)*"|-?[\d.eE+-]+|true|false|null))*?`
const PAYLOAD_ROLE = new RegExp(`${LEADING_KEYS},"role":"([a-z_]+)"`, 'y')
const PAYLOAD_ITEM = new RegExp(`${LEADING_KEYS},"item":\\{"type":"([A-Za-z_]+)"`, 'y')
/** How much of a line's start `mayBeRead` is shown before the line is kept: past the furthest word it decides by. */
const LINE_HEAD_BYTES = 1024
const READ_EVENTS = new Set(['task_started', 'task_complete', 'user_message', 'agent_message', 'item_completed'])
/**
 * Whether a rollout line may hold anything this reader takes: a turn's context, its start and end, a user's or the
 * agent's message as an event, a completed user message, and the agent's message as a response item
 * (`CodexRolloutIdentities.consume`, and the user messages read below). It is judged from the line's first few hundred
 * characters, so a line's start alone answers for the whole line whenever the answer is no. Every other line, a tool
 * call and its output, reasoning, a user's or the developer's message as a response item, a token count, is skipped
 * before it is joined, decoded or parsed: across the development machine's 1,616 rollouts, 93% of lines and over 99% of
 * bytes (#992). A line that does not start the way Codex writes them today is parsed and checked as before, so the check
 * only spares work it can prove is not needed.
 */
export function mayBeRead(line: string): boolean {
  ROLLOUT_HEAD.lastIndex = 0
  const head = ROLLOUT_HEAD.exec(line)
  if (!head) return true
  const [, kind, payloadKind] = head
  if (kind === 'turn_context') return true
  if (kind !== 'event_msg' && kind !== 'response_item') return false
  if (payloadKind === undefined) return true
  if (kind === 'response_item') {
    if (payloadKind !== 'message') return false
    const role = leading(PAYLOAD_ROLE, line, head[0].length)
    return role === undefined || role === 'assistant'
  }
  if (!READ_EVENTS.has(payloadKind)) return false
  if (payloadKind !== 'item_completed') return true
  const item = leading(PAYLOAD_ITEM, line, head[0].length)
  return item === undefined || item === 'UserMessage' || item === 'user_message'
}
/** The value `pattern` finds among the payload's leading keys, from `at`; none when a nested value comes first. */
function leading(pattern: RegExp, line: string, at: number): string | undefined {
  pattern.lastIndex = at
  return pattern.exec(line)?.[1]
}

/** Rollout event messages are authored input; response_item user messages can be injected instructions. */
export class CodexSessionLogWatcher {
  private readonly tails = new Map<string, Tail>()
  private timer: ReturnType<typeof setInterval> | undefined
  private polling: Promise<void> | undefined
  private wholePoll: Promise<void> | undefined
  private inUsePoll: Promise<void> | undefined
  private readonly reading = new Map<string, Promise<void>>()
  private stopped = false
  /** The threads with a saved position, listed once. */
  private savedThreads: Promise<ReadonlySet<string>> | undefined
  /** The threads in use on the last tick, each read once more on the tick after it leaves them. */
  private lastInUse: ReadonlySet<string> = new Set()
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private saving: Promise<void> = Promise.resolve()
  /**
   * `inUse` names the threads each tick reads: where it is given, the others are read only to catch up once, when they
   * have no saved position, and then when a complete read asks, as opening or sending to a thread does (#992). Absent,
   * every tick reads every tail. `positions` keeps where each tail had read to between runs.
   */
  constructor(private readonly options: { codexHome: string; pollIntervalMs?: number | undefined; onMessage: (threadId: string, message: AgentMessage) => void
    inUse?: (() => ReadonlySet<string>) | undefined; positions?: RolloutPositions | undefined; saveDelayMs?: number | undefined
    /** Whether the tick catches up a tail with no saved position; absent, every one. A tail it leaves catches up when read whole. */
    catchUp?: ((threadId: string) => boolean) | undefined }) {}
  observe(threadId: string): void {
    if (!this.tails.has(threadId)) this.tails.set(threadId, { locateAfter: 0, locateBackoffMs: INITIAL_LOCATE_BACKOFF_MS, locateGeneration: 0, offset: 0, buffer: [], bufferedBytes: 0, discarding: false, own: new Map(), files: new Set(), seen: new Set(), identities: new CodexRolloutIdentities(),
      lineStart: 0, caughtUp: false, saved: this.options.positions ? 'unknown' : 'settled', dirty: false, retry: false })
  }
  identities(threadId: string, turnId: string): readonly RolloutIdentity[] { return this.tails.get(threadId)?.identities.get(turnId) ?? [] }
  /** A prompt Sotto sent, by its words' digest; `files` when it carried an attached file, and so the note (ADR-0131). */
  sent(threadId: string, messageId: string, text: string, files = false): void { this.sentDigest(threadId, messageId, promptDigest(text), files) }
  sentDigest(threadId: string, messageId: string, digest: string, files = false): void {
    this.observe(threadId)
    const tail = this.tails.get(threadId)!
    tail.own.set(messageId, digest)
    if (files) tail.files.add(messageId); else tail.files.delete(messageId)
    tail.locateAfter = 0; tail.locateBackoffMs = INITIAL_LOCATE_BACKOFF_MS
    tail.locateGeneration++
  }
  forget(threadId: string, messageId: string): void { const tail = this.tails.get(threadId); tail?.own.delete(messageId); tail?.files.delete(messageId) }
  /** A deleted thread (ADR-0140): stop tailing its rollout, drop any read in flight for it, and forget where it had read to. */
  drop(threadId: string): void {
    this.tails.delete(threadId); this.reading.delete(threadId)
    // Behind any save under way, so a save that began before the thread went cannot put its position back.
    const positions = this.options.positions
    if (positions) this.saving = this.saving.then(() => positions.remove(threadId)).catch(() => undefined)
  }
  start(): void {
    if (this.timer || this.stopped) return
    this.timer = setInterval(() => { void this.tick() }, this.options.pollIntervalMs ?? 1000)
    this.timer.unref()
  }
  async stop(): Promise<void> {
    this.stopped = true; clearInterval(this.timer); this.timer = undefined; await this.polling; await Promise.all(this.reading.values())
    // Where each tail read to is kept for the next run.
    clearTimeout(this.saveTimer); this.saveTimer = undefined
    await this.savePositions()
  }
  /** A read of every tail, after any tick under way, as a whole read of the provider asks. */
  poll(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    this.wholePoll ??= (this.polling ?? Promise.resolve()).then(() => this.readAll('all')).finally(() => { this.wholePoll = undefined })
    return this.wholePoll
  }
  /**
   * A read of the tails in use and of any whose last read failed, as a read of the provider asks: at connect, or for a
   * snapshot. It waits on no tail catching up, so it costs the same however many threads are saved.
   */
  pollInUse(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    this.inUsePoll ??= (this.polling ?? Promise.resolve()).then(() => this.readAll('in-use')).finally(() => { this.inUsePoll = undefined })
    return this.inUsePoll
  }
  /** What the timer does each second (`readAll`). A tick under way stands for this one. */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    this.polling ??= this.readAll('tick').finally(() => { this.polling = undefined })
    return this.polling
  }
  /** Queue a fresh read behind this tail only; a guarded send cannot reuse a pre-origin read. */
  pollThread(threadId: string, complete = true): Promise<void> {
    if (this.stopped) return Promise.resolve()
    this.observe(threadId)
    const work = (this.reading.get(threadId) ?? Promise.resolve()).then(() => this.read(threadId, complete))
    this.reading.set(threadId, work)
    void work.finally(() => { if (this.reading.get(threadId) === work) this.reading.delete(threadId) })
    return work
  }
  /**
   * `all` reads every tail. `in-use` reads each tail in use and each whose last read failed. A `tick` reads those, each
   * that left the tails in use since the last tick, once, so the last lines of its turn land, and each still catching up
   * to the end of a rollout it has no saved position for, a megabyte a tick.
   */
  private async readAll(mode: 'all' | 'in-use' | 'tick'): Promise<void> {
    const saved = await this.savedPositions()
    const inUse = mode === 'all' ? undefined : this.options.inUse?.()
    const ids: string[] = []
    for (const [id, tail] of this.tails) {
      this.classify(id, tail, saved)
      if (!inUse || inUse.has(id) || tail.retry || mode === 'tick' && (this.lastInUse.has(id) || !tail.caughtUp && (this.options.catchUp?.(id) ?? true))) ids.push(id)
    }
    if (mode === 'tick') this.lastInUse = new Set(inUse)
    // A thread let go meanwhile is not read, which would take up its tail again.
    for (const id of ids) if (this.tails.has(id)) await this.pollThread(id, false)
  }
  private savedPositions(): Promise<ReadonlySet<string>> {
    return this.savedThreads ??= this.options.positions?.list().catch(() => new Set<string>()) ?? Promise.resolve(new Set<string>())
  }
  /** A tail first seen with a saved position counts as read to the end: it reads on from there when it is next read. */
  private classify(threadId: string, tail: Tail, saved: ReadonlySet<string>): void {
    if (tail.saved !== 'unknown') return
    tail.saved = saved.has(threadId) ? 'pending' : 'settled'
    if (saved.has(threadId)) tail.caughtUp = true
  }
  /** Takes up the saved position, while the tail has read nothing; one that cannot be read leaves it reading from the first byte. */
  private async restore(threadId: string, tail: Tail): Promise<void> {
    tail.saved = 'settled'
    const position = await this.options.positions?.load(threadId).catch(() => undefined)
    if (!position || tail.offset !== 0 || tail.lineStart !== 0) { tail.caughtUp = false; return }
    tail.path ??= position.path
    if (tail.path !== position.path) { tail.caughtUp = false; return }
    tail.offset = position.offset; tail.lineStart = position.offset
    tail.file = { ...(position.ino === undefined ? {} : { ino: position.ino }), ...(position.birthtimeMs === undefined ? {} : { birthtimeMs: position.birthtimeMs }) }
    for (const id of position.seen) tail.seen.add(id)
    tail.identities = CodexRolloutIdentities.restore(position.identities)
  }
  /** Back to the first byte, as for a rollout that shrank or is not the one a saved position named. */
  private reset(tail: Tail): void {
    tail.offset = 0; tail.lineStart = 0; tail.buffer = []; tail.bufferedBytes = 0; tail.discarding = false; tail.identities = new CodexRolloutIdentities()
    tail.caughtUp = false
  }
  private scheduleSave(): void {
    if (this.saveTimer || this.stopped || !this.options.positions) return
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; void this.savePositions() }, this.options.saveDelayMs ?? SAVE_DELAY_MS)
    this.saveTimer.unref()
  }
  /** Saves each tail that read on since it was last saved. A save that fails is tried again with the next. */
  private savePositions(): Promise<void> {
    const positions = this.options.positions
    if (!positions) return Promise.resolve()
    this.saving = this.saving.then(async () => {
      for (const [threadId, tail] of this.tails) {
        if (!tail.dirty || !tail.path || !tail.file) continue
        tail.dirty = false
        const position: RolloutPosition = { path: tail.path, offset: tail.lineStart, ...tail.file, seen: [...tail.seen], identities: tail.identities.snapshot() }
        try { await positions.save(threadId, position) } catch { tail.dirty = true }
      }
    })
    return this.saving
  }
  private async locate(directory: string, threadId: string, depth = 0): Promise<string | undefined> {
    if (depth > 3) return
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${threadId}.jsonl`)) return join(directory, entry.name)
      if (entry.isDirectory()) { const found = await this.locate(join(directory, entry.name), threadId, depth + 1); if (found) return found }
    }
  }
  private async read(threadId: string, complete: boolean): Promise<void> {
    // A thread let go while this read waited its turn has nothing to read.
    const tail = this.tails.get(threadId)
    if (!tail || this.stopped) return
    try {
      if (tail.saved === 'unknown') this.classify(threadId, tail, await this.savedPositions())
      if (tail.saved === 'pending') await this.restore(threadId, tail)
      if (!tail.path) {
        // Complete reads protect a dispatch and must search for new evidence now.
        if (!complete && Date.now() < tail.locateAfter) return
        const generation = tail.locateGeneration
        tail.path = await this.locate(join(this.options.codexHome, 'sessions'), threadId)
        if (!tail.path) {
          // A send during this search keeps its immediate retry, even if this
          // older lookup missed the file before Codex created it.
          if (!complete && generation === tail.locateGeneration) {
            tail.locateAfter = Date.now() + tail.locateBackoffMs
            tail.locateBackoffMs = Math.min(tail.locateBackoffMs * 2, MAX_LOCATE_BACKOFF_MS)
          }
          // Nothing to catch up on: a thread not in use finds its rollout when it is next read whole.
          tail.caughtUp = true; tail.retry = false
          return
        }
        tail.locateAfter = 0; tail.locateBackoffMs = INITIAL_LOCATE_BACKOFF_MS
      }
      const file = await open(tail.path, 'r')
      const lineStart = tail.lineStart
      try {
        const stats = await file.stat()
        const size = stats.size
        // A saved position is trusted only for the file it was taken from, and only while that file is not shorter.
        if (tail.file && !sameFile(tail.file, identityOf(stats))) this.reset(tail)
        tail.file = identityOf(stats)
        if (size < tail.offset) this.reset(tail)
        // Background polls stay bounded. A guarded target read reaches the captured
        // file size with bounded buffers so takeover evidence is never truncated.
        do {
          const buffer = Buffer.alloc(Math.min(size - tail.offset, 1024 * 1024))
          const { bytesRead } = await file.read(buffer, 0, buffer.length, tail.offset)
          if (!bytesRead) break
          const base = tail.offset
          tail.offset += bytesRead
          let start = 0
          while (start < bytesRead) {
            const newline = buffer.indexOf(10, start)
            const end = newline < 0 ? bytesRead : newline
            const part = buffer.subarray(start, end)
            // A line whose first characters show it holds nothing this reader takes is neither kept, joined nor decoded.
            // Latin-1 keeps every ASCII character the check looks for where UTF-8 has it, and cannot split one (#992).
            if (!tail.discarding && tail.bufferedBytes === 0 && !mayBeRead(part.toString('latin1', 0, Math.min(part.length, LINE_HEAD_BYTES)))) tail.discarding = true
            if (!tail.discarding) {
              tail.buffer.push(part); tail.bufferedBytes += part.length
              if (tail.bufferedBytes > MAX_ROLLOUT_LINE_BYTES) {
                tail.buffer = []; tail.bufferedBytes = 0; tail.discarding = true
              }
            }
            // Stopped, a line is left unread, so the position saved for the next run comes before it rather than past input
            // that was never reported.
            if (newline < 0 || this.stopped) break
            if (!tail.discarding) this.consume(threadId, tail, Buffer.concat(tail.buffer, tail.bufferedBytes).toString('utf8'))
            tail.buffer = []; tail.bufferedBytes = 0; tail.discarding = false
            start = newline + 1
            tail.lineStart = base + start
          }
        } while (complete && tail.offset < size && !this.stopped)
        if (tail.offset >= size) tail.caughtUp = true
      } finally { await file.close() }
      tail.retry = false
      if (tail.lineStart !== lineStart) { tail.dirty = true; this.scheduleSave() }
    } catch (error) {
      // A rollout may not exist yet, rotate, or be temporarily locked by Codex; the next tick reads it again. One gone from
      // where it was is looked for again, and its saved position kept only if it is the same file somewhere else.
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' && tail.path) {
        tail.path = undefined; tail.locateAfter = 0; tail.locateBackoffMs = INITIAL_LOCATE_BACKOFF_MS
      }
      tail.retry = true
    }
  }
  private consume(threadId: string, tail: Tail, line: string): void {
    if (!mayBeRead(line)) return
    try {
      const entry = entrySchema.parse(JSON.parse(line))
      tail.identities.consume(entry)
      if (entry.type !== 'event_msg') return
      const event = userEvent.parse(entry.payload)
      const item = event.type === 'item_completed' && ['UserMessage', 'user_message'].includes(event.item?.type ?? '') ? event.item : undefined
      if (!item && event.type !== 'user_message') return
      const clientId = item?.client_id ?? event.client_id
      // A rollout's `message` may join the input's text items, the note naming attached files among them. It comes off
      // only for a prompt Sotto sent with an attached file, found by its client ID or, without one, by its words (ADR-0131).
      const all = item ? textOf(item.content) : event.message ?? event.text ?? textOf(event.content)
      const words = item ? wordsOf(item.content) : stripAttachedFilesNote(all)
      const sentWithFiles = (digest: string): boolean => clientId ? tail.files.has(clientId) && tail.own.get(clientId) === digest
        : [...tail.files].some(messageId => tail.own.get(messageId) === digest)
      const text = words !== all && sentWithFiles(promptDigest(words)) ? words : all
      const hasImages = (event.images?.length ?? 0) > 0 || (event.local_images?.length ?? 0) > 0
        || (item?.content ?? event.content)?.some(part => part.type === 'image' || part.type === 'localImage')
      if (!text && !hasImages) return
      const id = item?.id ?? event.id ?? `rollout:${promptDigest(`${entry.ordinal ?? entry.timestamp}:${text}`)}`
      if (tail.seen.has(id)) return
      tail.seen.add(id)
      const digest = promptDigest(text)
      const conflictingClient = item?.client_id && event.client_id && item.client_id !== event.client_id
      if (!conflictingClient && clientId && tail.own.get(clientId) === digest) return
      // No-client legacy rows stay unowned until complete turn history can
      // corroborate an exact alias. Text alone must not hide native input.
      if (!this.stopped) this.options.onMessage(threadId, { id, role: 'user', text, createdAt: entry.timestamp })
    } catch { /* Partial, malformed and unrelated rollout entries do not transfer authority. */ }
  }
}
