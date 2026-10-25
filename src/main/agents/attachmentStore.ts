import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { AGENT_GENERIC_FILE_MIME_TYPE, AGENT_MAX_FILE_BYTES, agentAttachmentHandleSchema, agentMimeTypeSchema, attachmentDigestSchema, attachmentLimitBytes, bytesHaveRasterSignature,
  ATTACHED_FILE_TOO_LARGE, isImageAttachment, SCREENSHOT_NOT_ITS_TYPE, SCREENSHOT_TOO_LARGE, SCREENSHOT_WRONG_TYPE, type AgentAttachment, type AgentAttachmentDimensions,
  type AgentAttachmentHandle, type AgentImageMimeType } from '../../shared/agents'
import { AtomicJsonStore } from '../storage/atomicJsonStore'

const EXTENSIONS: Record<AgentImageMimeType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
const TYPES = new Map(Object.entries(EXTENSIONS).map(([type, extension]) => [extension, type as AgentImageMimeType]))
/** A file that is not an image is kept as `<digest>.bin`, its MIME type in the index alone (ADR-0131). */
const FILE_EXTENSION = 'bin'
const CONTENT_FILE = /^([a-f0-9]{64})\.(png|jpg|gif|webp|bin)$/u
const INDEX_FILE = 'index.json'
const WINDOWS_RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160] as const
/**
 * How long content nothing owns is kept (ADR-0031). It is what lets a refused prompt go back to its composer, or be
 * sent again from the window's own copy, without staging again; after it the content is removed.
 */
export const UNOWNED_ATTACHMENT_GRACE_MS = 60 * 60_000

const entrySchema = z.object({ digest: attachmentDigestSchema, mimeType: agentMimeTypeSchema,
  sizeBytes: z.number().int().min(1).max(AGENT_MAX_FILE_BYTES), stagedAt: z.number().finite() }).strict()
  .refine(entry => entry.sizeBytes <= attachmentLimitBytes(entry.mimeType))
type Entry = z.infer<typeof entrySchema>
type Index = { version: 1; entries: Entry[] }
/**
 * Content this store keeps: on disk under its digest, or in memory alone while history is off. `lastStagedAt` is
 * this run's latest staging of it, which a privacy change reads to tell content staged again for a draft from
 * content only an older preview names.
 */
interface Held extends Entry { memory?: Buffer; unownedSince: number | null; lastStagedAt: number }

/**
 * Whether a handle describes content as it is kept: the same size, and for an image the same type, since its signature
 * was checked for that type. A file's bytes are not inspected, so any kept content of its size is the file it names.
 */
function describes(held: Pick<Entry, 'mimeType' | 'sizeBytes'>, handle: Pick<AgentAttachmentHandle, 'mimeType' | 'sizeBytes'>): boolean {
  return held.sizeBytes === handle.sizeBytes && (held.mimeType === handle.mimeType || !isImageAttachment(handle.mimeType))
}

/** Content staging refuses for what it is (its type, its size, its signature), not for a failure to keep it. */
export class RefusedImage extends Error {}

/**
 * Stages one image a file from before ADR-0031 kept inline, answering with its handle under the image's own ID, or
 * null for one that is not the image it claims. Failing to keep one is thrown: that is storage, not the image. The
 * bytes are already on disk inside that file, so they are written to the store whatever the history setting: kept
 * in memory alone, the rewrite of the file would lose them at the next restart.
 */
export type StageInline = (attachment: AgentAttachment) => Promise<AgentAttachmentHandle | null>
export function inlineStager(store: Pick<AttachmentStore, 'stage'>): StageInline {
  return async attachment => {
    const bytes = Buffer.from(attachment.dataUrl.slice(attachment.dataUrl.indexOf(',') + 1), 'base64')
    try { return { ...await store.stage({ name: attachment.name, mimeType: attachment.mimeType, bytes, ...(attachment.dimensions ? { dimensions: attachment.dimensions } : {}) }, { onDisk: true }), id: attachment.id } }
    catch (error) { if (error instanceof RefusedImage) return null; throw error }
  }
}

export const MISSING_ATTACHMENT = 'An image in this message is no longer kept on this computer. Remove it and attach it again. Nothing else was changed.'
/** The same, from a headless host: the desktop reading it is not the machine that lost the image. */
export const MISSING_REMOTE_ATTACHMENT = 'An image in this message is no longer kept on its host. Remove it and attach it again. Nothing else was changed.'
export const MISMATCHED_ATTACHMENT = 'An image in this message does not match the copy Sotto kept. Remove it and attach it again. Nothing was sent.'

