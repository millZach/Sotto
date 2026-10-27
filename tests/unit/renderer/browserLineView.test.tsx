import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentState, AgentThread } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import type { PromptEditorElement } from '../../../src/renderer/src/agents/promptSelection'
import { liveAgentState, threadsStateFixture } from '../../fixtures/renderer/liveAgentState'

// The browser line (ADR-0154) is an Owl feature (ADR-0072); each test says whether this build has it.
const gate = vi.hoisted(() => ({ on: true }))
vi.mock('../../../src/renderer/src/state/owlFeature', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/owlFeature')>(),
  useOwlFeature: (id: string) => id === 'quiet-browser' && gate.on,
}))
vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const NOW = E2E_THREADS_NOW
const THREAD = 'grok-previews'
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString()
let sequence = 0
const mountedEditors = new Set<PromptEditorElement['editor']>()
const activity = (patch: Partial<AgentActivity> & Pick<AgentActivity, 'id'>): AgentActivity =>
  ({ turnId: 'turn-1', sequence: sequence++, kind: 'tool', status: 'completed', title: 'Tool', afterMessageId: `${THREAD}-1`, ...patch })
const browser = (id: string, tool: string, input: unknown, patch: Partial<AgentActivity> = {}): AgentActivity =>
  activity({ id, title: `mcp__sotto_browser__${tool}`, text: JSON.stringify(input), ...patch })
const lifecycle = (status: AgentActivity['status']): AgentActivity =>
  activity({ id: 'lifecycle', kind: 'turn', title: 'Turn', status, startedAt: iso(-65_000), ...status === 'running' ? {} : { completedAt: iso(0) } })

/** An agent checking sign-in: it starts the server, then opens the page, clicks, fails a scroll and clicks again. */
const run = (): AgentActivity[] => [
  activity({ id: 'dev', kind: 'command', title: 'Command', command: 'npm run dev', durationMs: 2_000 }),
  browser('open', 'browser_open', { url: 'http://localhost:5173/', description: 'Check sign-in' }),
  browser('look', 'browser_action', { action: { type: 'inspect' } }),
  browser('scroll', 'browser_action', { action: { type: 'scroll', x: 0, y: 0, deltaX: 0, deltaY: 400 } }, { status: 'failed', error: 'The browser action did not finish.' }),
  browser('click', 'browser_action', { action: { type: 'click', x: 40, y: 80 } }),
]

function stateWith(patch: Partial<AgentThread>): AgentState {
  const state = threadsStateFixture()
  state.activeThreadId = THREAD
  state.host.connected = true
  Object.assign(state.host.threads.find(item => item.id === THREAD)!, { modelId: 'codex:gpt' }, patch)
  return state
}

function mount(state: AgentState) {
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  render(<ThreadsView now={NOW} />)
  for (const field of document.querySelectorAll<PromptEditorElement>('.prompt-editor')) mountedEditors.add(field.editor)
  const publish = (patch: Partial<AgentThread>): void => act(() => {
    live.publish({ host: { ...live.state.host, threads: live.state.host.threads.map(thread => thread.id === THREAD ? { ...thread, ...patch } : thread) } })
  })
  return { publish, transcript: screen.getByRole('log', { name: 'Thread transcript' }) }
}

beforeEach(() => { sequence = 0; gate.on = true; localStorage.clear(); vi.mocked(useAgents).mockReset() })
afterEach(() => {
  cleanup()
  for (const editor of mountedEditors) if (!editor.isDestroyed) editor.destroy()
  mountedEditors.clear()
})

