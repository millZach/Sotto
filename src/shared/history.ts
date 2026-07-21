import { z } from 'zod'

export const historyEntrySchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  language: z.string().min(1),
  modelPreset: z.enum(['fast', 'balanced', 'accurate', 'instant']),
})

export type HistoryEntry = z.infer<typeof historyEntrySchema>

export function parseHistoryEntry(input: unknown): HistoryEntry {
  return historyEntrySchema.parse(input)
}
