import { z } from 'zod'

/**
 * T3 Code's stacked Git action: one press commits, pushes and opens the pull request, or any prefix of
 * that (ADR-0027). The host runs the steps in order and reports each as it goes.
 */
export const gitStackedActionSchema = z.enum(['commit', 'push', 'create_pr', 'commit_push', 'commit_push_pr'])
export type GitStackedAction = z.infer<typeof gitStackedActionSchema>
export const gitActionPhaseSchema = z.enum(['branch', 'commit', 'push', 'pr'])
export type GitActionPhase = z.infer<typeof gitActionPhaseSchema>

const line = z.string().max(500)
export const gitActionToastSchema = z.object({
  title: line,
  description: line.optional(),
  cta: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('none') }).strict(),
    z.object({ kind: z.literal('open_pr'), label: line, url: z.string().max(2048) }).strict(),
    z.object({ kind: z.literal('run_action'), label: line, action: gitStackedActionSchema }).strict(),
  ]),
}).strict()
export type GitActionToast = z.infer<typeof gitActionToastSchema>

export const gitActionResultSchema = z.object({
  action: gitStackedActionSchema,
  branch: z.object({ status: z.enum(['created', 'skipped_not_requested']), name: z.string().optional() }).strict(),
  commit: z.object({ status: z.enum(['created', 'skipped_no_changes', 'skipped_not_requested']), sha: z.string().optional(), subject: z.string().optional() }).strict(),
  push: z.object({ status: z.enum(['pushed', 'skipped_not_requested', 'skipped_up_to_date']), branch: z.string().optional(), upstream: z.string().optional(), setUpstream: z.boolean().optional() }).strict(),
  pr: z.object({ status: z.enum(['created', 'opened_existing', 'skipped_not_requested']), url: z.string().optional(), number: z.number().int().positive().optional(), base: z.string().optional(), head: z.string().optional(), title: z.string().optional() }).strict(),
  toast: gitActionToastSchema,
}).strict()
export type GitActionResult = z.infer<typeof gitActionResultSchema>

/**
 * What a thread's Git action looks like while it runs and once it is over, carried on the thread's
 * record so every client draws the same progress: the stage in T3's words ("Committing...", "Pushing to
 * origin..."), the hook running and its last line, then the result or the error.
 */
export const gitActionProgressSchema = z.object({
  actionId: z.string().min(1).max(128),
  action: gitStackedActionSchema,
  status: z.enum(['running', 'done', 'failed']),
  phases: z.array(gitActionPhaseSchema),
  phase: gitActionPhaseSchema.nullable(),
  stage: line.nullable(),
  hook: z.object({ name: z.string().max(200), output: line.nullable() }).strict().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  result: gitActionResultSchema.nullable(),
  error: z.string().max(2000).nullable(),
}).strict()
export type GitActionProgress = z.infer<typeof gitActionProgressSchema>

export const gitPullResultSchema = z.object({
  status: z.enum(['pulled', 'skipped_up_to_date']),
  branch: z.string(),
  upstream: z.string().nullable(),
}).strict()
export type GitPullResult = z.infer<typeof gitPullResultSchema>

/** T3's stage lines, so the progress notice reads the same in both apps. */
export function gitActionStages(input: { action: GitStackedAction; hasMessage: boolean; hasChanges: boolean; pushTarget?: string; featureBranch?: boolean; pushBeforePr?: boolean }): string[] {
  const branch = input.featureBranch ? ['Preparing feature ref...'] : []
  const push = input.pushTarget ? `Pushing to ${input.pushTarget}...` : 'Pushing...'
  const pr = ['Preparing PR...', 'Generating PR content...', 'Creating pull request...']
  if (input.action === 'push') return [push]
  if (input.action === 'create_pr') return input.pushBeforePr ? [push, ...pr] : pr
  const commit = input.action !== 'commit' && !input.hasChanges ? [] : input.hasMessage ? ['Committing...'] : ['Generating commit message...', 'Committing...']
  if (input.action === 'commit') return [...branch, ...commit]
  if (input.action === 'commit_push') return [...branch, ...commit, push]
  return [...branch, ...commit, push, ...pr]
}

/** The phases an action runs, in order, for the notice's outline. */
export function gitActionPhases(action: GitStackedAction, featureBranch: boolean): GitActionPhase[] {
  const phases: GitActionPhase[] = []
  if (featureBranch) phases.push('branch')
  if (action === 'commit' || action === 'commit_push' || action === 'commit_push_pr') phases.push('commit')
  if (action !== 'commit') phases.push('push')
  if (action === 'create_pr' || action === 'commit_push_pr') phases.push('pr')
  return phases
}
