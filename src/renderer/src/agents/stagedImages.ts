import { useEffect, useState } from 'react'
import type { AgentAttachmentDimensions, AgentAttachmentHandle, AgentWireBridge } from '../../../shared/agents'

/** The long edge of a chip's thumbnail, in pixels: twice the chip's own size, so it stays sharp at 200%. */
export const THUMBNAIL_EDGE = 256
/**
 * Thumbnails kept for the life of the window, most recently used last: at most 64 of them, and at most 8 MiB of
 * data URL between them. A drawn one is a few tens of kilobytes; an image the canvas will not draw is kept as it
 * is, up to UNDRAWN_LIMIT, which is what the byte bound is for.
 */
const THUMBNAIL_CACHE = 64
const THUMBNAIL_CACHE_CHARACTERS = 8 * 1024 * 1024
/** `size` is the data URL's length once it is made; 0 while it is being made. */
const thumbnails = new Map<string, { readonly source: Promise<string | null>; size: number }>()

/** Only the staging calls are used, which cross the bridge as they are. */
function agents(): AgentWireBridge | undefined { return window.sotto?.agents }

/** Drops the least recently used thumbnails until the cache is within both bounds. The newest is always kept. */
function evict(): void {
  let characters = 0
  for (const entry of thumbnails.values()) characters += entry.size
  for (const [digest, entry] of thumbnails) {
    if ((thumbnails.size <= THUMBNAIL_CACHE && characters <= THUMBNAIL_CACHE_CHARACTERS) || thumbnails.size === 1) return
    thumbnails.delete(digest); characters -= entry.size
  }
}
function remember(digest: string, source: Promise<string | null>): Promise<string | null> {
  const entry = { source, size: 0 }
  thumbnails.delete(digest)
  thumbnails.set(digest, entry)
  evict()
  void source.then(value => {
    if (thumbnails.get(digest) !== entry) return
    // A thumbnail that could not be made may be made later, from bytes read again.
    if (value === null) thumbnails.delete(digest)
    else { entry.size = value.length; evict() }
  })
  return source
}
/** A cached thumbnail, which becomes the most recently used. */
function cached(digest: string): Promise<string | null> | undefined {
  const entry = thumbnails.get(digest)
  if (!entry) return undefined
  thumbnails.delete(digest); thumbnails.set(digest, entry)
  return entry.source
}

/** The largest image a chip shows as it is when the canvas will not draw a thumbnail of it. */
const UNDRAWN_LIMIT = 1024 * 1024
/**
 * What a chip shows: a copy of the image at most THUMBNAIL_EDGE on its long side, drawn once in this window. An
 * image of at most UNDRAWN_LIMIT that the canvas will not decode, which an image element may still show, is shown as
 * it is, so that copy is not bounded in pixels; otherwise the chip shows the image's name.
 */
async function chipSource(image: Blob): Promise<string | null> {
  const drawn = await drawThumbnail(image)
  if (drawn !== null || image.size > UNDRAWN_LIMIT || typeof FileReader === 'undefined') return drawn
  return new Promise(resolve => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(image)
  })
}

async function drawThumbnail(image: Blob): Promise<string | null> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null
  try {
    const bitmap = await createImageBitmap(image)
    const scale = Math.min(1, THUMBNAIL_EDGE / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (!context) { bitmap.close(); return null }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    return canvas.toDataURL('image/png')
  } catch { return null }
}

/** A screenshot could not be staged and no sentence says why. */
export const STAGING_FAILED = 'Could not add this screenshot. Nothing was attached. Try again.'
/** A screenshot's bytes could not be read before staging, as when its file was removed or locked since it was chosen. */
const READ_FAILED = 'Could not read this screenshot. Nothing was attached. Try adding it again.'
/**
 * The sentence a failed staging shows. Electron prefixes whatever main threw with the channel it came through, which
 * is not the user's to read; a refusal with no sentence of its own (a sender or schema check) gets the plain one.
 */
export function stagingError(error: unknown): string {
  const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/u, '').trim() : ''
  return /^[A-Z][A-Z0-9_]+$/u.test(message) || message.startsWith('[') || message.startsWith('{') || !message ? STAGING_FAILED : message
}

/**
 * Why a staging failed, in main's own sentence, or null when it gave none of its own and only the plain failure
 * (or something that is not a sentence for the user) is left.
 */
export function stagingReason(error: unknown): string | null {
  const message = error instanceof Error ? error.message : ''
  return message === STAGING_FAILED || message === READ_FAILED || !/^[A-Z].*\.$/u.test(message) ? null : message
}

/**
 * Hands an image's bytes to main once and answers with its handle (ADR-0031). `threadId` is the thread the draft
 * belongs to, which decides the host that keeps it; null is the coordinator's composer on the selected host. Anything
 * that changes the image before it is sent, such as a downscale, runs before this and hands over its result.
 */
export async function stageImage(threadId: string | null, image: { readonly name: string; readonly mimeType: string; readonly blob: Blob; readonly dimensions?: AgentAttachmentDimensions }): Promise<AgentAttachmentHandle> {
  const bridge = agents()
  if (!bridge?.stageAttachment) throw new Error('Screenshots cannot be attached in this window. Nothing was attached.')
  // A file removed or locked since it was chosen cannot be read; the browser's own words for that are not the user's.
  const bytes = new Uint8Array(await image.blob.arrayBuffer().catch((error: unknown) => { throw new Error(READ_FAILED, { cause: error }) }))
  let handle: AgentAttachmentHandle
  try {
    handle = await bridge.stageAttachment({ threadId, name: image.name, mimeType: image.mimeType as AgentAttachmentHandle['mimeType'], bytes,
      ...(image.dimensions ? { dimensions: image.dimensions } : {}) })
  }
  catch (error) { throw new Error(stagingError(error), { cause: error }) }
  if (!cached(handle.digest)) remember(handle.digest, chipSource(new Blob([bytes], { type: handle.mimeType })))
  return handle
}

/** The chip's thumbnail: drawn when the image was staged here, or from the bytes its host still keeps. */
export function thumbnailFor(threadId: string | null, handle: Pick<AgentAttachmentHandle, 'digest'>): Promise<string | null> {
  const thumbnail = cached(handle.digest)
  if (thumbnail) return thumbnail
  const bridge = agents()
  if (!bridge?.attachmentContent) return Promise.resolve(null)
  return remember(handle.digest, bridge.attachmentContent({ threadId, digest: handle.digest })
    .then(content => content ? chipSource(new Blob([new Uint8Array(content.bytes)], { type: content.mimeType })) : null, () => null))
}

/** undefined while the thumbnail is being drawn or read, null when there is none to show. */
export function useThumbnail(threadId: string | null, handle: Pick<AgentAttachmentHandle, 'digest'>): string | null | undefined {
  const [source, setSource] = useState<{ digest: string; value: string | null } | undefined>(undefined)
  useEffect(() => {
    let live = true
    void thumbnailFor(threadId, handle).then(value => { if (live) setSource({ digest: handle.digest, value }) })
    return () => { live = false }
  }, [threadId, handle.digest])
  return source?.digest === handle.digest ? source.value : undefined
}
