import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { MAX_ACTIVITY_MEDIA, type AgentActivity, type AgentActivityMedia } from '../../shared/agentActivity'
import { AGENT_MAX_IMAGE_BYTES, bytesHaveRasterSignature, isImageAttachment } from '../../shared/agents'
import { imageDimensions } from '../../shared/imageDimensions'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { AttachmentStore } from './attachmentStore'

/** A picture as a provider's tool result carries it: base64 bytes and the type it says they are. */
export interface CapturedPicture { readonly mimeType: string; readonly data: string }
/** Captures a tool result's pictures (ADR-0170): their handles, in order, at most eight. */
export type MediaCapture = (pictures: readonly CapturedPicture[], source: AgentActivityMedia['source']) => AgentActivityMedia[]
/**
 * Captures one picture a provider saved to a file (ADR-0170): its handle, or none when the file is not a picture Sotto
 * shows. Read off the update path, so the row it belongs to gains it a moment after the step ends.
 */
export type MediaFileCapture = (path: string, source: AgentActivityMedia['source']) => Promise<AgentActivityMedia[]>

/** How much the thread media store keeps on disk before its oldest pictures go (ADR-0170). */
export const THREAD_MEDIA_KEEP_BYTES = 1024 * 1024 * 1024
/** The same while Keep local history is off, when the pictures are held in memory. */
export const THREAD_MEDIA_KEEP_MEMORY_BYTES = 128 * 1024 * 1024
const keptSchema = z.object({ version: z.literal(1), kept: z.record(z.string().regex(/^[a-f0-9]{64}$/u), z.object({ sizeBytes: z.number().int().min(1), at: z.number().finite() })) })
type Kept = z.infer<typeof keptSchema>

const NAMES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

/**
 * The pictures a tool result holds, in the shapes Sotto's providers send: MCP and ACP `{type: 'image', data, mimeType}`,
 * and the Messages API's `{type: 'image', source: {type: 'base64', media_type, data}}`, which Claude Code's tool results
 * use. Anything else, text included, is not a picture. A picture only text names is never read.
 */
export function picturesIn(content: unknown): CapturedPicture[] {
  if (!Array.isArray(content)) return []
  const found: CapturedPicture[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const item = block as Record<string, unknown>
    // ACP wraps its content once: `{type: 'content', content: {type: 'image', ...}}`.
    const part = item.type === 'content' && typeof item.content === 'object' && item.content !== null ? item.content as Record<string, unknown> : item
    // Codex's dynamic tools hand a picture back as a data URL.
    if (part.type === 'inputImage' && typeof part.imageUrl === 'string') {
      const url = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/su.exec(part.imageUrl)
      if (url) found.push({ mimeType: url[1]!, data: url[2]! })
      if (found.length === MAX_ACTIVITY_MEDIA) break
      continue
    }
    if (part.type !== 'image') continue
    const source = typeof part.source === 'object' && part.source !== null ? part.source as Record<string, unknown> : undefined
    const data = source ? source.type === 'base64' ? source.data : undefined : part.data
    const mimeType = source ? source.media_type : part.mimeType ?? part.mime_type
    if (typeof data === 'string' && typeof mimeType === 'string') found.push({ data, mimeType })
    if (found.length === MAX_ACTIVITY_MEDIA) break
  }
  return found
}

/** The raster type a picture's own first bytes say it is, of the four Sotto shows. */
export function rasterTypeOf(bytes: Uint8Array): string | undefined {
  return Object.keys(NAMES).find(mimeType => bytesHaveRasterSignature(mimeType, bytes))
}

/** A picture file's bytes, or undefined when it is missing, not a file, empty or over the image limit. Nothing is logged. */
async function readPicture(path: string): Promise<Buffer | undefined> {
  const file = await open(path, 'r').catch(() => undefined)
  if (!file) return undefined
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size < 1 || stat.size > AGENT_MAX_IMAGE_BYTES) return undefined
    // Read at most the size it had plus one byte: a file still growing is refused, never read past the limit.
    const bytes = Buffer.alloc(stat.size + 1)
    let length = 0
    for (;;) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
      if (length > stat.size) return undefined
    }
    return length > 0 ? bytes.subarray(0, length) : undefined
  } catch { return undefined } finally { await file.close().catch(() => undefined) }
}

/**
 * An ACP tool step's pictures (ADR-0170). An update's content replaces the step's, and a picture arrives whole, so an
 * update that holds no more pictures than the step already has handles for keeps those handles and hashes nothing: a
 * repeated update, a later update with words alone, and a replay into a row that has them. One that holds more, a tool
 * that added a picture as it ran, captures them all; the store keeps each content once, so the earlier ones cost a hash.
 */
