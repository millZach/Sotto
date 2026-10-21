import { z } from 'zod'
import { agentRuntimeModeSchema, providerIdSchema, type AgentThread } from './agents'
import { WATCHER_OUTCOMES, watcherOutcomeSchema } from './watcher'
import { workerKindSchema } from './workerRoles'

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

/**
 * The kind of work a delegation is for: one of the worker roles (#1041), from which Sotto fills in what the call leaves
 * out while that Owl feature is on (decision 9).
 */
export const delegationWorkSchema = workerKindSchema
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
  title: z.string().trim().min(1).max(DELEGATION_TITLE_MAX).optional().describe('For a new thread: its name in the sidebar, which Sotto keeps. Left out, Sotto names the thread from the brief, as it names any thread.'),
  wait_seconds: z.number().int().min(0).max(DELEGATION_WAIT_MAX_SECONDS).optional()
    .describe(`How long to wait in this call for the outcome, up to ${DELEGATION_WAIT_MAX_SECONDS}. Left out, ${DELEGATION_WAIT_MAX_SECONDS}. When the wait ends first the call returns working, and Sotto sends a wake-up when the outcome changes.`),
  retry_key: z.uuid().optional().describe('A UUID of your own. Calling again with the same key returns the first call\'s delegation and starts or sends nothing new.'),
}).strict()
export type DelegateInput = z.infer<typeof delegateInputSchema>
export const readDelegationInputSchema = z.object({
  delegation: z.uuid().optional().describe('The delegation to read. Leave it out to list this thread\'s delegations and the models it can delegate to.'),
}).strict()
export const cancelDelegationInputSchema = z.object({ delegation: z.uuid().describe('The delegation to cancel.') }).strict()

// IN_FLIGHT_LIMIT is no longer refused (#1183, no limit on threads working). It stays so a refusal recorded before then still reads.
export const delegationRefusalCodeSchema = z.enum(['INVALID_INPUT', 'NOT_ADMITTED', 'LEVEL_LIMIT', 'NO_USER_MESSAGE', 'PROVIDER_UNAVAILABLE',
  'PERMISSION_NOT_COMPARABLE', 'PERMISSION_TOO_WIDE', 'IN_FLIGHT_LIMIT', 'PROMPT_LIMIT', 'PAUSED', 'TARGET_CHANGED', 'PENDING_USER_REQUEST',
  'UNKNOWN_THREAD', 'UNKNOWN_DELEGATION', 'RETRY_KEY_CONFLICT', 'STOPPING',
  // The delegated thread's own queue holds its next prompt until the user resumes, clears or checks it there (October 19, 2026).
  'QUEUE_HELD'])
export type DelegationRefusalCode = z.infer<typeof delegationRefusalCodeSchema>
/**
 * A refusal, and the delegation it is recorded as when the call was a delegation main refused under its rules: the
 * delegating thread can read it again, and the window can show it, by that ID.
 */
export interface DelegationRefusal { readonly status: 'refused'; readonly code: DelegationRefusalCode; readonly message: string; readonly delegation?: string }
/**
 * The refusals of a well-formed `delegate` call that are recorded as a delegation whose outcome is `refused`: every one
 * main makes under ADR-0081's rules. A call with arguments to correct, a retry key used twice, or Sotto stopping
 * refuses without one, since no delegation was asked for that the rules turned down.
 */
export const RECORDED_REFUSALS: ReadonlySet<DelegationRefusalCode> = new Set(['NOT_ADMITTED', 'LEVEL_LIMIT', 'NO_USER_MESSAGE', 'PROVIDER_UNAVAILABLE',
  'PERMISSION_NOT_COMPARABLE', 'PERMISSION_TOO_WIDE', 'IN_FLIGHT_LIMIT', 'PROMPT_LIMIT', 'PAUSED', 'TARGET_CHANGED', 'PENDING_USER_REQUEST', 'UNKNOWN_THREAD', 'QUEUE_HELD'])

/**
 * Where a delegation stands (CONTEXT.md, Outcome): Watcher's outcomes (ADR-0073), and `refused`, a delegation main
 * turned down when it was asked for, so nothing was started or sent and nothing will come of it (ADR-0081 decision 7).
 */
export const DELEGATION_OUTCOMES = [...WATCHER_OUTCOMES, 'refused'] as const
export const delegationOutcomeSchema = z.enum(DELEGATION_OUTCOMES)
export type DelegationOutcome = z.infer<typeof delegationOutcomeSchema>

/** Where a delegation stands, with the delegated thread's words only once answered and only when asked for. */
export interface DelegationRead {
  readonly id: string
  /** The delegated thread, by its Sotto thread ID (ADR-0002). A refused start has none: nothing was started. */
  readonly thread?: string
  /** The provider a refused start named. */
  readonly provider?: string
  readonly work: DelegationWork
  readonly action: 'start' | 'send'
  readonly outcome: DelegationOutcome
  readonly note: string
  readonly createdAt: string
  readonly turnMessageId?: string
  readonly reply?: { readonly from: 'delegated-thread'; readonly thread: string; readonly messageId: string; readonly text: string; readonly truncated: boolean }
  readonly replyUnavailable?: string
  /** The user has sent their own message in the delegated thread since this thread's last brief to it. */
  readonly userSentSince?: boolean
  /**
   * Why it was refused: for a `refused` delegation, the rule that turned it down, with `note` in plain words; for a `paused`
   * one, the user's newer message (`TARGET_CHANGED`) or their turn (`PAUSED`) in the delegated thread, before delivery.
   */
  readonly refusal?: DelegationRefusalCode
}

