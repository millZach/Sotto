import { describe, expect, it } from 'vitest'
import { AGENT_GENERIC_FILE_MIME_TYPE, AGENT_MAX_ATTACHMENTS_TOTAL_BYTES, AGENT_MAX_FILE_BYTES, AGENT_MAX_VIDEO_BYTES, agentAttachmentHandleSchema, agentAttachmentHandlesSchema,
  agentAttachmentStageFileRequestSchema, agentAttachmentStageRequestSchema, attachmentBytesBesideVideos, attachmentImagesBytes, attachmentVideosBytes, isVideoAttachment, attachmentMimeType, imagesNotReadRefusal, isImageAttachment, type AgentAttachmentHandle } from '../../../src/shared/agents'
import { HOST_FEATURES, HOST_VIDEO_PARTS_MAX, hostFilePartSchema, hostFileUploadProgressSchema, hostRequestSchema, isLargeVideoPart } from '../../../src/shared/hostProtocol'
import { isOwlFeatureEnabled, OWL_FEATURES, owlFeaturesForTrack } from '../../../src/shared/owlFeatures'

const MB = 1024 * 1024
let next = 0
const handle = (mimeType: string, sizeBytes: number): AgentAttachmentHandle => ({ id: `item-${next++}`, name: 'item', mimeType, sizeBytes, digest: 'a'.repeat(64) })

describe('attached files in the shared schemas (ADR-0131)', () => {
  it('tells an image from a file by its type alone', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) expect(isImageAttachment(type)).toBe(true)
    for (const type of ['image/svg+xml', 'image/heic', 'application/pdf', 'text/plain', AGENT_GENERIC_FILE_MIME_TYPE]) expect(isImageAttachment(type)).toBe(false)
  })

  it('stages a file under the browser\'s type, lowercased and without parameters, or the generic type', () => {
    expect(attachmentMimeType('application/pdf')).toBe('application/pdf')
    expect(attachmentMimeType('Text/Plain; charset=UTF-8')).toBe('text/plain')
    expect(attachmentMimeType('')).toBe(AGENT_GENERIC_FILE_MIME_TYPE)
    expect(attachmentMimeType('not a type')).toBe(AGENT_GENERIC_FILE_MIME_TYPE)
    expect(attachmentMimeType(`application/${'x'.repeat(130)}`)).toBe(AGENT_GENERIC_FILE_MIME_TYPE)
    // A video the browser gives no type takes one from its extension, so it is held to a video's limit (Chromium on Linux, November 9 amendment).
    expect(attachmentMimeType('', 'IMG_0412.MOV')).toBe('video/quicktime')
    expect(attachmentMimeType('application/octet-stream', 'clip.mkv')).toBe('video/x-matroska')
    expect(attachmentMimeType('', 'notes')).toBe(AGENT_GENERIC_FILE_MIME_TYPE)
    expect(attachmentMimeType('', 'archive.zip')).toBe(AGENT_GENERIC_FILE_MIME_TYPE)
    expect(attachmentMimeType('video/mp4', 'clip.mov')).toBe('video/mp4')
  })

  it('takes any well-formed type on a handle and a stage request, with limits by kind', () => {
    expect(agentAttachmentHandleSchema.safeParse(handle('application/vnd.openxmlformats-officedocument.wordprocessingml.document', AGENT_MAX_FILE_BYTES)).success).toBe(true)
    expect(agentAttachmentHandleSchema.safeParse(handle('application/pdf', AGENT_MAX_FILE_BYTES + 1)).success).toBe(false)
    expect(agentAttachmentHandleSchema.safeParse(handle('image/png', 10 * MB)).success).toBe(true)
    expect(agentAttachmentHandleSchema.safeParse(handle('image/png', 10 * MB + 1)).success).toBe(false)
    for (const type of ['PDF', 'application/PDF', 'text/plain; charset=utf-8', '/plain', `a/${'b'.repeat(127)}`]) {
      expect(agentAttachmentHandleSchema.safeParse(handle(type, 1)).success, type).toBe(false)
    }
    const request = (mimeType: string, size: number) => ({ threadId: 'thread', name: 'file', mimeType, bytes: new Uint8Array(size) })
    expect(agentAttachmentStageRequestSchema.safeParse(request('text/plain', 12 * MB)).success).toBe(true)
    expect(agentAttachmentStageRequestSchema.safeParse(request('image/png', 12 * MB)).success).toBe(false)
    expect(agentAttachmentStageRequestSchema.safeParse(request('text/plain', AGENT_MAX_FILE_BYTES + 1)).success).toBe(false)
  })

  it('holds a set to 8 attachments, 20 MiB of images and 50 MiB in all', () => {
    expect(agentAttachmentHandlesSchema.safeParse([handle('image/png', 10 * MB), handle('image/png', 10 * MB), handle('application/zip', 25 * MB)]).success).toBe(true)
    expect(agentAttachmentHandlesSchema.safeParse([handle('image/png', 10 * MB), handle('image/png', 10 * MB), handle('image/gif', 1)]).success).toBe(false)
    expect(agentAttachmentHandlesSchema.safeParse([handle('application/zip', 25 * MB), handle('application/zip', 25 * MB)]).success).toBe(true)
    expect(agentAttachmentHandlesSchema.safeParse([handle('application/zip', 25 * MB), handle('application/zip', 25 * MB), handle('text/plain', 1)]).success).toBe(false)
    expect(agentAttachmentHandlesSchema.safeParse(Array.from({ length: 9 }, () => handle('text/plain', 1))).success).toBe(false)
    expect(attachmentImagesBytes([handle('image/png', 3), handle('text/plain', 5)])).toBe(3)
    expect(AGENT_MAX_ATTACHMENTS_TOTAL_BYTES).toBe(50 * MB)
  })

  it('names the image a model that reads none is refused', () => {
    expect(imagesNotReadRefusal('screenshot.png')).toBe('This model does not read images. Choose a model with image support, or remove screenshot.png.')
  })

  it('lists attaching any file as an Owl feature, off on stable and on Owl, and a host feature for it', () => {
    expect(OWL_FEATURES).toContainEqual({ id: 'attach-any-file', name: 'Attach any file', owlSince: '2026-10-24', owner: 'docs/adr/0131-any-file-can-be-attached.md', sentToStable: false })
    expect(isOwlFeatureEnabled('attach-any-file', 'stable')).toBe(false)
    expect(isOwlFeatureEnabled('attach-any-file', 'owl')).toBe(true)
    expect(owlFeaturesForTrack('stable')['attach-any-file']).toBe(false)
    expect(HOST_FEATURES).toContain('file-staging')
  })
})

