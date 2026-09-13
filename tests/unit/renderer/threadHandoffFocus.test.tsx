import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentAssignment, AgentCapabilities, AgentCommand, AgentFollowup, AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { SplitLayoutStore } from '../../../src/renderer/src/agents/splitLayout'
import { liveAgentState, threadsStateFixture } from './liveAgentState'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const NOW = E2E_THREADS_NOW
const THREAD = 'grok-previews'
const CAPABILITIES: AgentCapabilities = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true }

function managedAssignment(threadId: string): AgentAssignment {
  return { threadId, mode: 'managed', instruction: '', followups: 0, paused: false, seenMessageIds: [], ownMessageIds: [], handledRequestIds: [], lastFailure: '', contextUpdatedAt: NOW } as unknown as AgentAssignment
}

/** The Threads workspace with a controller that hands a thread to Sotto and back, as main does for the saved draft. */
function mount({ managed = false, running = false, capabilities = {}, followups = [], holdSaves = false }: {
  readonly managed?: boolean; readonly running?: boolean; readonly capabilities?: Partial<AgentCapabilities>; readonly followups?: AgentFollowup[]; readonly holdSaves?: boolean
} = {}) {
  const initial = threadsStateFixture()
  initial.assignments = managed ? [managedAssignment(THREAD)] : []
  initial.queue = []
  initial.activeThreadId = THREAD
  initial.host.capabilities = { ...CAPABILITIES, ...capabilities }
  initial.followups = followups
  if (running) initial.host.threads.find(item => item.id === THREAD)!.status = 'running'
  const live = liveAgentState(initial, { holdSaves })
  // The draft store and the workspace share main's command, as in the app.
  const base = live.command.getMockImplementation()!
  const command = live.command.mockImplementation(async (request: AgentCommand): Promise<AgentState | null> => {
    if (request.type === 'assign') {
      const saved = live.state.threadDrafts?.find(item => item.threadId === request.threadId)
      return live.publish({ assignments: [...live.state.assignments, managedAssignment(request.threadId)],
        ...(saved ? { draft: saved.text, draftAttachments: saved.attachments, draftThreadId: request.threadId, composing: true } : {}) })
    }
    if (request.type === 'unassign') return live.publish({ assignments: live.state.assignments.filter(item => item.threadId !== request.threadId), draft: '', draftAttachments: [], draftThreadId: null, composing: false })
    if (request.type === 'select-thread') {
      // Main answers a selection after the renderer's next task, as over IPC.
      await new Promise(resolve => setTimeout(resolve, 20))
      const thread = live.state.host.threads.find(item => item.id === request.threadId)!
      return live.publish({ activeThreadId: thread.id, activeProjectId: thread.projectId })
    }
    if (request.type === 'save-thread-draft') {
      // Main confirms persistence of the exact revision, which the handoff waits for.
      const saved = await base(request)
      return saved === null || saved.error !== null ? saved : live.publish({ threadDraftPersistence: [...(live.state.threadDraftPersistence ?? []).filter(item => item.threadId !== request.threadId),
        { threadId: request.threadId, draftId: request.draftId, status: 'saved' }] })
    }
    return base(request)
  })
  vi.mocked(useAgents).mockImplementation(() => ({ ...live.useLive(), command }))
  render(<ThreadsView onOpenAgents={vi.fn()} now={NOW} layoutStore={new SplitLayoutStore()} paneAreaWidth={1200} />)
  const pane = (title = 'Grok voice previews') => screen.getByRole('region', { name: title })
  return { live, command, pane }
}

beforeEach(() => { vi.mocked(useAgents).mockReset() })
afterEach(() => { cleanup() })