/**
 * One host's staged images (ADR-0031). Each distinct content is one file named by its SHA-256, beside a small index
 * of digest, type, size and staging time: no names, no thread IDs, no text. Staging commits the bytes and the index
 * before it answers, so nothing can be saved pointing at content that is not on disk. What to keep is the caller's:
 * `sweep` is handed every digest something still owns.
 */
export class AttachmentStore {
  private readonly held = new Map<string, Held>()
  private readonly folder: string
  private readonly index: AtomicJsonStore<Index>
  private serial: Promise<unknown> = Promise.resolve()
  private readonly historyEnabled: () => boolean
  private readonly now: () => number
  /**
   * The sentence a handle whose content is gone is refused with: this computer's on the desktop,
   * MISSING_REMOTE_ATTACHMENT on a headless host, whose refusals a desktop shows.
   */
  readonly missing: string
  /** Whether this store keeps files that are not images: the `attach-any-file` Owl answer, read once at start (ADR-0131). */
  readonly acceptsFiles: boolean
  constructor(directory: string, { historyEnabled = () => true, now = () => Date.now(), missing = MISSING_ATTACHMENT, acceptsFiles = false }: {
    readonly historyEnabled?: () => boolean; readonly now?: () => number; readonly missing?: string | undefined; readonly acceptsFiles?: boolean | undefined } = {}) {
    this.historyEnabled = historyEnabled; this.now = now; this.missing = missing; this.acceptsFiles = acceptsFiles
    this.folder = join(directory, 'attachments')
    this.index = new AtomicJsonStore(join(this.folder, INDEX_FILE), value => {
      const saved = z.object({ version: z.literal(1), entries: z.array(z.unknown()) }).parse(value)
      return { version: 1, entries: saved.entries.flatMap(item => { const parsed = entrySchema.safeParse(item); return parsed.success ? [parsed.data] : [] }) }
    }, () => ({ version: 1, entries: [] }))
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.serial.then(work)
    this.serial = pending.catch(() => undefined)
    return pending
  }
  private file(entry: Pick<Entry, 'digest' | 'mimeType'>): string {
    return join(this.folder, `${entry.digest}.${isImageAttachment(entry.mimeType) ? EXTENSIONS[entry.mimeType] : FILE_EXTENSION}`)
  }

