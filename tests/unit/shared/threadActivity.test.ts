// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { agentThreadSchema } from '../../../src/shared/agents'
import { isThreadClosed, isThreadSettled, isWatcherWakeUpTurn } from '../../../src/shared/threadActivity'

const AT = '2026-09-10T11:00:00.000Z'
const base = { id: 'thread', projectId: 'project', title: 'Thread', modelId: '', status: 'idle', messages: [], requests: [] }

describe('shared thread lifecycle contract', () => {
  it.each(['idle', 'running', 'error'])('never infers closure or settlement from %s with unknown metadata', status => {
    const thread = agentThreadSchema.parse({ ...base, status })
    expect(isThreadSettled(thread)).toBe(false)
    expect(isThreadClosed(thread)).toBe(false)
  })

  it.each([
    [{ settledAt: AT }, true, true],
    [{ settledOverride: 'settled' }, true, true],
    [{ archivedAt: AT }, false, true],
    [{ settledAt: null, archivedAt: null, settledOverride: null }, false, false],
    [{ settledAt: 'invalid', archivedAt: '' }, false, false],
    [{ settledAt: AT, settledOverride: 'active' }, false, false],
    [{ settledAt: AT, settledOverride: 'active', archivedAt: AT }, false, true],
  ] as const)('preserves explicit lifecycle metadata %j', (metadata, settled, closed) => {
    const thread = agentThreadSchema.parse({ ...base, ...metadata })
    expect(thread).toMatchObject(metadata)
    expect(isThreadSettled(thread)).toBe(settled)
    expect(isThreadClosed(thread)).toBe(closed)
  })
})

describe('Watcher answering a wake-up (#1188)', () => {
  const watcher = (patch: Record<string, unknown>) => agentThreadSchema.parse({ ...base, kind: 'watcher', status: 'running', wakeUpMessageIds: ['news'], ...patch })
  it('is a running Watcher turn whose message Sotto recorded as a wake-up', () => {
    expect(isWatcherWakeUpTurn(watcher({ lastUserMessageId: 'news' }))).toBe(true)
    expect(isWatcherWakeUpTurn(watcher({ status: 'idle', lastTurn: { id: 'turn', status: 'running', messageId: 'news' } }))).toBe(true)
    expect(isWatcherWakeUpTurn(watcher({ messages: [{ id: 'news', role: 'user', text: 'News', createdAt: AT }] }))).toBe(true)
  })
  it('is not the user’s own turn, a finished turn, or an ordinary thread’s wake-up', () => {
    expect(isWatcherWakeUpTurn(watcher({ lastUserMessageId: 'user' }))).toBe(false)
    expect(isWatcherWakeUpTurn(watcher({ lastTurn: { id: 'turn', status: 'running', messageId: 'user' }, lastUserMessageId: 'news' }))).toBe(false)
    expect(isWatcherWakeUpTurn(watcher({ status: 'idle', lastUserMessageId: 'news' }))).toBe(false)
    expect(isWatcherWakeUpTurn(agentThreadSchema.parse({ ...base, status: 'running', lastUserMessageId: 'news', wakeUpMessageIds: ['news'] }))).toBe(false)
  })
})
