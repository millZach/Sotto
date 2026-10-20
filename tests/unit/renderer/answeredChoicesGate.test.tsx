import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentRequest, AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import type { AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { useOptionalApp } from '../../../src/renderer/src/state/AppContext'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { answeredChoices } from '../../../src/renderer/src/agents/requests/answeredChoices'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'
import { describeThreads } from '../../../src/renderer/src/agents/threadFacts'
import { ThreadPane } from '../../../src/renderer/src/agents/ThreadPane'
import { liveAgentState, threadsStateFixture } from '../../fixtures/renderer/liveAgentState'

vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: vi.fn(),
}))
vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const THREAD = 'grok-previews'
const asked = (id: string): AgentRequest => ({ id, kind: 'permission', text: 'Run a command?', options: [], context: { command: 'npm test' },
  permissionChoices: [{ id: 'once', label: 'Allow once', kind: 'allow-once' }, { id: 'no', label: 'Deny', kind: 'deny' }] })

/** A thread's own pane with its own permission waiting (the answer store outlives a test), answered with Allow once, in a build with Watcher on or off. */
async function answerInPane(watcherOn: boolean, id: string): Promise<void> {
  vi.mocked(useOptionalApp).mockReturnValue(watcherOn ? { settings: DEFAULT_SETTINGS, update: { watcherEnabled: true } } as unknown as AppContextValue : null)
  const state: AgentState = threadsStateFixture()
  state.activeThreadId = THREAD
  state.host.threads.find(thread => thread.id === THREAD)!.requests = [asked(id)]
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  const row = describeThreads(state, E2E_THREADS_NOW).find(item => item.thread.id === THREAD)!
  render(<ThreadPane row={row} state={state} command={live.command} store={new ThreadDraftStore(live.command)} focused promptId="prompt" error={null} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Allow once' }))
  await waitFor(() => expect(live.command).toHaveBeenCalledWith(expect.objectContaining({ type: 'answer', threadId: THREAD, requestId: id })))
  await waitFor(() => expect(screen.getByText('Answer sent.')).toBeInTheDocument())
}

beforeEach(() => { answeredChoices.clear(); vi.mocked(useAgents).mockReset(); vi.mocked(useOptionalApp).mockReset() })
afterEach(cleanup)

/** What a thread's pane answered is kept only for Watcher's lines, so only where Watcher is on (ADR-0072). */
describe('what the thread’s own pane answered', () => {
  it('is kept nowhere in a build with Watcher off', async () => {
    await answerInPane(false, 'gate-off')
    expect(answeredChoices.has(THREAD)).toBe(false)
  })

  it('is kept, in the card’s own words, where Watcher is on', async () => {
    await answerInPane(true, 'gate-on')
    expect(answeredChoices.sent(THREAD, 'gate-on')).toBe('Allow once')
  })
})
