import { z } from 'zod'
import { GIT_PULL_REQUEST_LINKS_MAX, gitPullRequestUrlSchema } from './gitPullRequests'

/** Who asked a thread to babysit a pull request (ADR-0061 decision 3): the agent through Sotto's tool, or the user. */
export const babysitStarterSchema = z.enum(['agent', 'user'])
export type BabysitStarter = z.infer<typeof babysitStarterSchema>

/**
 * A pull request a thread babysits, as clients are sent it (ADR-0061 decision 10): which one, who started it and
 * since when. What the thread was last told stays on the host. Read, never sent by a client, so a later host may add
 * fields and this build still reads the thread.
 */
export const agentBabysittingSchema = z.object({
  url: gitPullRequestUrlSchema,
  number: z.number().int().positive(),
  startedBy: babysitStarterSchema,
  startedAt: z.string().datetime(),
})
export type AgentBabysitting = z.infer<typeof agentBabysittingSchema>
/**
 * Why babysitting a pull request ended on its own, or with the switch, as clients are sent it: it merged or closed, ten
 * wake-ups in a row brought only comments, GitHub could not be read, or Let agents babysit pull requests was turned off
 * for one an agent started (ADR-0061 decision 9). A stop, by the agent or the user, settling, archiving and unlinking
 * are not sent: the press or the call that did it says so.
 */
export const babysitEndedReasonSchema = z.enum(['merged', 'closed', 'comment-limit', 'unreadable', 'switched-off'])
export type BabysitEndedReason = z.infer<typeof babysitEndedReasonSchema>
/** The last time babysitting a pull request ended for one of those reasons, so the Pull request surface can say so and why. */
export const agentBabysitEndedSchema = z.object({
  url: gitPullRequestUrlSchema,
  number: z.number().int().positive(),
  reason: babysitEndedReasonSchema,
  endedAt: z.string().datetime(),
})
export type AgentBabysitEnded = z.infer<typeof agentBabysitEndedSchema>
/** A thread babysits at most as many pull requests as it can link. */
export const BABYSITTING_PER_THREAD_MAX = GIT_PULL_REQUEST_LINKS_MAX
