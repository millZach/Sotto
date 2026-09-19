import { z } from 'zod'
import { agentMessageSchema } from './agents'

/**
 * Who asked for a recorded answer. A thread's log is Sotto's own history, so an answer says where it
 * came in from; it is evidence about the record, never authority (ADR-0004).
 */
export const threadEventAttributionSchema = z.object({
  clientId: z.string().min(1).max(512),
  user: z.string().max(512).optional(),
  transport: z.enum(['ipc', 'socket']),
}).strict()
export type ThreadEventAttribution = z.infer<typeof threadEventAttributionSchema>

const at = z.string().min(1).max(64)

/**
 * One entry in a thread's append-only log. The message projection is rebuilt from these alone, so a
 * kind added here is a kind the projection must know how to apply.
 */
export const threadEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message-added'), at, message: agentMessageSchema }).strict(),
  z.object({ kind: z.literal('message-text-appended'), at, messageId: z.string().min(1).max(512), appendText: z.string().max(100_000) }).strict(),
  z.object({ kind: z.literal('message-replaced'), at, message: agentMessageSchema }).strict(),
  /** A confirmed rewind: everything projected for this thread is dropped and the new epoch recorded. */
  z.object({ kind: z.literal('messages-reset'), at, historyEpoch: z.string().max(512).optional() }).strict(),
  /**
   * An answer to a permission request or a question, and who gave it. The answer's own words are not
   * here: an answer can read like a prompt, and the log says what happened rather than what was said.
   * A question's chosen options are recorded by their ids alone, for the same reason.
   */
  z.object({ kind: z.literal('answer-given'), at, requestId: z.string().min(1).max(512), answer: z.string().max(100_000).optional(),
    approved: z.boolean().optional(), permissionChoice: z.string().max(512).optional(),
    questionOptionIds: z.array(z.string().min(1).max(512)).max(1_000).optional(),
    attribution: threadEventAttributionSchema }).strict(),
])
export type ThreadEvent = z.infer<typeof threadEventSchema>
export type ThreadEventKind = ThreadEvent['kind']
/** The recorded answer, named because the host and the coordinator both hand one around. */
export type AnswerGivenEvent = Extract<ThreadEvent, { kind: 'answer-given' }>

/** An event as the log holds it: its sequence number and the thread it belongs to. */
export interface StoredThreadEvent {
  readonly seq: number
  readonly threadId: string
  readonly event: ThreadEvent
}

/** The message kinds whose payload carries what the user or the agent said. */
export const MESSAGE_TEXT_EVENT_KINDS: ReadonlySet<ThreadEventKind> = new Set(['message-added', 'message-replaced', 'message-text-appended', 'answer-given'])
