import { z } from 'zod'
import { questionPageSchema } from './agents'

/** The window asks main to open one of a question's pages by the request it is on and its token, never by path or address (ADR-0084). */
export const questionPageOpenSchema = z.object({
  threadId: z.string().min(1).max(1_024), requestId: z.string().min(1).max(512), token: questionPageSchema.shape.token,
}).strict()
export type QuestionPageOpen = z.infer<typeof questionPageOpenSchema>

/** `gone` when the question, the page or its file is no longer there; `unavailable` when nothing could open it. */
export const questionPageOpenResultSchema = z.union([
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(['gone', 'unavailable']) }).strict(),
])
export type QuestionPageOpenResult = z.infer<typeof questionPageOpenResultSchema>
