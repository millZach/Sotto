// @vitest-environment node
// #1178: which threads move to another machine, in plain words, and what the moved thread is told.
import { describe, expect, it } from 'vitest'
import type { AgentModel, AgentThread } from '../../../src/shared/agents'
import { MOVE_HANDOVER_CLOSE, moveFacts, movePermission, movePermissionWords, movePrompt, THREAD_MOVE_WORDS, threadMoveRefusal, type MoveEligibility,
  type MoveFacts } from '../../../src/shared/threadMoves'

const thread = (patch: Partial<AgentThread> = {}): AgentThread => ({ id: 'source', title: 'WAV preview stall', projectId: 'project', modelId: 'codex:gpt', providerId: 'codex',
  status: 'idle', requests: [], messages: [{ id: 'm1', role: 'user', text: 'Find out why.', createdAt: '2026-10-29T10:00:00.000Z' }],
  worktree: { mode: 'independent', status: 'ready', branch: 'feat/wav', git: { isRepository: true, branch: 'feat/wav', upstream: null, hasRemote: true, defaultBranch: 'main',
    isDefaultBranch: false, dirty: false, changedFiles: 0, insertions: 0, deletions: 0, ahead: 1, behind: 0, aheadOfDefault: 1, pullRequest: null, fetchedAt: null,
    readAt: '2026-10-29T10:00:00.000Z' } }, ...patch })
const clear: MoveEligibility = { machine: 'forge', delegatedWorking: false, backgroundWork: 0, unresolved: false }
const git = (patch: Partial<NonNullable<NonNullable<AgentThread['worktree']>['git']>>) => ({ worktree: { ...thread().worktree!, git: { ...thread().worktree!.git!, ...patch } } })

describe('which threads move (Zach, October 21, 2026)', () => {
  it('moves a thread at rest on its branch, with nothing waiting', () => {
    expect(threadMoveRefusal(thread(), clear)).toBeNull()
  })
  it.each([
    ['Watcher’s own thread', thread({ kind: 'watcher' }), clear, THREAD_MOVE_WORDS.watcher],
    ['a delegated thread', thread({ delegatedBy: 'parent' }), clear, THREAD_MOVE_WORDS.delegated],
    ['a delegating thread with children working', thread(), { ...clear, delegatedWorking: true }, THREAD_MOVE_WORDS.delegating],
    ['a turn running', thread({ status: 'running' }), clear, THREAD_MOVE_WORDS.running],
    ['a last turn still running', thread({ lastTurn: { id: 't', status: 'running' } }), clear, THREAD_MOVE_WORDS.running],
    ['a question or permission card', thread({ requests: [{ id: 'r', kind: 'question', text: 'Which?', options: [] }] }), clear, THREAD_MOVE_WORDS.waiting],
    ['background work', thread(), { ...clear, backgroundWork: 1 }, THREAD_MOVE_WORDS.background],
    ['an unresolved send', thread(), { ...clear, unresolved: true }, THREAD_MOVE_WORDS.unresolved],
    ['uncommitted work', thread(git({ dirty: true, changedFiles: 2 })), clear, THREAD_MOVE_WORDS.uncommitted],
    ['no branch checked out', thread(git({ branch: null })), clear, THREAD_MOVE_WORDS.notOnBranch],
    ['an archived thread', thread({ archivedAt: '2026-10-28T10:00:00.000Z' }), clear, THREAD_MOVE_WORDS.archived],
    ['a thread with nothing to hand over', thread({ messages: [] }), clear, THREAD_MOVE_WORDS.empty],
    ['a thread already moving', thread(), { ...clear, movingTo: 'the Mac' }, THREAD_MOVE_WORDS.moving('the Mac')],
  ])('keeps %s here and says why', (_name, source, context, words) => {
    expect(threadMoveRefusal(source, context)).toBe(words)
  })
  it('moves a thread on another machine too, which its own host holds for the move (#1178 part 3)', () => {
    expect(threadMoveRefusal(thread({ remoteHost: true }), clear)).toBeNull()
  })
  it('says one reason, the first that holds, for a thread several hold', () => {
    expect(threadMoveRefusal(thread({ delegatedBy: 'parent', status: 'running' }), { ...clear, unresolved: true })).toBe(THREAD_MOVE_WORDS.delegated)
  })
})

