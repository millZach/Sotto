import { z } from 'zod'

/**
 * A sound ElevenLabs made for a thread, as the window draws it in that thread (ADR-0205; the plugins plan's slice 12,
 * part 3). Main builds it from the sound's record and its file as it is now. It names the sound by Sotto's own ID and
 * its file by its name alone, never by a path.
 */

/** What a sound is: speech in one of the account's voices, a sound effect, or music. */
export const SOUND_KINDS = ['speech', 'effect', 'music'] as const
export type SoundKind = (typeof SOUND_KINDS)[number]
/**
 * What became of a sound. `making` while ElevenLabs makes it and Sotto saves it, `made` with its MP3 in the thread's
 * folder, `failed` when ElevenLabs or the folder would not have it.
 */
export const SOUND_STATES = ['making', 'made', 'failed'] as const
export type SoundState = (typeof SOUND_STATES)[number]
/** Why a sound was not made, in one word. `src/main/tools/elevenlabs/records.ts` says what each means. */
export const SOUND_FAILURES = ['refused', 'no-credits', 'rejected', 'busy', 'unreachable', 'unreadable', 'folder', 'too-large', 'no-account', 'locked', 'stopped'] as const
export type SoundFailure = (typeof SOUND_FAILURES)[number]
/** The most characters of speech ElevenLabs is sent in one call, and so the most words a view carries. */
export const SPEECH_CHARACTERS_MAX = 10_000

/** A visual's kind for a sound in its thread. Sotto adds it; the `visualize` tool does not take it. */
export const SOUND_VISUAL_KIND = 'sound'

export const soundViewSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  kind: z.enum(SOUND_KINDS),
  state: z.enum(SOUND_STATES),
  failure: z.enum(SOUND_FAILURES).optional(),
  /** What it cost at ElevenLabs' published prices, in US dollars: nothing for one ElevenLabs did not make. */
  cost: z.number().nonnegative().max(1_000),
  /** The voice speech was spoken in, by its name in the account. */
  voice: z.string().min(1).max(200).optional(),
  /** The words sent, only while Keep local history keeps them. */
  words: z.string().max(SPEECH_CHARACTERS_MAX).optional(),
  /** The MP3's name in its folder once saved, and its size as it is now; a file that is gone has no size. */
  fileName: z.string().min(1).max(200).optional(),
  bytes: z.number().int().nonnegative().optional(),
  /** When the MP3 was saved, while it is there. */
  madeAt: z.iso.datetime().optional(),
}).strict()
export type SoundView = z.infer<typeof soundViewSchema>
export const soundViewOrNullSchema = soundViewSchema.nullable()
export const soundRequestSchema = z.object({ id: z.string().min(1).max(100) }).strict()
/** The MP3's bytes, or null when Sotto will not hand them over: the sound or its file is gone, or it is not an MP3. */
export const soundBytesSchema = z.custom<Uint8Array>(value => value instanceof Uint8Array && value.byteLength > 0).nullable()
/** Whether main showed the file. */
export const soundDoneSchema = z.boolean()

/** Whether a made sound's file is gone from its folder, as when it was moved, renamed or deleted. */
export function soundFileGone(view: Pick<SoundView, 'state' | 'bytes'>): boolean {
  return view.state === 'made' && view.bytes === undefined
}

/** One sound's view by its ID, or null when Sotto holds no such sound. */
export const PLUGINS_SOUND = 'sotto:plugins:sound'
/** Main to the window: a sound's view, whenever its record changes. */
export const PLUGINS_SOUND_CHANGED = 'sotto:plugins:sound-changed'
export const PLUGINS_SOUND_BYTES = 'sotto:plugins:sound-bytes'
/** Shows a sound's MP3 in the folder app. */
export const PLUGINS_SOUND_REVEAL = 'sotto:plugins:sound-reveal'

/** The most one sound may be: five minutes of music at 128 kbps is under 5 MB, so this stops a runaway answer only. */
export const SOUND_BYTES_MAX = 32 * 1024 * 1024

/**
 * A paired host's sounds on this computer (the plugins plan's slice 12, part 4b; host feature `plugin-elevenlabs-sounds`).
 * The host answers by its own IDs. Main gives the window each sound by a key that says which host holds it, as a host
 * thread's key does (`hostEntityKey`); the window asks for one by that key, and main sends its host the ID.
 *
 * An MP3 crosses the connection in parts no larger than a 3D model's, so no frame passes the socket's cap. The host
 * reads it whole, checks it as this computer checks its own (inside its thread's working folder, under the cap, an MP3),
 * and then hands it over a part at a time from what it checked.
 */
export const SOUND_HOST_PART_BYTES = 8 * 1024 * 1024
export const SOUND_HOST_PARTS_MAX = SOUND_BYTES_MAX / SOUND_HOST_PART_BYTES
/** The host's SHA-256 of the whole MP3 it checked, in hex, which every part carries and the whole must match. */
const digest = z.string().regex(/^[0-9a-f]{64}$/u)
/** One part of a host's sound's MP3, from `offset` in the file the host checked. */
export const soundHostBytesRequestSchema = z.object({
  id: z.string().min(1).max(100),
  offset: z.number().int().min(0).max(SOUND_BYTES_MAX - 1),
  /** After the first part, the digest it carried: a file that changed since is refused rather than mixed. */
  digest: digest.optional(),
}).strict()
export type SoundHostBytesRequest = z.infer<typeof soundHostBytesRequestSchema>
export const soundHostBytesSchema = z.object({
  data: z.string().min(1).max(Math.ceil(SOUND_HOST_PART_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/u),
  total: z.number().int().positive().max(SOUND_BYTES_MAX),
  digest,
}).strict().nullable()
export type SoundHostBytes = z.infer<typeof soundHostBytesSchema>
/** The host's news of a sound (`plugin-elevenlabs-sounds` push): its view as its record changes, and the thread that made it by the host's ID. */
export const soundHostNewsSchema = z.object({ threadId: z.string().min(1).max(500), view: soundViewSchema }).strict()
export type SoundHostNews = z.infer<typeof soundHostNewsSchema>

/**
 * A host's sounds as a recorded desktop reads them (`plugin-elevenlabs-sounds`), by the host's own IDs: on the headless
 * host over its records, and on the desktop's connection to it over the socket. An MP3 comes a part at a time, each part
 * from the one file the host checked, for the client that asked.
 */
export interface HostSoundViews {
  view(id: string): Promise<SoundView | null>
  bytes(request: SoundHostBytesRequest, clientId: string): Promise<SoundHostBytes>
  /** Hears a sound's record change. Returns the way to stop. */
  subscribe(listener: (news: SoundHostNews) => void): () => void
}