describe('management handoff focus', () => {
  it('saves the latest typing before Manage, focuses the managed composer showing it, and Stop managing focuses the manual prompt', async () => {
    const view = mount()
    const prompt = within(view.pane()).getByRole('textbox', { name: 'Prompt', exact: true })
    fireEvent.change(prompt, { target: { value: 'My unsent manual draft.' } })
    const manage = within(view.pane()).getByRole('button', { name: 'Manage', exact: true })
    manage.focus()
    await act(async () => { fireEvent.click(manage) })
    // The debounced save is flushed and answered before the handoff reads the saved draft.
    await waitFor(() => expect(view.command.mock.calls.some(([request]) => request.type === 'assign')).toBe(true))
    const types = view.command.mock.calls.map(([request]) => request.type === 'save-thread-draft' ? `save:${request.text}` : request.type)
    expect(types.indexOf('save:My unsent manual draft.')).toBeGreaterThanOrEqual(0)
    expect(types.indexOf('save:My unsent manual draft.')).toBeLessThan(types.indexOf('assign'))
    expect(view.command.mock.calls.find(([request]) => request.type === 'assign')![0]).toMatchObject({ expectedDraftId: expect.any(String) })
    const managed = await waitFor(() => within(view.pane()).getByRole('textbox', { name: 'Prompt', exact: true }))
    expect(managed).toHaveAttribute('id', 'agent-prompt')
    await waitFor(() => expect(managed).toHaveFocus())
    expect(managed).toHaveValue('My unsent manual draft.')

    await act(async () => { fireEvent.click(within(view.pane()).getByRole('button', { name: 'Stop managing', exact: true })) })
    const manual = within(view.pane()).getByRole('textbox', { name: 'Prompt', exact: true })
    expect(manual).not.toHaveAttribute('id', 'agent-prompt')
    await waitFor(() => expect(manual).toHaveFocus())
    expect(manual).toHaveValue('My unsent manual draft.')
  })

  it('while Manage waits for the save, this thread cannot submit or settle, another pane can, and a failed save keeps the manual draft', async () => {
    const view = mount({ holdSaves: true })
    await act(async () => { fireEvent.click(within(screen.getByRole('complementary', { name: 'Thread sidebar' })).getByRole('button', { name: 'Open Streaming WAV stall beside', exact: true })) })
    await waitFor(() => expect(view.live.state.activeThreadId).toBe('wav-stall'))
    const prompt = within(view.pane()).getByRole('textbox', { name: 'Prompt', exact: true })
    await act(async () => { prompt.focus() })
    await waitFor(() => expect(view.live.state.activeThreadId).toBe(THREAD))
    fireEvent.change(prompt, { target: { value: 'Held manual draft.' } })
    await act(async () => { fireEvent.click(within(view.pane()).getByRole('button', { name: 'Manage', exact: true })) })
    await waitFor(() => expect(view.live.heldSaves.some(item => item.command.text === 'Held manual draft.')).toBe(true))

    const pane = within(view.pane())
    expect(pane.getByRole('button', { name: 'Manage', exact: true })).toBeDisabled()
    expect(pane.getByRole('button', { name: 'Settle', exact: true })).toBeDisabled()
    expect(pane.getByRole('button', { name: 'Send prompt', exact: true })).toBeDisabled()
    expect(pane.getByText('Handing this draft to Sotto…')).toBeInTheDocument()
    await act(async () => { fireEvent.keyDown(prompt, { key: 'Enter' }) })
    expect(view.live.manualSends()).toBe(0)
    // Typing stays open; the handoff carries the latest revision.
    expect(prompt).toBeEnabled()
    // The other pane is not held.
    const other = within(screen.getByRole('region', { name: 'Streaming WAV stall' }))
    fireEvent.change(other.getByRole('textbox', { name: 'Prompt', exact: true }), { target: { value: 'Other pane prompt.' } })
    expect(other.getByRole('button', { name: 'Send prompt', exact: true })).toBeEnabled()
    expect(other.getByRole('button', { name: 'Settle', exact: true })).toBeEnabled()

    await act(async () => { for (const held of view.live.heldSaves.splice(0)) held.finish('Could not write the draft.') })
    await waitFor(() => expect(within(view.pane()).getByRole('button', { name: 'Manage', exact: true })).toBeEnabled())
    expect(view.command.mock.calls.map(([request]) => request.type)).not.toContain('assign')
    expect(view.live.state.assignments).toEqual([])
    expect(within(view.pane()).getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('Held manual draft.')
    expect(within(view.pane()).getByRole('textbox', { name: 'Prompt', exact: true })).not.toHaveAttribute('id', 'agent-prompt')
    expect(within(view.pane()).getByRole('button', { name: 'Settle', exact: true })).toBeEnabled()
  })

  it('keyboard Manage keeps focus in the prompt while the save is held and after it fails, unless the user moved to another pane', async () => {
    const view = mount({ holdSaves: true })
    const user = userEvent.setup()
    await act(async () => { fireEvent.click(within(screen.getByRole('complementary', { name: 'Thread sidebar' })).getByRole('button', { name: 'Open Streaming WAV stall beside', exact: true })) })
    await waitFor(() => expect(view.live.state.activeThreadId).toBe('wav-stall'))
    const prompt = within(view.pane()).getByRole('textbox', { name: 'Prompt', exact: true })
    await act(async () => { prompt.focus() })
    await waitFor(() => expect(view.live.state.activeThreadId).toBe(THREAD))
    fireEvent.change(prompt, { target: { value: 'Keyboard manual draft.' } })
    const manage = within(view.pane()).getByRole('button', { name: 'Manage', exact: true })

    // Held, then refused: the button disables under the keyboard, and focus is in this thread's prompt throughout.
    await act(async () => { manage.focus() })
    await user.keyboard('{Enter}')
    await waitFor(() => expect(view.live.heldSaves.some(item => item.command.text === 'Keyboard manual draft.')).toBe(true))
    expect(manage).toBeDisabled()
    expect(document.activeElement).toBe(prompt)
    await user.keyboard('{Enter}')
    expect(view.live.manualSends()).toBe(0)
    expect(within(view.pane()).getByRole('button', { name: 'Settle', exact: true })).toBeDisabled()
    await act(async () => { for (const held of view.live.heldSaves.splice(0)) held.finish('Could not write the draft.') })
    await waitFor(() => expect(manage).toBeEnabled())
    expect(document.activeElement).toBe(prompt)
    expect(prompt).toHaveValue('Keyboard manual draft.')
    expect(view.live.state.assignments).toEqual([])

    // Held again, but the user moves to the other pane before the failure: focus stays where they went.
    await act(async () => { manage.focus() })
    await user.keyboard('{Enter}')
    await waitFor(() => expect(view.live.heldSaves.length).toBeGreaterThan(0))
    expect(document.activeElement).toBe(prompt)
    const other = within(screen.getByRole('region', { name: 'Streaming WAV stall' })).getByRole('textbox', { name: 'Prompt', exact: true })
    await user.click(other)
    await user.keyboard('Other pane typing')
    await act(async () => { for (const held of view.live.heldSaves.splice(0)) held.finish('Could not write the draft.') })
    await waitFor(() => expect(within(view.pane()).getByRole('button', { name: 'Manage', exact: true })).toBeEnabled())
    expect(document.activeElement).toBe(other)
    expect(other).toHaveValue('Other pane typing')
    expect(within(view.pane()).getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('Keyboard manual draft.')
  })

  it('Write here in an unfocused managed pane focuses that pane’s managed composer once it holds the selection', async () => {
    const view = mount({ managed: true })
    await act(async () => { fireEvent.click(within(screen.getByRole('complementary', { name: 'Thread sidebar' })).getByRole('button', { name: 'Open Streaming WAV stall beside', exact: true })) })
    await waitFor(() => expect(view.live.state.activeThreadId).toBe('wav-stall'))
    expect(view.pane()).not.toHaveAttribute('data-focused')
    const write = within(view.pane()).getByRole('button', { name: 'Write here', exact: true })
    // As a pointer does it: the pane takes focus on pointerdown, before the click.
    await act(async () => { fireEvent.pointerDown(write) })
    await act(async () => { write.focus(); fireEvent.click(write) })
    await waitFor(() => expect(view.pane()).toHaveAttribute('data-focused'))
    await waitFor(() => expect(within(view.pane()).getByRole('textbox', { name: 'Prompt', exact: true })).toHaveFocus())
    expect(document.activeElement).toHaveAttribute('id', 'agent-prompt')

    // Keyboard: reaching Write here gives its pane the selection but keeps the button, so Enter uses the button and never
    // sends the managed draft; then the composer takes focus.
    const other = screen.getByRole('region', { name: 'Streaming WAV stall' })
    await act(async () => { within(other).getByRole('textbox', { name: 'Prompt', exact: true }).focus() })
    await waitFor(() => expect(view.live.state.activeThreadId).toBe('wav-stall'))
    const keyed = within(view.pane()).getByRole('button', { name: 'Write here', exact: true })
    await act(async () => { keyed.focus() })
    await waitFor(() => expect(view.live.state.activeThreadId).toBe(THREAD))
    expect(keyed).toBeInTheDocument()
    expect(keyed).toHaveFocus()
    await act(async () => { fireEvent.click(keyed) })
    await waitFor(() => expect(document.activeElement).toHaveAttribute('id', 'agent-prompt'))
    expect(view.pane()).toContainElement(document.activeElement as HTMLElement)
    expect(view.command.mock.calls.map(([request]) => request.type)).not.toContain('send')
  })
})

describe('composer focus after a button send', () => {
  it('returns focus to the prompt after Steer now empties the draft', async () => {
    const view = mount({ running: true, capabilities: { steer: true } })
    const prompt = within(view.pane()).getByRole('textbox', { name: 'Prompt', exact: true })
    fireEvent.change(prompt, { target: { value: 'Use the smaller fixture instead.' } })
    const steer = within(view.pane()).getByRole('button', { name: 'Steer now', exact: true })
    steer.focus()
    await act(async () => { fireEvent.click(steer) })
    expect(view.command.mock.calls.map(([request]) => request.type)).toContain('steer')
    expect(prompt).toHaveFocus()
  })
})

describe('queue arrival', () => {
  it('names the message just queued in a collapsed queue, and announces it', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('max-height'), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    try {
      const at = new Date(NOW).toISOString()
      const view = mount({ running: true, followups: [1, 2, 3].map(n => ({ id: `50000000-0000-4000-8000-00000000000${n}`, threadId: THREAD, draftId: crypto.randomUUID(), text: `Queued ${n}`, attachments: [], createdAt: at, updatedAt: at, status: 'queued' as const })) })
      const queue = within(view.pane()).getByRole('region', { name: 'Queued messages' })
      expect(within(queue).getByRole('button', { name: /Queued 3/ })).toHaveAttribute('aria-expanded', 'false')
      const prompt = within(view.pane()).getByRole('textbox', { name: 'Prompt', exact: true })
      fireEvent.change(prompt, { target: { value: 'Also update the changelog' } })
      await act(async () => { fireEvent.keyDown(prompt, { key: 'Enter' }) })
      await waitFor(() => expect(within(queue).getByRole('button', { name: /Queued 4/ })).toHaveTextContent('Added'))
      expect(within(queue).getByRole('button', { name: /Queued 4/ })).toHaveTextContent('Also update the changelog')
      expect(within(queue).getByText('Queued: Also update the changelog')).toBeInTheDocument()
      // Opening the list brings the message queued while it was closed into view.
      const scrolled: Element[] = []
      Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this) }
      await act(async () => { fireEvent.click(within(queue).getByRole('button', { name: /Queued 4/ })) })
      expect(scrolled.at(-1)).toHaveTextContent('Also update the changelog')
    } finally { vi.unstubAllGlobals(); delete (Element.prototype as Partial<Element>).scrollIntoView }
  })
})
