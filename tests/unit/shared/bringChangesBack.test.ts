// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { AgentThread, AgentWorktree } from '../../../src/shared/agents'
import { bringBackParentId, bringBackSchema, bringBackTarget, incomingRefBranch } from '../../../src/shared/bringChangesBack'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import type { GitStatus } from '../../../src/shared/gitStatus'

// Where a thread's commits would go (#1030), read from the records alone: no Git runs to decide whether the strip shows.

const status = (branch: string | null, dirty = false): GitStatus => ({ isRepository: true, branch, upstream: null, hasRemote: false, defaultBranch: 'main', isDefaultBranch: branch === 'main',
  dirty, changedFiles: dirty ? 2 : 0, insertions: 0, deletions: 0, ahead: 0, behind: 0, aheadOfDefault: null, pullRequest: null, fetchedAt: null, readAt: '2026-10-17T00:00:00.000Z' })
const thread = (id: string, worktree: AgentWorktree | undefined, extra: Partial<AgentThread> = {}): AgentThread =>
  ({ id, projectId: 'project', title: id, modelId: 'codex:model', providerId: 'codex', status: 'idle', messages: [], requests: [], ...(worktree ? { worktree } : {}), ...extra }) as AgentThread
const shared = (branch: string | null): AgentWorktree => ({ mode: 'shared', status: 'ready', path: '/repo', branch: branch ?? undefined, git: status(branch) })
const fresh = (overrides: Partial<AgentWorktree> = {}): AgentWorktree => ({ mode: 'independent', status: 'ready', path: '/worktrees/child', branch: 'sotto/child', baseBranch: 'main', git: status('sotto/child'), ...overrides })

describe('where a thread’s commits would be brought back to', () => {
  it.each([
    ['delegated', { delegatedBy: 'parent' }],
    ['continued', { continuedFrom: { threadId: 'parent', provider: 'claude' as const, at: '2026-10-17T00:00:00.000Z' } }],
    ['forked', { startedFrom: { threadId: 'parent', from: 'turn' as const, route: 'fork' as const, at: '2026-10-17T00:00:00.000Z' } }],
  ])('names the parent’s branch for a %s thread in a new worktree made from it', (_kind, link) => {
    const parent = thread('parent', shared('main'))
    const child = thread('child', fresh(), link)
    expect(bringBackTarget(child, [parent, child])).toEqual({ parentId: 'parent', target: 'main', branch: 'sotto/child', where: 'project', away: false })
  })

  it('says the parent works in a worktree of its own when it does', () => {
    const parent = thread('parent', { mode: 'independent', status: 'ready', path: '/worktrees/parent', branch: 'feat/wav', git: status('feat/wav') })
    const child = thread('child', fresh({ baseBranch: 'feat/wav' }), { delegatedBy: 'parent' })
    expect(bringBackTarget(child, [parent, child])).toMatchObject({ target: 'feat/wav', where: 'worktree' })
  })

  it.each([
    ['made from another branch', fresh({ baseBranch: 'release' }), shared('main')],
    ['a worktree used again', fresh({ reused: true }), shared('main')],
    ['another thread’s worktree it points at', fresh({ existingWorktreePath: '/worktrees/other' }), shared('main')],
    ['a pull request’s checkout', fresh({ checkoutBranch: true }), shared('main')],
    ['not made yet', fresh({ status: 'pending', path: undefined }), shared('main')],
    ['put away', fresh({ reclaimedAt: '2026-10-17T00:00:00.000Z' }), shared('main')],
    ['on a detached HEAD', fresh({ git: status(null) }), shared('main')],
    ['already on the parent’s branch', fresh({ branch: 'main', git: status('main') }), shared('main')],
    ['whose parent moved to another branch', fresh(), shared('topic')],
    ['whose parent is on a detached HEAD', fresh(), shared(null)],
    ['sharing the project folder', { mode: 'shared' as const, status: 'ready' as const, path: '/repo', branch: 'main', baseBranch: 'main' }, shared('main')],
  ])('offers nothing for a thread %s', (_case, worktree, parentWorktree) => {
    const parent = thread('parent', parentWorktree)
    const child = thread('child', worktree, { delegatedBy: 'parent' })
    expect(bringBackTarget(child, [parent, child])).toBeNull()
  })

  it('offers nothing without a parent on the same host', () => {
    const child = thread('child', fresh(), { delegatedBy: 'parent' })
    expect(bringBackTarget(thread('alone', fresh()), [])).toBeNull()
    expect(bringBackTarget(child, [child])).toBeNull()
    const elsewhere = thread('parent', shared('main'), { hostId: '22222222-2222-4222-8222-222222222222' })
    expect(bringBackTarget(child, [elsewhere, child])).toBeNull()
  })

  it('reads a record from an older or newer host without dropping the thread', () => {
    expect(bringBackSchema.safeParse({ actionId: '7a4c2e1f-0b3d-4e5f-8a9b-1c2d3e4f5a6b', status: 'done', target: 'main', branch: 'sotto/child', how: 'fast-forward', commits: 3, head: 'a41c2e9', checkedOut: 'project', at: '2026-10-17T00:00:00.000Z' }).success).toBe(true)
    expect(bringBackSchema.safeParse({ actionId: '7a4c2e1f-0b3d-4e5f-8a9b-1c2d3e4f5a6b', status: 'rebased', target: 'main', branch: 'b', at: '2026-10-17T00:00:00.000Z' }).success).toBe(false)
  })
})

