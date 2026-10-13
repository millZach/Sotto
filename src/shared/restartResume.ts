import { z } from 'zod'

/**
 * Resuming threads after a restart (ADR-0076): the note Sotto sends a thread whose turn a restart stopped, word for word
 * what every provider receives, and how many times in a row one thread is resumed before it waits for the user.
 */
export const RESUME_NOTE = 'Sotto restarted while you were working on this, and your last turn stopped partway. Any command or tool that was running was stopped too, so its result may be missing. Check where things stand, then carry on.'
export const RESUMES_IN_A_ROW_MAX = 3

/** The resume note's news as the follow-up queue keeps it: when the stopped turn started, and which resume this is. */
export const restartNewsSchema = z.object({
  source: z.literal('restart'),
  since: z.iso.datetime(),
  resumes: z.number().int().min(1).max(RESUMES_IN_A_ROW_MAX),
}).strict()
export type RestartNews = z.infer<typeof restartNewsSchema>

/**
 * Whether a message Sotto's own record has already marked as a wake-up is a resume note. The note always opens the
 * wake-up it is part of, so it is told by how the text starts; text alone never makes a message Sotto's.
 */
export const isResumeNoteText = (text: string): boolean => text.trimStart().startsWith(RESUME_NOTE)
