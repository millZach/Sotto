// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { threadVideoResponse, type ThreadVideoPart } from '../../../src/main/agents/threadMediaScheme'
import { AGENT_VIDEO_PART_BYTES } from '../../../src/shared/agentActivity'
import type { AgentThreadMediaPartRequest } from '../../../src/shared/agents'
import { threadVideoTarget, threadVideoUrl } from '../../../src/shared/threadVideoUrl'

const target = { threadId: 'thread/1', activityId: 'sotto-written-abc', mediaId: 'm1' }
/** A video of `size` bytes whose every byte is its own offset, mod 251, read a part at a time as the router hands it. */
function video(size: number) {
  const asked: AgentThreadMediaPartRequest[] = []
  const read = async (request: AgentThreadMediaPartRequest): Promise<ThreadVideoPart | null> => {
    asked.push(request)
    const start = request.part * AGENT_VIDEO_PART_BYTES
    if (start >= size) return null
    const bytes = Uint8Array.from({ length: Math.min(AGENT_VIDEO_PART_BYTES, size - start) }, (_, index) => (start + index) % 251)
    return { mimeType: 'video/webm', sizeBytes: size, bytes }
  }
  return { asked, read }
}
const ask = (range?: string, url = threadVideoUrl(target)) => new Request(url, range ? { headers: { range } } : {})

describe('the address a video plays from', () => {
  it('names its thread, record and handle, and nothing else reads as one', () => {
    expect(threadVideoTarget(threadVideoUrl(target))).toEqual(target)
    expect(threadVideoTarget('sotto-media://picture/a/b/m0')).toBeUndefined()
    expect(threadVideoTarget('sotto-media://video/a/b')).toBeUndefined()
    expect(threadVideoTarget('https://video/a/b/m0')).toBeUndefined()
  })
})

describe('a range of a video for the window\'s player', () => {
  it('answers from the part that holds the range\'s start, to that part\'s end or the range\'s own', async () => {
    const size = AGENT_VIDEO_PART_BYTES + 1_000, { asked, read } = video(size)
    const opening = await threadVideoResponse(ask('bytes=0-'), read)
    expect(opening.status).toBe(206)
    expect(opening.headers.get('content-range')).toBe(`bytes 0-${AGENT_VIDEO_PART_BYTES - 1}/${size}`)
    expect(opening.headers.get('content-type')).toBe('video/webm')
    const tail = await threadVideoResponse(ask(`bytes=${AGENT_VIDEO_PART_BYTES + 10}-${AGENT_VIDEO_PART_BYTES + 19}`), read)
    expect(tail.headers.get('content-range')).toBe(`bytes ${AGENT_VIDEO_PART_BYTES + 10}-${AGENT_VIDEO_PART_BYTES + 19}/${size}`)
    expect([...new Uint8Array(await tail.arrayBuffer())]).toEqual(Array.from({ length: 10 }, (_, index) => (AGENT_VIDEO_PART_BYTES + 10 + index) % 251))
    expect(asked.map(request => request.part)).toEqual([0, 1])
    expect(asked[0]).toEqual({ ...target, part: 0 })
  })

  it('takes a request with no range as one for the start', async () => {
    const response = await threadVideoResponse(ask(), video(500).read)
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 0-499/500')
  })

  it('is not found for another address, a video no longer readable, or a range it cannot read', async () => {
    expect((await threadVideoResponse(ask('bytes=0-', 'sotto-media://picture/a/b/m0'), video(500).read)).status).toBe(404)
    expect((await threadVideoResponse(ask('bytes=0-'), async () => null)).status).toBe(404)
    expect((await threadVideoResponse(ask('bytes=-500'), video(500).read)).status).toBe(404)
    expect((await threadVideoResponse(ask(`bytes=${AGENT_VIDEO_PART_BYTES * 30}-`), video(500).read)).status).toBe(416)
  })
})
