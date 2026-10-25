import { z } from 'zod'

/**
 * The next prompt (ADR-0132): after a thread's turn ends with an answer, the thread's own provider is asked, on the side,
 * what the user will most likely type next. The window shows the answer as the next prompt in an empty composer and as
 * the Next list. An Owl feature: the window has this bridge only while the startup answers turn `next-prompt` on.
 */
export const NEXT_PROMPT_READ = 'sotto:next-prompt:read'
export const NEXT_PROMPT_CHANGED = 'sotto:next-prompt:changed'
export const NEXT_PROMPT_RENDERER_ARGUMENT = '--sotto-next-prompt-enabled'

/** What each of the four suggestions is for, in the order they are listed. */
export const NEXT_PROMPT_INTENTS = ['continue', 'verify', 'challenge', 'wrap'] as const
export type NextPromptIntent = typeof NEXT_PROMPT_INTENTS[number]

export const NEXT_PROMPT_LIMITS = { label: 32, text: 200, headline: 400, suggestions: 4, answers: 3 } as const

const label = z.string().min(1).max(NEXT_PROMPT_LIMITS.label)
const text = z.string().min(1).max(NEXT_PROMPT_LIMITS.text)
export const nextPromptItemSchema = z.object({ label, text }).strict()
export const nextPromptSuggestionSchema = z.object({ intent: z.enum(NEXT_PROMPT_INTENTS), label, text }).strict()

export const nextPromptSchema = z.object({
  /** One sentence on the most important thing in the agent's last reply; may be empty. */
  headline: z.string().max(NEXT_PROMPT_LIMITS.headline),
  /** The single most likely next prompt; may be empty. */
  ghost: z.string().max(NEXT_PROMPT_LIMITS.text),
  suggestions: z.array(nextPromptSuggestionSchema).max(NEXT_PROMPT_LIMITS.suggestions),
  /** Answers to a question the agent's last reply ended on, in prose; empty when it asked nothing. */
  answers: z.array(nextPromptItemSchema).max(NEXT_PROMPT_LIMITS.answers),
}).strict()
export type NextPrompt = z.infer<typeof nextPromptSchema>
export type NextPromptItem = z.infer<typeof nextPromptItemSchema>
export type NextPromptSuggestion = z.infer<typeof nextPromptSuggestionSchema>

/**
 * One thread's next prompt as main holds it. `afterUserMessageId` is the thread's newest user message when the turn ended:
 * once the thread has a newer one, this answered a turn that is over and the window shows nothing. `prompt` is null when
 * main let go of it.
 */
export const nextPromptEntrySchema = z.object({
  threadId: z.string().min(1).max(512),
  afterUserMessageId: z.string().max(512),
  prompt: nextPromptSchema.nullable(),
}).strict()
export type NextPromptEntry = z.infer<typeof nextPromptEntrySchema>
export const nextPromptEntriesSchema = z.array(nextPromptEntrySchema).max(1_000)

export interface NextPromptBridge {
  /** Every next prompt main holds now, for a window that has just loaded. */
  read(): Promise<readonly NextPromptEntry[]>
  onChanged(listener: (entry: NextPromptEntry) => void): () => void
}