/**
 * A delegation's news as a waiting wake-up keeps it (ADR-0081 decision 7): identities only, never the delegated thread's
 * words. Since October 19, 2026 an answered delegation's reply goes with the news as it is sent, read from delegation's
 * own record then (`delegationNewsText`), so the queue still holds none of it.
 */
export const DELEGATION_NEWS_MAX = 50
export const delegationNewsSchema = z.object({
  source: z.literal('delegation'),
  // heldMinutes: a background outcome released after its thread sat idle twenty minutes with its work never seen to end (#1263).
  items: z.array(z.object({ delegationId: z.uuid(), threadId: id, outcome: watcherOutcomeSchema, turnMessageId: id.optional(),
    heldMinutes: z.number().int().nonnegative().max(100_000_000).optional() }).strict())
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
 * The newest finished delegations, refused ones among them, a read returns of what one thread delegated, beside every
 * one still open, and the newest briefs it was sent: enough for every card and brief a busy thread's history shows.
 */
export const DELEGATION_VIEWS_MAX = 200
/** Why a brief ended before it was delivered: the user's newer message or their turn there, a Stop, a failure, a restart. */
export const delegationNotSentSchema = z.enum(['target-changed', 'paused', 'stopped', 'provider', 'restarted'])
/** A delegation main accepted: a thread was started or sent a brief, and it has one of Watcher's outcomes. */
export const delegatedViewSchema = z.object({
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
  /** Why an outcome is unknown: Sotto restarted while it was open, the provider never confirmed the brief, or the thread is gone. */
  unknownWhy: z.enum(['restarted', 'unconfirmed', 'gone']).optional(),
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
export type DelegatedView = z.infer<typeof delegatedViewSchema>
/**
 * A delegation main refused as it was asked for (decision 7): the rule that turned it down, and nothing started or
 * sent, so no brief and, for a start, no thread. The card words the rule; main's own words were written for the agent.
 */
export const refusedViewSchema = z.object({
  id: z.uuid(),
  /** The thread a refused send named, when this thread delegated to it. A refused start names none: nothing was started. */
  thread: id.optional(),
  /** The provider a refused start named. */
  provider: providerIdSchema.optional(),
  action: z.enum(['start', 'send']),
  work: delegationWorkSchema,
  outcome: z.literal('refused'),
  refusal: delegationRefusalCodeSchema,
  /** The user's message the call answered, and the turn it was made in, when Sotto could find them. */
  rootUserMessageId: id.optional(),
  anchorMessageId: id.optional(),
  createdAt: z.iso.datetime(),
}).strict()
export type RefusedView = z.infer<typeof refusedViewSchema>
/** One delegation as the window shows it: one main accepted, or one it refused. */
export const delegationViewSchema = z.union([delegatedViewSchema, refusedViewSchema])
export type DelegationView = z.infer<typeof delegationViewSchema>
export const delegationsRequestSchema = z.object({ threadId: id }).strict()
export type DelegationsRequest = z.infer<typeof delegationsRequestSchema>
export const delegationsReadSchema = z.object({ threadId: id,
  /** What the thread delegated, the refused among them, oldest first. */
  delegations: z.array(delegationViewSchema).max(DELEGATION_VIEWS_MAX * 2),
  /** The briefs the thread was sent by the thread that delegated to it, oldest first. A refused send sent nothing. */
  received: z.array(delegatedViewSchema).max(DELEGATION_VIEWS_MAX),
}).strict()
export type DelegationsRead = z.infer<typeof delegationsReadSchema>
export const delegationsChangedSchema = z.object({ threadIds: z.array(id).max(10_000) }).strict()
/**
 * The newest brief a delegated thread was sent, in full, as Tools › Agents shows it when its row is opened (October 17,
 * 2026): the user message the delegation record names in that thread, and nothing else of it, never a reply. Read only
 * when a row is opened; null when Sotto no longer holds it.
 */
export const DELEGATION_BRIEF_READ = 'sotto:delegations:brief'
export const delegationBriefRequestSchema = z.object({ threadId: id }).strict()
export type DelegationBriefRequest = z.infer<typeof delegationBriefRequestSchema>
export const delegationBriefSchema = z.object({ threadId: id, text: z.string().max(DELEGATION_BRIEF_MAX) }).strict().nullable()
export type DelegationBrief = z.infer<typeof delegationBriefSchema>
export type DelegationsChanged = z.infer<typeof delegationsChangedSchema>
/** What the main window's preload offers while delegation is on. */
export interface DelegationsBridge {
  read(request: DelegationsRequest): Promise<DelegationsRead>
  brief(request: DelegationBriefRequest): Promise<DelegationBrief>
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
