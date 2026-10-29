import { describe, expect, it } from 'vitest'
import { BRANCH_BUNDLE_CHUNK_BYTES, BRANCH_BUNDLE_MAX_BYTES, branchMoveWords, branchNameSchema, branchStartWords, hostBranchMoveRequestSchema, systemClockTime, incomingRef } from '../../../src/shared/branchMoves'
import { hostRequestSchema } from '../../../src/shared/hostProtocol'

describe('branch move requests (ADR-0105 decision 8)', () => {
  it('takes plain branch names and refuses ones Git or another system would read differently', () => {
    for (const name of ['main', 'feature/login', 'sotto/abc123', 'fix-1033_v2', 'release/0.1.40']) expect(branchNameSchema.safeParse(name).success, name).toBe(true)
    for (const name of ['', '-x', '/x', 'x/', 'a..b', 'a//b', 'x.lock', 'a/.hidden', 'x.', 'a@{1}', 'with space', 'ü', 'a\\b', 'a:b', 'a~1', 'a^', 'a?', 'a*', 'a[']) {
      expect(branchNameSchema.safeParse(name).success, name).toBe(false)
    }
    expect(incomingRef('5c4f1d3e-6f0a-4d4e-9b8a-1c2d3e4f5a6b', 'feature/login')).toBe('refs/sotto/incoming/5c4f1d3e-6f0a-4d4e-9b8a-1c2d3e4f5a6b/feature/login')
  })

  it('holds a chunk inside the frame and a move inside the cap', () => {
    const moveId = '5c4f1d3e-6f0a-4d4e-9b8a-1c2d3e4f5a6b'
    const chunk = (bytes: number) => ({ action: 'receive-chunk', moveId, offset: 0, data: Buffer.alloc(bytes).toString('base64') })
    expect(hostBranchMoveRequestSchema.safeParse(chunk(BRANCH_BUNDLE_CHUNK_BYTES)).success).toBe(true)
    expect(hostBranchMoveRequestSchema.safeParse(chunk(BRANCH_BUNDLE_CHUNK_BYTES + 3)).success).toBe(false)
    const begin = { action: 'receive-begin', moveId, projectId: 'p', branch: 'main', commit: 'a'.repeat(40), sha256: 'b'.repeat(64) }
    expect(hostBranchMoveRequestSchema.safeParse({ ...begin, size: BRANCH_BUNDLE_MAX_BYTES }).success).toBe(true)
    expect(hostBranchMoveRequestSchema.safeParse({ ...begin, size: BRANCH_BUNDLE_MAX_BYTES + 1 }).success).toBe(false)
    // Nothing else rides along: no path, no remote, no force.
    for (const extra of [{ path: '/tmp' }, { remote: 'origin' }, { force: true }]) expect(hostBranchMoveRequestSchema.safeParse({ ...begin, size: 1, ...extra }).success).toBe(false)
    expect(hostRequestSchema.safeParse({ v: 1, id: 'm', session: 's', op: 'branch-move', request: { action: 'end', moveId } }).success).toBe(true)
  })
})

describe('a worker started from a thread’s branch (#1033)', () => {
  it('says where it started and from which branch, and what a test run carried, in Zach’s words', () => {
    expect(branchStartWords('forge', 'feat/x')).toBe('Started on forge from feat/x.')
    expect(branchStartWords('forge', 'feat/x', { untracked: ['a', 'b', 'c'], untrackedCount: 3 })).toBe('Started on forge from feat/x with your uncommitted changes (3 untracked files).')
    expect(branchStartWords('This computer', 'feat/x', { untracked: ['a'], untrackedCount: 1 })).toBe('Started on This computer from feat/x with your uncommitted changes (1 untracked file).')
    expect(branchStartWords('forge', 'feat/x', { untracked: [], untrackedCount: 0 })).toBe('Started on forge from feat/x with your uncommitted changes.')
  })

  it('says when a check’s snapshot was taken, as the computer writes a time, and that a check still waiting starts later (#1312)', () => {
    expect(branchStartWords('forge', 'feat/x', { untracked: ['a', 'b', 'c'], untrackedCount: 3 }, { takenAt: '2:02 PM' }))
      .toBe('Started on forge from feat/x with your uncommitted changes as they were at 2:02 PM (3 untracked files).')
    expect(branchStartWords('forge', 'feat/x', { untracked: [], untrackedCount: 0 }, { takenAt: '14:02', waiting: true }))
      .toBe('Starts on forge from feat/x with your uncommitted changes as they were at 14:02.')
    // A start with no snapshot has no time to say.
    expect(branchStartWords('forge', 'feat/x', undefined, { takenAt: '2:02 PM', waiting: true })).toBe('Starts on forge from feat/x.')
    // Without an interface language, the machine's own default writes it.
    const at = new Date(2026, 9, 23, 14, 2)
    expect(systemClockTime(at)).toBe(new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(at))
  })

  it('refuses a check whose submodule has changes of its own in Zach’s words', () => {
    expect(branchMoveWords.submoduleChanges).toBe('A submodule in this thread has uncommitted changes, and a check can\'t carry them. Commit them inside the submodule first, then start again. Nothing was started.')
  })

  it('asks for a snapshot or a same-machine copy only in the shapes it names', () => {
    const moveId = '5c4f1d3e-6f0a-4d4e-9b8a-1c2d3e4f5a6b'
    expect(hostBranchMoveRequestSchema.safeParse({ action: 'send-begin', moveId, threadId: 't', bases: [], snapshot: true }).success).toBe(true)
    // A check snapshot its host pinned when its thread asked (#1316 part 2), named by its pin and nothing else.
    expect(hostBranchMoveRequestSchema.safeParse({ action: 'send-begin', moveId, threadId: 't', bases: [], snapshot: true, pinned: moveId }).success).toBe(true)
    expect(hostBranchMoveRequestSchema.safeParse({ action: 'send-begin', moveId, threadId: 't', bases: [], snapshot: true, pinned: 'last-one' }).success).toBe(false)
    expect(hostBranchMoveRequestSchema.safeParse({ action: 'copy', moveId, threadId: 't', projectId: 'p', snapshot: false }).success).toBe(true)
    expect(hostBranchMoveRequestSchema.safeParse({ action: 'copy', moveId, threadId: 't', projectId: 'p', path: '/tmp' }).success).toBe(false)
    expect(hostBranchMoveRequestSchema.safeParse({ action: 'forget', moveId, projectId: 'p' }).success).toBe(true)
    expect(hostBranchMoveRequestSchema.safeParse({ action: 'forget', moveId, projectId: 'p', ref: 'refs/heads/main' }).success).toBe(false)
  })
})
