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

const word = (row: HTMLElement): Element => row.querySelector('.thread-activity-live__word')!

/** A mounted thread whose activities change as a host's would, with the transcript's line kept mounted across them. */
function mountLive(state: AgentState) {
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  render(<ThreadsView now={NOW} />)
  return {
    result: screen.getByRole('log', { name: 'Thread transcript' }),
    update: (activities: readonly AgentActivity[]): void => { act(() => { live.publish({ host: { ...live.state.host, threads: live.state.host.threads.map(item => item.id === THREAD ? { ...item, activities: [...activities] } : item) } }) }) },
  }
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

  it('names the step the provider reports running in place of its words, and folds the step under the line', () => {
    const { transcript } = mount(stateWith({ status: 'running', activities: [
      ...waiting(), activity({ id: 'test', command: 'npm test', status: 'running', startedAt: iso(-3_000) }),
    ] }))
    const liveRow = within(transcript).getByTestId('thread-activity-live')
    expect(word(liveRow).textContent).toBe('Running ⁨npm test⁩')
    const line = within(liveRow).getByRole('button', { name: 'Working, 1 step so far' })
    expect(line).toHaveAttribute('aria-expanded', 'false')
    expect(line).toHaveAccessibleDescription(/Running .*npm test/u)
  })
})

