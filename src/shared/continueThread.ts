import { z } from 'zod'
import { agentAttachmentHandlesSchema, agentRuntimeModeSchema, handoverCountsSchema, AGENT_TEXT_MAX, PROVIDER_LABELS,
  type AgentHostSnapshot, type AgentThread, type ProviderId } from './agents'
import { agentFileReferencesSchema } from './agentFiles'
import { HANDOVER_LEAD } from './handover'
import { isThreadArchived, isThreadTurnRunning } from './threadActivity'

/**
 * Continuing a thread on another provider (ADR-0088, #1027): a new **continued thread** with its own Sotto thread ID, in
 * the same project and folder, whose first message carries a handover of the thread it continues ahead of the user's own
 * words, so no turn is spent on an acknowledgement. Each thread links to the other. Only this computer's threads continue
 * for now; another machine arrives with work moving between machines (ADR-0082).
 */

/** Passed to the main window's preload only while the Owl list turns the feature on; without it there is no bridge. */
export const CONTINUE_RENDERER_ARGUMENT = '--sotto-continue-enabled'
/** What a continuation would carry: its counts, and its words when the user asks to read them. */
export const CONTINUE_READ = 'sotto:continue:read'
/** Start the continued thread and send its first message, the handover ahead of the user's words. */
export const CONTINUE_START = 'sotto:continue:start'

/** The line after a continued thread's handover that says where the user's own words begin. */
export const CONTINUE_HANDOVER_CLOSE = '[End of the handover. The user’s message follows.]'
/** Room the handover may take in the first message, so the user's words and it together stay a message's length. */
export const CONTINUE_HANDOVER_ROOM = 30_000
/** The longest first message a continuation takes from the user. */
export const CONTINUE_TEXT_MAX = AGENT_TEXT_MAX - CONTINUE_HANDOVER_ROOM

const id = z.string().min(1).max(512)
const words = z.string().min(1).max(600)
export const continueReadRequestSchema = z.object({ threadId: id, words: z.boolean().optional() }).strict()
export type ContinueReadRequest = z.infer<typeof continueReadRequestSchema>
export const continueReadSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), counts: handoverCountsSchema, text: z.string().max(AGENT_TEXT_MAX).optional() }).strict(),
  z.object({ status: z.literal('refused'), message: words }).strict(),
])
export type ContinueRead = z.infer<typeof continueReadSchema>
/**
 * Where the continued thread works: the source's own folder (its project folder, or the worktree it works in), or a new
 * worktree made from the branch the source is on.
 */
export const continueWorkingCopySchema = z.enum(['same', 'new-worktree'])
export type ContinueWorkingCopy = z.infer<typeof continueWorkingCopySchema>
export const continueStartRequestSchema = z.object({
  /** The thread continued, by the window's ID for it. */
  threadId: id,
  /** The continued thread's Sotto thread ID, minted by the window once per continuation so a retry finds the same thread. */
  newThreadId: z.uuid(),
  modelId: z.string().min(1).max(6_144),
  reasoningEffort: z.string().min(1).max(64).optional(), runtimeMode: agentRuntimeModeSchema.optional(), providerMode: z.string().min(1).max(6_144).optional(),
  workingCopy: continueWorkingCopySchema,
  draftId: z.uuid(),
  text: z.string().min(1).max(CONTINUE_TEXT_MAX),
  attachments: agentAttachmentHandlesSchema.optional(),
  files: agentFileReferencesSchema.optional(),
}).strict()
export type ContinueStartRequest = z.infer<typeof continueStartRequestSchema>
export const continueStartSchema = z.discriminatedUnion('status', [
  /** The continued thread, by the window's ID for it. */
  z.object({ status: z.literal('ok'), threadId: id }).strict(),
  z.object({ status: z.literal('refused'), message: words }).strict(),
])
export type ContinueStart = z.infer<typeof continueStartSchema>
export interface ContinueBridge {
  read(request: ContinueReadRequest): Promise<ContinueRead>
  start(request: ContinueStartRequest): Promise<ContinueStart>
}

/** Why a thread cannot be continued now, in the words the window and main both say; null when it can. */
export const CONTINUE_REFUSALS = {
  busy: 'Wait for this turn to finish, or stop it. A handover carries finished turns.',
  unstarted: 'Nothing to hand over: this thread has no messages yet. Pick another provider from its model chip instead.',
  empty: 'Nothing to hand over: Sotto holds none of this thread’s messages.',
  remote: 'This thread runs on another machine. Continuing it from here isn’t available yet.',
  archived: 'This thread is archived. Restore it to continue it.',
  watcher: 'Watcher changes provider from its own model chip.',
} as const

/** Whether a thread can be continued on another provider now, and if not, why. */
export function continueThreadRefusal(thread: Pick<AgentThread, 'kind' | 'remoteHost' | 'archivedAt' | 'status' | 'lastTurn' | 'requests'
  | 'nativeSessionStarted' | 'messages' | 'summary'>): string | null {
  if (thread.kind === 'watcher' || thread.kind === 'watcher-history') return CONTINUE_REFUSALS.watcher
  if (thread.remoteHost === true) return CONTINUE_REFUSALS.remote
  if (isThreadArchived(thread)) return CONTINUE_REFUSALS.archived
  if (isThreadTurnRunning(thread) || thread.requests.length > 0) return CONTINUE_REFUSALS.busy
  if (thread.nativeSessionStarted === false) return CONTINUE_REFUSALS.unstarted
  if ((thread.summary?.messageCount ?? thread.messages.length) === 0 && thread.messages.length === 0) return CONTINUE_REFUSALS.empty
  return null
}

/** Why a provider cannot take a continued thread now, or null when it can. */
export function continueProviderRefusal(host: Pick<AgentHostSnapshot, 'providers' | 'connected' | 'capabilities'>, provider: ProviderId): string | null {
  const name = PROVIDER_LABELS[provider]
  const status = host.providers?.find(item => item.id === provider)
  if (status ? status.connection === 'connected' && status.capabilities.threads : host.connected && host.capabilities.threads) return null
  if (status?.connection === 'connected') return `${name} can’t start threads from Sotto.`
  if (status?.connection === 'connecting') return `${name} is still connecting. Continue there once it is connected.`
  if (status?.problem === 'signed-out') return `${name} isn’t signed in. Sign in under Settings → Providers to continue there.`
  if (status?.problem === 'not-installed') return `${name} isn’t installed. Install it under Settings → Providers to continue there.`
  return `${name} isn’t connected. Connect it under Settings → Providers to continue there.`
}

/**
 * The user's own words in a continued thread's first message, by the length its handover proof records, for a copy that
 * has the message's ID and words but not the digest's means (the sidebar's excerpt). Only the message the proof names is
 * split, or, before its send named one, a message that begins as a handover does. Undefined for any other message, and
 * when the excerpt was cut before the user's words began.
 */
export function continuedWordsOf(thread: Pick<AgentThread, 'continuedFrom'>, message: { readonly id: string; readonly text: string }): string | undefined {
  const proof = thread.continuedFrom?.handover
  if (proof === undefined || !message.text.startsWith(HANDOVER_LEAD)) return undefined
  if (proof.messageId !== undefined && proof.messageId !== message.id) return undefined
  return message.text.length > proof.prefixLength ? message.text.slice(proof.prefixLength) : undefined
}
