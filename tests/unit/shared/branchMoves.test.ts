import { describe, expect, it } from 'vitest'
import { BRANCH_BUNDLE_CHUNK_BYTES, BRANCH_BUNDLE_MAX_BYTES, branchNameSchema, hostBranchMoveRequestSchema, incomingRef } from '../../../src/shared/branchMoves'
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
