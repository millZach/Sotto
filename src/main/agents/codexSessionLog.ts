import { createHash } from 'node:crypto'
import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { AGENT_MAX_ATTACHMENT_BYTES, type AgentMessage } from '../../shared/agents'
import { CodexRolloutIdentities, type RolloutIdentity } from './codexMessageIdentity'

export const promptDigest = (text: string): string => createHash('sha256').update(text).digest('hex')
export const textOf = (content?: { type: string; text?: string | undefined }[]): string => (content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n')
// An authored rollout row can contain the full accepted image batch as base64.
const MAX_ROLLOUT_LINE_BYTES = Math.ceil(AGENT_MAX_ATTACHMENT_BYTES / 3) * 4 + 1024 * 1024
const entrySchema = z.object({ timestamp: z.string(), ordinal: z.number().optional(), type: z.string(), payload: z.unknown() })
const textContent = z.array(z.object({ type: z.string(), text: z.string().optional() }))
const userEvent = z.object({ type: z.string(), id: z.string().optional(), message: z.string().optional(), text: z.string().optional(),
  client_id: z.string().nullish(), images: z.array(z.string()).optional(), local_images: z.array(z.string()).optional(),
  content: textContent.optional(), item: z.object({ type: z.string(), id: z.string().optional(), content: textContent.optional() }).optional() })
type Tail = { path?: string | undefined; offset: number; buffer: Buffer[]; bufferedBytes: number; discarding: boolean; own: Map<string, string>; seen: Set<string>; identities: CodexRolloutIdentities }

/** Rollout event messages are authored input; response_item user messages can be injected instructions. */
export class CodexSessionLogWatcher {
  private readonly tails = new Map<string, Tail>()
  private timer: ReturnType<typeof setInterval> | undefined
  private polling: Promise<void> | undefined
  private readonly reading = new Map<string, Promise<void>>()
  private stopped = false
  constructor(private readonly options: { codexHome: string; pollIntervalMs?: number | undefined; onMessage: (threadId: string, message: AgentMessage) => void }) {}
  observe(threadId: string): void {
    if (!this.tails.has(threadId)) this.tails.set(threadId, { offset: 0, buffer: [], bufferedBytes: 0, discarding: false, own: new Map(), seen: new Set(), identities: new CodexRolloutIdentities() })
  }
  identities(threadId: string, turnId: string): readonly RolloutIdentity[] { return this.tails.get(threadId)?.identities.get(turnId) ?? [] }
  sent(threadId: string, messageId: string, text: string): void { this.sentDigest(threadId, messageId, promptDigest(text)) }
  sentDigest(threadId: string, messageId: string, digest: string): void { this.observe(threadId); this.tails.get(threadId)!.own.set(messageId, digest) }
  forget(threadId: string, messageId: string): void { this.tails.get(threadId)?.own.delete(messageId) }
  start(): void {
    if (this.timer || this.stopped) return
    this.timer = setInterval(() => { void this.poll() }, this.options.pollIntervalMs ?? 1000)
    this.timer.unref()
  }
  async stop(): Promise<void> { this.stopped = true; clearInterval(this.timer); this.timer = undefined; await this.polling; await Promise.all(this.reading.values()) }
  poll(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    this.polling ??= this.readAll().finally(() => { this.polling = undefined })
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
  private async readAll(): Promise<void> { for (const id of this.tails.keys()) await this.pollThread(id, false) }
  private async locate(directory: string, threadId: string, depth = 0): Promise<string | undefined> {
    if (depth > 3) return
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${threadId}.jsonl`)) return join(directory, entry.name)
      if (entry.isDirectory()) { const found = await this.locate(join(directory, entry.name), threadId, depth + 1); if (found) return found }
    }
  }
  private async read(threadId: string, complete: boolean): Promise<void> {
    const tail = this.tails.get(threadId)!
    if (this.stopped) return
    try {
      tail.path ??= await this.locate(join(this.options.codexHome, 'sessions'), threadId)
      if (!tail.path) return
      const file = await open(tail.path, 'r')
      try {
        const size = (await file.stat()).size
        if (size < tail.offset) { tail.offset = 0; tail.buffer = []; tail.bufferedBytes = 0; tail.discarding = false; tail.identities = new CodexRolloutIdentities() }
        // Background polls stay bounded. A guarded target read reaches the captured
        // file size with bounded buffers so takeover evidence is never truncated.
        do {
          const buffer = Buffer.alloc(Math.min(size - tail.offset, 1024 * 1024))
          const { bytesRead } = await file.read(buffer, 0, buffer.length, tail.offset)
          if (!bytesRead) break
          tail.offset += bytesRead
          let start = 0
          while (start < bytesRead) {
            const newline = buffer.indexOf(10, start)
            const end = newline < 0 ? bytesRead : newline
            if (!tail.discarding) {
              const part = buffer.subarray(start, end)
              tail.buffer.push(part); tail.bufferedBytes += part.length
              if (tail.bufferedBytes > MAX_ROLLOUT_LINE_BYTES) {
                tail.buffer = []; tail.bufferedBytes = 0; tail.discarding = true
              }
            }
            if (newline < 0) break
            if (!tail.discarding) this.consume(threadId, tail, Buffer.concat(tail.buffer, tail.bufferedBytes).toString('utf8'))
            tail.buffer = []; tail.bufferedBytes = 0; tail.discarding = false
            start = newline + 1
          }
        } while (complete && tail.offset < size && !this.stopped)
      } finally { await file.close() }
    } catch { /* A rollout may not exist yet, rotate, or be temporarily locked by Codex. */ }
  }
  private consume(threadId: string, tail: Tail, line: string): void {
    try {
      const entry = entrySchema.parse(JSON.parse(line))
      tail.identities.consume(entry)
      if (entry.type !== 'event_msg') return
      const event = userEvent.parse(entry.payload)
      const item = event.type === 'item_completed' && ['UserMessage', 'user_message'].includes(event.item?.type ?? '') ? event.item : undefined
      if (!item && event.type !== 'user_message') return
      const text = item ? textOf(item.content) : event.message ?? event.text ?? textOf(event.content)
      const hasImages = (event.images?.length ?? 0) > 0 || (event.local_images?.length ?? 0) > 0
        || (item?.content ?? event.content)?.some(part => part.type === 'image' || part.type === 'localImage')
      if (!text && !hasImages) return
      const id = item?.id ?? event.id ?? `rollout:${promptDigest(`${entry.ordinal ?? entry.timestamp}:${text}`)}`
      if (tail.seen.has(id)) return
      tail.seen.add(id)
      const digest = promptDigest(text)
      if (event.client_id && tail.own.get(event.client_id) === digest) return
      // No-client legacy rows stay unowned until complete turn history can
      // corroborate an exact alias. Text alone must not hide native input.
      if (!this.stopped) this.options.onMessage(threadId, { id, role: 'user', text, createdAt: entry.timestamp })
    } catch { /* Partial, malformed and unrelated rollout entries do not transfer authority. */ }
  }
}
