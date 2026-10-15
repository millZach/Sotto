import { useEffect, useMemo, useState } from 'react'
import { agentAttachmentPreviewDataSchema, type AgentAttachmentReference } from '../../../shared/agents'

// Raster data URLs are ASCII (one byte per character); other retained strings use two.
const PREVIEW_CACHE_BYTES = 8 * 1024 * 1024
function evictPreviews<T extends { size: number }>(cache: Map<string, T>, limit: number): void {
  let bytes = 0
  for (const entry of cache.values()) bytes += entry.size
  for (const [key, entry] of cache) {
    if (cache.size <= limit && bytes <= PREVIEW_CACHE_BYTES) break
    cache.delete(key); bytes -= entry.size
  }
}
const validatedPreviews = new Map<string, { valid: boolean; size: number }>()
const VALIDATED_PREVIEW_CACHE = 48

/** The preview as an image source only when it is a validated raster data URL. */
function trustedPreviewSource(dataUrl: string | undefined): string | null {
  if (typeof dataUrl !== 'string') return null
  let entry = validatedPreviews.get(dataUrl)
  if (entry === undefined) {
    const valid = agentAttachmentPreviewDataSchema.safeParse({ dataUrl }).success
    entry = { valid, size: dataUrl.length * (valid ? 1 : 2) }
    if (entry.size <= PREVIEW_CACHE_BYTES) {
      validatedPreviews.set(dataUrl, entry)
      evictPreviews(validatedPreviews, VALIDATED_PREVIEW_CACHE)
    }
  }
  return entry.valid ? dataUrl : null
}

/** The message a submitted attachment belongs to, which is how main finds its preview bytes. */
export interface AttachmentOrigin { readonly threadId: string; readonly messageId: string }

// Published state carries markers alone; cache fetched images within count and byte bounds.
const fetchedPreviews = new Map<string, { source: Promise<string | null>; size: number }>()
const pendingPreviews = new Map<string, { source: Promise<string | null>; size: number }>()
const FETCHED_PREVIEW_CACHE = 64

function requestPreview(origin: AttachmentOrigin, attachmentId: string): Promise<string | null> {
  const key = JSON.stringify([origin.threadId, origin.messageId, attachmentId])
  const cached = fetchedPreviews.get(key) ?? pendingPreviews.get(key)
  if (cached) return cached.source
  const bridge = window.sotto?.agents
  const pending: Promise<string | null> = bridge?.attachmentPreview
    ? bridge.attachmentPreview({ threadId: origin.threadId, messageId: origin.messageId, attachmentId })
      .then(result => trustedPreviewSource(result?.dataUrl), () => null)
    : Promise.resolve(null)
  const entry = { source: pending, size: key.length * 2 }
  // Deduplicate reads separately: an unknown result cannot evict a retained image yet.
  if (entry.size <= PREVIEW_CACHE_BYTES) {
    pendingPreviews.set(key, entry)
    evictPreviews(pendingPreviews, FETCHED_PREVIEW_CACHE)
  }
  // A preview main could not hand over may exist later; only the bytes themselves are worth keeping.
  void pending.then(source => {
    // An evicted request may finish after another request for the same image was cached.
    if (pendingPreviews.get(key) !== entry) return
    pendingPreviews.delete(key)
    if (source !== null) {
      entry.size += source.length
      if (entry.size <= PREVIEW_CACHE_BYTES) {
        fetchedPreviews.set(key, entry)
        evictPreviews(fetchedPreviews, FETCHED_PREVIEW_CACHE)
      }
    }
  })
  return pending
}

/**
 * The image an attachment shows: a draft's own bytes, or a submitted image's bytes fetched from main by its message.
 * `awaiting` while that request is still out, so a pending tile does not claim the preview is unavailable.
 */
export function useAttachmentSource(attachment: Pick<AgentAttachmentReference, 'id'> & Partial<Pick<AgentAttachmentReference, 'preview'>>,
  origin: AttachmentOrigin | undefined): { readonly source: string | null; readonly awaiting: boolean } {
  const inline = attachment.preview && 'dataUrl' in attachment.preview ? attachment.preview.dataUrl : undefined
  const marked = Boolean(attachment.preview && 'available' in attachment.preview)
  const [fetched, setFetched] = useState<string | null | undefined>(undefined)
  const threadId = origin?.threadId
  const messageId = origin?.messageId
  useEffect(() => {
    setFetched(undefined)
    if (inline !== undefined || !marked || threadId === undefined || messageId === undefined) return
    let live = true
    void requestPreview({ threadId, messageId }, attachment.id).then(source => { if (live) setFetched(source) })
    return () => { live = false }
  }, [inline, marked, threadId, messageId, attachment.id])
  const dataUrl = inline ?? fetched ?? undefined
  const source = useMemo(() => trustedPreviewSource(dataUrl), [dataUrl])
  return { source, awaiting: inline === undefined && marked && fetched === undefined && threadId !== undefined && messageId !== undefined }
}
