// @vitest-environment node
// How the merge train reads main before a GO MERGE (#2229, #2431): pushes to main wait behind each other, and GitHub
// replaces a waiting run, so main's newest commits often have no checks at all. The guard reads back along main's first
// parents to the newest commit whose checks finished.
import { expect, it } from 'vitest'
import { baseBranchChecksOf } from '../../../src/main/agents/worktreeCleanup'

type Commit = { oid: string; statusCheckRollup: { state: string } | null; parents?: { nodes: Commit[] } }
/** GitHub's answer for a base branch whose first-parent commits, newest first, have these rolled-up states. */
function answer(states: readonly (string | null)[]): unknown {
  const chain = states.reduceRight<Commit | undefined>((parent, state, index) => ({ oid: String(index).repeat(40),
    statusCheckRollup: state === null ? null : { state }, ...parent ? { parents: { nodes: [parent] } } : {} }), undefined)
  return { data: { repository: { pullRequest: { baseRefName: 'main', baseRef: { target: chain } } } } }
}

it('reads main by its newest finished checks, naming the commit that failed beside the newest', () => {
  const newest = '0'.repeat(40)
  // A newest commit whose checks finished is read as it was.
  expect(baseBranchChecksOf(answer(['FAILURE', 'SUCCESS']))).toEqual({ branch: 'main', head: newest, state: 'failed' })
  expect(baseBranchChecksOf(answer(['SUCCESS', 'FAILURE']))).toEqual({ branch: 'main', head: newest, state: 'passed' })
  // November 10, 2026: three merges in a row whose runs had not started, after one that failed. Main is red.
  expect(baseBranchChecksOf(answer(['PENDING', null, null, 'ERROR', 'SUCCESS']))).toEqual({ branch: 'main', head: '3'.repeat(40), state: 'failed', newest })
  // After one that passed, it names that one, and holds nothing.
  expect(baseBranchChecksOf(answer([null, null, 'SUCCESS', 'FAILURE']))).toEqual({ branch: 'main', head: '2'.repeat(40), state: 'passed', newest })
  // No finished checks in the commits read is unknown, even with the newest running.
  expect(baseBranchChecksOf(answer(['PENDING', null, null]))).toEqual({ branch: 'main', head: newest, state: 'unknown' })
  expect(baseBranchChecksOf(answer([null, null]))).toEqual({ branch: 'main', head: newest, state: 'unknown' })
  expect(() => baseBranchChecksOf({ data: { repository: { pullRequest: null } } })).toThrow('did not describe the base branch')
})