export function acpToolMedia(capture: MediaCapture | undefined, content: unknown, old: Pick<AgentActivity, 'media'> | undefined): { media?: AgentActivityMedia[] } {
  if (!capture) return {}
  const pictures = picturesIn(content)
  if (pictures.length <= (old?.media?.length ?? 0)) return {}
  const media = capture(pictures, 'tool')
  return media.length ? { media } : {}
}

/**
 * A tool's raw output as text for its step, with every picture's bytes left out: MCP's `{type: 'image', data}` and the
 * Messages API's `{type: 'base64', data}` source keep their other fields and leave their base64 behind, so a step's words never carry a picture, whether or not the picture became a handle.
 */
export function rawOutputText(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value, (key, item: unknown) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return item
    const part = item as Record<string, unknown>
    return (part.type === 'image' || part.type === 'base64') && typeof part.data === 'string' ? { ...part, data: undefined } : item
  }) ?? ''
}

/**
 * The thread media store (ADR-0170): every picture a thread's agent made or looked at, kept once by digest as staged images
 * are (ADR-0031), in its own folder, and in memory alone while Keep local history is off. It keeps the newest
 * `THREAD_MEDIA_KEEP_BYTES`; past that the pictures captured longest ago go first. Its index holds each picture's size and
 * when it was last captured, nothing else, so its upkeep follows the number of pictures, never the length of a history.
 */
export class ThreadMediaStore {
  private readonly content: AttachmentStore
  private readonly kept = new Map<string, { sizeBytes: number; at: number }>()
  private readonly keptFile: AtomicJsonStore<Kept>
  private readonly historyEnabled: () => boolean
  private readonly now: () => number
  private readonly keepBytes: number
  /** Captures since the index was last written; it is written with the next upkeep, never on a capture. */
  private unsaved = false
  /** What the kept pictures hold together, so a capture knows at once when it passed the limit. */
  private total = 0
  /** Writes under way, by digest: a tile can ask for a picture before its bytes reach the store. */
  private readonly staging = new Map<string, Promise<unknown>>()
  /** A sweep a capture asked for because the pictures passed their limit; it runs after the capture, off the update path. */
  private sweepQueued = false

  constructor(directory: string, { historyEnabled = () => true, now = () => Date.now(), keepBytes = THREAD_MEDIA_KEEP_BYTES }: {
    readonly historyEnabled?: () => boolean; readonly now?: () => number; readonly keepBytes?: number } = {}) {
    this.historyEnabled = historyEnabled; this.now = now; this.keepBytes = keepBytes
    this.content = new AttachmentStore(directory, { historyEnabled, now, folder: 'thread-media' })
    this.keptFile = new AtomicJsonStore(join(directory, 'thread-media.json'), value => keptSchema.parse(value), () => ({ version: 1, kept: {} }))
  }

  async load(): Promise<void> {
    await this.content.load()
    const saved = await this.keptFile.peek().catch(() => ({ version: 1 as const, kept: {} }))
    this.kept.clear()
    for (const [digest, entry] of Object.entries(saved.kept)) if (this.content.has(digest)) this.kept.set(digest, entry)
    // A picture captured after the index was last written, before a crash, is taken back as captured now, not swept.
    const now = this.now()
    for (const { digest, sizeBytes } of this.content.kept()) if (!this.kept.has(digest)) { this.kept.set(digest, { sizeBytes, at: now }); this.unsaved = true }
    this.total = [...this.kept.values()].reduce((sum, entry) => sum + entry.sizeBytes, 0)
  }
  private limit(): number { return this.historyEnabled() ? this.keepBytes : Math.min(this.keepBytes, THREAD_MEDIA_KEEP_MEMORY_BYTES) }

  /**
   * Handles for a tool result's pictures, made at once so the row that carries them is written now; the bytes reach the
   * store afterwards, off the update path. A picture that is not the type it claims, or is over the image limit, gets no
   * handle. The digest is the store's own, so a record can only name content a provider sent.
   */
  capture: MediaCapture = (pictures, source) => {
    const handles: AgentActivityMedia[] = []
    for (const picture of pictures.slice(0, MAX_ACTIVITY_MEDIA)) {
      if (!isImageAttachment(picture.mimeType) || picture.data.length > Math.ceil(AGENT_MAX_IMAGE_BYTES / 3) * 4 + 4) continue
      const handle = this.keep(Buffer.from(picture.data, 'base64'), picture.mimeType, source, handles.length)
      if (handle) handles.push(handle)
    }
    this.limitSoon()
    return handles
  }

