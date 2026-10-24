// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { AgentProject, AgentThread } from '../../../src/shared/agents'
import { threadClearHold, threadDelegators, type ThreadClearFacts } from '../../../src/main/agents/threadClearing'

const SETTLED = '2026-09-01T00:00:00.000Z'
const project: AgentProject = { id: 'project', title: 'Sotto', path: '/work/sotto', workspaceSettledAt: null }
const thread = (id: string, extra: Partial<AgentThread> = {}): AgentThread => ({ id, projectId: 'project', title: id, modelId: 'model', status: 'idle',
  messages: [], requests: [], workspaceSettledAt: SETTLED, ...extra })
function facts(threads: AgentThread[], extra: Partial<ThreadClearFacts> = {}): ThreadClearFacts {
  return { threads, delegators: threadDelegators(threads), projects: [project], hidden: () => false, pending: () => false, watched: () => false, ...extra }
}
const hold = (subject: AgentThread, others: AgentThread[] = [], extra: Partial<ThreadClearFacts> = {}) => threadClearHold(subject, facts([subject, ...others], extra))

describe('what keeps a settled thread back from clearing (ADR-0126 decision 3)', () => {
  it('lets a settled thread at rest go', () => {
    expect(hold(thread('a'))).toBeNull()
    // A thread settled with its project goes too.
    expect(threadClearHold(thread('b', { workspaceSettledAt: null }), facts([thread('b', { workspaceSettledAt: null })], { projects: [{ ...project, workspaceSettledAt: SETTLED }] }))).toBeNull()
  })

  it('keeps every thread that is not settled, hidden, or Watcher’s own', () => {
    expect(hold(thread('a', { workspaceSettledAt: null }))).toBe('not-settled')
    expect(hold(thread('a'), [], { hidden: () => true })).toBe('hidden')
    expect(hold(thread('a', { kind: 'watcher' }))).toBe('hidden')
    expect(hold(thread('a', { kind: 'watcher-history' }))).toBe('hidden')
    expect(threadClearHold(undefined, facts([]))).toBe('hidden')
  })

  it('keeps a thread that is working, waiting on the user or has something queued', () => {
    expect(hold(thread('a', { status: 'running' }))).toBe('working')
    expect(hold(thread('a', { compaction: { commandId: 'c', status: 'running' } }))).toBe('working')
    expect(hold(thread('a', { backgroundWork: [{ id: '22222222-2222-4222-8222-222222222222', label: 'Build', type: 'command', startedAt: SETTLED }] }))).toBe('working')
    expect(hold(thread('a', { requests: [{ id: 'r', kind: 'question', text: 'Which?', options: [] }] }))).toBe('waiting-on-you')
    // A permission holds its turn running; what the thread needs is still the user.
    expect(hold(thread('a', { status: 'running', requests: [{ id: 'r', kind: 'permission', text: 'Run npm test?', options: [] }] }))).toBe('waiting-on-you')
    expect(hold(thread('a'), [], { pending: id => id === 'a' })).toBe('queued')
    // A compaction whose result is unknown is an action whose result is unknown.
    expect(hold(thread('a', { compaction: { commandId: 'c', status: 'uncertain' } }))).toBe('queued')
  })

  it('keeps a thread with an open pull request, its own or a delegated thread’s', () => {
    const open = { url: 'https://github.com/o/r/pull/1', number: 1, state: 'open' } as NonNullable<AgentThread['pullRequests']>[number]
    expect(hold(thread('a', { pullRequests: [open] }))).toBe('pull-request')
    expect(hold(thread('a', { pullRequests: [{ ...open, state: 'merged' }] }))).toBeNull()
    expect(hold(thread('a'), [thread('child', { delegatedBy: 'a', pullRequests: [open] })])).toBe('pull-request')
  })

  it('keeps a thread whose delegated thread is not at rest, two levels down', () => {
    expect(hold(thread('a'), [thread('child', { delegatedBy: 'a', status: 'running', workspaceSettledAt: null })])).toBe('delegated-working')
    expect(hold(thread('a'), [thread('child', { delegatedBy: 'a' }), thread('grandchild', { delegatedBy: 'child' })], { pending: id => id === 'grandchild' })).toBe('delegated-working')
    expect(hold(thread('a'), [thread('child', { delegatedBy: 'a' })])).toBeNull()
  })

  it('keeps a thread being babysat or watched', () => {
    expect(hold(thread('a', { babysitting: [{ url: 'https://github.com/o/r/pull/1', number: 1, startedBy: 'user', startedAt: SETTLED }] as AgentThread['babysitting'] }))).toBe('babysitting')
    expect(hold(thread('a'), [], { watched: id => id === 'a' })).toBe('watched')
  })
})