describe('what the working line names', () => {
  const waiting = (): AgentActivity[] => [lifecycle({ status: 'running', startedAt: iso(-12_000), timingSource: 'observed' })]
  const said = (...steps: readonly AgentActivity[]): string | null => {
    const { transcript } = mount(stateWith({ status: 'running', activities: [...waiting(), ...steps] }))
    const text = word(within(transcript).getByTestId('thread-activity-live')).textContent
    cleanup()
    // The marks that keep a name in its own direction are not letters.
    return (text ?? '').replace(/[\u2068\u2069]/gu, '')
  }

  it.each([
    ['a command, without its shell', activity({ id: 's', status: 'running', command: `"C:\\Windows\\powershell.exe" -Command 'npm test'` }), 'Running npm test'],
    ['Claude reading a file', activity({ id: 's', kind: 'tool', status: 'running', title: 'Read', text: JSON.stringify({ file_path: 'D:\\repo\\src\\threads.css' }) }), 'Reading threads.css'],
    ['Muse reading a file', activity({ id: 's', kind: 'tool', status: 'running', title: 'read_file', text: JSON.stringify({ path: 'src/threads.css' }) }), 'Reading threads.css'],
    ['Grok naming the file in its title', activity({ id: 's', kind: 'tool', status: 'running', title: 'Read src/threads.css' }), 'Reading threads.css'],
    ['a file change', activity({ id: 's', kind: 'file-change', status: 'running', title: 'File changes', changes: [{ path: 'src/control.ts', kind: 'update' }] }), 'Editing control.ts'],
    ['a change to several files', activity({ id: 's', kind: 'file-change', status: 'running', title: 'File changes', changes: [{ path: 'src/control.ts', kind: 'update' }, { path: 'src/a.ts', kind: 'update' }] }), 'Editing control.ts and 1 more'],
    ['any other tool, as the provider named it', activity({ id: 's', kind: 'tool', status: 'running', title: 'Grep', text: JSON.stringify({ pattern: 'workingNow' }) }), 'Grep workingNow'],
  ])('%s', (_, step, words) => { expect(said(step)).toBe(words) })

  it.each([
    ['reasoning, which it does not call Thinking', activity({ id: 's', kind: 'reasoning', status: 'running', title: 'Thinking' })],
    ['a plan, whose record runs for the whole turn', activity({ id: 's', kind: 'plan', status: 'running', title: 'Plan', steps: [{ text: 'Write the tests', status: 'running' }, { text: 'Ship it', status: 'pending' }] })],
    ['a gap between steps', activity({ id: 's', command: 'npm test', status: 'completed' })],
  ])('leaves %s to the words', (_, step) => { expect(said(step)).toBe('Combing the desert') })

  it('says a reply is being written, but not one from before the turn', () => {
    const messages = threadsStateFixture().host.threads.find(item => item.id === THREAD)!.messages
    const reply = (createdAt: string) => ({ ...messages.at(-1)!, id: 'reply', role: 'assistant' as const, text: 'So far', createdAt })
    const first = mount(stateWith({ status: 'running', messages: [...messages, reply(iso(0))], activities: waiting() }))
    expect(word(within(first.transcript).getByTestId('thread-activity-live'))).toHaveTextContent('Writing a reply')
    cleanup()
    const before = mount(stateWith({ status: 'running', messages: [...messages, reply(iso(-3_600_000))], activities: waiting() }))
    expect(word(within(before.transcript).getByTestId('thread-activity-live'))).toHaveTextContent('Combing the desert')
  })

  it('holds what it says so quick steps do not flicker, and comes back to the words only after a gap that lasts', () => {
    vi.useFakeTimers({ now: NOW })
    const step = (id: string, command: string, status: AgentActivity['status'] = 'running'): AgentActivity => activity({ id, command, status })
    const state = stateWith({ status: 'running', activities: [...waiting(), step('a', 'one')] })
    const { result, update } = mountLive(state)
    const line = (): string => (word(within(result).getByTestId('thread-activity-live')).textContent ?? '').replace(/[\u2068\u2069]/gu, '')
    expect(line()).toBe('Running one')
    act(() => { vi.advanceTimersByTime(1_600) })
    // A new step takes the line at once when the last has had its time.
    update([...waiting(), step('a', 'one', 'completed'), step('b', 'two')])
    expect(line()).toBe('Running two')
    // Three more in quick succession: the line keeps the last it showed until its time is up, then shows the newest.
    update([...waiting(), step('b', 'two', 'completed'), step('c', 'three')])
    expect(line()).toBe('Running two')
    update([...waiting(), step('c', 'three', 'completed'), step('d', 'four')])
    expect(line()).toBe('Running two')
    act(() => { vi.advanceTimersByTime(1_500) })
    expect(line()).toBe('Running four')
    // A short gap never shows, and the same step coming back changes nothing.
    update([...waiting(), step('d', 'four', 'completed')])
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(line()).toBe('Running four')
    update([...waiting(), step('d', 'four', 'completed'), step('e', 'five')])
    expect(line()).toBe('Running four')
    act(() => { vi.advanceTimersByTime(500) })
    expect(line()).toBe('Running five')
    // A gap that lasts gives the line back to the words.
    update([...waiting(), step('e', 'five', 'completed')])
    act(() => { vi.advanceTimersByTime(1_500) })
    expect(line()).not.toContain('Running')
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
    const summary = within(transcript).getByRole('button', { name: 'Changed 2 files, 3 lines added, 2 lines removed' })
    expect(within(transcript).getByRole('button', { name: 'Worked for 30s · 3 steps · Ran 1 command' })).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(summary)
    const files = within(transcript).getByRole('list', { name: 'Changed 2 files' })
    const items = [...files.querySelectorAll(':scope > li')]
    expect(items.map(item => item.querySelector('code')!.textContent)).toEqual(['src/voice.ts', 'src/new.ts'])
    // Every diff the turn reported for a file, not just the last one.
    expect(items[0]!.textContent).toContain('old')
    expect(items[0]!.textContent).toContain('third')
    expect(items[1]!.textContent).toContain('fresh')
  })

  it('says nothing when a turn changed no files', () => {
    const { transcript } = mount(stateWith({ activities: [
      lifecycle({ status: 'completed', durationMs: 30_000 }), activity({ id: 'test', command: 'npm test' }),
    ] }))
    expect(within(transcript).queryByRole('button', { name: /^Changed/u })).not.toBeInTheDocument()
  })
})
