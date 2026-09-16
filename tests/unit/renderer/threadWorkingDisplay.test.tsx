import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString()
let sequence = 0
const activity = (patch: Partial<AgentActivity> & Pick<AgentActivity, 'id'>): AgentActivity =>
  ({ turnId: 'turn-1', sequence: sequence++, kind: 'command', status: 'completed', title: 'Command', afterMessageId: `${THREAD}-1`, ...patch })
const lifecycle = (patch: Partial<AgentActivity> = {}): AgentActivity => activity({ id: 'lifecycle', kind: 'turn', title: 'Turn', ...patch })

function stateWith(patch: Partial<AgentThread>): AgentState {
  const state = threadsStateFixture()
  state.assignments = []
  state.activeThreadId = THREAD
  state.host.connected = true
  Object.assign(state.host.threads.find(item => item.id === THREAD)!, { modelId: 'codex:gpt' }, patch)
  return state
}

function mount(state: AgentState) {
  vi.mocked(useAgents).mockImplementation(liveAgentState(state).useLive)
  render(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
  return { transcript: screen.getByRole('log', { name: 'Thread transcript' }) }
}

beforeEach(() => { sequence = 0; vi.mocked(useAgents).mockReset() })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('a turn that has reported nothing yet', () => {
  const waiting = (): AgentActivity[] => [lifecycle({ status: 'running', startedAt: iso(-12_000), timingSource: 'observed' })]

  it('carries the wait with changing words, and says one steady thing to assistive tech', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] })
    const { transcript } = mount(stateWith({ status: 'running', activities: waiting() }))
    const liveRow = within(transcript).getByTestId('thread-activity-live')
    const word = liveRow.querySelector('.thread-activity-live__word')!
    expect(word.textContent).toBe('Combing the desert')
    expect(word).toHaveAttribute('aria-hidden', 'true')
    expect(liveRow).toHaveTextContent('Working for 12s')

    const seen = new Set<string>([word.textContent!])
    for (let step = 0; step < 6; step++) {
      const before = word.textContent
      act(() => { vi.advanceTimersByTime(3_800) })
      expect(word.textContent).not.toBe(before)
      seen.add(word.textContent!)
    }
    expect(seen.size).toBeGreaterThan(2)
    // The clock keeps its own time while the words change.
    expect(liveRow).toHaveTextContent('for 34s')
  })

  it('names the current action instead of a word once the provider reports one', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] })
    const { transcript } = mount(stateWith({ status: 'running', activities: [
      ...waiting(), activity({ id: 'test', command: 'npm test', status: 'running', startedAt: iso(-3_000) }),
    ] }))
    const liveRow = within(transcript).getByTestId('thread-activity-live')
    expect(liveRow.querySelector('.thread-activity-live__word')).toBeNull()
    expect(liveRow).toHaveTextContent('Working for 12snpm test')
  })
})

describe('what a finished turn changed', () => {
  it('counts the files beside the folded work and opens them with their diffs', () => {
    const { transcript } = mount(stateWith({ activities: [
      lifecycle({ status: 'completed', durationMs: 30_000 }),
      activity({ id: 'edit', kind: 'file-change', title: 'File changes', changes: [{ path: 'src/voice.ts', kind: 'update', diff: '-old\n+new' }] }),
      activity({ id: 'edit-again', kind: 'file-change', title: 'File changes', changes: [
        { path: 'src/voice.ts', kind: 'update', diff: '-second\n+third' }, { path: 'src/new.ts', kind: 'add', diff: '+fresh' },
      ] }),
      activity({ id: 'test', command: 'npm test' }),
    ] }))
    // The count is readable without opening the turn's work.
    const summary = within(transcript).getByRole('button', { name: 'Changed 2 files' })
    expect(within(transcript).getByRole('button', { name: 'Worked for 30s' })).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(summary)
    const files = within(transcript).getByRole('list', { name: 'Changed 2 files' })
    const items = [...files.querySelectorAll(':scope > li')]
    expect(items.map(item => item.querySelector('code')!.textContent)).toEqual(['src/voice.ts', 'src/new.ts'])
    // Every diff the turn reported for a file, not just the last one.
    expect(items[0]!.textContent).toContain('-old')
    expect(items[0]!.textContent).toContain('+third')
    expect(items[1]!.textContent).toContain('+fresh')
  })

  it('says nothing when a turn changed no files', () => {
    const { transcript } = mount(stateWith({ activities: [
      lifecycle({ status: 'completed', durationMs: 30_000 }), activity({ id: 'test', command: 'npm test' }),
    ] }))
    expect(within(transcript).queryByRole('button', { name: /^Changed/u })).not.toBeInTheDocument()
  })
})
