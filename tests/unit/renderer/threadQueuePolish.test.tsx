import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentCapabilities, AgentCommand, AgentFollowup, AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { liveAgentState, threadsStateFixture } from './liveAgentState'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const NOW = E2E_THREADS_NOW
const THREAD = 'grok-previews'
const BASE: AgentCapabilities = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true }
const PAUSE = 'The last turn did not confirm completion. Review the thread and resume queued follow-ups when ready.'

function manualState({ running = false, capabilities = {} }: { readonly running?: boolean; readonly capabilities?: Partial<AgentCapabilities> } = {}): AgentState {
  const state = threadsStateFixture()
  state.assignments = []
  state.activeThreadId = THREAD
  state.host.capabilities = { ...BASE, ...capabilities }
  if (running) state.host.threads.find(item => item.id === THREAD)!.status = 'running'
  return state
}

function mount(state: AgentState, options: Parameters<typeof liveAgentState>[1] = {}) {
  const live = liveAgentState(state, options)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  const view = render(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
  return { live, view, prompt: () => screen.getByRole('textbox', { name: 'Prompt', exact: true }) as HTMLTextAreaElement }
}

const requests = <T extends AgentCommand['type']>(live: ReturnType<typeof liveAgentState>, type: T): Extract<AgentCommand, { type: T }>[] =>
  live.command.mock.calls.map(([request]) => request).filter((request): request is Extract<AgentCommand, { type: T }> => request.type === type)

function type(prompt: HTMLTextAreaElement, value: string): void {
  fireEvent.change(prompt, { target: { value, selectionStart: value.length, selectionEnd: value.length } })
}

function followup(patch: Partial<AgentFollowup> & Pick<AgentFollowup, 'id' | 'text'>): AgentFollowup {
  return { threadId: THREAD, draftId: crypto.randomUUID(), attachments: [], createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), status: 'queued', ...patch }
}

const ids = (n: number): string => `40000000-0000-4000-8000-00000000000${n}`

/** A short window (820x560, or large display scaling) as matchMedia reports it. */
function shortWindow(short: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: short && query.includes('max-height'), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), onchange: null, dispatchEvent: vi.fn() }))
}

