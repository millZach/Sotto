import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentActivity, OwnServerTurn } from '../../../src/shared/agentActivity'
import type { AgentMessage, AgentThread } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import type { AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { useOptionalApp } from '../../../src/renderer/src/state/AppContext'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { OwnServerTurnContext, type OwnServerTurnActions } from '../../../src/renderer/src/agents/OwnServerTurn'
import { LiveActivity, STILL_WAITING_MS } from '../../../src/renderer/src/agents/ThreadActivity'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { liveAgentState, threadsStateFixture } from '../../fixtures/renderer/liveAgentState'

vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: vi.fn(),
}))
vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

/**
 * A thread on one of the user's own model servers (ADR-0124, October 24 amendment; placement A of
 * prototype/own-server-turn-errors): the running turn's line while OpenCode tries the server again and once it has sent
 * nothing for 30 seconds, and a failed turn's words and buttons where its Failed line is.
 */
const SERVER: OwnServerTurn = { name: 'Sparks', model: 'DeepSeek V4.1 Flash', host: 'spark-head:8888' }
const at = (seconds: number): string => new Date(E2E_THREADS_NOW + seconds * 1000).toISOString()
const LAST = 'Now write the guide section on adding a server, with the Sparks setup as the example.'

const user = (id: string, text: string, seconds: number): AgentMessage => ({ id, role: 'user', text, createdAt: at(seconds) })
const reply = (id: string, text: string, seconds: number): AgentMessage => ({ id, role: 'assistant', text, createdAt: at(seconds) })
const turn = (turnId: string, patch: Partial<AgentActivity>): AgentActivity => ({ id: `opencode-turn-${turnId}`, turnId, afterMessageId: turnId, sequence: 0, kind: 'turn',
  status: 'running', title: 'Working', startedAt: at(-60), timingSource: 'observed', ...patch })
const failed = (turnId: string, failure: NonNullable<OwnServerTurn['failure']>, seconds = -60): AgentActivity =>
  turn(turnId, { status: 'failed', title: 'Turn failed', startedAt: at(seconds), completedAt: at(seconds + 90), error: `English words for ${failure}.`, ownServer: { ...SERVER, failure } })

function mount(patch: Partial<AgentThread>, options: { readonly owl?: boolean; readonly draft?: string } = {}) {
  const navigate = vi.fn()
  vi.mocked(useOptionalApp).mockReturnValue({ navigation: 'threads', platform: 'win32', windowMaximized: false, settings: DEFAULT_SETTINGS,
    update: { owlFeatures: { 'own-model-servers': options.owl !== false } },
    actions: { navigate, minimizeApp: vi.fn(), toggleMaximizeApp: vi.fn(), hideApp: vi.fn(), updateSettings: vi.fn() } } as unknown as AppContextValue)
  const state = threadsStateFixture()
  const base = state.host.threads[0]!
  const thread: AgentThread = { id: 'own', projectId: base.projectId, title: 'Guide: your own model servers', modelId: 'own-spark1/deepseek-v4.1-flash', providerId: base.providerId,
    status: 'idle', requests: [], messages: [], activities: [], updatedAt: at(0), ...patch }
  state.host.threads = [thread, ...state.host.threads]
  state.activeThreadId = thread.id
  const live = liveAgentState(state)
  if (options.draft !== undefined) live.threadDrafts.edit(thread.id, { text: options.draft })
  vi.mocked(useAgents).mockImplementation(live.useLive)
  render(<ThreadsView now={E2E_THREADS_NOW} />)
  return { live, navigate, transcript: screen.getByRole('log', { name: 'Thread transcript' }) }
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.mocked(useAgents).mockReset(); vi.mocked(useOptionalApp).mockReset() })

describe('while the server will not answer', () => {
  it('says which try OpenCode is on, with Stop, the thread’s own interrupt', () => {
    const { live, transcript } = mount({ status: 'running', messages: [user('u1', LAST, -60)], activities: [turn('u1', { ownServer: { ...SERVER, attempt: 3, attempts: 10 } })] })
    const line = within(transcript).getByTestId('thread-activity-live')
    expect(within(line).getByRole('status')).toHaveTextContent('Sparks isn’t answering. Trying again (3 of 10).')
    fireEvent.click(within(line).getByRole('button', { name: 'Stop agent' }))
    expect(live.command).toHaveBeenCalledWith({ type: 'interrupt', threadId: 'own' })
    // The button goes with the line, so focus goes to the composer, where the next message is written.
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveFocus()
  })

  it('gives the line back to the work when the server answers', () => {
    mount({ status: 'running', messages: [user('u1', LAST, -60), reply('r1', 'Reading the guide.', -5)], activities: [turn('u1', { ownServer: SERVER })] })
    expect(screen.queryByText(/isn’t answering|Still waiting/u)).toBeNull()
  })
})

