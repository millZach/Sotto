// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { agentThreadSchema } from '../../../src/shared/agents'
import { isThreadClosed, isThreadSettled } from '../../../src/shared/threadActivity'

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
