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