describe('the still-waiting line', () => {
  const actions: OwnServerTurnActions = { newestFailure: null, canTryAgain: false, canStop: true, tryAgain: vi.fn(), openSettings: vi.fn(), stop: vi.fn() }
  const waiting = (activities: AgentActivity[], messages: AgentMessage[] = [user('u1', LAST, 0)]) =>
    <OwnServerTurnContext.Provider value={actions}><LiveActivity thread={{ status: 'running', activities, messages }} connected /></OwnServerTurnContext.Provider>

  it('says it is still waiting once the server has sent nothing for 30 seconds, and what that means', () => {
    vi.useFakeTimers({ now: E2E_THREADS_NOW + 5_000 })
    render(waiting([turn('u1', { startedAt: at(0), ownServer: SERVER })]))
    expect(screen.queryByText(/Still waiting/u)).toBeNull()
    act(() => { vi.advanceTimersByTime(STILL_WAITING_MS - 5_000) })
    expect(screen.getByRole('status')).toHaveTextContent('Still waiting for Sparks to start answering.')
    expect(screen.getByText('A long prompt can take a few minutes. The turn stops waiting at 5 minutes.')).toHaveClass('tt-paragraph')
    fireEvent.click(screen.getByRole('button', { name: 'Stop agent' }))
    expect(actions.stop).toHaveBeenCalled()
  })

  it('never says so once the server has sent anything, or for a model that is not one of the user’s servers', () => {
    vi.useFakeTimers({ now: E2E_THREADS_NOW + 60_000 })
    const { unmount } = render(waiting([turn('u1', { startedAt: at(0), ownServer: SERVER }), { id: 'tool', turnId: 'u1', sequence: 1, kind: 'tool', status: 'running', title: 'Read' }]))
    expect(screen.queryByText(/Still waiting/u)).toBeNull()
    unmount()
    render(waiting([turn('u1', { startedAt: at(0), ownServer: SERVER })], [user('u1', LAST, 0), reply('r1', 'Reading.', 40)]))
    expect(screen.queryByText(/Still waiting/u)).toBeNull()
    cleanup()
    render(waiting([turn('u1', { startedAt: at(0) })]))
    expect(screen.queryByText(/Still waiting/u)).toBeNull()
  })
})