describe('what a moved thread starts on (ADR-0089 decision 5a, ADR-0074)', () => {
  const model = (patch: Partial<AgentModel> = {}): AgentModel => ({ id: 'codex:gpt', provider: 'Codex', providerId: 'codex', name: 'GPT', ready: true,
    runtimeModes: ['approval-required', 'auto-accept-edits', 'auto', 'full-access'], ...patch })
  it('starts on the thread’s own permission where the default and the machine allow it', () => {
    expect(movePermission(thread({ runtimeMode: 'auto-accept-edits' }), model(), model(), 'full-access', true)).toEqual({ runtimeMode: 'auto-accept-edits' })
  })
  it('asks first when the new-thread default caps it, and says so', () => {
    const permission = movePermission(thread({ runtimeMode: 'full-access' }), model(), model(), 'auto-accept-edits', true)
    expect(permission).toEqual({ runtimeMode: 'auto-accept-edits', narrowed: { from: 'full-access', to: 'auto-accept-edits', by: 'default' } })
    expect(movePermissionWords(permission.narrowed!, 'forge')).toBe('It would start on Allow edits on forge, not this thread’s Full access, since your new-thread default allows no more.')
  })
  it('asks first when the machine does not let This computer answer there, as Watcher’s starts are held', () => {
    const permission = movePermission(thread({ runtimeMode: 'auto' }), model(), model(), 'full-access', false)
    expect(permission).toEqual({ runtimeMode: 'approval-required', narrowed: { from: 'auto', to: 'approval-required', by: 'machine' } })
    expect(movePermissionWords(permission.narrowed!, 'forge')).toBe('It would start on Ask for approval on forge, not this thread’s Auto, since forge doesn’t let This computer answer there.')
  })
  it('asks first when the model there offers nothing as wide', () => {
    expect(movePermission(thread({ runtimeMode: 'full-access' }), model(), model({ runtimeModes: ['approval-required', 'auto-accept-edits'] }), 'full-access', true))
      .toEqual({ runtimeMode: 'auto-accept-edits', narrowed: { from: 'full-access', to: 'auto-accept-edits', by: 'provider' } })
  })
  it('asks first when a provider’s own profile there allows less than the thread’s, as Devin’s Bypass permissions to Ask first (Sol’s review)', () => {
    const devin = model({ id: 'devin:model', providerId: 'devin', runtimeModes: undefined, providerModes: [{ id: 'ask', name: 'Ask first', allows: 'nothing' },
      { id: 'bypass', name: 'Bypass permissions', allows: 'everything' }] })
    const permission = movePermission(thread({ providerId: 'devin', modelId: devin.id, providerMode: 'bypass' }), devin, devin, 'full-access', true)
    expect(permission).toEqual({ providerMode: 'ask', narrowed: { from: 'full-access', to: 'approval-required', by: 'provider', toName: 'Ask first' } })
    expect(movePermissionWords(permission.narrowed!, 'forge')).toBe('It would start on Ask first on forge, not this thread’s Full access, since a new thread on that provider starts on Ask first.')
    // A thread already on Ask first has nothing to ask.
    expect(movePermission(thread({ providerId: 'devin', modelId: devin.id, providerMode: 'ask' }), devin, devin, 'full-access', true)).toEqual({ providerMode: 'ask' })
  })
  it('moves a thread that asks now on Ask for approval wherever it goes, with nothing to ask', () => {
    expect(movePermission(thread({ runtimeMode: 'approval-required' }), model(), model(), undefined, false)).toEqual({ runtimeMode: 'approval-required' })
  })
})

describe('the facts block (#1178)', () => {
  const facts: MoveFacts = { title: 'WAV preview stall', from: 'This computer', to: 'forge', branch: 'feat/wav', commit: 'a'.repeat(40),
    pullRequests: [{ number: 12, title: 'Fix the stall', draft: false }, { number: 14, title: 'Try a buffer', draft: true }], babysat: [12], watched: true }
  it('says where the thread ran, its branch and commit, its open pull requests, babysitting and Watcher, in Sotto’s words', () => {
    expect(moveFacts(facts)).toBe([
      'This thread continues “WAV preview stall”, which ran on This computer until the user moved it here, to forge. These facts are Sotto’s own:',
      `- Branch: feat/wav, at commit ${'a'.repeat(40)}. This thread’s worktree was made from it.`,
      '- Open pull requests: #12 “Fix the stall”, #14 “Try a buffer” (draft).',
      '- Sotto was babysitting #12 on This computer.',
      '- Watcher watched it on This computer, and watches this thread now.',
      '',
      'Pick up the work where the handover leaves it.',
    ].join('\n'))
  })
  it('says plainly when there is no pull request, no babysitting and no watch', () => {
    const text = moveFacts({ ...facts, pullRequests: [], babysat: [], watched: false })
    expect(text).toContain('- No open pull request is linked to it.')
    expect(text).toContain('- Watcher did not watch it.')
    expect(text).not.toContain('babysitting')
  })
  it('puts the facts after the handover and the line that closes it, as one prompt', () => {
    expect(movePrompt('This is a handover from another Sotto thread.', facts)).toBe(`This is a handover from another Sotto thread.\n\n${MOVE_HANDOVER_CLOSE}\n\n${moveFacts(facts)}`)
  })
})
