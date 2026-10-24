import { createHash } from 'node:crypto'
import { FILE_UPLOAD_INCOMPLETE, FILE_UPLOAD_MISMATCH } from '../shared/agents'
import { HOST_FILE_PART_BYTES, type HostFilePart } from '../shared/hostProtocol'

export { FILE_UPLOAD_INCOMPLETE, FILE_UPLOAD_MISMATCH }

/** How long an upload waits for its next part before the host lets it go (ADR-0127). */
export const FILE_UPLOAD_IDLE_MS = 2 * 60_000

/** A part refused for what it is, whose sentence the client is shown. */
export class FileUploadRefusal extends Error {}

/** A file whose every part has arrived and whose size and digest are the ones its parts named. */
export interface ReceivedFile { readonly name: string; readonly mimeType: string; readonly bytes: Uint8Array }

interface Upload {
  readonly part: Omit<HostFilePart, 'index' | 'data'>
  readonly chunks: Buffer[]
  next: number
  received: number
  lastPartAt: number
  cancel: () => void
}

/**
 * The parts of attached files on their way to this host (`file-staging`, ADR-0127). A client holds one upload at a time:
 * a first part starts it, replacing any other that client had under way, so an upload the client gave up on never holds
 * the next one back. Parts come in order. An upload is let go two minutes after its last part, when its client leaves
 * (`drop`), or once its last part arrives, when its size and digest are checked. Nothing here reaches disk or a log.
 */
export class FileUploads<Client> {
  private readonly uploads = new Map<Client, Upload>()
  private readonly now: () => number
  private readonly schedule: (run: () => void, ms: number) => () => void
  constructor({ now = () => Date.now(), schedule = defaultSchedule }: {
    readonly now?: () => number
    /** Runs `run` after `ms` and answers with what cancels it; scripted in tests, never a real sleep. */
    readonly schedule?: (run: () => void, ms: number) => () => void
  } = {}) {
    this.now = now; this.schedule = schedule
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

  /** Lets go of a client's upload, as when it leaves. */
  drop(client: Client): void {
    const upload = this.uploads.get(client)
    if (!upload) return
    upload.cancel()
    this.uploads.delete(client)
  }

  /** Whether a client has an upload under way. */
  holds(client: Client): boolean { return this.uploads.has(client) }
}

function sameFile(upload: Upload['part'], part: HostFilePart): boolean {
  return upload.count === part.count && upload.name === part.name && upload.mimeType === part.mimeType
    && upload.sizeBytes === part.sizeBytes && upload.digest === part.digest
}

function defaultSchedule(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms)
  timer.unref?.()
  return () => clearTimeout(timer)
}
