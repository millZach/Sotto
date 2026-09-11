import { createHash } from 'node:crypto'
import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { AgentMessage } from '../../shared/agents'

export const promptDigest = (text: string): string => createHash('sha256').update(text).digest('hex')
const entrySchema = z.object({ timestamp: z.string(), ordinal: z.number().optional(), type: z.string(), payload: z.unknown() })
const textContent = z.array(z.object({ type: z.string(), text: z.string().optional() }))
const userEvent = z.object({ type: z.string(), id: z.string().optional(), message: z.string().optional(), text: z.string().optional(),
  content: textContent.optional(), item: z.object({ type: z.string(), id: z.string().optional(), content: textContent.optional() }).optional() })
type Tail = { path?: string | undefined; offset: number; buffer: Buffer; own: Map<string, string>; seen: Set<string> }

/** Rollout event messages are authored input; response_item user messages can be injected instructions. */
export class CodexSessionLogWatcher {
  private readonly tails = new Map<string, Tail>()
  private timer: ReturnType<typeof setInterval> | undefined
  private polling: Promise<void> | undefined
  private stopped = false
  constructor(private readonly options: { codexHome: string; pollIntervalMs?: number | undefined; onMessage: (threadId: string, message: AgentMessage) => void }) {}
  observe(threadId: string): void {
    if (!this.tails.has(threadId)) this.tails.set(threadId, { offset: 0, buffer: Buffer.alloc(0), own: new Map(), seen: new Set() })
  }
  sent(threadId: string, messageId: string, text: string): void { this.sentDigest(threadId, messageId, promptDigest(text)) }
  sentDigest(threadId: string, messageId: string, digest: string): void { this.observe(threadId); this.tails.get(threadId)!.own.set(messageId, digest) }
  forget(threadId: string, messageId: string): void { this.tails.get(threadId)?.own.delete(messageId) }
  start(): void {
    if (this.timer || this.stopped) return
    this.timer = setInterval(() => { void this.poll() }, this.options.pollIntervalMs ?? 1000)
    this.timer.unref()
  }
  async stop(): Promise<void> { this.stopped = true; clearInterval(this.timer); this.timer = undefined; await this.polling }
  poll(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    this.polling ??= this.read().finally(() => { this.polling = undefined })
    return this.polling
  }
  private async locate(directory: string, threadId: string, depth = 0): Promise<string | undefined> {
    if (depth > 3) return
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${threadId}.jsonl`)) return join(directory, entry.name)
      if (entry.isDirectory()) { const found = await this.locate(join(directory, entry.name), threadId, depth + 1); if (found) return found }
    }
  }
  private async read(): Promise<void> {
    for (const [threadId, tail] of this.tails) {
      if (this.stopped) return
      try {
        tail.path ??= await this.locate(join(this.options.codexHome, 'sessions'), threadId)
        if (!tail.path) continue
        const file = await open(tail.path, 'r')
        try {
          const size = (await file.stat()).size
          if (size < tail.offset) { tail.offset = 0; tail.buffer = Buffer.alloc(0) }
          // Bound each poll and partial line; offsets are bytes, never UTF-16 string positions.
          const buffer = Buffer.alloc(Math.min(size - tail.offset, 1024 * 1024))
          const { bytesRead } = await file.read(buffer, 0, buffer.length, tail.offset)
          tail.offset += bytesRead
          tail.buffer = Buffer.concat([tail.buffer, buffer.subarray(0, bytesRead)])
          let newline: number
          while ((newline = tail.buffer.indexOf(10)) >= 0) {
            const line = tail.buffer.subarray(0, newline).toString('utf8')
            tail.buffer = tail.buffer.subarray(newline + 1)
            this.consume(threadId, tail, line)
          }
          if (tail.buffer.length > 1024 * 1024) tail.buffer = Buffer.alloc(0)
        } finally { await file.close() }
      } catch { /* A rollout may not exist yet, rotate, or be temporarily locked by Codex. */ }
    }
  }
  private consume(threadId: string, tail: Tail, line: string): void {
    try {
      const entry = entrySchema.parse(JSON.parse(line))
      if (entry.type !== 'event_msg') return
      const event = userEvent.parse(entry.payload)
      const item = event.type === 'item_completed' && ['UserMessage', 'user_message'].includes(event.item?.type ?? '') ? event.item : undefined
      if (!item && event.type !== 'user_message') return
      const text = item ? (item.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n')
        : event.message ?? event.text ?? (event.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n')
      if (!text) return
      const id = item?.id ?? event.id ?? `rollout:${promptDigest(`${entry.ordinal ?? entry.timestamp}:${text}`)}`
      if (tail.seen.has(id)) return
      tail.seen.add(id)
      const digest = promptDigest(text)
      const own = [...tail.own].find(([, value]) => value === digest)
      if (own) { tail.own.delete(own[0]); return }
      if (!this.stopped) this.options.onMessage(threadId, { id, role: 'user', text, createdAt: entry.timestamp })
    } catch { /* Partial, malformed and unrelated rollout entries do not transfer authority. */ }
  }
}
