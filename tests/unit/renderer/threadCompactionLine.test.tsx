import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentState, AgentThread } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { liveAgentState, threadsStateFixture } from './liveAgentState'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const NOW = E2E_THREADS_NOW
const THREAD = 'grok-previews'
let sequence = 0
const activity = (patch: Partial<AgentActivity> & Pick<AgentActivity, 'id'>): AgentActivity =>
  ({ turnId: 'turn-1', sequence: sequence++, kind: 'command', status: 'completed', title: 'Command', afterMessageId: `${THREAD}-1`, ...patch })
const compaction = (patch: Partial<AgentActivity> = {}): AgentActivity =>
  activity({ id: 'compacted', kind: 'compaction', title: 'Context compacted', ...patch })

function mount(activities: AgentActivity[]): { transcript: HTMLElement } {
  const state: AgentState = threadsStateFixture()
  state.assignments = []
  state.activeThreadId = THREAD
  state.host.connected = true
  Object.assign(state.host.threads.find(item => item.id === THREAD)! as AgentThread, { status: 'idle' as const, activities })
  vi.mocked(useAgents).mockImplementation(liveAgentState(state).useLive)
  render(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
  return { transcript: screen.getByRole('log', { name: 'Thread transcript' }) }
}

beforeEach(() => { sequence = 0; vi.mocked(useAgents).mockReset() })
afterEach(() => { cleanup() })

describe('a compaction in the transcript', () => {
  it('draws a boundary naming what the context went from and to', () => {
    const { transcript } = mount([compaction({ context: { before: 120_000, after: 30_000 } })])
    const line = within(transcript).getByRole('separator', { name: 'Context compacted, 120k → 30k tokens' })
    expect(line).toHaveTextContent('Context compacted120k → 30k tokens')
  })

  it('names only the side the provider reported, and says nothing more when it reported neither', () => {
    expect(within(mount([compaction({ context: { after: 4_200 } })]).transcript).getByRole('separator').textContent).toBe('Context compactednow 4.2k tokens')
    cleanup()
    expect(within(mount([compaction({ context: { before: 1_400_000 } })]).transcript).getByRole('separator').textContent).toBe('Context compactedwas 1.4M tokens')
    cleanup()
    expect(within(mount([compaction()]).transcript).getByRole('separator').textContent).toBe('Context compacted')
  })

  it('stands on its own rather than folding into the work around it', () => {
    const { transcript } = mount([
      activity({ id: 'before', command: 'npm test' }),
      compaction({ context: { before: 90_000, after: 12_000 } }),
      activity({ id: 'after', command: 'npm run build' }),
    ])
    const line = within(transcript).getByRole('separator', { name: /Context compacted/u })
    // The turn folds its commands away; the boundary stays out of that fold so the reader still sees it.
    const fold = transcript.querySelector('.thread-work')
    expect(fold).not.toBeNull()
    expect(fold!.contains(line)).toBe(false)
    expect(fold!.textContent).not.toContain('Context compacted')
  })
})
