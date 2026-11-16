import { createHash } from 'node:crypto'
import { SOUND_BYTES_MAX, SOUND_HOST_PART_BYTES, type HostSoundViews, type SoundHostBytes, type SoundHostBytesRequest, type SoundHostNews } from '../../../shared/sounds'
import type { SoundRecord } from './records'
import { soundBytes, soundView, soundViewOf, type SoundViewSource } from './view'

/**
 * A headless host's sounds as a recorded desktop reads them (`plugin-elevenlabs-sounds`; the plugins plan's slice 12,
 * part 4b): the view the desktop's own line is built from, read over this host's records by the same code, and the MP3
 * it plays, a part at a time.
 *
 * The MP3 is read whole and checked as the desktop checks its own (by its record's name, inside the thread's working
 * folder, under the cap, an MP3), and its parts are then cut from what was checked, never read again part by part: a
 * file that changed between parts would otherwise be handed over half one and half the other. What was checked is held
 * for the client that asked, one file each, until its last part goes or a short while passes.
 */

/** How long a checked MP3 is held for the rest of its parts. */
export const HELD_SOUND_MS = 60_000

interface Held { readonly id: string; readonly digest: string; readonly bytes: Uint8Array; readonly timer: ReturnType<typeof setTimeout> }

export interface HostSoundViewsWithNews extends HostSoundViews {
  /** A sound's record changed: its view as it is now goes to every listener, in order, while its record is there. */
  changed(sound: SoundRecord): void
  close(): void
}

export function hostSoundViews(source: SoundViewSource): HostSoundViewsWithNews {
  const listeners = new Set<(news: SoundHostNews) => void>()
  const tell = (news: SoundHostNews): void => { for (const listener of [...listeners]) { try { listener(news) } catch { /* A listener's failure is its own. */ } } }
  const held = new Map<string, Held>()
  const letGo = (clientId: string): void => { const kept = held.get(clientId); if (kept) { clearTimeout(kept.timer); held.delete(clientId) } }
  // Views are sent in order, so a slower one never lands after a newer one, as the desktop's own are.
  let sent: Promise<void> = Promise.resolve()

  /** The whole MP3 checked for `clientId`, held for its other parts, or the one already held when it is the same. */
  const checked = async (request: SoundHostBytesRequest, clientId: string): Promise<Held | null> => {
    const kept = held.get(clientId)
    if (kept && kept.id === request.id && request.offset > 0 && kept.digest === request.digest) return kept
    letGo(clientId)
    const bytes = await soundBytes(source, request.id, SOUND_BYTES_MAX)
    if (!bytes) return null
    const digest = createHash('sha256').update(bytes).digest('hex')
    // A later part is cut only from the file its first part was: one that changed since is refused, not mixed.
    if (request.offset > 0 && request.digest !== digest) return null
    const timer = setTimeout(() => { if (held.get(clientId)?.timer === timer) held.delete(clientId) }, HELD_SOUND_MS)
    timer.unref?.()
    const fresh: Held = { id: request.id, digest, bytes, timer }
    held.set(clientId, fresh)
    return fresh
  }

  return {
    view: async id => soundViewOf(source, id),
    bytes: async (request, clientId): Promise<SoundHostBytes> => {
      const file = await checked(request, clientId)
      if (!file || request.offset >= file.bytes.byteLength) return null
      const end = Math.min(file.bytes.byteLength, request.offset + SOUND_HOST_PART_BYTES)
      if (end === file.bytes.byteLength) letGo(clientId)
      return { data: Buffer.from(file.bytes.buffer, file.bytes.byteOffset + request.offset, end - request.offset).toString('base64'), total: file.bytes.byteLength, digest: file.digest }
    },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    changed: sound => {
      if (listeners.size === 0) return
      // The record as it is now, not as it was told: words cleared since are not sent again.
      sent = sent.then(async () => { const now = await source.sound(sound.id); return now ? { threadId: now.threadId, view: await soundView(source, now) } : null })
        .then(news => { if (news) tell(news) }, () => undefined)
    },
    close: () => { listeners.clear(); for (const clientId of [...held.keys()]) letGo(clientId) },
  }
}
