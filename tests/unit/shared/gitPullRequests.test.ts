import { describe, expect, it } from 'vitest'
import { gitPullRequestRequestSchema, gitPullRequestResultSchema } from '../../../src/shared/gitPullRequests'

const answer = {
  number: 74, url: 'https://github.com/o/r/pull/74', title: 'Greet the reviewer', body: '', state: 'open', draft: false, baseBranch: 'main', headBranch: 'feat/greeting',
  crossRepository: false, reviewDecision: null, reviews: [{ author: 'mira', state: 'approved', url: 'https://github.com/o/r/pull/74#pullrequestreview-1' }], mergeable: 'mergeable',
  checks: [{ name: 'CI / build', status: 'success', url: null, description: null }], mergeMethods: ['squash'], autoMergeAllowed: true, autoMerge: null, mergedAt: null,
  behindBy: 0, canUpdateBranch: true, linked: null, branch: true,
}

describe('reading a pull request from a host', () => {
  it('reads an answer from a later host that adds fields, dropping what this build does not know', () => {
    const later = {
      ...answer, labels: ['ui'],
      checks: [{ ...answer.checks[0], startedAt: '2026-09-23T00:00:00Z' }],
      reviews: [{ ...answer.reviews[0], submittedAt: '2026-09-23T00:00:00Z' }],
      autoMerge: { method: 'squash', enabledBy: 'mira' },
    }
    const read = gitPullRequestResultSchema.parse(later)
    expect(read).toEqual({ ...answer, autoMerge: { method: 'squash' } })
    expect(read).not.toHaveProperty('labels')
  })
  it('still refuses a field of the wrong kind, and keeps what a client sends strict', () => {
    expect(gitPullRequestResultSchema.safeParse({ ...answer, number: 'seventy-four' }).success).toBe(false)
    expect(gitPullRequestRequestSchema.safeParse({ threadId: 't', extra: true }).success).toBe(false)
  })
})
