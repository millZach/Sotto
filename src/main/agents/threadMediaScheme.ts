import { AGENT_VIDEO_PART_BYTES } from '../../shared/agentActivity'
import { agentThreadMediaPartRequestSchema, type AgentThreadMediaPartRequest } from '../../shared/agents'
import { THREAD_MEDIA_SCHEME, threadVideoTarget } from '../../shared/threadVideoUrl'

/**
 * How the window plays a video an agent wrote (ADR-0170, part 4): `<video>` asks `sotto-media://video/...` for a range of
 * its bytes, and main answers from the part that holds it, read from the file on this computer or from the host that runs
 * the thread. The window is never handed a path, nothing is read before the player asks, and a part is all one answer
 * holds, so the player asks again for the rest as it plays.
 */
export const THREAD_MEDIA_SCHEME_PRIVILEGES = Object.freeze({ scheme: THREAD_MEDIA_SCHEME, privileges: Object.freeze({ standard: true, secure: true, stream: true }) })

/** One part of a video, as the router hands it to the scheme: what the whole video is, and this part's bytes. */
export interface ThreadVideoPart { readonly mimeType: string; readonly sizeBytes: number; readonly bytes: Uint8Array }

/** The first byte a `Range: bytes=<start>-<end>` asks for, and its last if it names one; 0 and none without one. */
function requestedRange(header: string | null): { start: number; end: number | undefined } | undefined {
  if (!header) return { start: 0, end: undefined }
  const range = /^bytes=(\d+)-(\d*)$/u.exec(header.trim())
  if (!range) return undefined
  const start = Number(range[1]), end = range[2] ? Number(range[2]) : undefined
  return Number.isSafeInteger(start) && (end === undefined || Number.isSafeInteger(end) && end >= start) ? { start, end } : undefined
}

/**
 * The answer to the player's request: 206 with the bytes from the range's start to the end of the part that holds it (or
 * the range's own end, if sooner), 404 for a request that names no video this computer can read, 416 for a range past
 * its end.
 */
export async function threadVideoResponse(request: Request, readPart: (request: AgentThreadMediaPartRequest) => Promise<ThreadVideoPart | null>): Promise<Response> {
  const target = threadVideoTarget(request.url)
  const range = requestedRange(request.headers.get('range'))
  if (!target || !range) return new Response(null, { status: 404 })
  const part = Math.floor(range.start / AGENT_VIDEO_PART_BYTES)
  const parsed = agentThreadMediaPartRequestSchema.safeParse({ ...target, part })
  if (!parsed.success) return new Response(null, { status: 416 })
  const found = await readPart(parsed.data).catch(() => null)
  if (!found) return new Response(null, { status: 404 })
  if (range.start >= found.sizeBytes) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${found.sizeBytes}` } })
  const from = range.start - part * AGENT_VIDEO_PART_BYTES
  const to = Math.min(found.bytes.byteLength, range.end === undefined ? Number.POSITIVE_INFINITY : range.end + 1 - part * AGENT_VIDEO_PART_BYTES)
  const body = found.bytes.subarray(from, to)
  const last = range.start + body.byteLength - 1
  // A part is always its own buffer's view (a read or a decoded part), never shared memory.
  return new Response(body as Uint8Array<ArrayBuffer>, { status: 206, headers: { 'Content-Type': found.mimeType, 'Accept-Ranges': 'bytes', 'Content-Length': String(body.byteLength),
    'Content-Range': `bytes ${range.start}-${last}/${found.sizeBytes}`, 'Cache-Control': 'no-store' } })
}