describe('a turn the server let down', () => {
  const cases = [
    ['unreachable', 'Sparks didn’t answer.', 'OpenCode tried it 10 times over about a minute and a half. Nothing in the thread was lost. Check that Sparks is on and this computer can reach spark-head:8888, then try again.'],
    ['timeout', 'Sparks didn’t start answering within 5 minutes.', 'It took the message but sent nothing back. It may be busy, stuck or still reading a very long prompt. Nothing in the thread was lost. Check Sparks, then try again.'],
    ['key-refused', 'Sparks turned down its key.', 'Nothing in the thread was lost. In Settings › Providers › Your own model servers, remove Sparks and add it again with the right key, then try again.'],
    ['model-gone', 'Sparks no longer has DeepSeek V4.1 Flash.', 'Nothing in the thread was lost. Pick another model in the model menu below, or load DeepSeek V4.1 Flash on Sparks again, then try again.'],
    ['too-long', 'This thread is too long for DeepSeek V4.1 Flash.', 'Your last message and the thread before it are more than the model takes at once. Nothing in the thread was lost. OpenCode threads can’t be compacted in Sotto, so pick a model with more context and try again, or start a new thread.'],
  ] as const

  it.each(cases)('says what %s means, the first sentence in the error colour, with its buttons', (failure, title, body) => {
    const { transcript } = mount({ status: 'error', messages: [user('u1', LAST, -60)], activities: [failed('u1', failure)], lastTurn: { id: 'u1', status: 'failed' } })
    const reason = transcript.querySelector<HTMLElement>('.thread-own-failure__reason')!
    expect(reason).toHaveTextContent(`${title} ${body}`)
    expect(reason).toHaveClass('tt-paragraph')
    expect(reason.querySelector('strong')).toHaveTextContent(title)
    expect(within(transcript).queryByText(`English words for ${failure}.`)).toBeNull()
    const buttons = within(transcript.querySelector<HTMLElement>('.thread-own-failure__actions')!).getAllByRole('button').map(button => button.getAttribute('aria-label'))
    expect(buttons).toEqual([...failure === 'key-refused' ? ['Open Settings at Your own model servers'] : [], 'Try again, sending your last message to Sparks again'])
  })

  it('keeps the buttons on the newest failure only', () => {
    const { transcript } = mount({ status: 'error', messages: [user('u1', LAST, -300), user('u2', LAST, -60)],
      activities: [failed('u1', 'unreachable', -300), failed('u2', 'unreachable', -60)], lastTurn: { id: 'u2', status: 'failed' } })
    expect(transcript.querySelectorAll('.thread-own-failure')).toHaveLength(2)
    expect(within(transcript).getAllByRole('button', { name: 'Try again, sending your last message to Sparks again' })).toHaveLength(1)
    expect(transcript.querySelectorAll('.thread-own-failure')[1]!.querySelector('.thread-own-failure__actions')).not.toBeNull()
  })

  it('sends the last message again through the composer’s send, and keeps a draft the composer held', async () => {
    const { live, transcript } = mount({ status: 'error', messages: [user('u1', LAST, -60)], activities: [failed('u1', 'unreachable')], lastTurn: { id: 'u1', status: 'failed' } },
      { draft: 'A half-written thought' })
    await act(async () => { fireEvent.click(within(transcript).getByRole('button', { name: 'Try again, sending your last message to Sparks again' })) })
    const sent = live.command.mock.calls.map(([request]) => request).filter(request => request.type === 'manual-send')
    expect(sent).toEqual([expect.objectContaining({ type: 'manual-send', threadId: 'own', text: LAST })])
    expect(live.threadDrafts.draft('own').text).toBe('A half-written thought')
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveFocus()
  })

  it('opens Settings at Your own model servers', () => {
    const { navigate, transcript } = mount({ status: 'error', messages: [user('u1', LAST, -60)], activities: [failed('u1', 'key-refused')], lastTurn: { id: 'u1', status: 'failed' } })
    fireEvent.click(within(transcript).getByRole('button', { name: 'Open Settings at Your own model servers' }))
    expect(navigate).toHaveBeenCalledWith('settings', 'settings-providers', 'own-model-servers')
  })

  it('reads as its turn record says without the Owl feature', () => {
    const { transcript } = mount({ status: 'error', messages: [user('u1', LAST, -60)], activities: [failed('u1', 'unreachable')], lastTurn: { id: 'u1', status: 'failed' } }, { owl: false })
    expect(within(transcript).getByText('English words for unreachable.')).toBeInTheDocument()
    expect(transcript.querySelector('.thread-own-failure')).toBeNull()
    expect(within(transcript).queryByRole('button', { name: /Try again/u })).toBeNull()
  })

  it('leaves a failure that is not the server’s as its turn record says', () => {
    const { transcript } = mount({ status: 'error', messages: [user('u1', LAST, -60)],
      activities: [turn('u1', { status: 'failed', title: 'Turn failed', completedAt: at(0), error: 'OpenCode could not finish this turn.' })], lastTurn: { id: 'u1', status: 'failed' } })
    expect(within(transcript).getByText('OpenCode could not finish this turn.')).toBeInTheDocument()
    expect(within(transcript).queryByRole('button', { name: /Try again/u })).toBeNull()
  })

  it('shows the plain line for a retry when the Owl feature is off', () => {
    const { transcript } = mount({ status: 'running', messages: [user('u1', LAST, -60)], activities: [turn('u1', { ownServer: { ...SERVER, attempt: 3, attempts: 10 } })] }, { owl: false })
    expect(within(transcript).queryByText(/isn’t answering/u)).toBeNull()
    expect(within(transcript).getByTestId('thread-activity-live')).toBeInTheDocument()
  })
})
