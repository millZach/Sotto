import { join } from 'node:path'
import { readFile, readdir, unlink } from 'node:fs/promises'
import { z } from 'zod'
import { agentAttachmentHandlesSchema, agentAttachmentsSchema, hasRasterImageSignature, isImageAttachment,
  type AgentAttachmentHandle, type AgentHostSnapshot } from '../../shared/agents'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import type { AttachmentStore, StageInline } from './attachmentStore'

export const ATTACHMENT_PREVIEW_RETENTION_MS = 7 * 86_400_000
export const MAX_ATTACHMENT_PREVIEW_BYTES = 100 * 1024 * 1024
const identity = {
  threadId: z.string().min(1).max(512), messageId: z.string().min(1).max(512), commandId: z.string().min(1).max(512),
  storedAt: z.number().finite(),
}
const entrySchema = z.object({ ...identity, attachments: agentAttachmentHandlesSchema })
/** Version 1 kept each image's bytes inline; they are staged into the attachment store when it is read (ADR-0031). */
const inlineEntrySchema = z.object({ ...identity, attachments: agentAttachmentsSchema.refine(items => items.every(hasRasterImageSignature)) })
type Entry = z.infer<typeof entrySchema>
type Read = { version: 1 | 2; entries: unknown[] }
type Cached = Entry & { retain: boolean }

/**
 * Submitted content only. No native transcript ingestion, URL fetching, or path resolution. An entry names the
 * staged attachments its message carried; the bytes are the attachment store's, which keeps an image's while an entry
 * here (or anything else) owns them. Retention here is the entries': seven days and 100 MiB of the images' sizes. A
 * file that is not an image has no preview (ADR-0127): its entry keeps the handle for the tile's name, type and size,
 * and owns none of its bytes.
 */