describe('a worker started from a thread’s branch (#1033) brings its commits back to that branch', () => {
  const MOVE = '9d1c3f0e-5b8e-4d4a-8a77-1f0d2f6c4b1a', LAPTOP = '11111111-1111-4111-8111-111111111111', FORGE = '22222222-2222-4222-8222-222222222222'
  // The computer the window runs on, which started the worker; it is neither the parent's machine nor the child's here.
  const DESKTOP = '33333333-3333-4333-8333-333333333333', OTHER_DESKTOP = '44444444-4444-4444-8444-444444444444'
  const moved = (madeFrom: { thread: string; host?: string }): AgentWorktree => fresh({ baseBranch: undefined, branch: 'feat/x-2', git: status('feat/x-2'),
    incomingRef: `refs/sotto/incoming/${MOVE}/feat/x`, madeFrom })

  it('reads the branch a move carried from its incoming ref', () => {
    expect(incomingRefBranch(`refs/sotto/incoming/${MOVE}/feat/x`)).toBe('feat/x')
    expect(incomingRefBranch('refs/heads/feat/x')).toBeUndefined()
    expect(incomingRefBranch(undefined)).toBeUndefined()
  })

  it('names the thread on the same machine whose branch it began from, on the host and in the window', () => {
    const parent = thread('parent', shared('feat/x'))
    const child = thread('child', moved({ thread: 'parent' }))
    expect(bringBackTarget(child, [parent, child])).toEqual({ parentId: 'parent', target: 'feat/x', branch: 'feat/x-2', where: 'project', away: false })
    const keyedParent = thread(hostEntityKey(FORGE, 'parent'), shared('feat/x')), keyedChild = thread(hostEntityKey(FORGE, 'child'), moved({ thread: 'parent' }))
    expect(bringBackTarget(keyedChild, [keyedParent, keyedChild])).toMatchObject({ parentId: hostEntityKey(FORGE, 'parent'), away: false })
  })

  it('names a thread on another machine only in the window, which sees both machines', () => {
    const child = thread(hostEntityKey(FORGE, 'child'), moved({ thread: 'parent', host: LAPTOP, by: DESKTOP }))
    const parent = thread(hostEntityKey(LAPTOP, 'parent'), shared('feat/x'))
    expect(bringBackParentId(child)).toBe(hostEntityKey(LAPTOP, 'parent'))
    expect(bringBackTarget(child, [parent, child], DESKTOP)).toEqual({ parentId: hostEntityKey(LAPTOP, 'parent'), target: 'feat/x', branch: 'feat/x-2', where: 'project', away: true })
    // Forge's own host has no thread from another machine, and offers nothing for it.
    const own = thread('child', moved({ thread: 'parent', host: LAPTOP, by: DESKTOP }))
    expect(bringBackParentId(own)).toBeUndefined()
    expect(bringBackTarget(own, [thread('parent', shared('feat/x')), own])).toBeNull()
  })

  it('offers a child on another machine whose branch has the parent’s name, and not one in the same repository', () => {
    const sameName = (madeFrom: { thread: string; host?: string }): AgentWorktree => fresh({ baseBranch: undefined, branch: 'feat/x', git: status('feat/x'),
      incomingRef: `refs/sotto/incoming/${MOVE}/feat/x`, madeFrom })
    const child = thread(hostEntityKey(FORGE, 'child'), sameName({ thread: 'parent', host: LAPTOP, by: DESKTOP }))
    expect(bringBackTarget(child, [thread(hostEntityKey(LAPTOP, 'parent'), shared('feat/x')), child], DESKTOP))
      .toEqual({ parentId: hostEntityKey(LAPTOP, 'parent'), target: 'feat/x', branch: 'feat/x', where: 'project', away: true })
    const here = thread(hostEntityKey(FORGE, 'child'), sameName({ thread: 'parent' }))
    expect(bringBackTarget(here, [thread(hostEntityKey(FORGE, 'parent'), shared('feat/x')), here])).toBeNull()
  })

  it('offers a child on another machine only on the desktop that started it', () => {
    const parent = thread(hostEntityKey(LAPTOP, 'parent'), shared('feat/x'))
    const child = thread(hostEntityKey(FORGE, 'child'), moved({ thread: 'parent', host: LAPTOP, by: DESKTOP }))
    expect(bringBackTarget(child, [parent, child], DESKTOP)).toMatchObject({ away: true })
    expect(bringBackTarget(child, [parent, child], OTHER_DESKTOP)).toBeNull()
    expect(bringBackTarget(child, [parent, child])).toBeNull()
    // A record that does not say which desktop started it is brought back by none.
    const unnamed = thread(hostEntityKey(FORGE, 'child'), moved({ thread: 'parent', host: LAPTOP }))
    expect(bringBackTarget(unnamed, [parent, unnamed], DESKTOP)).toBeNull()
  })

  it('offers nothing once the thread it began from is on another branch', () => {
    const child = thread(hostEntityKey(FORGE, 'child'), moved({ thread: 'parent', host: LAPTOP, by: DESKTOP }))
    expect(bringBackTarget(child, [thread(hostEntityKey(LAPTOP, 'parent'), shared('main')), child], DESKTOP)).toBeNull()
  })

  it('keeps who it was from on a record the thread the commits went to holds', () => {
    const record = { actionId: '7a4c2e1f-0b3d-4e5f-8a9b-1c2d3e4f5a6b', status: 'refused', target: 'feat/x', branch: 'feat/x-2', refusal: 'snapshot', from: hostEntityKey(FORGE, 'child'), at: '2026-10-23T00:00:00.000Z' }
    expect(bringBackSchema.safeParse(record).success).toBe(true)
  })
})
