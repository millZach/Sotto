import { describe, expect, it } from 'vitest'
import type { AgentState, AgentThread } from '../../../../src/shared/agents'
import { relatedThreadIds, samePaneWorld } from '../../../../src/renderer/src/agents/paneWorld'
import { threadsStateFixture } from '../../../fixtures/agentState'

/** The state as main publishes it after one thread's record changed: a new state, host and list, the rest shared. */
function withThread(state: AgentState, id: string, change: (thread: AgentThread) => AgentThread): AgentState {
  return { ...state, host: { ...state.host, threads: state.host.threads.map(thread => thread.id === id ? change(thread) : thread) } }
}

const streamed = (thread: AgentThread): AgentThread => ({ ...thread, messages: [...thread.messages], summary: thread.summary, updatedAt: thread.updatedAt })

describe('samePaneWorld (#993)', () => {
  const state = threadsStateFixture()

  it('keeps a pane as it was when an unrelated thread in another project streams', () => {
    // visual-gate is in "workshop"; footer-links is in "sotto-site".
    expect(samePaneWorld(state, withThread(state, 'footer-links', streamed), 'visual-gate')).toBe(true)
    expect(samePaneWorld(state, withThread(state, 'footer-links', thread => ({ ...thread, updatedAt: '2026-10-31T12:00:00.000Z' })), 'visual-gate')).toBe(true)
  })

  it('draws the pane again for its own thread, whatever changed in it', () => {
    expect(samePaneWorld(state, withThread(state, 'visual-gate', streamed), 'visual-gate')).toBe(false)
  })

  it('draws the pane again when another thread changes more than what moves while it streams', () => {
    expect(samePaneWorld(state, withThread(state, 'footer-links', thread => ({ ...thread, title: 'Renamed' })), 'visual-gate')).toBe(false)
    expect(samePaneWorld(state, withThread(state, 'footer-links', thread => ({ ...thread, status: 'idle' })), 'visual-gate')).toBe(false)
    expect(samePaneWorld(state, withThread(state, 'footer-links', thread => ({ ...thread, requests: [] })), 'visual-gate')).toBe(false)
  })

  it('draws the pane again for anything else in the state, and for a list that gained, lost or reordered threads', () => {
    expect(samePaneWorld(state, { ...state, deliveries: [] }, 'visual-gate')).toBe(false)
    expect(samePaneWorld(state, { ...state, host: { ...state.host, providers: [...state.host.providers ?? []] } }, 'visual-gate')).toBe(false)
    expect(samePaneWorld(state, { ...state, host: { ...state.host, threads: state.host.threads.slice(1) } }, 'visual-gate')).toBe(false)
    expect(samePaneWorld(state, { ...state, host: { ...state.host, threads: [...state.host.threads].reverse() } }, 'visual-gate')).toBe(false)
  })

  it('draws the pane again when a thread related to it streams: one it delegated to, or the one that delegated it', () => {
    const delegated = withThread(state, 'footer-links', thread => ({ ...thread, delegatedBy: 'visual-gate' }))
    expect(samePaneWorld(delegated, withThread(delegated, 'footer-links', streamed), 'visual-gate')).toBe(false)
    expect(samePaneWorld(delegated, withThread(delegated, 'visual-gate', streamed), 'footer-links')).toBe(false)
  })

  it('draws the pane again when a thread in its project moves the branch toolbar\'s order of working copies', () => {
    // release-notes shares visual-gate's project and has a worktree of its own: its activity decides its place in the order.
    const worktree = (thread: AgentThread, path: string): AgentThread => ({ ...thread, worktree: { mode: 'independent', status: 'ready', path, branch: `sotto/${thread.id}` } })
    let base = withThread(state, 'release-notes', thread => ({ ...worktree(thread, '/w/release'), updatedAt: '2030-10-01T00:00:00.000Z' }))
    base = withThread(base, 'grok-previews', thread => ({ ...worktree(thread, '/w/grok'), updatedAt: '2030-10-02T00:00:00.000Z' }))
    const moved = withThread(base, 'release-notes', thread => ({ ...thread, updatedAt: '2030-10-03T00:00:00.000Z' }))
    expect(samePaneWorld(base, moved, 'visual-gate')).toBe(false)
    // Activity that leaves the order alone keeps the pane as it was.
    const stillSecond = withThread(base, 'release-notes', thread => ({ ...thread, updatedAt: '2030-10-01T12:00:00.000Z' }))
    expect(samePaneWorld(base, stillSecond, 'visual-gate')).toBe(true)
  })
})

describe('relatedThreadIds', () => {
  it('follows delegation both ways, continuations, starts and swarms', () => {
    let state = threadsStateFixture()
    state = withThread(state, 'footer-links', thread => ({ ...thread, delegatedBy: 'visual-gate' }))
    state = withThread(state, 'weekly-note', thread => ({ ...thread, delegatedBy: 'footer-links' }))
    state = withThread(state, 'benchmark', thread => ({ ...thread, continuedFrom: { threadId: 'visual-gate', provider: 'codex', at: '2026-10-01T00:00:00.000Z' } }))
    state = withThread(state, 'notes-cleanup', thread => ({ ...thread, startedFrom: { threadId: 'visual-gate', from: 'turn', route: 'fork' } as AgentThread['startedFrom'] }))
    const related = relatedThreadIds(state.host.threads, 'visual-gate')
    expect([...related].sort()).toEqual(['benchmark', 'footer-links', 'notes-cleanup', 'visual-gate', 'weekly-note'])
    expect([...relatedThreadIds(state.host.threads, 'weekly-note')].sort()).toEqual(['footer-links', 'visual-gate', 'weekly-note'])
  })
})