beforeEach(() => { vi.mocked(useAgents).mockReset() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('queued message editor focus', () => {
  it('edits in a dialog whose Save and Cancel are outside the list, and Escape returns focus to that item’s Edit button', async () => {
    const state = manualState({ running: true })
    state.followups = [followup({ id: ids(1), text: 'First follow-up' }), followup({ id: ids(2), text: 'Second follow-up' })]
    const { live } = mount(state)
    const queue = screen.getByRole('region', { name: 'Queued messages' })
    const edit = within(queue).getByRole('button', { name: 'Edit queued message 2' })
    edit.focus()
    fireEvent.click(edit)
    const dialog = screen.getByRole('dialog', { name: 'Edit queued message' })
    const editor = within(dialog).getByRole('textbox', { name: 'Edit queued message' })
    expect(editor).toHaveFocus()
    expect(editor).toHaveValue('Second follow-up')
    // The editor is not clipped by the list: its actions are not inside the list.
    expect(within(dialog).getByRole('button', { name: 'Save' }).closest('.thread-followups__list')).toBeNull()
    fireEvent.keyDown(editor, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Edit queued message' })).not.toBeInTheDocument()
    await waitFor(() => expect(within(queue).getByRole('button', { name: 'Edit queued message 2' })).toHaveFocus())
    expect(document.activeElement).not.toBe(document.body)
    expect(requests(live, 'edit-followup')).toEqual([])
  })

  it('returns focus to the Edit button after a confirmed save, and keeps the dialog open with the reason when the item started sending', async () => {
    const state = manualState({ running: true })
    state.followups = [followup({ id: ids(1), text: 'First follow-up' })]
    const { live } = mount(state)
    const queue = screen.getByRole('region', { name: 'Queued messages' })
    fireEvent.click(within(queue).getByRole('button', { name: 'Edit queued message 1' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit queued message' })
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'First follow-up, edited' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(within(queue).getByText('First follow-up, edited')).toBeInTheDocument()
    await waitFor(() => expect(within(queue).getByRole('button', { name: 'Edit queued message 1' })).toHaveFocus())

    fireEvent.click(within(queue).getByRole('button', { name: 'Edit queued message 1' }))
    const again = screen.getByRole('dialog', { name: 'Edit queued message' })
    act(() => { live.publish({ followups: live.state.followups!.map(item => ({ ...item, status: 'dispatching' as const })) }) })
    // Sotto may already be sending it: the edit cannot be saved and says why.
    expect(within(again).getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(again).toHaveTextContent('Sotto has started sending this message, so it can’t be changed.')
    fireEvent.click(within(again).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // The Edit button is gone with the dispatching item; focus stays in the queue, not on the page.
    await waitFor(() => expect(document.activeElement).not.toBe(document.body))
    expect(queue.contains(document.activeElement)).toBe(true)
    expect(requests(live, 'edit-followup')).toHaveLength(1)
  })

  it('keeps keyboard focus in the queue after removing an item or resuming the queue', async () => {
    const state = manualState({ running: true })
    state.followups = [followup({ id: ids(1), text: 'One', status: 'paused', error: PAUSE }), followup({ id: ids(2), text: 'Two', status: 'paused', error: PAUSE })]
    const { live } = mount(state)
    const queue = screen.getByRole('region', { name: 'Queued messages' })
    fireEvent.click(within(queue).getByRole('button', { name: 'Remove queued message 1' }))
    await waitFor(() => expect(live.state.followups).toHaveLength(1))
    await waitFor(() => expect(within(queue).getByRole('button', { name: 'Remove queued message 1' })).toHaveFocus())
    fireEvent.click(within(queue).getByRole('button', { name: 'Resume queue' }))
    await waitFor(() => expect(within(queue).queryByRole('button', { name: 'Resume queue' })).not.toBeInTheDocument())
    await waitFor(() => expect(document.activeElement).not.toBe(document.body))
    expect(queue.contains(document.activeElement)).toBe(true)
  })

  it('keeps focus on a move button that reaches the end of the list', async () => {
    const state = manualState({ running: true })
    state.followups = [followup({ id: ids(1), text: 'One' }), followup({ id: ids(2), text: 'Two' })]
    const { live } = mount(state)
    const queue = screen.getByRole('region', { name: 'Queued messages' })
    const up = within(queue).getByRole('button', { name: 'Move queued message 2 up' })
    up.focus()
    fireEvent.click(up)
    await waitFor(() => expect(live.state.followups!.map(item => item.text)).toEqual(['Two', 'One']))
    await waitFor(() => expect(document.activeElement).not.toBe(document.body))
    expect(queue.contains(document.activeElement)).toBe(true)
  })
})

describe('queue presentation', () => {
  it('states a shared pause once, keeps a unique failure on its own item, and says Paused once', () => {
    const state = manualState()
    state.followups = [
      followup({ id: ids(1), text: 'Run the audio suite', status: 'paused', error: PAUSE }),
      followup({ id: ids(2), text: 'Check the WAV callers', status: 'paused', error: PAUSE }),
      followup({ id: ids(3), text: 'Update the changelog', status: 'paused', error: PAUSE }),
      followup({ id: ids(4), text: 'Rejected one', status: 'failed', error: 'Claude rejected this message.' }),
    ]
    mount(state)
    const queue = screen.getByRole('region', { name: 'Queued messages' })
    expect(within(queue).getAllByText(PAUSE)).toHaveLength(1)
    expect(within(queue).getAllByText('Paused')).toHaveLength(1)
    expect(within(queue).getAllByText('Claude rejected this message.')).toHaveLength(1)
    expect(within(queue).getByText('Not sent')).toBeInTheDocument()
    expect(within(queue).getAllByRole('button', { name: 'Resume queue' })).toHaveLength(1)
  })

  it('collapses to a count and the next message in a short window, and the toggle shows the list', () => {
    shortWindow(true)
    const state = manualState({ running: true })
    state.followups = [followup({ id: ids(1), text: 'Then run the full audio suite' }), followup({ id: ids(2), text: 'Finally update the changelog' })]
    mount(state)
    const queue = screen.getByRole('region', { name: 'Queued messages' })
    const toggle = within(queue).getByRole('button', { name: /Queued 2/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(queue).toHaveTextContent('Then run the full audio suite')
    expect(within(queue).queryByRole('listitem')).not.toBeInTheDocument()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(within(queue).getAllByRole('listitem')).toHaveLength(2)
    expect(within(queue).getByRole('button', { name: 'Edit queued message 2' })).toBeInTheDocument()
  })

  it('shows the list in a tall window and keeps an item that needs attention visible when collapsed', () => {
    shortWindow(false)
    const tall = manualState({ running: true })
    tall.followups = [followup({ id: ids(1), text: 'Visible at once' })]
    const first = mount(tall)
    expect(within(screen.getByRole('region', { name: 'Queued messages' })).getByRole('button', { name: /Queued 1/ })).toHaveAttribute('aria-expanded', 'true')
    first.view.unmount()
    shortWindow(true)
    const short = manualState({ running: true })
    short.followups = [followup({ id: ids(1), text: 'Waiting normally' }), followup({ id: ids(2), text: 'Maybe sent', status: 'uncertain' })]
    mount(short)
    const queue = screen.getByRole('region', { name: 'Queued messages' })
    expect(queue).toHaveTextContent('Maybe sent')
    expect(within(queue).getByRole('button', { name: 'Check again' })).toBeInTheDocument()
  })

  it('tells a managed thread’s queue that it waits while Sotto manages the thread', () => {
    const state = manualState({ running: true })
    state.assignments = [{ threadId: THREAD, mode: 'managed', instruction: 'Finish previews', followups: 0, paused: false, seenMessageIds: [], ownMessageIds: [], handledRequestIds: [], lastFailure: '', contextUpdatedAt: NOW, startedAt: '' } as unknown as AgentState['assignments'][number]]
    state.followups = [followup({ id: ids(1), text: 'Queued before managing' })]
    mount(state)
    expect(screen.getByRole('region', { name: 'Queued messages' })).toHaveTextContent('Waits while Sotto manages this thread.')
  })
})

describe('composer admission', () => {
  it('queues behind a direct send main has admitted instead of dropping Enter, and still holds behind an unconfirmed one', async () => {
    const { live, prompt } = mount(manualState())
    type(prompt(), 'Start the long job.')
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    expect(requests(live, 'manual-send')).toHaveLength(1)
    // Main published `queued` for the send: it is on its way, not unconfirmed.
    type(prompt(), 'Then run the audio suite')
    expect(screen.getByRole('button', { name: 'Queue prompt' })).toBeEnabled()
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    expect(requests(live, 'queue-followup')).toEqual([expect.objectContaining({ text: 'Then run the audio suite' })])
    expect(requests(live, 'manual-send')).toHaveLength(1)
    await waitFor(() => expect(prompt()).toHaveValue(''))
    // No answer from the provider: nothing newer lines up until the user reviews it.
    act(() => live.deliver(THREAD, 'uncertain'))
    type(prompt(), 'Start the long job.')
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    expect(requests(live, 'queue-followup')).toHaveLength(1)
    expect(requests(live, 'manual-send')).toHaveLength(1)
    expect(screen.getByText('Waiting for your last prompt to be confirmed.')).toBeInTheDocument()
  })

  it('does not send or queue into a thread whose working folder is not ready, and keeps the draft', () => {
    const state = manualState()
    state.host.threads.find(item => item.id === THREAD)!.worktree = { mode: 'independent', status: 'error', error: 'This Git repository has no commit to branch from.' }
    state.host.threads.find(item => item.id === THREAD)!.nativeSessionStarted = false
    const { live, prompt } = mount(state)
    type(prompt(), 'Draft kept while setup failed.')
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled()
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    expect(requests(live, 'manual-send')).toEqual([])
    expect(requests(live, 'queue-followup')).toEqual([])
    expect(prompt()).toHaveValue('Draft kept while setup failed.')
    expect(screen.getByText('Available once the working folder is ready.')).toBeInTheDocument()
  })
})

describe('composer while a turn runs', () => {
  it('says the agent is working only in the placeholder and puts Stop in the send button’s place', () => {
    const { live, prompt } = mount(manualState({ running: true }))
    const form = prompt().closest('form')!
    expect(form).toHaveAttribute('data-running')
    expect(prompt().placeholder).toMatch(/is working\. Write a follow-up to queue it\.$/u)
    expect(form.querySelector('.thread-prompt__status')).toBeNull()
    expect(within(form).queryByRole('button', { name: 'Queue prompt' })).not.toBeInTheDocument()
    fireEvent.click(within(form).getByRole('button', { name: 'Stop agent' }))
    expect(requests(live, 'interrupt')).toEqual([{ type: 'interrupt', threadId: THREAD }])
    // One Stop for the pane: the header leaves it to the composer.
    expect(screen.getAllByRole('button', { name: 'Stop agent' })).toHaveLength(1)
  })

  it('keeps Enter’s button last once there is a follow-up to queue, with Stop beside it', () => {
    const { prompt } = mount(manualState({ running: true }))
    type(prompt(), 'Then run the audio suite')
    const buttons = within(prompt().closest('form')!.querySelector('.thread-prompt__actions')!).getAllByRole('button')
    expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual(['Stop agent', 'Queue prompt'])
  })

  it('disables Stop when the provider cannot interrupt, and shows neither Stop nor the working note when idle', () => {
    mount(manualState({ running: true, capabilities: { interrupt: false } }))
    expect(screen.getByRole('button', { name: 'Stop agent' })).toBeDisabled()
    cleanup()
    const { prompt } = mount(manualState())
    expect(screen.queryByRole('button', { name: 'Stop agent' })).not.toBeInTheDocument()
    expect(prompt().closest('form')).not.toHaveAttribute('data-running')
    expect(prompt().placeholder).toBe('What would you like to do next?')
  })
})
