import { z } from 'zod'

import { deliveredAppSchema } from './dictationRecord'

export const historyEntrySchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  language: z.string().min(1),
  modelPreset: z.enum(['fast', 'balanced', 'accurate', 'instant', 'mai', 'parakeet']),
  /** The delivered app: the name of the app that had focus when Sotto pasted or copied it (ADR-0100). */
  app: deliveredAppSchema.optional(),
})

/** A finished dictation as the window reports it. Main adds the delivered app; the window never names one. */
export const finishedDictationSchema = historyEntrySchema.omit({ app: true }).strict()

export type HistoryEntry = z.infer<typeof historyEntrySchema>
export type FinishedDictation = z.infer<typeof finishedDictationSchema>

export function parseHistoryEntry(input: unknown): HistoryEntry {
  return historyEntrySchema.parse(input)
}
