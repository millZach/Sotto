import { z } from 'zod'
import { agentRuntimeModeSchema, providerIdSchema, type AgentThread } from './agents'
import { watcherOutcomeSchema, type WatcherOutcome } from './watcher'

/**
 * Delegation between threads (ADR-0081): an ordinary thread hands work to a thread it starts, through the scoped
 * `sotto_delegate` server, and reads each **delegation**'s **outcome**. These are the shapes both processes and the tool
 * server share. The model passes no authority: main attributes every call to the calling thread through its tool token.
 */
export const DELEGATE_MCP_SERVER = 'sotto_delegate'
export const DELEGATE_TOOL = 'delegate'
export const READ_DELEGATION_TOOL = 'read_delegation'
export const CANCEL_DELEGATION_TOOL = 'cancel_delegation'
/** Prompts per delegated thread per turn of the delegating thread, the brief that started it included (decision 5). */
export const DELEGATION_PROMPTS_PER_THREAD = 4
/** The longest `delegate` waits for an outcome in the same call (decision 8). The tool server's client timeout sits above it. */
export const DELEGATION_WAIT_MAX_SECONDS = 300
/** How deep delegation goes: a delegated thread delegates once more, and the threads it starts cannot (decision 2). */
export const DELEGATION_LEVELS_MAX = 2
export const DELEGATION_BRIEF_MAX = 32_000
export const DELEGATION_TITLE_MAX = 120

/** The kind of work a delegation is for; once worker roles land (#1041), Sotto fills in the model from it (decision 9). */
export const delegationWorkSchema = z.enum(['building', 'ui', 'code-review', 'research', 'computer-use'])
export type DelegationWork = z.infer<typeof delegationWorkSchema>
export const DELEGATION_WORK_TITLES: Record<DelegationWork, string> = {
  building: 'Building', ui: 'UI work', 'code-review': 'Code review', research: 'Research', 'computer-use': 'Computer use',
}

const id = z.string().min(1).max(512)
export const delegateInputSchema = z.object({
  work: delegationWorkSchema.describe('The kind of work: building, ui, code-review, research or computer-use.'),
  brief: z.string().trim().min(1).max(DELEGATION_BRIEF_MAX).describe('What the delegated thread should do, in full: it sees nothing of this thread.'),
  thread: id.optional().describe('A thread this thread delegated to before, to send it another brief. Leave it out to start a new thread.'),
  provider: providerIdSchema.optional().describe('For a new thread: claude, codex, grok, muse or devin. Call read_delegation with no delegation to see what is ready.'),
  model: z.string().min(1).max(512).optional().describe('For a new thread: a ready model ID of that provider, as read_delegation lists it.'),
  effort: z.string().min(1).max(64).optional().describe('For a new thread: a reasoning effort the model offers, required when it offers any.'),
  permission: agentRuntimeModeSchema.optional().describe('For a new thread, required: approval-required, auto-accept-edits, auto or full-access, one the model offers. Never wider than this thread\'s own or the user\'s new-thread default.'),
  working_copy: z.enum(['shared', 'independent']).optional().describe('For a new thread: share this project\'s checkout (the default) or start its own worktree.'),
  title: z.string().trim().min(1).max(DELEGATION_TITLE_MAX).optional().describe('For a new thread: its name in the sidebar.'),
  wait_seconds: z.number().int().min(0).max(DELEGATION_WAIT_MAX_SECONDS).optional()
    .describe(`How long to wait in this call for the outcome, up to ${DELEGATION_WAIT_MAX_SECONDS}. Left out, ${DELEGATION_WAIT_MAX_SECONDS}. When the wait ends first the call returns working, and Sotto sends a wake-up when the outcome changes.`),
  retry_key: z.uuid().optional().describe('A UUID of your own. Calling again with the same key returns the first call\'s delegation and starts or sends nothing new.'),
}).strict()
export type DelegateInput = z.infer<typeof delegateInputSchema>
export const readDelegationInputSchema = z.object({
  delegation: z.uuid().optional().describe('The delegation to read. Leave it out to list this thread\'s delegations and the models it can delegate to.'),
}).strict()
export const cancelDelegationInputSchema = z.object({ delegation: z.uuid().describe('The delegation to cancel.') }).strict()

