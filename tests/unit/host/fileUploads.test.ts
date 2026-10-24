// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { FILE_UPLOAD_IDLE_MS, FILE_UPLOAD_INCOMPLETE, FILE_UPLOAD_MISMATCH, FileUploadRefusal, FileUploads } from '../../../src/host/fileUploads'
import { HOST_FILE_PART_BYTES, HOST_FILE_PARTS_MAX, hostFilePartSchema, hostRequestSchema, type HostFilePart } from '../../../src/shared/hostProtocol'

/** A file's bytes cut into the parts a desktop sends, each naming the whole file. */
function partsOf(bytes: Buffer, { uploadId = randomUUID(), name = 'report.pdf', mimeType = 'application/pdf', partBytes = HOST_FILE_PART_BYTES } = {}): HostFilePart[] {
  const digest = createHash('sha256').update(bytes).digest('hex')
  const count = Math.max(1, Math.ceil(bytes.byteLength / partBytes))
  return Array.from({ length: count }, (_, index) => ({ uploadId, index, count, name, mimeType, sizeBytes: bytes.byteLength, digest,
    data: bytes.subarray(index * partBytes, (index + 1) * partBytes).toString('base64') }))
}

/** A clock the test moves, and the timers it would have run, so no test waits two real minutes. */
function scripted() {
  let now = 1_000_000
  const timers: { at: number; run: () => void; cancelled: boolean }[] = []
  return {
    now: () => now,
    schedule: (run: () => void, ms: number) => { const timer = { at: now + ms, run, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true } },
    advance(ms: number) { now += ms; for (const timer of timers) if (!timer.cancelled && timer.at <= now) { timer.cancelled = true; timer.run() } },
  }
}

const refusal = (run: () => unknown): string => {
  try { run() } catch (error) { if (error instanceof FileUploadRefusal) return error.message; throw error }
  throw new Error('The part was not refused.')
}

