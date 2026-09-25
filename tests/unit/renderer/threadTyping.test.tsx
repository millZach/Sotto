import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadPane } from '../../../src/renderer/src/agents/ThreadPane'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'
import { describeThreads } from '../../../src/renderer/src/agents/threadFacts'
import { liveAgentState, threadsStateFixture } from './liveAgentState'

const renders = vi.hoisted(() => ({ transcript: 0, options: 0 }))
vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))
vi.mock('../../../src/renderer/src/agents/ThreadTranscript', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/renderer/src/agents/ThreadTranscript')>()
  return { ...actual, ThreadTranscript: (props: React.ComponentProps<typeof actual.ThreadTranscript>) => {
    renders.transcript++
    return <actual.ThreadTranscript {...props} />
  } }
})
vi.mock('../../../src/renderer/src/agents/ThreadOptions', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/renderer/src/agents/ThreadOptions')>()
  return { ...actual, ThreadOptions: (props: React.ComponentProps<typeof actual.ThreadOptions>) => {
    renders.options++
    return <actual.ThreadOptions {...props} />
  } }
})
afterEach(cleanup)

it('keeps typing within the composer once the draft has content', () => {
  const state = threadsStateFixture()
  state.assignments = []
  state.queue = []
  state.activeThreadId = 'grok-previews'
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  const row = describeThreads(state, E2E_THREADS_NOW).find(row => row.thread.id === state.activeThreadId)!
  const store = new ThreadDraftStore(live.command)
  render(<ThreadPane row={row} state={state} command={live.command} store={store} focused promptId="prompt" error={null} onOpenThread={vi.fn()} />)
  const input = screen.getByRole('textbox', { name: 'Prompt', exact: true })
  fireEvent.change(input, { target: { value: 'a' } })
  const before = renders.transcript
  const optionsBefore = renders.options
  for (const text of ['ab', 'abc', 'abcd']) fireEvent.change(input, { target: { value: text } })
  expect(input).toHaveValue('abcd')
  expect(renders.transcript).toBe(before)
  expect(renders.options).toBe(optionsBefore)
  fireEvent.change(input, { target: { value: '' } })
  expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled()
})

it('does not process a closed model picker catalog while typing or deleting', () => {
  const state = threadsStateFixture()
  state.assignments = []
  state.queue = []
  state.activeThreadId = 'grok-previews'
  const thread = state.host.threads.find(thread => thread.id === state.activeThreadId)!
  thread.nativeSessionStarted = false
  let namesRead = 0
  const original = state.host.models.find(model => model.id === thread.modelId)!
  state.host.models = [original, ...Array.from({ length: 600 }, (_, index) => ({
    ...original, id: `typing-model-${index}`,
    get name() { namesRead++; return `Model ${index}` },
  }))]
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  const row = describeThreads(state, E2E_THREADS_NOW).find(row => row.thread.id === thread.id)!
  const store = new ThreadDraftStore(live.command)
  render(<ThreadPane row={row} state={state} command={live.command} store={store} focused promptId="prompt" error={null} onOpenThread={vi.fn()} />)
  const input = screen.getByRole('textbox', { name: 'Prompt', exact: true })
  fireEvent.change(input, { target: { value: 'a' } })
  const before = namesRead
  const optionsBefore = renders.options
  for (const text of ['ab', 'abc', 'ab', 'a']) fireEvent.change(input, { target: { value: text } })
  expect(input).toHaveValue('a')
  expect(namesRead).toBe(before)
  expect(renders.options).toBe(optionsBefore)
})

it('sends the latest text after edits that did not render the surrounding controls', async () => {
  const state = threadsStateFixture()
  state.assignments = []
  state.queue = []
  state.activeThreadId = 'grok-previews'
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  const row = describeThreads(state, E2E_THREADS_NOW).find(row => row.thread.id === state.activeThreadId)!
  const store = new ThreadDraftStore(live.command)
  render(<ThreadPane row={row} state={state} command={live.command} store={store} focused promptId="prompt" error={null} onOpenThread={vi.fn()} />)
  const input = screen.getByRole('textbox', { name: 'Prompt', exact: true })
  fireEvent.change(input, { target: { value: 'First' } })
  const before = renders.options
  fireEvent.change(input, { target: { value: 'First, then the latest edit' } })
  expect(renders.options).toBe(before)
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(live.command).toHaveBeenCalledWith(expect.objectContaining({
    type: 'manual-send', threadId: state.activeThreadId, text: 'First, then the latest edit',
  })))
  expect(input).toHaveValue('')
})
