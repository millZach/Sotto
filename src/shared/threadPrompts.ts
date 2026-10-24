import { z } from 'zod'

/**
 * Every message the user sent above the window a pane holds, read from the thread's store for the message scrubber
 * (ADR-0109). Each carries the start of what was sent and the start and end of the turn's last reply: what a tick's card
 * shows, and no more, so a long history costs its prompts rather than its words.
 */
export const AGENT_THREAD_PROMPTS = 'sotto:agents:thread-prompts'

/** The most of a sent message a stored prompt carries; the card shows at most 400 characters of it. */
export const THREAD_PROMPT_TEXT = 400
/** The start of the turn's last reply, of which the card shows 220 characters, and its end, where a question it closes on sits. */
export const THREAD_PROMPT_REPLY_HEAD = 300
export const THREAD_PROMPT_REPLY_TAIL = 300
/** The most prompts one answer carries: the newest this many above the window, which still fits one of a host's frames. */
export const THREAD_PROMPTS_MOST = 5_000

const id = z.string().min(1).max(512)
export const agentThreadPromptSchema = z.object({
  id,
  createdAt: z.string().min(1).max(64),
  text: z.string().max(THREAD_PROMPT_TEXT),
  /** How many files were attached, when any were. */
  attachments: z.number().int().positive().max(1000).optional(),
  reply: z.object({ id, text: z.string().max(THREAD_PROMPT_REPLY_HEAD + THREAD_PROMPT_REPLY_TAIL + 2) }).strict().optional(),
}).strict()
export type AgentThreadPrompt = z.infer<typeof agentThreadPromptSchema>
/** The thread by the window's own key, and the first message of the window it holds: the prompts before it are read. */
export const agentThreadPromptsRequestSchema = z.object({ threadId: id, beforeMessageId: id }).strict()
export type AgentThreadPromptsRequest = z.infer<typeof agentThreadPromptsRequestSchema>
export const agentThreadPromptsSchema = z.object({ prompts: z.array(agentThreadPromptSchema).max(THREAD_PROMPTS_MOST) }).strict()
export type AgentThreadPrompts = z.infer<typeof agentThreadPromptsSchema>

/**
 * A reply as a stored prompt carries it: whole when it is short, otherwise its start and its end from a paragraph's start,
 * so a question it closes on is still its last words.
 */
export function promptReplyText(head: string, tail: string | null): string {
  if (tail === null) return clipText(head, THREAD_PROMPT_REPLY_HEAD + THREAD_PROMPT_REPLY_TAIL)
  const paragraph = tail.indexOf('\n\n')
  const end = paragraph >= 0 && paragraph < tail.length - 2 ? tail.slice(paragraph + 2) : tail
  const last = end.length > THREAD_PROMPT_REPLY_TAIL ? end.slice(-THREAD_PROMPT_REPLY_TAIL) : end
  // A cut through a pair of surrogates leaves the low half alone, which is no character.
  return `${clipText(head, THREAD_PROMPT_REPLY_HEAD)}\n\n${/^[\uDC00-\uDFFF]/u.test(last) ? last.slice(1) : last}`
}

/** The first `most` UTF-16 units of a text, never ending on half a character. The store counts characters, not units. */
export function clipText(text: string, most: number): string {
  if (text.length <= most) return text
  const code = text.charCodeAt(most - 1)
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? most - 1 : most)
}