describe('videos in the shared schemas (ADR-0131, November 9 amendment)', () => {
  it('tells a video by its type, and gives it 500 MiB where a file has 25 MiB', () => {
    for (const type of ['video/quicktime', 'video/mp4', 'video/webm', 'video/x-m4v']) expect(isVideoAttachment(type)).toBe(true)
    for (const type of ['image/png', 'application/mp4', 'audio/mp4', 'text/plain']) expect(isVideoAttachment(type)).toBe(false)
    expect(AGENT_MAX_VIDEO_BYTES).toBe(500 * MB)
    expect(agentAttachmentHandleSchema.safeParse(handle('video/quicktime', 500 * MB)).success).toBe(true)
    expect(agentAttachmentHandleSchema.safeParse(handle('video/quicktime', 500 * MB + 1)).success).toBe(false)
    expect(agentAttachmentHandleSchema.safeParse(handle('application/zip', 26 * MB)).success).toBe(false)
  })

  it('counts videos against their own 500 MiB, apart from the 50 MiB for everything else', () => {
    const set = [handle('video/quicktime', 300 * MB), handle('video/mp4', 200 * MB), handle('application/zip', 25 * MB), handle('application/zip', 25 * MB)]
    expect(agentAttachmentHandlesSchema.safeParse(set).success).toBe(true)
    expect(attachmentVideosBytes(set)).toBe(500 * MB)
    expect(attachmentBytesBesideVideos(set)).toBe(50 * MB)
    expect(agentAttachmentHandlesSchema.safeParse([...set, handle('video/mp4', 1)]).success).toBe(false)
    expect(agentAttachmentHandlesSchema.safeParse([...set, handle('text/plain', 1)]).success).toBe(false)
    // Eight attachments in all, videos among them.
    expect(agentAttachmentHandlesSchema.safeParse(Array.from({ length: 9 }, () => handle('video/mp4', 1))).success).toBe(false)
  })

  it('stages a video by path only, never anything else, and never by bytes past a file\'s limit', () => {
    const request = (mimeType: string) => ({ threadId: null, name: 'clip.mov', mimeType, path: '/Users/me/clip.mov' })
    expect(agentAttachmentStageFileRequestSchema.safeParse(request('video/quicktime')).success).toBe(true)
    expect(agentAttachmentStageFileRequestSchema.safeParse(request('application/zip')).success).toBe(false)
    expect(agentAttachmentStageRequestSchema.safeParse({ threadId: null, name: 'clip.mov', mimeType: 'video/quicktime', bytes: new Uint8Array(AGENT_MAX_FILE_BYTES + 1) }).success).toBe(false)
  })

  it('lets a part name a video of up to 63 parts, and anything else no more than a file\'s four', () => {
    const part = (mimeType: string, sizeBytes: number, count: number, index = 0) => ({ uploadId: crypto.randomUUID(), index, count, name: 'clip.mov', mimeType, sizeBytes, digest: 'a'.repeat(64), data: 'AAAA' })
    expect(HOST_VIDEO_PARTS_MAX).toBe(63)
    expect(hostFilePartSchema.safeParse(part('video/quicktime', 500 * MB, 63, 62)).success).toBe(true)
    expect(hostFilePartSchema.safeParse(part('video/quicktime', 500 * MB + 1, 63)).success).toBe(false)
    expect(hostFilePartSchema.safeParse(part('application/zip', 30 * MB, 4)).success).toBe(false)
    expect(hostFilePartSchema.safeParse(part('application/zip', 25 * MB, 5)).success).toBe(false)
    expect(hostFilePartSchema.safeParse(part('application/zip', 25 * MB, 4)).success).toBe(true)
    expect(isLargeVideoPart(part('video/mp4', 25 * MB, 4))).toBe(false)
    expect(isLargeVideoPart(part('video/mp4', 25 * MB + 1, 4))).toBe(true)
    expect(hostRequestSchema.safeParse({ v: 1, id: 'one', session: 'session', op: 'file-upload-progress', uploadId: crypto.randomUUID() }).success).toBe(true)
    expect(hostFileUploadProgressSchema.safeParse({ parts: 3 }).success).toBe(true)
    expect(hostFileUploadProgressSchema.safeParse(null).success).toBe(true)
    expect(hostFileUploadProgressSchema.safeParse({ parts: 0 }).success).toBe(false)
    expect(HOST_FEATURES).toContain('video-staging')
  })
})
