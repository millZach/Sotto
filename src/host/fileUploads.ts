import { createHash, randomUUID, type Hash } from 'node:crypto'
import { mkdir, open, unlink, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { FILE_UPLOAD_INCOMPLETE, FILE_UPLOAD_MISMATCH, isVideoAttachment } from '../shared/agents'
import { HOST_FILE_PART_BYTES, type HostFilePart } from '../shared/hostProtocol'

export { FILE_UPLOAD_INCOMPLETE, FILE_UPLOAD_MISMATCH }

/** How long an upload waits for its next part before the host lets it go (ADR-0131). */
export const FILE_UPLOAD_IDLE_MS = 2 * 60_000
/**
 * How long a video's upload is kept after its last part, even once its client has gone, so the client can carry on
 * where it stopped when it is back (`video-staging`, ADR-0131, November 9 amendment).
 */
export const VIDEO_UPLOAD_IDLE_MS = 10 * 60_000

/** A part refused for what it is, whose sentence the client is shown. */
export class FileUploadRefusal extends Error {}

/** A file whose every part has arrived and whose size and digest are the ones its parts named. */
export interface ReceivedFile { readonly name: string; readonly mimeType: string; readonly bytes: Uint8Array }
/** A video whose every part has arrived on disk and checks out: the store takes the file from `path`. */
export interface ReceivedVideo { readonly name: string; readonly mimeType: string; readonly path: string; readonly sizeBytes: number; readonly digest: string }

interface Upload {
  readonly part: Omit<HostFilePart, 'index' | 'data'>
  readonly chunks: Buffer[]
  next: number
  received: number
  lastPartAt: number
  cancel: () => void
  /** A video's parts go to this file, hashed as they arrive, rather than to `chunks`. */
  readonly disk?: { readonly path: string; readonly file: FileHandle; readonly hash: Hash }
}

/**
 * The parts of attached files on their way to this host (`file-staging`, ADR-0131). A client holds one upload at a time:
 * a first part starts it, replacing any other that client had under way, so an upload the client gave up on never holds
 * the next one back. Parts come in order. An upload is let go two minutes after its last part, when its client leaves
 * (`leave`), or once its last part arrives, when its size and digest are checked. A file's parts never reach disk.
 * With `video-staging`, a video's parts are written to a file in the store's folder instead, hashed as they come, and
 * its upload is kept ten minutes after its last part, its client gone or not, so the client can ask `progress` and
 * carry on. Nothing here reaches a log.
 */
export class FileUploads<Client> {
  private readonly uploads = new Map<Client, Upload>()
  private readonly turns = new Map<Client, Promise<unknown>>()
  private readonly now: () => number
  private readonly schedule: (run: () => void, ms: number) => () => void
  /** Where a video's parts are written, with `video-staging`; without one, a video's parts are kept in memory as a file's are. */
  readonly videoFolder: string | undefined
  constructor({ now = () => Date.now(), schedule = defaultSchedule, videoFolder }: {
    readonly now?: () => number
    /** Runs `run` after `ms` and answers with what cancels it; scripted in tests, never a real sleep. */
    readonly schedule?: (run: () => void, ms: number) => () => void
    readonly videoFolder?: string | undefined
  } = {}) {
    this.now = now; this.schedule = schedule; this.videoFolder = videoFolder
  }

  /**
   * Takes one part of any upload: a video's goes to disk with `video-staging`, anything else to `receive`. One part of a
   * client's at a time, whichever of its sockets it came on.
   */
  receivePart(client: Client, part: HostFilePart): Promise<ReceivedFile | ReceivedVideo | null> {
    const folder = this.videoFolder
    if (!folder || !isVideoAttachment(part.mimeType)) return Promise.resolve().then(() => this.receive(client, part))
    const turn = (this.turns.get(client) ?? Promise.resolve()).then(() => this.receiveToDisk(client, part, folder))
    const settled = turn.catch(() => undefined)
    this.turns.set(client, settled)
    void settled.then(() => { if (this.turns.get(client) === settled) this.turns.delete(client) })
    return turn
  }

  /** How many parts of `uploadId` the host holds for this client: the next part it should send, or null when it holds none. */
  progress(client: Client, uploadId: string): number | null {
    const upload = this.uploads.get(client)
    if (!upload || upload.part.uploadId !== uploadId || upload.next < 1 || this.now() - upload.lastPartAt >= idleOf(upload)) return null
    return upload.next
  }

  /** A client's last socket closed: a file's upload goes, a video's is kept until its own wait is over, for the client to carry on. */
  leave(client: Client): void {
    if (!this.uploads.get(client)?.disk) this.drop(client)
  }

  private async receiveToDisk(client: Client, part: HostFilePart, folder: string): Promise<ReceivedVideo | null> {
    const now = this.now()
    let upload = this.uploads.get(client)
    if (upload && now - upload.lastPartAt >= idleOf(upload)) { this.drop(client); upload = undefined }
    if (part.index === 0) {
      if (upload) this.drop(client)
      await mkdir(folder, { recursive: true })
      const path = join(folder, `${randomUUID()}.part`)
      const file = await open(path, 'wx', 0o600)
      const whole = { uploadId: part.uploadId, count: part.count, name: part.name, mimeType: part.mimeType, sizeBytes: part.sizeBytes, digest: part.digest }
      upload = { part: whole, chunks: [], next: 0, received: 0, lastPartAt: now, cancel: () => undefined, disk: { path, file, hash: createHash('sha256') } }
      this.uploads.set(client, upload)
    } else if (!upload || upload.part.uploadId !== part.uploadId || !upload.disk) {
      throw new FileUploadRefusal(FILE_UPLOAD_INCOMPLETE)
    } else if (part.index !== upload.next || !sameFile(upload.part, part)) {
      this.drop(client); throw new FileUploadRefusal(FILE_UPLOAD_INCOMPLETE)
    }
    const disk = upload.disk!
    const data = Buffer.from(part.data, 'base64')
    if (data.byteLength > HOST_FILE_PART_BYTES || upload.received + data.byteLength > upload.part.sizeBytes) {
      this.drop(client); throw new FileUploadRefusal(FILE_UPLOAD_INCOMPLETE)
    }
    try {
      // A write may take fewer bytes than it was given; the part counts only once every byte is in the file.
      for (let written = 0; written < data.byteLength;) {
        const { bytesWritten } = await disk.file.write(data, written, data.byteLength - written, upload.received + written)
        if (bytesWritten < 1) throw new Error('The part could not be written.')
        written += bytesWritten
      }
    } catch (error) { this.drop(client); throw error }
    disk.hash.update(data); upload.received += data.byteLength; upload.next += 1; upload.lastPartAt = now
    upload.cancel()
    if (upload.next < upload.part.count) {
      const waiting = upload
      upload.cancel = this.schedule(() => { if (this.uploads.get(client) === waiting) this.drop(client) }, VIDEO_UPLOAD_IDLE_MS)
      return null
    }
    this.uploads.delete(client)
    await disk.file.close()
    if (upload.received !== upload.part.sizeBytes || disk.hash.digest('hex') !== upload.part.digest) {
      await unlink(disk.path).catch(() => undefined)
      throw new FileUploadRefusal(FILE_UPLOAD_MISMATCH)
    }
    return { name: upload.part.name, mimeType: upload.part.mimeType, path: disk.path, sizeBytes: upload.received, digest: upload.part.digest }
  }

  /** Takes one part. Null while parts are still to come; the whole file once the last has arrived and checks out. */
  receive(client: Client, part: HostFilePart): ReceivedFile | null {
    const now = this.now()
    let upload = this.uploads.get(client)
    if (upload && now - upload.lastPartAt >= FILE_UPLOAD_IDLE_MS) { this.drop(client); upload = undefined }
    if (part.index === 0) {
      if (upload) this.drop(client)
      const whole = { uploadId: part.uploadId, count: part.count, name: part.name, mimeType: part.mimeType, sizeBytes: part.sizeBytes, digest: part.digest }
      upload = { part: whole, chunks: [], next: 0, received: 0, lastPartAt: now, cancel: () => undefined }
      this.uploads.set(client, upload)
    } else if (!upload || upload.part.uploadId !== part.uploadId) {
      // A stray part of an upload this host no longer holds leaves the one under way alone.
      throw new FileUploadRefusal(FILE_UPLOAD_INCOMPLETE)
    } else if (part.index !== upload.next || !sameFile(upload.part, part)) {
      this.drop(client); throw new FileUploadRefusal(FILE_UPLOAD_INCOMPLETE)
    }
    const data = Buffer.from(part.data, 'base64')
    if (data.byteLength > HOST_FILE_PART_BYTES || upload.received + data.byteLength > upload.part.sizeBytes) {
      this.drop(client); throw new FileUploadRefusal(FILE_UPLOAD_INCOMPLETE)
    }
    upload.chunks.push(data); upload.received += data.byteLength; upload.next += 1; upload.lastPartAt = now
    upload.cancel()
    if (upload.next < upload.part.count) {
      const waiting = upload
      upload.cancel = this.schedule(() => { if (this.uploads.get(client) === waiting) this.uploads.delete(client) }, FILE_UPLOAD_IDLE_MS)
      return null
    }
    this.drop(client)
    const bytes = Buffer.concat(upload.chunks, upload.received)
    if (bytes.byteLength !== upload.part.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== upload.part.digest) {
      throw new FileUploadRefusal(FILE_UPLOAD_MISMATCH)
    }
    return { name: upload.part.name, mimeType: upload.part.mimeType, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) }
  }

  /** Lets go of a client's upload, as when it leaves; a video's part file goes with it. */
  drop(client: Client): void {
    const upload = this.uploads.get(client)
    if (!upload) return
    upload.cancel()
    this.uploads.delete(client)
    if (upload.disk) { const { file, path } = upload.disk; void file.close().catch(() => undefined).then(() => unlink(path)).catch(() => undefined) }
  }

  /** Whether a client has an upload under way. */
  holds(client: Client): boolean { return this.uploads.has(client) }
}

function idleOf(upload: Upload): number { return upload.disk ? VIDEO_UPLOAD_IDLE_MS : FILE_UPLOAD_IDLE_MS }

function sameFile(upload: Upload['part'], part: HostFilePart): boolean {
  return upload.count === part.count && upload.name === part.name && upload.mimeType === part.mimeType
    && upload.sizeBytes === part.sizeBytes && upload.digest === part.digest
}

function defaultSchedule(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms)
  timer.unref?.()
  return () => clearTimeout(timer)
}
