import { z } from 'zod'
import { delegationWorkSchema, DELEGATION_VIEWS_MAX } from './delegation'
import { watcherOutcomeSchema } from './watcher'

/**
 * The iPhone's Agents view (ADR-0103, an Owl feature): a thread's top bar names how many delegated threads and provider
 * sub-agents it has, and opens a sheet listing them, as the desktop's Tools › Agents does. A host offers it as the
 * `agents-view` feature, and answers `thread-delegations` with what its delegation record knows of each delegated thread
 * below one thread. Sub-agents come from the reads `subagents` already offers.
 */
export const AGENTS_VIEW_FEATURE = 'agents-view'

/** The start of a brief a row shows; the whole brief is the delegated thread's own first message, read when it is opened. */
export const HOST_DELEGATION_BRIEF_EXCERPT = 600
/** Delegated threads below one thread, both levels, a read returns at most. */
export const HOST_DELEGATED_THREADS_MAX = DELEGATION_VIEWS_MAX * 2

const id = z.string().min(1).max(512)
/**
 * One delegated thread as the delegation record knows it: the thread that delegated to it, the kind of work, when the
 * brief that started it was sent, its newest delegation's outcome and when that outcome was reached, and the start of its
 * newest brief. Never its reply (ADR-0081 decision 7).
 */
export const hostDelegatedThreadSchema = z.object({
  thread: id,
  /** The thread that delegated to it: the read's own thread, or one of its delegated threads. */
  by: id,
  work: delegationWorkSchema,
  outcome: watcherOutcomeSchema,
  unknownWhy: z.enum(['restarted', 'unconfirmed', 'gone']).optional(),
  /** When the brief that started it was sent, once the record holds that brief. */
  startedAt: z.iso.datetime().optional(),
  /** When its newest outcome was reached, once it has finished. */
  outcomeAt: z.iso.datetime().optional(),
  /** The delegating thread's `delegate` call for its newest brief is still under way. */
  waiting: z.boolean(),
  /** The start of the newest brief Sotto still holds, cut to `HOST_DELEGATION_BRIEF_EXCERPT`. */
  brief: z.string().max(HOST_DELEGATION_BRIEF_EXCERPT).optional(),
}).strict()
export type HostDelegatedThread = z.infer<typeof hostDelegatedThreadSchema>
export const hostThreadDelegationsSchema = z.object({ threadId: id, threads: z.array(hostDelegatedThreadSchema).max(HOST_DELEGATED_THREADS_MAX) }).strict()
export type HostThreadDelegations = z.infer<typeof hostThreadDelegationsSchema>
