import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
const lifecycle = (patch: Partial<AgentActivity> = {}): AgentActivity => activity({ id: `lifecycle-${patch.turnId ?? 'turn-1'}`, kind: 'turn', title: 'Turn', ...patch })

function stateWith(patch: Partial<AgentThread>, connected = true): AgentState {
  const state = threadsStateFixture()
  state.assignments = []
  state.activeThreadId = THREAD
  state.host.connected = connected
  const thread = state.host.threads.find(item => item.id === THREAD)!
  Object.assign(thread, { modelId: 'codex:gpt' }, patch)
  return state
}

function mount(state: AgentState) {
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  render(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
  return { live, transcript: screen.getByRole('log', { name: 'Thread transcript' }) }
}

beforeEach(() => { sequence = 0; vi.mocked(useAgents).mockReset() })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('settled activity in the transcript', () => {
  const settled = (): AgentActivity[] => [
    lifecycle({ status: 'completed', durationMs: 124_000, timingSource: 'provider' }),
    activity({ id: 'test', command: 'npm test -- --run', cwd: 'D:\\work', output: 'PASS 12 tests', durationMs: 4_200, timingSource: 'provider' }),
    activity({ id: 'edit', kind: 'file-change', title: 'File changes', changes: [{ path: 'src/voice.ts', kind: 'update', diff: '-old\n+new' }] }),
    activity({ id: 'lint', command: 'npm run lint', status: 'failed', exitCode: 1, output: 'src/voice.ts: 1 error' }),
  ]

  it('folds the turn’s work under one line above the final reply, which stays in focus', () => {
    const { transcript } = mount(stateWith({ activities: settled() }))
    const messages = transcript.querySelectorAll('.thread-message')
    expect(messages).toHaveLength(2)
    const work = within(transcript).getByRole('region', { name: 'Worked for 2m 04s' })
    // DOM order: the user's message, the folded work, then the answer.
    expect(messages[0]!.compareDocumentPosition(work) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(work.compareDocumentPosition(messages[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const summary = within(work).getByRole('button', { name: 'Worked for 2m 04s' })
    expect(summary).toHaveAttribute('aria-expanded', 'false')
    expect(within(transcript).queryByRole('button', { name: /npm run lint/ })).not.toBeInTheDocument()
    expect(messages[1]).toHaveTextContent('Done. The preview plays a two-second sample')

    fireEvent.click(summary)
    // Opened, the group carries only its counts and still keeps its failure in view.
    const group = within(work).getByRole('region', { name: 'Ran 2 commands, changed 1 file' })
    expect(within(group).getByRole('button', { name: 'Ran 2 commands, changed 1 file' })).toHaveAttribute('aria-expanded', 'false')
    expect(within(group).getByRole('button', { name: 'npm run lint, Exit 1' })).toBeVisible()
  })

  it('folds replies written on the way, and times a turn with no lifecycle record from its messages', () => {
    const { transcript } = mount(stateWith({
      messages: [
        { id: `${THREAD}-1`, role: 'user', text: 'Check the parser.', createdAt: iso(0) },
        { id: 'on-the-way', role: 'assistant', text: 'Looking at the parser first.', createdAt: iso(2_000) },
        { id: 'empty-call', role: 'assistant', text: '', createdAt: iso(40_000) },
        { id: 'answer', role: 'assistant', text: 'The parser is fine.', createdAt: iso(65_000) },
      ],
      activities: [activity({ id: 'read', afterMessageId: 'on-the-way', command: 'cat parser.ts' })],
    }))
    expect([...transcript.querySelectorAll('.thread-message')].map(message => message.textContent)).toEqual([
      expect.stringContaining('Check the parser.'), expect.stringContaining('The parser is fine.'),
    ])
    fireEvent.click(within(transcript).getByRole('button', { name: 'Worked for 1m 05s' }))
    const work = within(transcript).getByRole('region', { name: 'Worked for 1m 05s' })
    expect(work).toHaveTextContent('Looking at the parser first.')
    expect(within(work).getByRole('button', { name: 'Ran 1 command' })).toBeVisible()
  })

  it('opens by keyboard to the exact command, output and diff, with one copy path per block', async () => {
    const user = userEvent.setup()
    const { transcript } = mount(stateWith({ activities: settled() }))
    const work = within(transcript).getByRole('button', { name: 'Worked for 2m 04s' })
    work.focus()
    await user.keyboard('{Enter}')
    expect(work).toHaveAttribute('aria-expanded', 'true')
    const summary = within(transcript).getByRole('button', { name: 'Ran 2 commands, changed 1 file' })
    summary.focus()
    await user.keyboard('{Enter}')
    expect(summary).toHaveAttribute('aria-expanded', 'true')
    const row = within(transcript).getByRole('button', { name: 'npm test -- --run, completed in 4.2s' })
    row.focus()
    await user.keyboard(' ')
    expect(row).toHaveAttribute('aria-expanded', 'true')
    const details = document.getElementById(row.getAttribute('aria-controls')!)!
    expect(within(details).getByLabelText('command code block')).toHaveTextContent('npm test -- --run')
    expect(within(details).getByLabelText('output code block')).toHaveTextContent('PASS 12 tests')
    expect(details).toHaveTextContent('In D:\\work')
    expect(details).toHaveTextContent('Reported by Codex')
    // The duration is stated once, in the row.
    expect(details).not.toHaveTextContent('4.2s')
    expect(within(details).getAllByRole('button', { name: /^Copy/ })).toHaveLength(2)

    await user.click(within(transcript).getByRole('button', { name: 'Edited src/voice.ts, completed' }))
    expect(within(transcript).getByLabelText('diff code block')).toHaveTextContent('-old +new')
  })
})

describe('the running turn', () => {
  const running = (): AgentActivity[] => [
    lifecycle({ status: 'running', startedAt: iso(-65_000), timingSource: 'observed' }),
    activity({ id: 'install', command: 'npm ci', durationMs: 9_000 }),
    activity({ id: 'test', command: 'npm test', status: 'running', startedAt: iso(-8_000) }),
  ]

  it('lists rows and ticks one live line while connected', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] })
    const { transcript } = mount(stateWith({ status: 'running', activities: running() }))
    const liveRow = within(transcript).getByTestId('thread-activity-live')
    // The answer sits between the rows and this line, so the line names the current action.
    expect(liveRow).toHaveTextContent('Working for 1m 05snpm test')
    const test = within(transcript).getByRole('button', { name: 'npm test, Running' })
    expect(test).toHaveTextContent('Running 8s')
    expect(within(transcript).getByRole('button', { name: 'npm ci, completed in 9.0s' })).toBeVisible()
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(liveRow).toHaveTextContent('Working for 1m 06s')
    expect(test).toHaveTextContent('Running 9s')
    // The live line follows the last message of the turn.
    expect(transcript.querySelectorAll('.thread-message')[1]!.compareDocumentPosition(liveRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('leaves the current action out of the live line only when it is the row directly above', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] })
    const last = `${THREAD}-2`
    const { live, transcript } = mount(stateWith({ status: 'running', activities: [
      lifecycle({ status: 'running', startedAt: iso(-65_000), afterMessageId: last }),
      activity({ id: 'test', command: 'npm test', status: 'running', startedAt: iso(-8_000), afterMessageId: last }),
    ] }))
    const liveRow = (): HTMLElement => within(transcript).getByTestId('thread-activity-live')
    // With the action named directly above, the line carries the wait in words instead of repeating it.
    expect(liveRow().querySelector('.thread-activity-live__word')).toHaveTextContent('Thinking')
    expect(liveRow()).toHaveTextContent(/^ThinkingWorking for 1m 05s$/)
    act(() => {
      live.publish({ host: { ...live.state.host, threads: live.state.host.threads.map(thread => thread.id === THREAD
        ? { ...thread, activities: [...thread.activities!, activity({ id: 'read', command: 'git diff', durationMs: 300, afterMessageId: last })] } : thread) } })
    })
    expect(liveRow()).toHaveTextContent(/^Working for 1m 05snpm test$/)
  })

  it('stops the clocks and says when work was last seen while the provider is disconnected', () => {
    const { transcript } = mount(stateWith({ status: 'running', activities: running() }, false))
    const liveRow = within(transcript).getByTestId('thread-activity-live')
    expect(liveRow).toHaveTextContent('Last seen working')
    expect(liveRow.querySelector('[data-elapsed]')).toBeNull()
    expect(within(transcript).getByRole('button', { name: 'npm test, Last seen running' }).querySelector('[data-elapsed]')).toBeNull()
  })

  it('shows the newest rows of a long turn and folds it once the turn completes', () => {
    const many = [lifecycle({ status: 'running', startedAt: iso(-1_000) }), ...Array.from({ length: 9 }, (_, index) => activity({ id: `c${index}`, command: `step ${index}` }))]
    const { live, transcript } = mount(stateWith({ status: 'running', activities: many }))
    expect(within(transcript).queryByRole('button', { name: /step 2\b/ })).not.toBeInTheDocument()
    fireEvent.click(within(transcript).getByRole('button', { name: 'Show 3 earlier' }))
    expect(within(transcript).getByRole('button', { name: /step 0\b/ })).toBeVisible()
    act(() => {
      live.publish({ host: { ...live.state.host, threads: live.state.host.threads.map(thread => thread.id === THREAD
        ? { ...thread, status: 'idle', activities: many.map(item => item.id === 'lifecycle-turn-1' ? { ...item, status: 'completed', completedAt: iso(0) } : item) } : thread) } })
    })
    expect(within(transcript).queryByTestId('thread-activity-live')).not.toBeInTheDocument()
    expect(within(transcript).getByRole('button', { name: 'Worked for 1.0s' })).toHaveAttribute('aria-expanded', 'false')
    expect(within(transcript).queryByRole('button', { name: /step 8\b/ })).not.toBeInTheDocument()
  })
})

describe('honest detail', () => {
  it('shows subagent lifecycle without identities or controls, and only the provider’s reasoning summary', async () => {
    const user = userEvent.setup()
    const { transcript } = mount(stateWith({ activities: [
      activity({ id: 'agents', kind: 'subagent', title: 'spawnAgent', text: 'Check the WAV parser', status: 'completed',
        agents: [{ id: 'codex-agent-7f3e', status: 'running', message: 'Reading parser' }, { id: 'codex-agent-99aa', status: 'errored' }] }),
      activity({ id: 'why', kind: 'reasoning', title: 'Reasoning summary', text: '**Checking the parser**' }),
      activity({ id: 'lost', command: 'git status', status: 'unknown', truncated: true, output: 'On branch' }),
    ] }))
    await user.click(within(transcript).getByRole('button', { name: /^Worked/ }))
    await user.click(within(transcript).getByRole('button', { name: 'Ran 1 command, 1 agent action, 1 reasoning summary' }))
    await user.click(within(transcript).getByRole('button', { name: 'Spawn agent, 2 agents, completed' }))
    const agents = within(transcript).getByRole('list', { name: 'Agents' })
    expect(agents).toHaveTextContent('Agent 1RunningReading parserAgent 2Failed')
    expect(transcript).not.toHaveTextContent('codex-agent-7f3e')
    expect(within(agents).queryAllByRole('button')).toHaveLength(0)
    expect(within(agents).queryAllByRole('link')).toHaveLength(0)

    await user.click(within(transcript).getByRole('button', { name: 'Reasoning summary, Checking the parser, completed' }))
    expect(within(transcript).getByText('Checking the parser').tagName).toBe('STRONG')

    const unknown = within(transcript).getByRole('button', { name: 'git status, Outcome unknown' })
    await user.click(unknown)
    expect(document.getElementById(unknown.getAttribute('aria-controls')!)).toHaveTextContent('Time not recorded · Some details were not kept.')
  })

  it('restores activity with earlier history only when that page is shown', () => {
    const messages = Array.from({ length: 90 }, (_, index) => ({ id: `m${index}`, role: index % 2 ? 'assistant' as const : 'user' as const, text: `History ${index}`, createdAt: iso(index) }))
    const { transcript } = mount(stateWith({ messages, activities: [
      activity({ id: 'old', afterMessageId: 'm2', command: 'old command' }),
      activity({ id: 'new', turnId: 'turn-2', afterMessageId: 'm88', command: 'new command' }),
    ] }))
    // Each turn with work folds it under its own line.
    expect(transcript.querySelectorAll('.thread-work')).toHaveLength(1)
    fireEvent.click(within(transcript).getByRole('button', { name: 'Show earlier messages (10)' }))
    expect(transcript.querySelectorAll('.thread-work')).toHaveLength(2)
  })
})
