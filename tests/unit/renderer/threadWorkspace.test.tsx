import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentCapabilities, AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { composerEnterIntent } from '../../../src/renderer/src/agents/composerKeys'
import { sendThreadRevision } from '../../../src/renderer/src/agents/ThreadComposer'
import { ThreadDraftStore, submissionStatus } from '../../../src/renderer/src/agents/threadDraftStore'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { describeThreads, organizeWorkspace } from '../../../src/renderer/src/agents/threadFacts'
import { liveAgentState, threadsStateFixture } from './liveAgentState'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const NOW = E2E_THREADS_NOW
const SETTLED_AT = new Date(NOW - 60_000).toISOString()
const ALL: AgentCapabilities = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true }

/** An unmanaged idle thread: the manual composer is the one on the page. */
function manualState(threadId = 'grok-previews'): AgentState {
  const state = threadsStateFixture()
  state.assignments = []
  state.activeThreadId = threadId
  return state
}

function mount(state: AgentState) {
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  const view = render(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
  return { live, view, prompt: () => screen.getByRole('textbox', { name: 'Prompt', exact: true }) }
}

beforeEach(() => { vi.mocked(useAgents).mockReset() })
afterEach(() => { cleanup(); delete (window as { sotto?: unknown }).sotto })

describe('composer Enter intent', () => {
  const key = (patch: Partial<Parameters<typeof composerEnterIntent>[0]> = {}) => composerEnterIntent({ key: 'Enter', shiftKey: false, altKey: false, defaultPrevented: false, isComposing: false, keyCode: 13, menuOpen: false, ...patch })
  it('sends on Enter and keeps Shift+Enter for a new line', () => {
    expect(key()).toBe('send')
    expect(key({ shiftKey: true })).toBe('newline')
    expect(key({ key: 'a' })).toBe('none')
  })
  it('never sends while composing text, after another handler took the key, or while a command menu is open', () => {
    expect(key({ isComposing: true })).toBe('none')
    expect(key({ keyCode: 229 })).toBe('none')
    expect(key({ defaultPrevented: true })).toBe('none')
    expect(key({ menuOpen: true })).toBe('none')
  })
})

describe('Threads manual composer', () => {
  it.each(['edited', 'rejected'] as const)('does not admit the captured prompt when stopping old management is %s', async outcome => {
    const state = threadsStateFixture()
    const thread = state.host.threads.find(item => item.id === 'footer-links')!
    thread.settledAt = SETTLED_AT
    const row = describeThreads(state, NOW).find(item => item.thread.id === thread.id)!
    expect(row.assignment?.mode).toBe('managed')
    let release!: (state: AgentState | null) => void
    const command = vi.fn(async request => request.type === 'unassign' ? new Promise<AgentState | null>(done => { release = done }) : state)
    const store = new ThreadDraftStore(command)
    store.edit(thread.id, { text: 'Captured before management stops' })
    const sending = sendThreadRevision(store, row, command, 1)
    if (outcome === 'edited') store.edit(thread.id, { text: 'Newer text while stopping management' })
    release(outcome === 'rejected' ? null : state)
    await sending
    expect(command.mock.calls.some(([request]) => request.type === 'manual-send')).toBe(false)
    expect(submissionStatus(store.submissions()[0]!, state).status).toBe('failed')
    expect(store.draft(thread.id).text).toBe(outcome === 'edited' ? 'Newer text while stopping management' : 'Captured before management stops')
    store.flushAll()
  })

  it.each(['queued', 'submitting', 'uncertain'] as const)('recovers durable %s delivery after remount independently of a newer or empty draft', status => {
    const state = manualState()
    const thread = state.host.threads.find(item => item.id === 'grok-previews')!
    thread.providerId = 'claude'
    state.host.providers = [{ id: 'claude', name: 'Claude', version: 'fixture', connection: 'connected', capabilities: ALL },
      { id: 'codex', name: 'Codex', version: 'fixture', connection: 'connected', capabilities: ALL }]
    const draftId = crypto.randomUUID()
    state.deliveries = [{ threadId: thread.id, draftId, status, createdAt: SETTLED_AT, updatedAt: SETTLED_AT }]
    state.threadDrafts = [{ threadId: thread.id, draftId: crypto.randomUUID(), text: 'My newer draft', attachments: [], requestId: null, updatedAt: SETTLED_AT }]
    const { live, view, prompt } = mount(state)
    const check = () => within(screen.getByLabelText('Pending message')).getByRole('button', { name: 'Check again' })
    expect(screen.getByLabelText('Pending message')).not.toHaveTextContent('My newer draft')
    // Without prompt text there is no second, empty "You" bubble: only the state line and its action.
    expect(screen.getByLabelText('Pending message').closest('article')).toBeNull()
    expect(screen.getByLabelText('Pending message')).toHaveTextContent('Sotto will not send your last prompt twice.')
    expect(screen.getByLabelText('Pending message').querySelector('.rich-message')).toBeNull()
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled()
    fireEvent.click(check())
    expect(live.command).toHaveBeenLastCalledWith({ type: 'refresh', provider: 'claude' })
    // A fresh page has no local submission text to use. Clearing the current
    // draft must not remove the independent durable recovery action either.
    fireEvent.change(prompt(), { target: { value: '' } })
    view.unmount()
    render(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    expect(prompt()).toHaveValue('')
    expect(check()).toBeEnabled()
    act(() => live.publish({ host: { ...live.state.host, providers: live.state.host.providers!.map(provider => provider.id === 'claude' ? { ...provider, connection: 'disconnected' } : provider) } }))
    // Disconnected, the pending line points to the one Reconnect in the thread header.
    expect(screen.getByLabelText('Pending message')).toHaveTextContent('Reconnect to check it.')
    expect(within(screen.getByLabelText('Pending message')).queryByRole('button')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(live.command).toHaveBeenLastCalledWith({ type: 'connect', provider: 'claude' })
    expect(live.manualSends()).toBe(0)
    act(() => live.publish({ deliveredDrafts: [{ threadId: thread.id, draftId }] }))
    expect(screen.queryByLabelText('Pending message')).not.toBeInTheDocument()
  })

  it.each(['null', 'throw'] as const)('keeps a %s IPC outcome unconfirmed and blocks replay until authoritative reconciliation', async failure => {
    const { live, prompt, view } = mount(manualState())
    const original = live.command.getMockImplementation()!
    live.command.mockImplementation(async request => {
      if (request.type === 'manual-send') {
        if (failure === 'throw') throw new Error('IPC reply unavailable')
        return null
      }
      return original(request)
    })
    fireEvent.change(prompt(), { target: { value: 'Possibly delivered' } })
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    await screen.findByRole('button', { name: 'Check again' })
    expect(screen.getByLabelText('Pending message')).toHaveTextContent('Unconfirmed')
    expect(screen.getByLabelText('Pending message')).not.toHaveTextContent('Not sent')
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    fireEvent.change(prompt(), { target: { value: 'Keep newer text' } })
    view.unmount()
    render(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(live.command).toHaveBeenLastCalledWith({ type: 'refresh' })
    expect(live.manualSends()).toBe(1)
    const draftId = live.sentDraftId('grok-previews')
    act(() => live.publish({ deliveredDrafts: [{ threadId: 'grok-previews', draftId }] }))
    expect(screen.queryByLabelText('Pending message')).not.toBeInTheDocument()
    expect(prompt()).toHaveValue('Keep newer text')
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeEnabled()
  })

  it('sends with Enter, shows the pending message at once and ignores IME and open-menu Enter', () => {
    const { live, prompt } = mount(manualState())
    fireEvent.change(prompt(), { target: { value: 'Ship the preview' } })
    expect(fireEvent.keyDown(prompt(), { key: 'Enter', keyCode: 229 })).toBe(true)
    prompt().setAttribute('aria-expanded', 'true')
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    prompt().removeAttribute('aria-expanded')
    expect(fireEvent.keyDown(prompt(), { key: 'Enter', shiftKey: true })).toBe(true)
    expect(live.manualSends()).toBe(0)
    expect(fireEvent.keyDown(prompt(), { key: 'Enter' })).toBe(false)
    expect(screen.getByLabelText('Pending message')).toHaveTextContent('Ship the preview')
    expect(live.command).toHaveBeenCalledWith({ type: 'manual-send', threadId: 'grok-previews', draftId: expect.any(String), text: 'Ship the preview' })
    const save = live.command.mock.calls.findIndex(([request]) => request.type === 'save-thread-draft')
    const send = live.command.mock.calls.findIndex(([request]) => request.type === 'manual-send')
    expect(save).toBeGreaterThanOrEqual(0)
    expect(save).toBeLessThan(send)
    expect(live.command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'assign' }))
  })

  it('keeps edits made during a pending send and clears nothing when the earlier prompt is accepted', async () => {
    const { live, prompt } = mount(manualState())
    fireEvent.change(prompt(), { target: { value: 'First prompt' } })
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    fireEvent.change(prompt(), { target: { value: 'Second thought while it sends' } })
    act(() => live.deliver('grok-previews', 'accepted', 'First prompt'))
    await waitFor(() => expect(screen.queryByLabelText('Pending message')).not.toBeInTheDocument())
    expect(prompt()).toHaveValue('Second thought while it sends')
    expect(screen.getByLabelText('Thread transcript')).toHaveTextContent('First prompt')
  })

  it('clears the composer when its own revision is accepted', async () => {
    const { live, prompt } = mount(manualState())
    fireEvent.change(prompt(), { target: { value: 'Only prompt' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send prompt' }))
    expect(prompt()).toHaveValue('Only prompt')
    act(() => live.deliver('grok-previews', 'accepted', 'Only prompt'))
    await waitFor(() => expect(prompt()).toHaveValue(''))
  })

  it('offers Retry for a failed send only while the composer still holds that revision', async () => {
    const { live, prompt } = mount(manualState())
    fireEvent.change(prompt(), { target: { value: 'Try this' } })
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    const draftId = live.sentDraftId('grok-previews')
    act(() => live.deliver('grok-previews', 'failed'))
    await waitFor(() => expect(screen.getByLabelText('Pending message')).toHaveTextContent('Not sent'))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(live.manualSends()).toBe(2)
    expect(live.sentDraftId('grok-previews')).toBe(draftId)
    act(() => live.deliver('grok-previews', 'failed'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible())
    fireEvent.change(prompt(), { target: { value: 'Try this instead' } })
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Pending message')).toHaveTextContent('Your newer draft is in the composer.')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByLabelText('Pending message')).not.toBeInTheDocument()
  })

  it('never resends an unconfirmed prompt: it offers Check again, or Reconnect when disconnected', async () => {
    const { live, prompt } = mount(manualState())
    fireEvent.change(prompt(), { target: { value: 'Maybe delivered' } })
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    act(() => live.deliver('grok-previews', 'uncertain'))
    await waitFor(() => expect(screen.getByLabelText('Pending message')).toHaveTextContent('Unconfirmed'))
    fireEvent.change(prompt(), { target: { value: 'A new prompt' } })
    expect(fireEvent.keyDown(prompt(), { key: 'Enter' })).toBe(false)
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(live.command).toHaveBeenLastCalledWith({ type: 'refresh' })
    // The send's own unconfirmed error is told once, by the pending message; an unrelated error still shows.
    act(() => { live.publish({ error: 'The provider did not confirm the result.' }) })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    act(() => { live.publish({ error: 'Could not save the spoken reply setting.' }) })
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save the spoken reply setting.')
    act(() => { live.publish({ error: null, host: { ...live.state.host, connected: false } }) })
    expect(screen.getAllByRole('button', { name: 'Reconnect' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(live.command).toHaveBeenLastCalledWith({ type: 'connect' })
    expect(live.manualSends()).toBe(1)
    expect(prompt()).toHaveValue('A new prompt')
  })

  it('does not repeat an unconfirmed prompt that already appears in the provider history', async () => {
    const { live, prompt } = mount(manualState())
    fireEvent.change(prompt(), { target: { value: 'Maybe delivered' } })
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    act(() => live.deliver('grok-previews', 'uncertain'))
    const draftId = live.sentDraftId('grok-previews')
    act(() => {
      live.publish({
        deliveries: live.state.deliveries!.map(item => item.draftId === draftId ? { ...item, messageId: 'provider-copy' } : item),
        host: { ...live.state.host, threads: live.state.host.threads.map(thread => thread.id === 'grok-previews' ? { ...thread, messages: [...thread.messages, { id: 'provider-copy', role: 'user' as const, text: 'Maybe delivered', createdAt: new Date(NOW).toISOString() }] } : thread) },
      })
    })
    const pending = await screen.findByLabelText('Pending message')
    expect(pending).toHaveTextContent('Unconfirmed')
    expect(pending.closest('article')).toBeNull()
    expect(within(pending).queryByText('You')).not.toBeInTheDocument()
    expect(pending).not.toHaveTextContent('Maybe delivered')
    expect(within(screen.getByLabelText('Thread transcript')).getAllByText('Maybe delivered')).toHaveLength(1)
    expect(within(pending).getByRole('button', { name: 'Check again' })).toBeEnabled()
  })

  it('keeps each thread’s draft across navigation and a new window', async () => {
    const { live, prompt, view } = mount(manualState())
    fireEvent.change(prompt(), { target: { value: 'Draft for previews' } })
    act(() => { live.publish({ activeThreadId: 'wav-stall' }) })
    // Leaving the thread saved it without waiting for the debounce.
    expect(live.command).toHaveBeenCalledWith(expect.objectContaining({ type: 'save-thread-draft', threadId: 'grok-previews', text: 'Draft for previews' }))
    expect(prompt()).toHaveValue('')
    fireEvent.change(prompt(), { target: { value: 'Draft for the stall' } })
    act(() => { live.publish({ activeThreadId: 'grok-previews' }) })
    expect(prompt()).toHaveValue('Draft for previews')
    view.unmount()
    render(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
    expect(prompt()).toHaveValue('Draft for previews')
    act(() => { live.publish({ activeThreadId: 'wav-stall' }) })
    await waitFor(() => expect(prompt()).toHaveValue('Draft for the stall'))
  })

  it('states only why a running thread cannot send, even with an empty composer', () => {
    const state = manualState()
    state.host.threads.find(item => item.id === 'grok-previews')!.status = 'running'
    state.host.capabilities = { ...state.host.capabilities, configureThread: true }
    mount(state)
    expect(screen.getByRole('combobox', { name: 'Thread model' })).toBeInTheDocument()
    expect(screen.getByText('You can send after this turn finishes.')).toBeVisible()
    expect(screen.queryByText(/Enter to send/)).not.toBeInTheDocument()
    expect(screen.queryByText('Available after this turn finishes.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled()
  })

  it('writes a question’s answer as a request-bound draft and sends it with answer', async () => {
    const state = manualState('visual-gate')
    const thread = state.host.threads.find(item => item.id === 'visual-gate')!
    thread.requests = [{ id: 'direction', kind: 'question', text: 'Which direction?', options: [] }]
    state.queue = [{ id: 'visual-gate:direction:question', threadId: 'visual-gate', kind: 'question', text: 'Which direction?', requestId: 'direction', createdAt: new Date(NOW).toISOString(), deferred: false }]
    const { live } = mount(state)
    const answer = screen.getByRole('textbox', { name: 'Your answer' })
    fireEvent.change(answer, { target: { value: 'Go left' } })
    fireEvent.keyDown(answer, { key: 'Enter' })
    expect(live.command).toHaveBeenCalledWith(expect.objectContaining({ type: 'save-thread-draft', threadId: 'visual-gate', text: 'Go left', requestId: 'direction' }))
    await waitFor(() => expect(live.command).toHaveBeenCalledWith({ type: 'answer', threadId: 'visual-gate', requestId: 'direction', answer: 'Go left' }))
    expect(live.manualSends()).toBe(0)
  })

  it('keeps the draft editable while the provider is disconnected and says why it cannot send', () => {
    const state = manualState()
    state.host.connected = false
    const { prompt } = mount(state)
    fireEvent.change(prompt(), { target: { value: 'Later' } })
    expect(prompt()).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled()
    expect(screen.getByText('Reconnect to send. Your draft stays here.')).toBeVisible()
    expect(screen.queryByText(/Enter to send/)).not.toBeInTheDocument()
    expect(screen.getByLabelText('Thread transcript')).toHaveTextContent('Add a preview button')
  })
})

describe('Threads project folders', () => {
  it('groups threads under their projects with provider marks and working and attention indicators', () => {
    const state = threadsStateFixture()
    const organization = organizeWorkspace(state, describeThreads(state, NOW), '')
    expect(organization.open.map(folder => [folder.title, folder.rows.map(row => row.thread.id)])).toEqual([
      ['workshop', ['visual-gate', 'grok-previews', 'wav-stall']],
      ['sotto-site', ['footer-links']],
      ['notes', ['weekly-note']],
    ])
    expect(organization.settled.map(folder => [folder.title, folder.settled, folder.rows.map(row => row.settledBy)])).toEqual([
      ['workshop', false, ['provider', 'provider', 'provider']],
      ['notes', false, ['provider']],
    ])
    mount(threadsStateFixture())
    const projects = screen.getByRole('region', { name: 'Projects' })
    // The heading counts project folders; thread counts are labelled as threads.
    expect(within(projects).getByRole('heading', { name: 'Projects 3 projects' })).toBeVisible()
    expect(within(projects).getByRole('button', { name: /^workshop/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: /^Settled 4 threads/ })).toBeVisible()
    expect(within(projects).getByRole('button', { name: 'Visual gate flake' }).querySelector('[data-provider]')).not.toBeNull()
    fireEvent.click(within(projects).getByRole('button', { name: /^workshop/ }))
    expect(within(projects).queryByRole('button', { name: 'Visual gate flake' })).not.toBeInTheDocument()
    expect(within(projects).getByRole('button', { name: /^workshop/ })).toHaveTextContent('1 waiting on you')
  })

  it('settles and restores a thread under its own project', () => {
    const state = threadsStateFixture()
    const { live } = mount(state)
    fireEvent.click(screen.getByRole('button', { name: 'Settle Footer links' }))
    expect(live.command).toHaveBeenLastCalledWith({ type: 'settle-thread', threadId: 'footer-links' })
    act(() => { live.publish({ host: { ...live.state.host, threads: live.state.host.threads.map(thread => thread.id === 'footer-links' ? { ...thread, workspaceSettledAt: SETTLED_AT } : thread) } }) })
    expect(within(screen.getByRole('region', { name: 'Projects' })).queryByRole('button', { name: 'Footer links' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Settled 5/ }))
    const settled = screen.getByRole('region', { name: 'Settled' })
    expect(within(settled).getByRole('button', { name: /^sotto-site/ })).toBeVisible()
    fireEvent.click(within(settled).getByRole('button', { name: 'Restore Footer links' }))
    expect(live.command).toHaveBeenLastCalledWith({ type: 'restore-thread', threadId: 'footer-links' })
    // A thread the provider closed is provider history, not a workspace restore.
    expect(within(settled).queryByRole('button', { name: 'Restore Release notes 1.4' })).not.toBeInTheDocument()
  })

  it('settles a whole project, keeps its live attention visible and restores it without touching individual settlement', () => {
    const state = threadsStateFixture()
    state.host.threads.find(thread => thread.id === 'wav-stall')!.workspaceSettledAt = SETTLED_AT
    const { live } = mount(state)
    fireEvent.click(screen.getByRole('button', { name: 'Settle project workshop' }))
    expect(live.command).toHaveBeenLastCalledWith({ type: 'settle-project', projectId: 'workshop' })
    act(() => { live.publish({ host: { ...live.state.host, projects: live.state.host.projects.map(project => project.id === 'workshop' ? { ...project, workspaceSettledAt: SETTLED_AT } : project) } }) })
    const shelf = screen.getByRole('button', { name: /^Settled/ })
    expect(shelf).toHaveAccessibleName(/1 waiting on you/)
    fireEvent.click(shelf)
    const settled = screen.getByRole('region', { name: 'Settled' })
    expect(within(settled).getByRole('button', { name: 'Visual gate flake' })).toBeVisible()
    expect(within(settled).queryByRole('button', { name: 'Restore Streaming WAV stall' })).not.toBeInTheDocument()
    fireEvent.click(within(settled).getByRole('button', { name: 'Restore project workshop' }))
    expect(live.command).toHaveBeenLastCalledWith({ type: 'restore-project', projectId: 'workshop' })
    act(() => { live.publish({ host: { ...live.state.host, projects: live.state.host.projects.map(project => ({ ...project, workspaceSettledAt: null })) } }) })
    expect(within(screen.getByRole('region', { name: 'Projects' })).getByRole('button', { name: 'Visual gate flake' })).toBeVisible()
    expect(within(screen.getByRole('region', { name: 'Settled' })).getByRole('button', { name: 'Restore Streaming WAV stall' })).toBeVisible()
  })

  it('adds a project from a folder, or opens the project that already has it', async () => {
    const choose = vi.fn(async () => 'D:\\Work\\new-app')
    ;(window as { sotto?: unknown }).sotto = { agents: { chooseProjectDirectory: choose } }
    const { live } = mount(threadsStateFixture())
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }))
    await waitFor(() => expect(live.command).toHaveBeenCalledWith({ type: 'create-project', title: 'new-app', path: 'D:\\Work\\new-app', useExisting: true }))
    choose.mockResolvedValueOnce('C:\\workshop\\')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add project' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }))
    await waitFor(() => expect(live.command).toHaveBeenCalledWith({ type: 'select-project', projectId: 'workshop' }))
  })

  it('starts a new thread in a chosen project', () => {
    mount(threadsStateFixture())
    fireEvent.click(screen.getByRole('button', { name: 'New thread in sotto-site' }))
    const dialog = screen.getByRole('dialog', { name: 'New thread' })
    expect(within(dialog).getByText('C:/sotto-site')).toBeVisible()
    expect(within(dialog).getByRole('button', { name: /Create thread/ })).toBeVisible()
  })
})

describe('Thread provider choice', () => {
  function providerState(nativeSessionStarted: boolean | undefined): AgentState {
    const state = manualState()
    state.host.models = state.host.models.map(model => ({ ...model, providerId: model.id.split(':')[0] as 'claude' | 'codex' | 'grok' }))
    state.host.providers = [
      { id: 'claude', name: 'Claude', version: '', connection: 'disconnected', capabilities: { ...ALL, configureThread: false } },
      { id: 'codex', name: 'Codex', version: '', connection: 'connected', capabilities: ALL },
      { id: 'grok', name: 'Grok', version: '', connection: 'connected', capabilities: { ...ALL, threads: false } },
    ]
    const thread = state.host.threads.find(item => item.id === 'grok-previews')!
    thread.providerId = 'claude'
    if (nativeSessionStarted === undefined) delete thread.nativeSessionStarted
    else thread.nativeSessionStarted = nativeSessionStarted
    return state
  }

  it('lets an unstarted thread choose any ready provider that can create threads', async () => {
    const { live } = mount(providerState(false))
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread model' }))
    expect(screen.queryByRole('button', { name: 'Grok', exact: true })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Codex', exact: true }))
    fireEvent.click(screen.getByRole('option', { name: 'GPT-5.4' }))
    await waitFor(() => expect(live.command).toHaveBeenCalledWith({ type: 'configure-thread', threadId: 'grok-previews', modelId: 'codex:gpt' }))
  })

  it('locks a started or unknown native conversation to its provider', () => {
    for (const started of [true, undefined]) {
      const state = providerState(started)
      state.host.providers![0] = { ...state.host.providers![0]!, connection: 'connected', capabilities: ALL }
      mount(state)
      fireEvent.click(screen.getByRole('combobox', { name: 'Thread model' }))
      expect(screen.queryByRole('button', { name: 'Codex', exact: true })).not.toBeInTheDocument()
      expect(screen.getByText('This conversation stays with Claude.')).toBeVisible()
      cleanup()
    }
  })
})

describe('Thread transcript scrolling', () => {
  const ROW = 100
  const VIEW = 500
  let tops: WeakMap<Element, number>
  beforeEach(() => {
    tops = new WeakMap()
    const height = (element: HTMLElement): number => element.querySelectorAll('.thread-message').length * ROW
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return height(this) })
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => VIEW)
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function (this: HTMLElement) { return tops.get(this) ?? 0 })
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (this: HTMLElement, value: number) { tops.set(this, Math.max(0, Math.min(value, height(this) - VIEW))) })
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('follows new messages at the end, keeps the reader’s place above it and anchors earlier pages', () => {
    const state = manualState()
    const at = new Date(NOW).toISOString()
    state.host.threads.find(item => item.id === 'grok-previews')!.messages = Array.from({ length: 100 }, (_, index) => ({ id: `m${index}`, role: 'assistant' as const, text: `History ${index}`, createdAt: at }))
    const { live } = mount(state)
    const transcript = screen.getByRole('log', { name: 'Thread transcript' })
    expect(transcript.scrollTop).toBe(80 * ROW - VIEW)
    const append = (id: string): void => act(() => { live.publish({ host: { ...live.state.host, threads: live.state.host.threads.map(thread => thread.id === 'grok-previews' ? { ...thread, messages: [...thread.messages, { id, role: 'assistant' as const, text: id, createdAt: at }] } : thread) } }) })
    append('following')
    expect(transcript.scrollTop).toBe(transcript.scrollHeight - VIEW)

    transcript.scrollTop = 1_000
    fireEvent.scroll(transcript)
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeVisible()
    append('while-reading')
    expect(transcript.scrollTop).toBe(1_000)
    expect(screen.getByRole('button', { name: 'New messages' })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Show earlier messages (21)' }))
    expect(transcript.scrollTop).toBe(1_000 + 21 * ROW)
    expect(screen.getByText('History 0', { exact: true })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'New messages' }))
    expect(transcript.scrollTop).toBe(transcript.scrollHeight - VIEW)
    expect(screen.queryByRole('button', { name: /Jump to latest|New messages/ })).not.toBeInTheDocument()
  })
})
