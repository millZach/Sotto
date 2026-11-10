import { createHash } from 'node:crypto'
import { open, unlink } from 'node:fs/promises'

/** How much of a file one read takes: enough to keep a 500 MiB video's copy quick, small enough to never matter in memory. */
const CHUNK_BYTES = 1024 * 1024

/**
 * Copies `source` to `target`, created with `wx` (never overwriting) and `mode`, hashing what it reads: the SHA-256 and
 * size of exactly what was written. A video is copied this way rather than read whole (ADR-0131, November 9 amendment).
 * It reads and writes through file handles alone, so the host archive needs no stream module. A copy that fails partway
 * is removed, unless the target was already there, which was never this copy's.
 */
export async function copyHashing(source: string, target: string, mode: number): Promise<{ digest: string; sizeBytes: number }> {
  const hash = createHash('sha256'); let sizeBytes = 0
  const from = await open(source, 'r')
  try {
    const to = await open(target, 'wx', mode)
    try {
      const chunk = Buffer.alloc(CHUNK_BYTES)
      for (;;) {
        const { bytesRead } = await from.read(chunk, 0, chunk.length, sizeBytes)
        if (bytesRead === 0) break
        for (let written = 0; written < bytesRead;) {
          const { bytesWritten } = await to.write(chunk, written, bytesRead - written, sizeBytes + written)
          if (bytesWritten < 1) throw new Error('The copy could not be written.')
          written += bytesWritten
        }
        hash.update(chunk.subarray(0, bytesRead)); sizeBytes += bytesRead
      }
      await to.close()
    } catch (error) {
      await to.close().catch(() => undefined)
      await unlink(target).catch(() => undefined)
      throw error
    }
  } finally { await from.close() }
  return { digest: hash.digest('hex'), sizeBytes }
}

/** The SHA-256 of a file, read a chunk at a time. */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  const file = await open(path, 'r')
  try {
    const chunk = Buffer.alloc(CHUNK_BYTES)
    for (let position = 0; ;) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, position)
      if (bytesRead === 0) break
      hash.update(chunk.subarray(0, bytesRead)); position += bytesRead
    }
  } finally { await file.close() }
  return hash.digest('hex')
}