  /**
   * Reads the index and squares it with the folder. Every content counts as unowned from now, so one staged just
   * before a crash, whose draft was never saved, is removed a grace period into this run. A content file the index
   * does not name (a crash between the rename and the index write) is taken back into it; temporary files and
   * anything else in the folder are removed, and an entry whose file is gone is dropped.
   */
  load(): Promise<void> {
    return this.enqueue(async () => {
      const names = await readdir(this.folder).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
      this.held.clear()
      if (names === null) return
      const saved = await this.index.peek()
      const indexed = new Map(saved.entries.map(entry => [entry.digest, entry]))
      const now = this.now()
      for (const name of names) {
        if (name === INDEX_FILE) continue
        const match = CONTENT_FILE.exec(name)
        const entry = match ? indexed.get(match[1]!) : undefined
        // A file's type is in the index alone; one the index lost comes back as a file of no particular type.
        const mimeType = !match ? undefined : match[2] === FILE_EXTENSION
          ? entry && !isImageAttachment(entry.mimeType) ? entry.mimeType : AGENT_GENERIC_FILE_MIME_TYPE
          : TYPES.get(match[2]!)
        const size = match && mimeType ? await stat(join(this.folder, name)).then(info => info.isFile() ? info.size : 0, () => 0) : 0
        if (!match || !mimeType || size < 1 || size > attachmentLimitBytes(mimeType) || this.held.has(match[1]!)) {
          await unlink(join(this.folder, name)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT' && error.code !== 'EISDIR' && error.code !== 'EPERM') throw error })
          continue
        }
        this.held.set(match[1]!, { digest: match[1]!, mimeType, sizeBytes: size, stagedAt: entry?.stagedAt ?? now, unownedSince: now, lastStagedAt: entry?.stagedAt ?? now })
      }
      if (saved.entries.length !== this.held.size || saved.entries.some(entry => !this.held.has(entry.digest))) await this.writeIndex()
    })
  }
  private writeIndex(): Promise<void> {
    return this.index.write({ version: 1, entries: [...this.held.values()].filter(item => !item.memory)
      .map(({ digest, mimeType, sizeBytes, stagedAt }) => ({ digest, mimeType, sizeBytes, stagedAt })) })
  }

  /**
   * Keeps an attachment's bytes once and answers with its handle. The type, size and, for an image, its signature are
   * checked here, whoever sent them; a file's bytes are not inspected. A store that does not accept files refuses
   * anything but the four image types, as before ADR-0131. With history on the bytes are on disk, and in the index,
   * before this resolves; with it off they are kept in memory and nothing is written. `onDisk` writes them whatever the
   * setting, for bytes that were already on disk elsewhere (`inlineStager`) and so are not new.
   */
  stage(input: { readonly name: string; readonly mimeType: string; readonly bytes: Uint8Array; readonly dimensions?: AgentAttachmentDimensions | undefined },
    { onDisk = false }: { readonly onDisk?: boolean } = {}): Promise<AgentAttachmentHandle> {
    const image = isImageAttachment(input.mimeType)
    if (!image && (!this.acceptsFiles || !agentMimeTypeSchema.safeParse(input.mimeType).success)) return Promise.reject(new RefusedImage(SCREENSHOT_WRONG_TYPE))
    if (input.bytes.byteLength < 1 || input.bytes.byteLength > attachmentLimitBytes(input.mimeType)) {
      return Promise.reject(new RefusedImage(image ? SCREENSHOT_TOO_LARGE : ATTACHED_FILE_TOO_LARGE))
    }
    if (image && !bytesHaveRasterSignature(input.mimeType, input.bytes)) return Promise.reject(new RefusedImage(SCREENSHOT_NOT_ITS_TYPE))
    const bytes = Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength)
    const digest = createHash('sha256').update(bytes).digest('hex')
    // The sizes are the composer's word for what it attached and staged; they describe, and are never read as content.
    const parsed = agentAttachmentHandleSchema.safeParse({ id: randomUUID(), name: input.name.trim() || (image ? 'Screenshot' : 'File'), mimeType: input.mimeType,
      sizeBytes: bytes.byteLength, digest, ...(image && input.dimensions ? { dimensions: input.dimensions } : {}) })
    if (!parsed.success) {
      return Promise.reject(new RefusedImage(image ? 'Could not read this screenshot’s name or size. Nothing was attached. Try again.'
        : 'Could not read this file’s name or size. Nothing was attached. Try again.'))
    }
    const handle = parsed.data
    const mimeType = handle.mimeType
    return this.enqueue(async () => {
      const now = this.now()
      const existing = this.held.get(digest)
      // Re-staging content starts its grace again; the same bytes are never written twice, unless only memory had
      // them and they must now reach disk. Each handle keeps the type it was attached as: the same bytes attached as an
      // image and as a file are an image and a file (ADR-0131). Content first kept as a file and now attached as an
      // image, whose signature was just checked, is kept as that image from now on, so its chip and preview can read it.
      if (existing && !(onDisk && existing.memory)) {
        existing.unownedSince = existing.unownedSince === null ? null : now; existing.lastStagedAt = now
        if (image && !isImageAttachment(existing.mimeType)) await this.keepAsImage(existing, mimeType, bytes)
        return handle
      }
      if (!onDisk && !this.historyEnabled()) {
        this.held.set(digest, { digest, mimeType, sizeBytes: bytes.byteLength, stagedAt: now, memory: Buffer.from(bytes), unownedSince: now, lastStagedAt: now })
        return handle
      }
      await this.writeContent({ digest, mimeType }, bytes)
      const held: Held = { digest, mimeType, sizeBytes: bytes.byteLength, stagedAt: existing?.stagedAt ?? now,
        unownedSince: existing?.unownedSince === null ? null : now, lastStagedAt: now }
      this.held.set(digest, held)
      try { await this.writeIndex() }
      catch (error) {
        // Without its index entry the content still comes back at the next start and is removed there.
        if (existing) this.held.set(digest, existing); else this.held.delete(digest)
        await unlink(this.file(held)).catch(() => undefined)
        throw error
      }
      return handle
    })
  }
  /**
   * Keeps content first staged as a file under the image type it was just staged as. The image's file is written and
   * indexed before the file's copy goes, and `read` follows the new entry, so nothing that names the digest loses it.
   */
  private async keepAsImage(existing: Held, mimeType: string, bytes: Buffer): Promise<void> {
    const image: Held = { ...existing, mimeType }
    if (existing.memory) { this.held.set(existing.digest, image); return }
    await this.writeContent(image, bytes)
    this.held.set(existing.digest, image)
    try { await this.writeIndex() }
    catch (error) {
      this.held.set(existing.digest, existing)
      await unlink(this.file(image)).catch(() => undefined)
      throw error
    }
    await unlink(this.file(existing)).catch(() => undefined)
  }
  private async writeContent(entry: Pick<Entry, 'digest' | 'mimeType'>, bytes: Buffer): Promise<void> {
    await mkdir(this.folder, { recursive: true })
    const target = this.file(entry)
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(bytes); await handle.sync()
    } catch (error) {
      await handle.close().catch(() => undefined); await unlink(temporary).catch(() => undefined); throw error
    }
    await handle.close()
    for (let attempt = 0; ; attempt += 1) {
      try { await rename(temporary, target); return }
      catch (error) {
        const retry = WINDOWS_RENAME_RETRY_DELAYS_MS[attempt]
        const code = (error as NodeJS.ErrnoException).code
        if (process.platform !== 'win32' || retry === undefined || (code !== 'EPERM' && code !== 'EBUSY')) {
          await unlink(temporary).catch(() => undefined); throw error
        }
        await delay(retry)
      }
    }
  }

  has(digest: string): boolean { return this.held.has(digest) }
  /** Whether content is only in memory: kept while history was off, and gone after a restart. */
  inMemory(digest: string): boolean { return Boolean(this.held.get(digest)?.memory) }
  /**
   * Refuses handles whose content this store does not keep, or whose type or size disagree with it, before a
   * command that carries them does anything. A window's handle is a claim; the store is what it is checked against.
   */
  verify(handles: readonly Pick<AgentAttachmentHandle, 'digest' | 'mimeType' | 'sizeBytes'>[] | undefined): void {
    for (const handle of handles ?? []) {
      const held = this.held.get(handle.digest)
      if (!held) throw new Error(this.missing)
      if (!describes(held, handle)) throw new Error(MISMATCHED_ATTACHMENT)
    }
  }
  /** Whether a handle names content this store keeps, as the handle describes it: what `verify` asks of each one. */
  keeps(handle: Pick<AgentAttachmentHandle, 'digest' | 'mimeType' | 'sizeBytes'>): boolean {
    const held = this.held.get(handle.digest)
    return held !== undefined && describes(held, handle)
  }
  /**
   * The bytes a digest names, or null when this store no longer keeps them. Bytes read from disk are hashed first:
   * a file missing, truncated, damaged or replaced since it was staged is not the image the user attached, so it is treated
   * as gone rather than sent under their digest. The file and its index entry go too, so the next start does not
   * take it back and every draft or follow-up that names it meets the missing-image sentence rather than a failed
   * send. Staging the same image again writes it afresh.
   */
  async read(digest: string): Promise<Buffer | null> {
    const held = this.held.get(digest)
    if (!held) return null
    if (held.memory) return held.memory
    let bytes: Buffer | null = null
    try { bytes = await readFile(this.file(held)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (bytes && createHash('sha256').update(bytes).digest('hex') === digest) return bytes
    // Content kept again under an image type meanwhile (`keepAsImage`) is read from its new file.
    const current = this.held.get(digest)
    if (current && current !== held && current.mimeType !== held.mimeType) return this.read(digest)
    if (current === held) {
      this.held.delete(digest)
      // In turn with staging: an image staged again meanwhile has written a good file, which is left alone.
      await this.enqueue(async () => {
        if (this.held.has(digest)) return
        await unlink(this.file(held)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
        await this.writeIndex()
      }).catch(() => undefined)
    }
    return null
  }
  /** The type a digest was staged as, so a reader can say what the bytes are. */
  mimeType(digest: string): string | null { return this.held.get(digest)?.mimeType ?? null }

  /**
   * Removes content nothing owns once it has been unowned for `graceMs`. Owned content starts its grace again the
   * next time nothing owns it. Content in `releaseNow` that nothing owns goes at once, without a grace: that is what
   * turning history off asks for the content only previews kept. Each is given with the time its latest preview was
   * stored; content staged again after that, for a draft not saved yet, keeps its grace instead.
   */
  sweep(owned: ReadonlySet<string> | (() => ReadonlySet<string>), graceMs = UNOWNED_ATTACHMENT_GRACE_MS, releaseNow: ReadonlyMap<string, number> = new Map()): Promise<void> {
    return this.enqueue(async () => {
      // Asked when the sweep runs, not when it was queued: whatever came to own content meanwhile keeps it.
      const kept = typeof owned === 'function' ? owned() : owned
      const now = this.now()
      const expired: Held[] = []
      for (const held of this.held.values()) {
        if (kept.has(held.digest)) { held.unownedSince = null; continue }
        held.unownedSince ??= now
        const previewedAt = releaseNow.get(held.digest)
        if ((previewedAt !== undefined && held.lastStagedAt <= previewedAt) || now - held.unownedSince >= graceMs) expired.push(held)
      }
      if (!expired.length) return
      for (const held of expired) this.held.delete(held.digest)
      if (expired.some(held => !held.memory)) await this.writeIndex()
      for (const held of expired) if (!held.memory) {
        await unlink(this.file(held)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
      }
    })
  }
  /** Waits for every stage and sweep already asked for. */
  idle(): Promise<void> { return this.enqueue(async () => undefined) }
}
