import { describe, expect, it } from 'vitest'
import { agentStateSchema, agentThreadSchema, defaultAgentConfiguration, EMPTY_AGENT_HOST } from '../../../src/shared/agents'
import { clockLabel, describeThreads, groupThreads, listThreads, threadCounts } from '../../../src/renderer/src/agents/threadFacts'

const OLD = '2026-08-01T10:00:00.000Z'
const NEW = '2026-09-10T11:00:00.000Z'
const NOW = Date.parse('2026-09-11T12:00:00.000Z')
function stateFor(fields: Record<string, unknown> = {}) {
  return agentStateSchema.parse({
    configuration: defaultAgentConfiguration(), connection: 'connected',
    host: { ...EMPTY_AGENT_HOST, threads: [{ id: 'thread', projectId: 'project', title: 'Thread', modelId: '', status: 'idle', messages: [], requests: [], ...fields }] },
    assignments: [], queue: [], activeThreadId: null, activeProjectId: null,
    draft: '', draftThreadId: null, draftRequestId: null, composing: false, pendingRequest: '', busy: false, notice: '', error: null,
    speech: { id: 0, text: '' }, voice: { status: 'off', error: null, action: 'none', revision: 0 },
    credentials: { reasoning: false, secure: true }, membership: { status: 'beta', label: 'Test', expiresAt: null },
  })
}

describe('thread facts metadata regressions', () => {
  it.each(['idle', 'running'])('leaves unknown %s activity blank and unchanged across refreshes', status => {
    const state = stateFor({ status })
    for (const now of [NOW, NOW + 60_000]) {
      const row = describeThreads(state, now)[0]!
      expect(row.activityAt).toBeNaN()
      expect(row.when).toBe('')
      expect(threadCounts([row], now).week).toBe(0)
    }
  })

  it('uses provider last activity for shell-only threads, not observation time', () => {
    const row = describeThreads(stateFor({ updatedAt: OLD }), NOW)[0]!
    expect(row.activityAt).toBe(Date.parse(OLD))
    expect(row.when).toBe(clockLabel(Date.parse(OLD)))
  })

  it('chooses the latest real timestamp and ignores malformed metadata', () => {
    const messages = [
      { id: 'new', role: 'assistant', text: 'Latest', createdAt: NEW },
      { id: 'old', role: 'user', text: 'Earlier', createdAt: OLD },
    ]
    expect(describeThreads(stateFor({ updatedAt: OLD, messages }), NOW)[0]!.activityAt).toBe(Date.parse(NEW))
    expect(describeThreads(stateFor({ updatedAt: 'invalid', messages }), NOW)[0]!.activityAt).toBe(Date.parse(NEW))
  })

  it.each([
    { settledAt: OLD, settledOverride: 'settled' },
    { archivedAt: OLD },
  ])('suppresses stale attention for parked/archived work %j', metadata => {
    const state = stateFor({ ...metadata, status: 'error', requests: [{ id: 'request', kind: 'permission', text: 'Old permission', options: [] }] })
    state.queue.push({ id: 'queue', threadId: 'thread', kind: 'permission', requestId: 'request', text: 'Old permission', deferred: false, createdAt: NEW })
    const rows = describeThreads(state, NOW)
    expect(rows[0]).toMatchObject({ state: 'done', attention: false, request: undefined })
    expect(listThreads(rows, 'does not match').listed).toEqual([])
    expect(threadCounts(rows, NOW).active).toBe(0)
  })

  it('groups known settlement separately while unknown idle threads stay unsettled; unknown activity sorts last', () => {
    const state = stateFor()
    const base = state.host.threads[0]!
    state.host.threads.push(
      agentThreadSchema.parse({ ...base, id: 'active', updatedAt: OLD }),
      agentThreadSchema.parse({ ...base, id: 'settled', settledAt: NEW, settledOverride: 'settled' }),
      agentThreadSchema.parse({ ...base, id: 'archived', archivedAt: OLD }),
    )
    expect(groupThreads(describeThreads(state, NOW), NOW).map(group => [group.id, group.rows.map(row => row.thread.id)]))
      .toEqual([['unsettled', ['active', 'thread']], ['settled', ['settled', 'archived']]])
  })

  it('restores attention after provider activity explicitly unsets settlement', () => {
    const state = stateFor({ updatedAt: NEW, settledAt: null, archivedAt: null, settledOverride: null,
      requests: [{ id: 'question', kind: 'question', text: 'A fresh question', options: [] }] })
    state.queue.push({ id: 'queue', threadId: 'thread', kind: 'question', requestId: 'question', text: 'A fresh question', deferred: false, createdAt: NEW })
    const rows = describeThreads(state, NOW)
    expect(rows[0]).toMatchObject({ state: 'needs', attention: true, request: { requestId: 'question' } })
    expect(groupThreads(rows).map(group => group.id)).toEqual(['unsettled'])
  })
})
