import { z } from 'zod'
import { questionPageSchema } from './agents'
import { browserPageSchema } from './browser'

/**
 * The window asks main to open one of a question's pages by the request it is on and its token, never by path or address
 * (ADR-0085). Without a request, the token is one of the thread's waiting prototype's pages (ADR-0108).
 */
export const questionPageOpenSchema = z.object({
  threadId: z.string().min(1).max(1_024), requestId: z.string().min(1).max(512).optional(), token: questionPageSchema.shape.token,
}).strict()
export type QuestionPageOpen = z.infer<typeof questionPageOpenSchema>

/**
 * `gone` when the question, the page or its file is no longer there; `unavailable` when nothing could open it. `page` when
 * the page opened in Sotto's browser, as **Web links in threads** chose, so the window shows it as it shows a link opened
 * there (ADR-0108); absent when it opened in the system browser.
 */
export const questionPageOpenResultSchema = z.union([
  z.object({ ok: z.literal(true), page: browserPageSchema.optional() }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(['gone', 'unavailable']) }).strict(),
])
export type QuestionPageOpenResult = z.infer<typeof questionPageOpenResultSchema>
