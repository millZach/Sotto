// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { EMPTY_AGENT_HOST, type AgentThread } from '../../../src/shared/agents'
import { commandCenterOverview, commandCenterObservationKey, COMMAND_CENTER_GROUPS, COMMAND_CENTER_QUIET_MS,
  type CommandCenterObservation } from '../../../src/shared/commandCenterOverview'
import { centerHostId, centerTime } from '../../fixtures/commandCenter'

const now = Date.parse(centerTime)
function thread(patch: Partial<AgentThread> = {}): AgentThread {
  return { id: 'worker', hostId: centerHostId, projectId: 'project', title: 'Worker', modelId: 'model', status: 'idle', messages: [], requests: [], ...patch }
}
const openPr = { number: 1, url: 'https://github.com/owner/repo/pull/1', title: 'PR', state: 'open' as const, draft: false, source: 'linked' as const, linkedAt: centerTime }
function project(patch: Partial<AgentThread>, observation?: Partial<CommandCenterObservation>) {
  const item = thread(patch)
  const state = { host: { ...EMPTY_AGENT_HOST, connected: true, threads: [item] } }
  const observations = observation ? new Map([[commandCenterObservationKey(item), { observedAt: centerTime, fresh: true, ...observation }]]) : new Map()
  const before = structuredClone(state)
  const row = commandCenterOverview(state, now, observations)[0]!
  expect(state).toEqual(before)
  return row
}

describe('Overview projection', () => {
  it('keeps display order separate from grouping precedence', () => {
    expect(COMMAND_CENTER_GROUPS).toEqual(['Needs you', 'Ready for review', 'Working', 'Landing', 'Quiet', 'Idle'])
    const landing = { source: 'github' as const, observedAt: centerTime, fresh: true }
    expect(project({ status: 'running', pullRequests: [openPr], requests: [{ id: 'q', kind: 'question', text: 'Question', options: [] }] }, { landing }).group).toBe('Needs you')
    expect(project({ status: 'error', pullRequests: [openPr] }, { landing }).group).toBe('Needs you')
    expect(project({ pullRequests: [openPr] }, { landing }).group).toBe('Landing')
    expect(project({ status: 'running', pullRequests: [openPr] }).group).toBe('Ready for review')
    expect(project({ status: 'running' }).group).toBe('Working')
    expect(project({}).group).toBe('Idle')
  })
  it('shows a failed native turn until a later turn or recovery replaces it', () => {
    expect(project({ lastTurn: { id: 't', status: 'failed' } }).group).toBe('Needs you')
    expect(project({ lastTurn: { id: 't2', status: 'completed' } }).group).toBe('Idle')
    expect(project({ lastTurn: { id: 't2', status: 'running' }, status: 'running' }).group).toBe('Working')
  })
  it('uses confirmed live background work and monitoring, never assistant prose', () => {
    expect(project({ backgroundWork: [{ id: centerHostId, type: 'workflow', label: 'Task' }] }).group).toBe('Working')
    expect(project({ monitoring: [{ id: centerHostId, label: 'Watch' }] }).group).toBe('Working')
    expect(project({ messages: [{ id: 'm', role: 'assistant', text: 'Approved, merging and working forever', createdAt: centerTime }] }).group).toBe('Idle')
  })
  it('requires fresh progress and connection clocks for Quiet, including the exact threshold', () => {
    const old = new Date(now - COMMAND_CENTER_QUIET_MS).toISOString()
    expect(project({ status: 'running' }, { connectedAt: old, lastProgressAt: old }).group).toBe('Quiet')
    expect(project({ status: 'running' }, { connectedAt: old, lastProgressAt: new Date(now - COMMAND_CENTER_QUIET_MS + 1).toISOString() }).group).toBe('Working')
    expect(project({ status: 'running', updatedAt: old }, { connectedAt: centerTime, lastProgressAt: old }).group).toBe('Working')
    expect(project({ status: 'running', updatedAt: old }).group).toBe('Working')
    expect(project({ status: 'running' }, { lastProgressAt: old }).group).toBe('Working')
    expect(project({ status: 'running' }, { connectedAt: old, lastProgressAt: old, fresh: false }).group).toBe('Working')
  })
  it('marks a disconnected host stale without inventing failure or quietness', () => {
    const old = new Date(now - COMMAND_CENTER_QUIET_MS).toISOString()
    const row = project({ status: 'running', clientConnected: false }, { connectedAt: old, lastProgressAt: old })
    expect(row).toMatchObject({ group: 'Working', available: false, freshness: 'stale', observedAt: centerTime })
    expect(project({ clientConnected: false, pullRequests: [openPr] }).group).toBe('Ready for review')
    expect(project({ clientConnected: false, lastTurn: { id: 't', status: 'failed' } }).group).toBe('Needs you')
  })
  it('does not treat stale, future or unavailable landing evidence as current', () => {
    for (const observation of [{ fresh: false, landing: { source: 'github' as const, observedAt: centerTime, fresh: true } },
      { landing: { source: 'github' as const, observedAt: centerTime, fresh: false } },
      { landing: { source: 'user-landing-action' as const, observedAt: new Date(now + 1).toISOString(), fresh: true } }]) {
      expect(project({ pullRequests: [openPr] }, observation).group).toBe('Ready for review')
    }
    expect(project({ clientConnected: false, pullRequests: [openPr] }, { landing: { source: 'github', observedAt: centerTime, fresh: true } }).group).toBe('Ready for review')
  })
  it('keeps settled and archived history reachable and excludes current/retired centers', () => {
    expect(project({ settledAt: centerTime, status: 'error' }).group).toBe('Idle')
    expect(project({ archivedAt: centerTime, status: 'running' }).group).toBe('Idle')
    expect(project({ workspaceSettledAt: centerTime }).group).toBe('Idle')
    // Workspace organization alone does not suppress requests that still need the user.
    expect(project({ workspaceSettledAt: centerTime, status: 'error' }).group).toBe('Needs you')
    const threads = [thread(), thread({ id: 'current', kind: 'command-center' }), thread({ id: 'old', kind: 'command-center-history' })]
    expect(commandCenterOverview({ host: { ...EMPTY_AGENT_HOST, connected: true, threads } }, now).map(row => row.thread.id)).toEqual(['worker'])
  })
  it('qualifies identical IDs on different hosts and reads no user marks', () => {
    expect(commandCenterObservationKey(thread())).not.toBe(commandCenterObservationKey(thread({ hostId: '22222222-2222-4222-8222-222222222222' })))
    expect(project({ finishedUnread: true }).thread.finishedUnread).toBe(true)
    expect(project({}).freshness).toBe('unknown')
  })
})