export class AttachmentPreviews {
  private entries: Cached[] = []
  private dormant: unknown[] = []
  private savedVersion: Read['version'] = 2
  private readonly diskOrder = new Map<string, number>()
  private readonly recoveryDigests = new Set<string>()
  private unreadRecovery = false
  private serial: Promise<unknown> = Promise.resolve()
  private enabled: boolean
  private dirty = false
  private readonly store: AtomicJsonStore<Read>
  constructor(private readonly directory: string, private readonly content: Pick<AttachmentStore, 'read'>,
    private readonly historyEnabled: () => boolean = () => true, private readonly now: () => number = Date.now,
    private readonly dormantThreadIds?: ReadonlySet<string>) {
    this.enabled = historyEnabled()
    this.store = new AtomicJsonStore<Read>(join(directory, 'attachment-previews.json'), value => {
      const saved = z.object({ version: z.union([z.literal(1), z.literal(2)]), entries: z.array(z.unknown()) }).parse(value)
      return { version: saved.version, entries: saved.entries }
    }, () => ({ version: 2, entries: [] }))
  }
  private enqueue(work: () => Promise<void>): Promise<void> {
    const pending = this.serial.then(work)
    this.serial = pending.catch(() => undefined)
    return pending
  }
  private preserveThread(threadId: string): boolean { return this.dormantThreadIds?.has(threadId) === true }
  private async maintainRecoveryCopies(): Promise<void> {
    this.recoveryDigests.clear()
    this.unreadRecovery = false
    const names = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })
    for (const name of names) if (/^attachment-previews\.json\.tmp-\d+-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(name)) {
      const path = join(this.directory, name)
      if (!this.dormantThreadIds?.size) { await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error }); continue }
      const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') this.unreadRecovery = true; return undefined })
      if (text === undefined) continue
      let kept: string | undefined
      try {
        const saved = z.object({ version: z.union([z.literal(1), z.literal(2)]), entries: z.array(z.unknown()) }).parse(JSON.parse(text))
        const entries = saved.entries.filter(item => { const owner = z.object({ threadId: z.string() }).safeParse(item); return owner.success && this.preserveThread(owner.data.threadId) })
        if (entries.length) {
          kept = entries.length === saved.entries.length ? text : JSON.stringify({ ...saved, entries })
          if (entries.length !== saved.entries.length) await new AtomicJsonStore<unknown>(path, value => value, () => undefined).writeSerialized(kept)
        }
      } catch (error) {
        // A failed rewrite must not be mistaken for a malformed copy and deleted.
        if (!(error instanceof SyntaxError || error instanceof z.ZodError)) throw error
        const mentionsDormant = [...text.matchAll(/"threadId"\s*:\s*("(?:[^"\\]|\\.)*")/g)].some(match => { try { return this.preserveThread(JSON.parse(match[1]!)) } catch { return false } })
        if (mentionsDormant) kept = text
      }
      if (kept === undefined) { await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error }); continue }
      for (const match of kept.matchAll(/"digest"\s*:\s*"([a-f0-9]{64})"/g)) this.recoveryDigests.add(match[1]!)
    }
  }
  /** An unread recovery copy may own any staged content; cleanup waits until it can be read. */
  contentCleanupBlocked(): boolean { return this.unreadRecovery }
  /** `stage` takes in the images a version 1 file kept inline; without it, such entries are dropped. */
  async load(stage?: StageInline): Promise<void> {
    await this.enqueue(async () => {
      // AtomicJsonStore removes failed writes; a process crash can leave its private temporary file.
      // Only this store's generated basenames qualify, and initialization precedes any writes.
      await this.maintainRecoveryCopies()
      // Cache corruption must not create an untracked copy of private image content.
      const saved = await this.store.peek()
      this.savedVersion = saved.version
      this.dormant = []
      this.diskOrder.clear()
      this.enabled = this.historyEnabled()
      const entries: Entry[] = []
      for (const [index, item] of saved.entries.entries()) {
        const owner = z.object({ threadId: z.string(), messageId: z.string() }).safeParse(item)
        if (owner.success) {
          this.diskOrder.set(JSON.stringify([owner.data.threadId, owner.data.messageId]), index)
          if (this.preserveThread?.(owner.data.threadId)) { this.dormant.push(item); continue }
        }
        // A stable save may carry dormant inline entries beside ordinary migrated handles.
        const parsed = entrySchema.safeParse(item)
        if (parsed.success) { if (this.enabled) entries.push(parsed.data); continue }
        const inline = inlineEntrySchema.safeParse(item)
        if (!inline.success || !stage || !this.enabled) continue
        const handles: AgentAttachmentHandle[] = []
        for (const attachment of inline.data.attachments) {
          const handle = await stage(attachment)
          if (handle) handles.push(handle)
        }
        if (handles.length) entries.push({ ...inline.data, attachments: handles })
      }
      const seen = new Set<string>()
      this.entries = entries.filter(entry => {
        const key = JSON.stringify([entry.threadId, entry.messageId])
        if (seen.has(key)) return false
        seen.add(key); return true
      }).map(entry => ({ ...entry, retain: true }))
      this.dirty = saved.version !== 2
      this.prune()
      await this.write()
    })
  }
  private prune(): boolean {
    const before = this.entries.length
    const enabled = this.historyEnabled()
    if (enabled !== this.enabled) this.dirty = true
    if (!enabled && this.enabled) this.entries = this.entries.filter(entry => this.preserveThread?.(entry.threadId))
    this.enabled = enabled
    const now = this.now()
    this.entries = this.entries.filter(entry => this.preserveThread?.(entry.threadId) || entry.storedAt > now - ATTACHMENT_PREVIEW_RETENTION_MS && entry.storedAt <= now)
    this.entries.sort((a, b) => a.storedAt - b.storedAt)
    let bytes = this.entries.filter(entry => !this.preserveThread?.(entry.threadId)).reduce((sum, entry) => sum + this.size(entry), 0)
    while (bytes > MAX_ATTACHMENT_PREVIEW_BYTES) {
      const index = this.entries.findIndex(entry => !this.preserveThread?.(entry.threadId))
      if (index < 0) break
      bytes -= this.size(this.entries.splice(index, 1)[0]!)
    }
    this.dirty ||= before !== this.entries.length
    return this.dirty
  }
  private size(entry: Entry): number {
    return entry.attachments.reduce((sum, attachment) => sum + (isImageAttachment(attachment.mimeType) ? attachment.sizeBytes : 0), 0)
  }
  private async write(): Promise<void> {
    const entries = [...this.dormant, ...this.entries.filter(entry => this.enabled && entry.retain)
      .map(entry => ({ threadId: entry.threadId, messageId: entry.messageId, commandId: entry.commandId, storedAt: entry.storedAt, attachments: entry.attachments }))]
    if (this.dormant.length) {
      const order = (entry: unknown): number => {
        const owner = z.object({ threadId: z.string(), messageId: z.string() }).safeParse(entry)
        return owner.success ? this.diskOrder.get(JSON.stringify([owner.data.threadId, owner.data.messageId])) ?? Infinity : Infinity
      }
      entries.sort((a, b) => order(a) - order(b))
    }
    await this.store.write({ version: this.dormant.length ? this.savedVersion : 2, entries })
    this.dirty = false
  }
  maintain(): Promise<void> {
    return this.enqueue(async () => { if (this.dormantThreadIds?.size) await this.maintainRecoveryCopies(); if (this.prune()) await this.write() })
  }
  /** Every content a live entry names, retained on disk or held for this run alone: what the attachment store keeps for previews. */
  digests(): Set<string> {
    const dormant = this.dormant.flatMap(item => { const parsed = entrySchema.safeParse(item); return parsed.success ? [parsed.data] : [] })
    return new Set([...this.recoveryDigests, ...[...this.live().values(), ...dormant].flatMap(entry => entry.attachments
      .filter(attachment => isImageAttachment(attachment.mimeType)).map(attachment => attachment.digest))])
  }
  /**
   * Every content any entry still names, live or not, with when its latest entry was stored: what a privacy change
   * may be about to release. Content staged again after that belongs to a draft instead.
   */
  named(): Map<string, number> {
    const named = new Map<string, number>()
    const dormant = this.dormant.flatMap(item => { const parsed = entrySchema.safeParse(item); return parsed.success ? [parsed.data] : [] })
    for (const entry of [...this.entries, ...dormant]) for (const { digest, mimeType } of entry.attachments) {
      if (isImageAttachment(mimeType)) named.set(digest, Math.max(named.get(digest) ?? entry.storedAt, entry.storedAt))
    }
    return named
  }
  /**
   * Records the images a prompt carried once the provider has it. The entry is live at once, so the next publish
   * carries its marker; the disk write follows in order and nothing waits on it to send. A failed write drops the
   * entry again, which the window shows as an unavailable preview: the message itself was already sent.
   */
  remember(threadId: string, messageId: string, commandId: string, attachments: readonly AgentAttachmentHandle[]): Promise<void> {
    let entry: Entry
    try { entry = entrySchema.parse({ threadId, messageId, commandId, storedAt: this.now(), attachments }) }
    catch (error) { return Promise.reject(error) }
    this.prune()
    const existing = this.entries.find(item => item.threadId === threadId && item.messageId === messageId)
    if (existing) {
      if (existing.commandId !== commandId || JSON.stringify(existing.attachments) !== JSON.stringify(entry.attachments)) {
        return Promise.reject(new Error('That message already owns different attachment previews.'))
      }
      // A retry never extends retention or changes identity.
      return this.enqueue(async () => { if (this.dirty) await this.write() })
    }
    if (!attachments.length) return Promise.resolve()
    const cached: Cached = { ...entry, retain: this.enabled }
    this.entries = [...this.entries, cached]
    this.dirty = true
    this.prune()
    return this.enqueue(async () => {
      try { await this.write() }
      catch (cause) {
        // Only this preview goes. What it pushed out under the size limit stays out: restoring entries here
        // could bring back ones a privacy change has since cleared.
        this.entries = this.entries.filter(item => item !== cached)
        throw new Error('Could not save the previews of the screenshots in this message. The message was sent; only its previews are unavailable. Check access to local storage.', { cause })
      }
    })
  }
  /** Entries retention and the privacy setting still allow, keyed by thread and message. */
  private live(): Map<string, Entry> {
    const now = this.now()
    return new Map(this.entries.filter(entry => !this.preserveThread?.(entry.threadId) && entry.storedAt > now - ATTACHMENT_PREVIEW_RETENTION_MS
      && entry.storedAt <= now && (this.historyEnabled() || !entry.retain))
      .map(entry => [JSON.stringify([entry.threadId, entry.messageId]), entry]))
  }
  /** Only the exact user message that submitted these bytes may show them. */
  private permits(message: AgentHostSnapshot['threads'][number]['messages'][number], entry: Entry): boolean {
    return message.role === 'user' && (message.commandId === undefined || message.commandId === entry.commandId)
  }
  /**
   * Decorate only an outbound clone. Workspace/native history must never cache these bytes, and the
   * published state carries markers alone: the window asks for one image at a time through preview().
   */
  decorate(snapshot: AgentHostSnapshot): void {
    const entries = this.live()
    for (const thread of snapshot.threads) for (const message of thread.messages) {
      // Provider content cannot mint previews, including when no local record exists.
      for (const attachment of message.attachments ?? []) delete attachment.preview
      const entry = entries.get(JSON.stringify([thread.id, message.id]))
      if (!entry || !this.permits(message, entry)) continue
      // A file's tile shows its name, type and size; only an image has a preview to ask for.
      const local = entry.attachments.map(attachment => ({ id: attachment.id, name: attachment.name, mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes, ...(isImageAttachment(attachment.mimeType) ? { preview: { available: true as const } } : {}) }))
      message.attachments = [...local, ...(message.attachments ?? []).filter(attachment => !local.some(item => item.id === attachment.id))]
    }
  }
  /** The bytes behind one marker, as a data URL, under exactly the rules decorate() places it by. */
  async preview(snapshot: AgentHostSnapshot, threadId: string, messageId: string, attachmentId: string): Promise<string | null> {
    const entry = this.live().get(JSON.stringify([threadId, messageId]))
    if (!entry) return null
    const message = snapshot.threads.find(thread => thread.id === threadId)?.messages.find(item => item.id === messageId)
    if (!message || !this.permits(message, entry)) return null
    const attachment = entry.attachments.find(item => item.id === attachmentId && isImageAttachment(item.mimeType))
    const bytes = attachment ? await this.content.read(attachment.digest) : null
    return attachment && bytes ? `data:${attachment.mimeType};base64,${bytes.toString('base64')}` : null
  }
}
