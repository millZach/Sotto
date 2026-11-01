import { createHash } from 'node:crypto'
import type { PromptImage } from '../../src/main/agents/host'
import type { AgentAttachmentHandle } from '../../src/shared/agents'

/** A real one-pixel PNG, the image most tests attach. */
export const PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZ0AAAAASUVORK5CYII=', 'base64')
export const PIXEL_DATA_URL = `data:image/png;base64,${PIXEL_PNG.toString('base64')}`

/** A PNG signature followed by padding, `size` bytes long, `seed` making each one different content. */
export function pngOfSize(size: number, seed = 0): Buffer {
  const bytes = Buffer.alloc(size, seed & 0xff); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  return bytes
}

/**
 * A PNG Sotto reads as a `width` by `height` picture: the signature, then IHDR, 40 bytes in all. Only the header is read
 * for its size; `salt`, the last byte, makes each one different content.
 */
export function pngHeader(width: number, height: number, salt = 0): Buffer {
  const bytes = Buffer.alloc(40)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12, 'ascii'); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20)
  bytes[39] = salt
  return bytes
}

/** The handle staging these bytes answers with, but with the ID and name a test chooses. */
export function handleOf(bytes: Uint8Array, id = 'image', name = 'pixel.png', mimeType: AgentAttachmentHandle['mimeType'] = 'image/png'): AgentAttachmentHandle {
  return { id, name, mimeType, sizeBytes: bytes.byteLength, digest: createHash('sha256').update(bytes).digest('hex') }
}

/** A staged image as an adapter receives it, reading these bytes. */
export function promptImageOf(bytes: Uint8Array, id = 'image', name = 'pixel.png', mimeType: AgentAttachmentHandle['mimeType'] = 'image/png'): PromptImage {
  return { ...handleOf(bytes, id, name, mimeType), read: async () => bytes }
}

type Upload = { name: string; mimeType: string; bytes: Uint8Array }
/** Stages each image in a coordinator's store (or a store itself), so commands carrying their handles are accepted. */
export async function stageInto(target: { stageAttachment(image: Upload): Promise<unknown> } | { stage(image: Upload): Promise<unknown> },
  ...images: (Uint8Array | { bytes: Uint8Array; mimeType: string })[]): Promise<void> {
  for (const image of images) {
    // Not `instanceof`: a Buffer made in Node's realm is not a Uint8Array of a jsdom test's realm.
    const { bytes, mimeType } = 'mimeType' in image ? image : { bytes: image, mimeType: 'image/png' }
    const upload = { name: 'fixture', mimeType, bytes }
    await ('stage' in target ? target.stage(upload) : target.stageAttachment(upload))
  }
}