describe('a file sent to a host in parts (ADR-0127)', () => {
  it('puts parts that arrive in order back together, and answers only once the last has come', () => {
    const uploads = new FileUploads<string>()
    const bytes = Buffer.alloc(20 * 1024 * 1024 + 5, 7)
    const parts = partsOf(bytes)
    expect(parts).toHaveLength(3)
    expect(uploads.receive('desktop', parts[0]!)).toBeNull()
    expect(uploads.holds('desktop')).toBe(true)
    expect(uploads.receive('desktop', parts[1]!)).toBeNull()
    const file = uploads.receive('desktop', parts[2]!)
    expect(file).toMatchObject({ name: 'report.pdf', mimeType: 'application/pdf' })
    expect(Buffer.from(file!.bytes).equals(bytes)).toBe(true)
    expect(uploads.holds('desktop')).toBe(false)
  })

  it('refuses an upload with a part missing, and lets it go', () => {
    const uploads = new FileUploads<string>()
    const parts = partsOf(Buffer.alloc(3 * 1024, 1), { partBytes: 1024 })
    uploads.receive('desktop', parts[0]!)
    expect(refusal(() => uploads.receive('desktop', parts[2]!))).toBe(FILE_UPLOAD_INCOMPLETE)
    expect(uploads.holds('desktop')).toBe(false)
    // What came after the gap belongs to no upload the host holds.
    expect(refusal(() => uploads.receive('desktop', parts[1]!))).toBe(FILE_UPLOAD_INCOMPLETE)
  })

  it('refuses a file whose parts do not add up to the digest or size the first part named', () => {
    const uploads = new FileUploads<string>()
    const parts = partsOf(Buffer.alloc(2 * 1024, 1), { partBytes: 1024 })
    const changed = { ...parts[1]!, data: Buffer.alloc(1024, 2).toString('base64') }
    uploads.receive('desktop', parts[0]!)
    expect(refusal(() => uploads.receive('desktop', changed))).toBe(FILE_UPLOAD_MISMATCH)
    const short = partsOf(Buffer.alloc(2 * 1024, 1), { partBytes: 1024 })
    uploads.receive('desktop', short[0]!)
    expect(refusal(() => uploads.receive('desktop', { ...short[1]!, data: Buffer.alloc(10, 1).toString('base64') }))).toBe(FILE_UPLOAD_MISMATCH)
    expect(uploads.holds('desktop')).toBe(false)
  })

  it('refuses a part that names another file than its upload, or carries more than the file holds', () => {
    const uploads = new FileUploads<string>()
    const parts = partsOf(Buffer.alloc(2 * 1024, 1), { partBytes: 1024 })
    uploads.receive('desktop', parts[0]!)
    expect(refusal(() => uploads.receive('desktop', { ...parts[1]!, name: 'other.pdf' }))).toBe(FILE_UPLOAD_INCOMPLETE)
    const again = partsOf(Buffer.alloc(1024, 1), { partBytes: 512 })
    expect(refusal(() => uploads.receive('desktop', { ...again[0]!, data: Buffer.alloc(2048, 1).toString('base64') }))).toBe(FILE_UPLOAD_INCOMPLETE)
  })

  it('lets an upload go two minutes after its last part, on the scripted clock', () => {
    const clock = scripted()
    const uploads = new FileUploads<string>(clock)
    const parts = partsOf(Buffer.alloc(3 * 1024, 1), { partBytes: 1024 })
    uploads.receive('desktop', parts[0]!)
    clock.advance(FILE_UPLOAD_IDLE_MS - 1)
    expect(uploads.receive('desktop', parts[1]!)).toBeNull()
    clock.advance(FILE_UPLOAD_IDLE_MS - 1)
    expect(uploads.holds('desktop')).toBe(true)
    clock.advance(1)
    expect(uploads.holds('desktop')).toBe(false)
    expect(refusal(() => uploads.receive('desktop', parts[2]!))).toBe(FILE_UPLOAD_INCOMPLETE)
  })

  it('refuses a late part even when its timer has not run yet', () => {
    const uploads = new FileUploads<string>({ now: (() => { let at = 0; return () => (at += FILE_UPLOAD_IDLE_MS) })(), schedule: () => () => undefined })
    const parts = partsOf(Buffer.alloc(2 * 1024, 1), { partBytes: 1024 })
    uploads.receive('desktop', parts[0]!)
    expect(refusal(() => uploads.receive('desktop', parts[1]!))).toBe(FILE_UPLOAD_INCOMPLETE)
  })

  it('holds one upload per client: a new one replaces the one under way, and other clients keep theirs', () => {
    const uploads = new FileUploads<string>()
    const first = partsOf(Buffer.alloc(2 * 1024, 1), { partBytes: 1024 })
    const second = partsOf(Buffer.alloc(2 * 1024, 2), { partBytes: 1024, name: 'notes.txt', mimeType: 'text/plain' })
    const phone = partsOf(Buffer.alloc(2 * 1024, 3), { partBytes: 1024 })
    uploads.receive('desktop', first[0]!)
    uploads.receive('phone', phone[0]!)
    uploads.receive('desktop', second[0]!)
    // The first upload's next part is from an upload the host let go; the one under way is left alone.
    expect(refusal(() => uploads.receive('desktop', first[1]!))).toBe(FILE_UPLOAD_INCOMPLETE)
    expect(uploads.receive('desktop', second[1]!)).toMatchObject({ name: 'notes.txt', mimeType: 'text/plain' })
    expect(uploads.receive('phone', phone[1]!)).toMatchObject({ name: 'report.pdf' })
  })

  it('lets a client\'s upload go when it leaves', () => {
    const clock = scripted()
    const uploads = new FileUploads<string>(clock)
    const parts = partsOf(Buffer.alloc(2 * 1024, 1), { partBytes: 1024 })
    uploads.receive('desktop', parts[0]!)
    uploads.drop('desktop')
    expect(uploads.holds('desktop')).toBe(false)
    expect(refusal(() => uploads.receive('desktop', parts[1]!))).toBe(FILE_UPLOAD_INCOMPLETE)
    // Its timer was cancelled with it, so nothing runs later against a newer upload.
    const newer = partsOf(Buffer.alloc(2 * 1024, 4), { partBytes: 1024 })
    uploads.receive('desktop', newer[0]!)
    clock.advance(FILE_UPLOAD_IDLE_MS - 1)
    expect(uploads.holds('desktop')).toBe(true)
  })

  it('bounds a part on the wire: 8 MiB of bytes, in order, within a 25 MiB file', () => {
    const [part] = partsOf(Buffer.alloc(16, 1))
    expect(hostFilePartSchema.safeParse(part).success).toBe(true)
    expect(HOST_FILE_PARTS_MAX).toBe(4)
    expect(hostFilePartSchema.safeParse({ ...part, index: 1, count: 1 }).success).toBe(false)
    expect(hostFilePartSchema.safeParse({ ...part, count: 5 }).success).toBe(false)
    expect(hostFilePartSchema.safeParse({ ...part, sizeBytes: 25 * 1024 * 1024 + 1 }).success).toBe(false)
    expect(hostFilePartSchema.safeParse({ ...part, mimeType: 'Not a type' }).success).toBe(false)
    expect(hostFilePartSchema.safeParse({ ...part, data: 'A'.repeat(Math.ceil(HOST_FILE_PART_BYTES / 3) * 4 + 4) }).success).toBe(false)
    expect(hostRequestSchema.safeParse({ v: 1, id: 'one', session: 'session', op: 'stage-file-part', part }).success).toBe(true)
  })
})