export const delegationRefusalCodeSchema = z.enum(['INVALID_INPUT', 'NOT_ADMITTED', 'LEVEL_LIMIT', 'NO_USER_MESSAGE', 'PROVIDER_UNAVAILABLE',
  'PERMISSION_NOT_COMPARABLE', 'PERMISSION_TOO_WIDE', 'IN_FLIGHT_LIMIT', 'PROMPT_LIMIT', 'PAUSED', 'TARGET_CHANGED', 'PENDING_USER_REQUEST',
  'UNKNOWN_THREAD', 'UNKNOWN_DELEGATION', 'RETRY_KEY_CONFLICT', 'STOPPING'])
export type DelegationRefusalCode = z.infer<typeof delegationRefusalCodeSchema>
export interface DelegationRefusal { readonly status: 'refused'; readonly code: DelegationRefusalCode; readonly message: string }

/** Where a delegation stands, with the delegated thread's words only once answered and only when asked for. */
export interface DelegationRead {
  readonly id: string
  /** The delegated thread, by its Sotto thread ID (ADR-0002). */
  readonly thread: string
  readonly work: DelegationWork
  readonly action: 'start' | 'send'
  readonly outcome: WatcherOutcome
  readonly note: string
  readonly createdAt: string
  readonly turnMessageId?: string
  readonly reply?: { readonly from: 'delegated-thread'; readonly thread: string; readonly messageId: string; readonly text: string; readonly truncated: boolean }
  readonly replyUnavailable?: string
  /** The user has sent their own message in the delegated thread since this thread's last brief to it. */
  readonly userSentSince?: boolean
  /** Why a brief was refused before it was delivered: the user's newer message, or their turn, in the delegated thread. */
  readonly refusal?: 'TARGET_CHANGED' | 'PAUSED'
}

/**
 * A delegation's news as a waiting wake-up keeps it (ADR-0081 decision 7): identities only, never the delegated
 * thread's words, which travel only when the delegating thread asks with `read_delegation`.
 */
export const DELEGATION_NEWS_MAX = 50
export const delegationNewsSchema = z.object({
  source: z.literal('delegation'),
  items: z.array(z.object({ delegationId: z.uuid(), threadId: id, outcome: watcherOutcomeSchema, turnMessageId: id.optional() }).strict())
    .min(1).max(DELEGATION_NEWS_MAX),
}).strict()
export type DelegationNews = z.infer<typeof delegationNewsSchema>

/**
 * The window's read of a thread's delegations (#1029, design A): what each card in the delegating thread shows. Main
 * answers from `DelegationService`'s own record, reading no snapshot, and only when the window asks: a delegating
 * thread's pane opening, or a change main announced for that thread. Identities, outcome and timing only, never a brief
 * or a reply.
 */
export const DELEGATIONS_READ = 'sotto:delegations:read'
/** Main names the delegating threads whose delegations changed, batched per pass; the window reads those it shows. */
export const DELEGATIONS_CHANGED = 'sotto:delegations:changed'
/** Passed to the main window's preload only while the Owl list turns delegation on; without it there is no bridge. */
export const DELEGATION_RENDERER_ARGUMENT = '--sotto-delegation-enabled'
/**
 * The newest finished delegations a read returns of what one thread delegated, beside every one still open, and the
 * newest briefs it was sent: enough for every card and brief a busy thread's history shows.
 */
