import { describe, expect, it } from 'vitest'
import { BRANCH_BUNDLE_GIT_MS, branchMoveStepTimeoutMs } from '../../../src/shared/branchMoves'

describe('how long the desktop waits for one step of a branch move', () => {
  it('waits longer than the host may take to create or import a bundle, and two minutes for every other step', () => {
    for (const action of ['send-begin', 'receive-finish']) expect(branchMoveStepTimeoutMs(action)).toBeGreaterThan(BRANCH_BUNDLE_GIT_MS)
    for (const action of ['tips', 'receive-begin', 'receive-chunk', 'receive-ref', 'send-chunk', 'end', 'forget']) expect(branchMoveStepTimeoutMs(action)).toBe(120_000)
  })
  it('waits for a same-host copy to create its bundle and import it (#1033)', () => {
    expect(branchMoveStepTimeoutMs('copy')).toBeGreaterThan(2 * BRANCH_BUNDLE_GIT_MS)
  })
})
