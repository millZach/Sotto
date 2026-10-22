import { z } from 'zod'

/** The longest delivered app name Sotto keeps; a longer one is cut here. */
export const MAX_DELIVERED_APP_LENGTH = 64

/** The name of the app that had focus when Sotto pasted or copied a dictation: its display name, never a window title. */
export const deliveredAppSchema = z.string().min(1).max(MAX_DELIVERED_APP_LENGTH)

/**
 * A dictation record (ADR-0100): the numbers Sotto keeps for one finished dictation, whether or not History keeps its
 * text. It shares its id with the dictation's transcript, so deleting the transcript deletes the record too.
 */
export const dictationRecordSchema = z.object({
  id: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  words: z.number().int().nonnegative(),
  app: deliveredAppSchema.optional(),
}).strict()

export type DictationRecord = z.infer<typeof dictationRecordSchema>

export const dictationRecordsSchema = z.array(dictationRecordSchema)

const wordSegmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null

/** How many words a transcript holds, counted the way a reader would, including in languages written without spaces. */
export function countWords(text: string): number {
  if (wordSegmenter === null) return text.split(/\s+/u).filter(part => part.length > 0).length
  let words = 0
  for (const segment of wordSegmenter.segment(text)) if (segment.isWordLike === true) words += 1
  return words
}

/**
 * Makes a name read from the operating system fit to keep: control characters and repeated spaces go, and a name
 * longer than Sotto keeps is cut. Null when nothing readable is left.
 */
export function deliveredAppName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').replace(/\s+/gu, ' ').trim()
  if (name.length === 0) return null
  return [...name].slice(0, MAX_DELIVERED_APP_LENGTH).join('').slice(0, MAX_DELIVERED_APP_LENGTH).trim() || null
}
