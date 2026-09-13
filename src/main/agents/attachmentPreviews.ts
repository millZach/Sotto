import { join } from 'node:path'
import { readdir, unlink } from 'node:fs/promises'
import { z } from 'zod'
import { agentAttachmentsSchema, attachmentSizeBytes, hasRasterImageSignature,
  type AgentAttachment, type AgentHostSnapshot } from '../../shared/agents'
import { AtomicJsonStore } from '../storage/atomicJsonStore'

export const ATTACHMENT_PREVIEW_RETENTION_MS = 7 * 86_400_000
export const MAX_ATTACHMENT_PREVIEW_BYTES = 100 * 1024 * 1024
const entrySchema = z.object({
  threadId: z.string().min(1).max(512), messageId: z.string().min(1).max(512), commandId: z.string().min(1).max(512),
  storedAt: z.number().finite(), attachments: agentAttachmentsSchema.refine(items => items.every(hasRasterImageSignature)),
})
type Entry = z.infer<typeof entrySchema>
type Saved = { version: 1; entries: Entry[] }
type Cached = Entry & { retain: boolean }

/** Submitted content only. No native transcript ingestion, URL fetching, or path resolution. */
export class AttachmentPreviews {
  private entries: Cached[] = []
  private serial: Promise<unknown> = Promise.resolve()
  private enabled: boolean
  private dirty = false
  private readonly store: AtomicJsonStore<Saved>
  constructor(private readonly directory: string, private readonly historyEnabled: () => boolean = () => true,
    private readonly now: () => number = Date.now) {
    this.enabled = historyEnabled()
    this.store = new AtomicJsonStore(join(directory, 'attachment-previews.json'), value => {
      const saved = z.object({ version: z.literal(1), entries: z.array(z.unknown()) }).parse(value)
      return { version: 1, entries: saved.entries.flatMap(item => {
        const parsed = entrySchema.safeParse(item)
        return parsed.success ? [parsed.data] : []
      }) }
    }, () => ({ version: 1, entries: [] }))
  }
  private enqueue(work: () => Promise<void>): Promise<void> {
    const pending = this.serial.then(work)
    this.serial = pending.catch(() => undefined)
    return pending
  }
  async load(): Promise<void> {
    await this.enqueue(async () => {
      // AtomicJsonStore removes failed writes; a process crash can leave its private temporary file.
      // Only this store's generated basenames qualify, and initialization precedes any writes.
      const names = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      })
      for (const name of names) if (/^attachment-previews\.json\.tmp-\d+-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(name)) {
        await unlink(join(this.directory, name)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
      }
      // Cache corruption must not create an untracked copy of private image content.
      const saved = await this.store.peek()
      this.enabled = this.historyEnabled()
      const seen = new Set<string>()
      this.entries = this.enabled ? saved.entries.filter(entry => {
        const key = JSON.stringify([entry.threadId, entry.messageId])
        if (seen.has(key)) return false
        seen.add(key); return true
      }).map(entry => ({ ...entry, retain: true })) : []
      this.prune()
      await this.write()
    })
  }
  private prune(): boolean {
    const before = this.entries.length
    const enabled = this.historyEnabled()
    if (enabled !== this.enabled) this.dirty = true
    if (!enabled && this.enabled) this.entries = []
    this.enabled = enabled
    const now = this.now()
    this.entries = this.entries.filter(entry => entry.storedAt > now - ATTACHMENT_PREVIEW_RETENTION_MS && entry.storedAt <= now)
    this.entries.sort((a, b) => a.storedAt - b.storedAt)
    let bytes = this.entries.reduce((sum, entry) => sum + this.size(entry), 0)
    while (bytes > MAX_ATTACHMENT_PREVIEW_BYTES) bytes -= this.size(this.entries.shift()!)
    this.dirty ||= before !== this.entries.length
    return this.dirty
  }
  private size(entry: Entry): number {
    return entry.attachments.reduce((sum, attachment) => sum + attachmentSizeBytes(attachment.dataUrl), 0)
  }
  private async write(): Promise<void> {
    await this.store.write({ version: 1, entries: this.enabled
      ? this.entries.filter(entry => entry.retain).map(entry => ({ threadId: entry.threadId, messageId: entry.messageId,
        commandId: entry.commandId, storedAt: entry.storedAt, attachments: entry.attachments })) : [] })
    this.dirty = false
  }
  maintain(): Promise<void> {
    return this.enqueue(async () => { if (this.prune()) await this.write() })
  }
  remember(threadId: string, messageId: string, commandId: string, attachments: AgentAttachment[]): Promise<void> {
    return this.enqueue(async () => {
      const entry = entrySchema.parse({ threadId, messageId, commandId, storedAt: this.now(), attachments })
      this.prune()
      const existing = this.entries.find(item => item.threadId === threadId && item.messageId === messageId)
      if (existing) {
        if (existing.commandId !== commandId || JSON.stringify(existing.attachments) !== JSON.stringify(entry.attachments)) {
          throw new Error('That message already owns different attachment previews.')
        }
        if (this.dirty) await this.write()
        return // A retry never extends retention or changes identity.
      }
      if (!attachments.length) return
      const previous = this.entries
      this.entries = [...this.entries, { ...entry, retain: this.enabled }]
      this.dirty = true
      this.prune()
      try { await this.write() }
      catch (cause) {
        this.entries = previous
        throw new Error('Could not save attachment previews. The prompt was not sent.', { cause })
      }
    })
  }
  forget(threadId: string, messageId: string, commandId: string): Promise<void> {
    return this.enqueue(async () => {
      const before = this.entries.length
      this.entries = this.entries.filter(entry => entry.threadId !== threadId || entry.messageId !== messageId || entry.commandId !== commandId)
      this.dirty ||= before !== this.entries.length
      if (this.prune()) await this.write()
    })
  }
  /** Decorate only an outbound clone. Workspace/native history must never cache these bytes. */
  decorate(snapshot: AgentHostSnapshot): void {
    const now = this.now()
    const entries = new Map(this.entries.filter(entry => entry.storedAt > now - ATTACHMENT_PREVIEW_RETENTION_MS
      && entry.storedAt <= now && (this.historyEnabled() || !entry.retain))
      .map(entry => [JSON.stringify([entry.threadId, entry.messageId]), entry]))
    for (const thread of snapshot.threads) for (const message of thread.messages) {
      // Provider content cannot mint previews, including when no local record exists.
      for (const attachment of message.attachments ?? []) delete attachment.preview
      const entry = entries.get(JSON.stringify([thread.id, message.id]))
      if (!entry || message.role !== 'user' || (message.commandId !== undefined && message.commandId !== entry.commandId)) continue
      const local = entry.attachments.map(attachment => ({ id: attachment.id, name: attachment.name, mimeType: attachment.mimeType,
        sizeBytes: attachmentSizeBytes(attachment.dataUrl), preview: { dataUrl: attachment.dataUrl } }))
      message.attachments = [...local, ...(message.attachments ?? []).filter(attachment => !local.some(item => item.id === attachment.id))]
    }
  }
}