export const DELEGATION_VIEWS_MAX = 200
/** Why a brief ended before it was delivered: the user's newer message or their turn there, a Stop, a failure, a restart. */
export const delegationNotSentSchema = z.enum(['target-changed', 'paused', 'stopped', 'provider', 'restarted'])
export const delegationViewSchema = z.object({
  id: z.uuid(),
  /** The delegated thread, by the window's own ID for it. */
  thread: id,
  action: z.enum(['start', 'send']),
  work: delegationWorkSchema,
  /** The user's message to the delegating thread this delegation answers, which its budget counts against (decision 3). */
  rootUserMessageId: id,
  /**
   * The delegating thread's newest message when it called, the user's or a wake-up's: the turn the call was made in,
   * where its card goes.
   */
  anchorMessageId: id,
  /** The brief's own message in the delegated thread, which that thread shows as the delegating thread's, not the user's. */
  briefMessageId: id,
  outcome: watcherOutcomeSchema,
  /** Why an outcome is unknown: Sotto restarted while it was open, or the provider never confirmed the brief. */
  unknownWhy: z.enum(['restarted', 'unconfirmed']).optional(),
  /** The delegating thread has been told this outcome, by the call's result, a read or a wake-up. */
  told: z.boolean(),
  createdAt: z.iso.datetime(),
  /** When the outcome last moved, once it has. */
  outcomeAt: z.iso.datetime().optional(),
  notSent: delegationNotSentSchema.optional(),
  /** How long the `delegate` call waited for the outcome, from when, and when it went on without one (decision 8). */
  wait: z.object({ seconds: z.number().int().min(0).max(DELEGATION_WAIT_MAX_SECONDS), startedAt: z.iso.datetime(), wentOnAt: z.iso.datetime().optional() }).strict().optional(),
  /** The `delegate` call for this brief is still under way: starting the thread, sending the brief, or waiting for the outcome. */
  waiting: z.boolean(),
}).strict()
export type DelegationView = z.infer<typeof delegationViewSchema>
export const delegationsRequestSchema = z.object({ threadId: id }).strict()
export type DelegationsRequest = z.infer<typeof delegationsRequestSchema>
export const delegationsReadSchema = z.object({ threadId: id,
  /** What the thread delegated, oldest first. */
  delegations: z.array(delegationViewSchema).max(DELEGATION_VIEWS_MAX * 2),
  /** The briefs the thread was sent by the thread that delegated to it, oldest first. */
  received: z.array(delegationViewSchema).max(DELEGATION_VIEWS_MAX),
}).strict()
export type DelegationsRead = z.infer<typeof delegationsReadSchema>
export const delegationsChangedSchema = z.object({ threadIds: z.array(id).max(10_000) }).strict()
export type DelegationsChanged = z.infer<typeof delegationsChangedSchema>
/** What the main window's preload offers while delegation is on. */
export interface DelegationsBridge {
  read(request: DelegationsRequest): Promise<DelegationsRead>
  onChanged(listener: (change: DelegationsChanged) => void): () => void
}

/** The thread that delegated to this one, by Sotto thread ID, when the snapshot records one. */
export const delegatingThreadOf = (thread: Pick<AgentThread, 'delegatedBy'> | undefined): string | undefined => thread?.delegatedBy

/**
 * Every thread below `threadId` that it delegated to, at both levels, from the snapshot's own links: what Stop on it
 * stops when they are working (decision 6). One pass over the threads, whatever the depth.
 */
export function delegatedThreadsBelow(threads: readonly Pick<AgentThread, 'id' | 'delegatedBy'>[], threadId: string): string[] {
  const children = new Map<string, string[]>()
  for (const thread of threads) if (thread.delegatedBy) children.set(thread.delegatedBy, [...children.get(thread.delegatedBy) ?? [], thread.id])
  const below: string[] = [], seen = new Set([threadId])
  let level = children.get(threadId) ?? []
  for (let depth = 0; depth < DELEGATION_LEVELS_MAX && level.length; depth++) {
    const next: string[] = []
    for (const child of level) if (!seen.has(child)) { seen.add(child); below.push(child); next.push(...children.get(child) ?? []) }
    level = next
  }
  return below
}
