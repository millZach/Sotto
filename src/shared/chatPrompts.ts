import { z } from 'zod'

export const CHAT_PROMPT_GENERATE = 'chat-prompt:generate'
export const CHAT_PROMPT_COPY = 'chat-prompt:copy'
export const chatPromptCopySchema = z.string().min(1).max(64000)
export const chatPromptInputSchema = z.object({ chatId: z.string().min(1).max(256) }).strict()
const evidenceSchema = z.object({ messageId: z.string().min(1), quote: z.string().trim().min(1).max(2000) }).strict()
const itemSchema = z.object({ text: z.string().trim().min(1).max(4000), evidence: z.array(evidenceSchema).min(1).max(12) }).strict()
export const chatPromptOutlineSchema = z.object({
  objective: z.array(itemSchema).max(5), context: z.array(itemSchema).max(30),
  decisions: z.array(itemSchema).max(30), constraints: z.array(itemSchema).max(30),
  deliverables: z.array(itemSchema).max(30), acceptanceChecks: z.array(itemSchema).max(30),
  unresolvedQuestions: z.array(itemSchema).max(30), suggestions: z.array(itemSchema).max(20),
}).strict()
export type ChatPromptOutline = z.infer<typeof chatPromptOutlineSchema>
export interface ChatPromptTranscript { readonly messages: readonly { readonly id: string; readonly role: 'user' | 'assistant'; readonly text: string }[] }
export const chatPromptResultSchema = z.object({ chatId: z.string(), text: z.string().min(1).max(64000), sourceMessageIds: z.array(z.string()), generatedAt: z.string() }).strict()
export type ChatPromptResult = z.infer<typeof chatPromptResultSchema>
export interface ChatPromptBridge { generate(input: z.infer<typeof chatPromptInputSchema>): Promise<ChatPromptResult>; copy(text: string): Promise<void> }
