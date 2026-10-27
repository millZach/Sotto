import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentState, AgentThread } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { liveAgentState, threadsStateFixture } from '../../fixtures/renderer/liveAgentState'

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

  state.activeThreadId = THREAD
  state.host.connected = true
  Object.assign(state.host.threads.find(item => item.id === THREAD)!, { modelId: 'codex:gpt' }, patch)
  return state
}

function mount(state: AgentState) {
  vi.mocked(useAgents).mockImplementation(liveAgentState(state).useLive)
  render(<ThreadsView now={NOW} />)
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
    // The words alone: no clock beside them.
    expect(liveRow).toHaveTextContent(/^Combing the desertWorking$/)

    const seen = new Set<string>([word.textContent!])
    for (let step = 0; step < 6; step++) {
      const before = word.textContent
      act(() => { vi.advanceTimersByTime(3_800) })
      expect(word.textContent).not.toBe(before)
      // The light's lit copy follows the word.
      expect(word).toHaveAttribute('data-word', word.textContent!)
      seen.add(word.textContent!)
    }
    expect(seen.size).toBeGreaterThan(2)
  })

  it('says the thread is compacting, not working, while its compaction runs', () => {
    const { transcript } = mount(stateWith({ status: 'running', compaction: { commandId: 'compact-1', status: 'running' }, activities: waiting() }))
    const liveRow = within(transcript).getByTestId('thread-activity-live')
    expect(liveRow).toHaveTextContent('Compacting context')
    expect(liveRow).not.toHaveTextContent('Working')
    cleanup()
    // Unconfirmed is not still going: the line goes back to the turn, and the composer reports the doubt.
    const { transcript: unsure } = mount(stateWith({ status: 'running', compaction: { commandId: 'compact-1', status: 'uncertain' }, activities: waiting() }))
    expect(within(unsure).getByTestId('thread-activity-live')).not.toHaveTextContent('Compacting context')
  })

  it('keeps a turn’s steps one press away while its context compacts part-way', () => {
    const { transcript } = mount(stateWith({ status: 'running', compaction: { commandId: 'compact-1', status: 'running' }, activities: [
      ...waiting(), activity({ id: 'test', command: 'npm test', durationMs: 3_000 }),
    ] }))
    const liveRow = within(transcript).getByTestId('thread-activity-live')
    expect(liveRow).toHaveTextContent('Compacting context')
    const steps = within(liveRow).getByRole('button', { name: '1 step' })
    fireEvent.click(steps)
    expect(within(transcript).getByRole('button', { name: 'npm test, completed in 3.0s' })).toBeVisible()
    fireEvent.keyDown(steps, { key: 'Escape' })
    expect(steps).toHaveAttribute('aria-expanded', 'false')
  })

  it('keeps its words once the provider reports a step, and folds the step under them', () => {
    const { transcript } = mount(stateWith({ status: 'running', activities: [
      ...waiting(), activity({ id: 'test', command: 'npm test', status: 'running', startedAt: iso(-3_000) }),
    ] }))
    const liveRow = within(transcript).getByTestId('thread-activity-live')
    expect(liveRow.querySelector('.thread-activity-live__word')).toHaveTextContent('Combing the desert')
    expect(liveRow).not.toHaveTextContent('npm test')
    expect(within(liveRow).getByRole('button', { name: 'Working, 1 step so far' })).toHaveAttribute('aria-expanded', 'false')
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
    expect(within(transcript).getByRole('button', { name: 'Worked for 30s · 3 steps' })).toHaveAttribute('aria-expanded', 'false')

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