  /**
   * The handle for a picture a provider saved to a file: Codex's generated images when its item carries only the path, and
   * Cursor's. Its type is read from its own first bytes, never its name, and a file over the image limit is not read.
   */
  captureFile: MediaFileCapture = async (path, source) => {
    const bytes = await readPicture(path)
    const mimeType = bytes ? rasterTypeOf(bytes) : undefined
    const handle = bytes && mimeType ? this.keep(bytes, mimeType, source, 0) : undefined
    this.limitSoon()
    return handle ? [handle] : []
  }

  /** Keeps one picture's bytes and makes its handle, `m{index}`, or none when they are not the type they claim. */
  private keep(bytes: Buffer, mimeType: string, source: AgentActivityMedia['source'], index: number): AgentActivityMedia | undefined {
    if (!Object.hasOwn(NAMES, mimeType) || bytes.byteLength < 1 || bytes.byteLength > AGENT_MAX_IMAGE_BYTES || !bytesHaveRasterSignature(mimeType, bytes)) return undefined
    const digest = createHash('sha256').update(bytes).digest('hex')
    const size = imageDimensions(bytes)
    const handle: AgentActivityMedia = { id: `m${index}`, digest, kind: 'image', mimeType: mimeType as AgentActivityMedia['mimeType'], sizeBytes: bytes.byteLength,
      ...(size ? { width: size.width, height: size.height } : {}), name: `picture-${index + 1}.${NAMES[mimeType]}`, source }
    if (!this.kept.has(digest)) this.total += bytes.byteLength
    this.kept.set(digest, { sizeBytes: bytes.byteLength, at: this.now() })
    if (!this.content.has(digest) && !this.staging.has(digest)) {
      const write = this.content.stage({ name: 'picture', mimeType, bytes }, { digest }).catch(() => undefined)
        .finally(() => this.staging.delete(digest))
      this.staging.set(digest, write)
    }
    this.unsaved = true
    return handle
  }

  /** Past the limit, the oldest go now rather than at the next upkeep, so a burst of screenshots never holds more for long. */
  private limitSoon(): void {
    if (this.total <= this.limit() || this.sweepQueued) return
    this.sweepQueued = true
    setTimeout(() => { this.sweepQueued = false; void this.sweep().catch(() => undefined) }, 0)
  }

  private saveKept(): Promise<void> {
    this.unsaved = false
    return this.keptFile.writeLatest(() => ({ version: 1, kept: Object.fromEntries(this.kept) })).catch(() => undefined)
  }

  /**
   * The bytes a record's handle names, as a data URL, or null when the record carries no such handle or the store no
   * longer keeps it. The record is the host's own, found by the caller from the thread a client may read.
   */
  async read(record: AgentActivity | null, mediaId: string): Promise<string | null> {
    const handle = record?.media?.find(item => item.id === mediaId)
    if (!handle) return null
    // A picture asked for before its bytes reached the store is read once they have.
    await this.staging.get(handle.digest)
    if (!this.content.keeps({ digest: handle.digest, mimeType: handle.mimeType, sizeBytes: handle.sizeBytes })) return null
    const bytes = await this.content.read(handle.digest)
    return bytes ? `data:${handle.mimeType};base64,${bytes.toString('base64')}` : null
  }

  /**
   * Upkeep, every 30 seconds with the attachment store's: writes the index if pictures were captured since, and lets the
   * pictures captured longest ago go until what is kept fits, `keepBytes` on disk and less in memory.
   */
  async sweep(): Promise<void> {
    const limit = this.limit()
    if (this.total > limit) {
      for (const [digest, entry] of [...this.kept].sort((a, b) => a[1].at - b[1].at)) {
        if (this.total <= limit) break
        this.kept.delete(digest); this.total -= entry.sizeBytes
      }
      this.unsaved = true
    }
    // The index is written here, in upkeep, so a capture never serializes it however many pictures it holds.
    if (this.unsaved && this.historyEnabled()) await this.saveKept()
    await this.content.idle()
    await this.content.sweep(() => new Set(this.kept.keys()), 0)
  }

  /** Lets every picture go: Keep local history was turned off (ADR-0170). */
  async clear(): Promise<void> {
    this.kept.clear(); this.total = 0
    await this.keptFile.write({ version: 1, kept: {} }).catch(() => undefined)
    await this.content.sweep(() => new Set(), 0)
  }

  idle(): Promise<void> { return this.content.idle() }
}