describe('on Owl, a running turn\'s calls to Sotto\'s browser', () => {
  it('show as one line in the transcript that updates in place, and stay out of the working line\'s steps', () => {
    // A provider keeps each record's place in the order as later ones arrive.
    const reported = [lifecycle('running'), ...run()]
    const { transcript, publish } = mount(stateWith({ status: 'running', activities: reported }))
    const line = within(transcript).getByRole('button', { name: 'Browsing localhost:5173 · clicked in the page' })
    expect(line).toHaveAttribute('aria-expanded', 'false')
    expect(transcript.querySelectorAll('.thread-browser')).toHaveLength(1)
    // The dot holds still and says the run is going.
    expect(line.querySelector('.thread-browser__dot')).not.toBeNull()
    // The working line holds the rest of the turn: the one command.
    const working = within(transcript).getByRole('button', { name: 'Working, 1 step so far' })
    fireEvent.click(working)
    const steps = document.getElementById(working.getAttribute('aria-controls')!)!
    expect(within(steps).getByRole('button', { name: 'npm run dev, completed in 2.0s' })).toBeVisible()
    expect(steps.querySelector('.thread-browser')).toBeNull()
    expect(within(steps).queryByText(/sotto browser/iu)).not.toBeInTheDocument()

    // The next call changes the same line's words.
    publish({ activities: [...reported, browser('shot', 'browser_action', { action: { type: 'screenshot' } }, { status: 'running' })] })
    expect(within(transcript).getByRole('button', { name: 'Browsing localhost:5173 · took a picture of the page' })).toBe(line)

    // Once the turn moves on to other work, the line says where it browsed and how many steps it took.
    publish({ activities: [...reported, activity({ id: 'test', kind: 'command', title: 'Command', command: 'npm test', status: 'running', startedAt: iso(-1_000) })] })
    const browsed = within(transcript).getByRole('button', { name: 'Browsed localhost:5173 · 4 steps' })
    expect(browsed.querySelector('.thread-browser__dot')).toBeNull()
  })

  it('open on a press to the steps in plain words, a failed one marked, and fold on Escape with focus on the line', async () => {
    const user = userEvent.setup()
    const { transcript } = mount(stateWith({ status: 'running', activities: [lifecycle('running'), ...run()] }))
    const line = within(transcript).getByRole('button', { name: 'Browsing localhost:5173 · clicked in the page' })
    await user.click(line)
    expect(line).toHaveAttribute('aria-expanded', 'true')
    const list = document.getElementById(line.getAttribute('aria-controls')!)!
    expect(within(list).getAllByRole('listitem').map(item => item.textContent)).toEqual([
      'Opened localhost:5173', 'Looked at the page', 'Could not scroll the page', 'Clicked in the page',
    ])
    expect(within(list).getByText('Could not scroll the page').closest('li')).toHaveAttribute('data-failed')
    expect(within(list).getByText('Clicked in the page').closest('li')).not.toHaveAttribute('data-failed')
    await user.keyboard('{Escape}')
    expect(line).toHaveAttribute('aria-expanded', 'false')
    expect(line).toHaveFocus()
    expect(document.getElementById(list.id)).toBeNull()
  })

  it('fold into one line among a finished turn\'s rows', async () => {
    localStorage.setItem('sotto.threads.stepsOpen', 'true')
    const { transcript } = mount(stateWith({ status: 'idle', activities: [lifecycle('completed'), ...run()] }))
    const line = within(transcript).getByRole('button', { name: 'Browsed localhost:5173 · 4 steps' })
    expect(line.closest('ul')).toHaveClass('thread-activity__rows')
    expect(within(transcript).getByRole('button', { name: 'npm run dev, completed in 2.0s' })).toBeVisible()
    expect(transcript.querySelectorAll('.thread-activity__row[data-kind="tool"]')).toHaveLength(0)
  })
})

describe('on stable', () => {
  it('keeps a row for every call, all under the working line', () => {
    gate.on = false
    const { transcript } = mount(stateWith({ status: 'running', activities: [lifecycle('running'), ...run()] }))
    expect(transcript.querySelector('.thread-browser')).toBeNull()
    const working = within(transcript).getByRole('button', { name: 'Working, 5 steps so far' })
    fireEvent.click(working)
    const steps = document.getElementById(working.getAttribute('aria-controls')!)!
    expect(steps.querySelectorAll('.thread-activity__row[data-kind="tool"]')).toHaveLength(4)
    expect(steps.querySelector('.thread-browser')).toBeNull()
  })

  it('keeps a finished turn\'s rows too', () => {
    gate.on = false
    localStorage.setItem('sotto.threads.stepsOpen', 'true')
    const { transcript } = mount(stateWith({ status: 'idle', activities: [lifecycle('completed'), ...run()] }))
    expect(transcript.querySelector('.thread-browser')).toBeNull()
    expect(transcript.querySelectorAll('.thread-activity__row[data-kind="tool"]')).toHaveLength(4)
  })
})
