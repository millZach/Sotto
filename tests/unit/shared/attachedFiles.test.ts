import { describe, expect, it } from 'vitest'
import { AGENT_GENERIC_FILE_MIME_TYPE, AGENT_MAX_ATTACHMENTS_TOTAL_BYTES, AGENT_MAX_FILE_BYTES, agentAttachmentHandleSchema, agentAttachmentHandlesSchema,
  agentAttachmentStageRequestSchema, attachmentImagesBytes, attachmentMimeType, imagesNotReadRefusal, isImageAttachment, type AgentAttachmentHandle } from '../../../src/shared/agents'
import { HOST_FEATURES } from '../../../src/shared/hostProtocol'
import { isOwlFeatureEnabled, OWL_FEATURES, owlFeaturesForTrack } from '../../../src/shared/owlFeatures'

const MB = 1024 * 1024
let next = 0
const handle = (mimeType: string, sizeBytes: number): AgentAttachmentHandle => ({ id: `item-${next++}`, name: 'item', mimeType, sizeBytes, digest: 'a'.repeat(64) })

describe('attached files in the shared schemas (ADR-0127)', () => {
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
    expect(OWL_FEATURES).toContainEqual({ id: 'attach-any-file', name: 'Attach any file', owlSince: '2026-10-24', owner: 'docs/adr/0127-any-file-can-be-attached.md', sentToStable: false })
    expect(isOwlFeatureEnabled('attach-any-file', 'stable')).toBe(false)
    expect(isOwlFeatureEnabled('attach-any-file', 'owl')).toBe(true)
    expect(owlFeaturesForTrack('stable')['attach-any-file']).toBe(false)
    expect(HOST_FEATURES).toContain('file-staging')
  })
})
