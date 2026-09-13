import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentSkillCatalog } from '../../../src/shared/agentSkills'
import type { AgentCapabilities, AgentCommand, AgentFollowup, AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { ThreadComposer } from '../../../src/renderer/src/agents/ThreadComposer'
import { describeThreads } from '../../../src/renderer/src/agents/threadFacts'
import { liveAgentState, threadsStateFixture } from './liveAgentState'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const NOW = E2E_THREADS_NOW
const THREAD = 'grok-previews'
const BASE: AgentCapabilities = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true }

const CATALOG: AgentSkillCatalog = {
  threadId: THREAD, providerId: 'codex', cwd: 'C:/workshop', status: 'ready', errors: [],
  skills: [
    { name: 'review-pr', description: 'Review the open pull request', path: 'C:/workshop/.agents/skills/review-pr/SKILL.md', scope: 'repo' },
    { name: 'deploy', description: 'Ship the site to staging', path: 'C:/Users/me/.codex/skills/deploy/SKILL.md', scope: 'user' },
    { name: 'imagegen', description: 'Generate an image', path: 'C:/codex/system/imagegen/SKILL.md', scope: 'system' },
  ],
}

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

/** Type into the prompt with the caret at the end, as a person would. */
function type(prompt: HTMLTextAreaElement, value: string): void {
  fireEvent.change(prompt, { target: { value, selectionStart: value.length, selectionEnd: value.length } })
  prompt.setSelectionRange(value.length, value.length)
  fireEvent.select(prompt)
}

function followup(patch: Partial<AgentFollowup> & Pick<AgentFollowup, 'id' | 'text'>): AgentFollowup {
  return { threadId: THREAD, draftId: crypto.randomUUID(), attachments: [], createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), status: 'queued', ...patch }
}

beforeEach(() => { vi.mocked(useAgents).mockReset() })
afterEach(() => { cleanup() })

describe('follow-up queue in the Threads composer', () => {
  it('queues with Enter while a turn runs, shows the row at once and clears only the revision the queue took', async () => {
    const { live, prompt } = mount(manualState({ running: true }), { holdQueue: true })
    type(prompt(), 'Then run the visual gate')
    const started = performance.now()
    expect(fireEvent.keyDown(prompt(), { key: 'Enter' })).toBe(false)
    // Local feedback is the queue row, before main answers; the transcript does not repeat it.
    const queue = screen.getByRole('region', { name: 'Queued messages' })
    expect(within(queue).getByText('Then run the visual gate')).toBeInTheDocument()
    expect(within(queue).getByText('Queuing…')).toBeInTheDocument()
    expect(performance.now() - started).toBeLessThan(100)
    expect(screen.queryByLabelText('Pending message')).not.toBeInTheDocument()
    expect(requests(live, 'queue-followup')).toEqual([{ type: 'queue-followup', threadId: THREAD, draftId: expect.any(String), text: 'Then run the visual gate' }])
    expect(requests(live, 'manual-send')).toHaveLength(0)
    // Typing continues while the durable queue write is slow.
    type(prompt(), 'A newer thought')
    act(() => live.heldQueue[0]!.finish())
    await waitFor(() => expect(within(queue).queryByText('Queuing…')).not.toBeInTheDocument())
    expect(within(queue).getByText('Then run the visual gate')).toBeInTheDocument()
    expect(prompt()).toHaveValue('A newer thought')
    expect(screen.queryByLabelText('Pending message')).not.toBeInTheDocument()
  })

  it('clears the composer when the queue owns its exact unchanged revision and keeps later sends behind the queue', async () => {
    const { live, prompt } = mount(manualState({ running: true }))
    type(prompt(), 'Queued prompt')
    fireEvent.click(screen.getByRole('button', { name: 'Queue prompt' }))
    await waitFor(() => expect(prompt()).toHaveValue(''))
    // The turn finishes, but a message typed now still lines up behind the queued one.
    act(() => { live.publish({ host: { ...live.state.host, threads: live.state.host.threads.map(thread => thread.id === THREAD ? { ...thread, status: 'idle' as const } : thread) } }) })
    type(prompt(), 'Second prompt')
    expect(screen.getByRole('button', { name: 'Queue prompt' })).toBeEnabled()
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    await waitFor(() => expect(live.state.followups?.map(item => item.text)).toEqual(['Queued prompt', 'Second prompt']))
    expect(requests(live, 'manual-send')).toHaveLength(0)
  })

  it('edits, reorders and removes queued items and resumes a paused queue without touching the composer', async () => {
    const state = manualState({ running: true })
    state.followups = [
      followup({ id: '10000000-0000-4000-8000-000000000001', text: 'First follow-up', skills: [{ name: 'deploy', path: CATALOG.skills[1]!.path }] }),
      followup({ id: '10000000-0000-4000-8000-000000000002', text: 'Second follow-up', status: 'paused', error: 'The turn was interrupted. Resume when ready.' }),
    ]
    const { live, prompt } = mount(state)
    type(prompt(), 'Unrelated draft')
    const queue = screen.getByRole('region', { name: 'Queued messages' })
    expect(within(queue).getByText('Paused')).toBeInTheDocument()
    expect(within(queue).getByText('The turn was interrupted. Resume when ready.')).toBeInTheDocument()

    fireEvent.click(within(queue).getByRole('button', { name: 'Edit queued message 1' }))
    const editor = within(queue).getByRole('textbox', { name: 'Edit queued message' })
    fireEvent.change(editor, { target: { value: 'First follow-up, then $deploy' } })
    fireEvent.keyDown(editor, { key: 'Enter', keyCode: 229 })
    expect(requests(live, 'edit-followup')).toHaveLength(0)
    fireEvent.keyDown(editor, { key: 'Enter' })
    await waitFor(() => expect(within(queue).getByText('First follow-up, then $deploy')).toBeInTheDocument())
    expect(requests(live, 'edit-followup')).toEqual([{ type: 'edit-followup', threadId: THREAD, itemId: state.followups[0]!.id, text: 'First follow-up, then $deploy', attachments: [], skills: [{ name: 'deploy', path: CATALOG.skills[1]!.path }] }])

    fireEvent.click(within(queue).getByRole('button', { name: 'Move queued message 1 down' }))
    await waitFor(() => expect(live.state.followups!.map(item => item.text)).toEqual(['Second follow-up', 'First follow-up, then $deploy']))
    expect(requests(live, 'reorder-followups')).toEqual([{ type: 'reorder-followups', threadId: THREAD, itemIds: [state.followups[1]!.id, state.followups[0]!.id] }])

    fireEvent.click(within(queue).getByRole('button', { name: 'Resume queue' }))
    await waitFor(() => expect(within(queue).queryByText('Paused')).not.toBeInTheDocument())
    expect(requests(live, 'resume-followups')).toEqual([{ type: 'resume-followups', threadId: THREAD }])

    fireEvent.click(within(queue).getByRole('button', { name: 'Remove queued message 2' }))
    await waitFor(() => expect(within(queue).queryByText('First follow-up, then $deploy')).not.toBeInTheDocument())
    expect(requests(live, 'remove-followup')).toEqual([{ type: 'remove-followup', threadId: THREAD, itemId: state.followups[0]!.id }])
    expect(prompt()).toHaveValue('Unrelated draft')
  })

  it('never offers changes to a dispatching or unconfirmed item and tells an unconfirmed one apart from a failed one', () => {
    const state = manualState({ running: true })
    state.followups = [
      followup({ id: '20000000-0000-4000-8000-000000000001', text: 'Being sent', status: 'dispatching', messageId: 'not-yet-in-history' }),
      followup({ id: '20000000-0000-4000-8000-000000000002', text: 'Maybe sent', status: 'uncertain' }),
      followup({ id: '20000000-0000-4000-8000-000000000003', text: 'Rejected', status: 'failed', error: 'Codex rejected this message.' }),
    ]
    mount(state)
    const queue = screen.getByRole('region', { name: 'Queued messages' })
    const [dispatching, uncertain, failed] = within(queue).getAllByRole('listitem')
    expect(dispatching).toHaveTextContent('Sending')
    expect(within(dispatching!).queryByRole('button')).not.toBeInTheDocument()
    expect(uncertain).toHaveTextContent('Unconfirmed')
    expect(uncertain).toHaveTextContent('Sotto will not send it twice.')
    expect(within(uncertain!).getByRole('button', { name: 'Check again' })).toBeInTheDocument()
    expect(within(uncertain!).queryByRole('button', { name: /Edit|Remove|Move/ })).not.toBeInTheDocument()
    expect(failed).toHaveTextContent('Not sent')
    expect(failed).toHaveTextContent('Codex rejected this message.')
    expect(within(failed!).getByRole('button', { name: 'Remove queued message 3' })).toBeInTheDocument()
    // Reordering waits for the pending delivery to settle.
    expect(within(queue).queryByRole('button', { name: /Move/ })).not.toBeInTheDocument()
    expect(within(queue).getByRole('button', { name: 'Resume queue' })).toBeInTheDocument()
  })

  it('hides a dispatched follow-up once the transcript shows its message', () => {
    const state = manualState({ running: true })
    const thread = state.host.threads.find(item => item.id === THREAD)!
    thread.messages = [...thread.messages, { id: 'dispatched-message', role: 'user', text: 'Already in history', createdAt: new Date(NOW).toISOString() }]
    state.followups = [followup({ id: '30000000-0000-4000-8000-000000000001', text: 'Already in history', status: 'dispatching', messageId: 'dispatched-message' })]
    mount(state)
    expect(screen.queryByRole('region', { name: 'Queued messages' })).not.toBeInTheDocument()
  })

  it('keeps a failed queue admission in the composer with Try again for the same revision', async () => {
    const { live, prompt } = mount(manualState({ running: true }), { holdQueue: true })
    type(prompt(), 'Queue me')
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    act(() => live.heldQueue[0]!.finish('Could not save this follow-up. Nothing was queued.'))
    const queue = await screen.findByRole('region', { name: 'Queued messages' })
    await waitFor(() => expect(within(queue).getByText('Not queued')).toBeInTheDocument())
    expect(queue).toHaveTextContent('Could not save this follow-up. Nothing was queued.')
    expect(prompt()).toHaveValue('Queue me')
    const first = requests(live, 'queue-followup')[0]!
    fireEvent.click(within(queue).getByRole('button', { name: 'Try again' }))
    expect(requests(live, 'queue-followup')).toHaveLength(2)
    expect(requests(live, 'queue-followup')[1]!.draftId).toBe(first.draftId)
    act(() => live.heldQueue[1]!.finish())
    await waitFor(() => expect(prompt()).toHaveValue(''))
  })

  it('calls an unanswered queue admission unconfirmed rather than refused, and asking again cannot add it twice', async () => {
    const { live, prompt } = mount(manualState({ running: true }))
    const answer = live.command.getMockImplementation()!
    let silent = true
    live.command.mockImplementation(async request => request.type === 'queue-followup' && silent ? null : answer(request))
    type(prompt(), 'Queue me quietly')
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    const queue = await screen.findByRole('region', { name: 'Queued messages' })
    await waitFor(() => expect(within(queue).getByText('Unconfirmed')).toBeInTheDocument())
    expect(within(queue).queryByText('Not queued')).not.toBeInTheDocument()
    expect(queue).toHaveTextContent('Sotto could not confirm this was queued.')
    silent = false
    fireEvent.click(within(queue).getByRole('button', { name: 'Try again' }))
    const [first, second] = requests(live, 'queue-followup')
    expect(second!.draftId).toBe(first!.draftId)
    await waitFor(() => expect(prompt()).toHaveValue(''))
    expect(live.state.followups).toHaveLength(1)
  })

  it('keeps sending, queuing and steering on each thread lane while Sotto is busy with other work', () => {
    const running = manualState({ running: true, capabilities: { steer: true } })
    running.busy = true
    const { prompt, view } = mount(running)
    type(prompt(), 'Queue while busy')
    expect(screen.getByRole('button', { name: 'Queue prompt' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Steer now' })).toBeEnabled()
    view.unmount()
    const idle = manualState()
    idle.busy = true
    const second = mount(idle)
    type(second.prompt(), 'Send while busy')
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeEnabled()
    expect(screen.queryByText('Sotto is finishing another action.')).not.toBeInTheDocument()
  })

  it('queues a newer revision behind a follow-up already on its way, but not behind an unconfirmed direct send', () => {
    const state = manualState({ running: true, capabilities: { steer: true } })
    const at = new Date(NOW).toISOString()
    const onItsWay = followup({ id: '30000000-0000-4000-8000-000000000009', text: 'Already dispatching', status: 'dispatching' })
    state.followups = [onItsWay]
    state.deliveries = [{ threadId: THREAD, draftId: onItsWay.draftId, status: 'submitting', createdAt: at, updatedAt: at }]
    const { prompt, view } = mount(state)
    type(prompt(), 'Line up behind it')
    expect(screen.getByRole('button', { name: 'Queue prompt' })).toBeEnabled()
    // Steering is a direct delivery and waits for the one on its way.
    expect(screen.getByRole('button', { name: 'Steer now' })).toBeDisabled()
    view.unmount()
    const uncertain = manualState({ running: true })
    const draftId = '50000000-0000-4000-8000-000000000001'
    uncertain.threadDrafts = [{ threadId: THREAD, draftId, text: 'Unconfirmed send', attachments: [], requestId: null, updatedAt: at }]
    uncertain.deliveries = [{ threadId: THREAD, draftId, status: 'uncertain', createdAt: at, updatedAt: at }]
    const second = mount(uncertain)
    expect(second.prompt()).toHaveValue('Unconfirmed send')
    expect(screen.getByRole('button', { name: 'Queue prompt' })).toBeDisabled()
    // Retyped, the unconfirmed prompt could reach the provider twice, so a newer revision waits too.
    type(second.prompt(), 'Unconfirmed send, edited')
    expect(screen.getByRole('button', { name: 'Queue prompt' })).toBeDisabled()
    expect(screen.getByText('Waiting for your last prompt to be confirmed.')).toBeInTheDocument()
    fireEvent.keyDown(second.prompt(), { key: 'Enter' })
    expect(requests(second.live, 'queue-followup')).toEqual([])
  })
})

describe('Steer now', () => {
  it('steers the running turn with the exact draft revision only when the provider supports it', async () => {
    const { live, prompt } = mount(manualState({ running: true, capabilities: { steer: true } }))
    expect(screen.getByRole('button', { name: 'Steer now' })).toBeDisabled()
    type(prompt(), 'Use the staging database instead')
    fireEvent.click(screen.getByRole('button', { name: 'Steer now' }))
    expect(screen.getByLabelText('Pending message')).toHaveTextContent('Use the staging database instead')
    expect(requests(live, 'steer')).toEqual([{ type: 'steer', threadId: THREAD, draftId: expect.any(String), text: 'Use the staging database instead' }])
    expect(requests(live, 'queue-followup')).toHaveLength(0)
    act(() => live.deliver(THREAD, 'accepted', 'Use the staging database instead'))
    await waitFor(() => expect(prompt()).toHaveValue(''))
  })

  it('explains an unsupported provider instead of offering a steer that cannot happen', () => {
    const state = manualState({ running: true })
    state.host.providers = [{ id: 'claude', name: 'Claude', version: 'fixture', connection: 'connected', capabilities: { ...BASE, steer: false } }]
    state.host.threads.find(item => item.id === THREAD)!.providerId = 'claude'
    const { prompt } = mount(state)
    expect(screen.queryByRole('button', { name: 'Steer now' })).not.toBeInTheDocument()
    expect(screen.getByText(/Claude can’t steer a running turn\./)).toBeInTheDocument()
    type(prompt(), 'Queue instead')
    expect(screen.getByRole('button', { name: 'Queue prompt' })).toBeEnabled()
  })

  it('is not offered to an idle thread', () => {
    mount(manualState({ capabilities: { steer: true } }))
    expect(screen.queryByRole('button', { name: 'Steer now' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeInTheDocument()
  })
})

describe('skills picker', () => {
  it('opens from $, asks for the thread catalog once, and inserts the selection for review without sending', async () => {
    const { live, prompt } = mount(manualState({ capabilities: { skills: true } }))
    type(prompt(), 'Please $')
    expect(screen.getByText('Loading skills…')).toHaveAttribute('role', 'status')
    type(prompt(), 'Please $re')
    expect(requests(live, 'refresh-thread-skills')).toEqual([{ type: 'refresh-thread-skills', threadId: THREAD }])
    act(() => live.publishCatalog(CATALOG))
    const list = await screen.findByRole('listbox', { name: 'Skills' })
    // Search narrows the native list; the scope stays with each native entry.
    expect(within(list).getAllByRole('option').map(option => option.textContent)).toEqual(['$review-prReview the open pull requestProject'])
    expect(prompt()).toHaveAttribute('aria-activedescendant', within(list).getAllByRole('option')[0]!.id)
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    expect(prompt()).toHaveValue('Please $review-pr ')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(requests(live, 'manual-send')).toHaveLength(0)
    act(() => { live.threadDrafts.flushAll() })
    expect(requests(live, 'save-thread-draft').at(-1)).toMatchObject({ text: 'Please $review-pr ', skills: [{ name: 'review-pr', path: CATALOG.skills[0]!.path }] })

    // Removing the written token removes its reference before the next save.
    type(prompt(), 'Please ')
    act(() => { live.threadDrafts.flushAll() })
    expect(requests(live, 'save-thread-draft').at(-1)).not.toHaveProperty('skills')
    expect(live.threadDrafts.draft(THREAD).skills).toEqual([])
  })

  it('keeps a typed /command as native text unless the user moves into the list', async () => {
    const { live, prompt } = mount(manualState({ capabilities: { skills: true } }), { catalog: () => CATALOG })
    type(prompt(), '/re')
    const list = await screen.findByRole('listbox', { name: 'Skills' })
    expect(prompt()).not.toHaveAttribute('aria-activedescendant')
    expect(screen.getByText('↓ to choose · Enter sends what you typed')).toBeInTheDocument()
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    expect(requests(live, 'manual-send')).toEqual([{ type: 'manual-send', threadId: THREAD, draftId: expect.any(String), text: '/re' }])
    expect(list).toBeTruthy()
  })

  it('selects from a /command list with the arrow keys and Tab, and ignores keys during composition', async () => {
    const { live, prompt } = mount(manualState({ capabilities: { skills: true } }), { catalog: () => CATALOG })
    type(prompt(), '/')
    await screen.findByRole('listbox', { name: 'Skills' })
    fireEvent.keyDown(prompt(), { key: 'ArrowDown' })
    fireEvent.keyDown(prompt(), { key: 'ArrowDown' })
    fireEvent.keyDown(prompt(), { key: 'Enter', isComposing: true })
    fireEvent.keyDown(prompt(), { key: 'Enter', keyCode: 229 })
    expect(prompt()).toHaveValue('/')
    fireEvent.keyDown(prompt(), { key: 'Tab' })
    expect(prompt()).toHaveValue('$deploy ')
    expect(live.threadDrafts.draft(THREAD).skills).toEqual([{ name: 'deploy', path: CATALOG.skills[1]!.path }])
    expect(requests(live, 'manual-send')).toHaveLength(0)
  })

  it('closes with Escape and leaves text unchanged, and a no-match $ token sends as typed', async () => {
    const { live, prompt } = mount(manualState({ capabilities: { skills: true } }), { catalog: () => CATALOG })
    type(prompt(), 'echo $HOME')
    await screen.findByText('No skills match “HOME”.')
    expect(prompt()).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(prompt(), { key: 'Escape' })
    expect(screen.queryByText(/No skills match/)).not.toBeInTheDocument()
    expect(prompt()).toHaveValue('echo $HOME')
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    expect(requests(live, 'manual-send')).toEqual([{ type: 'manual-send', threadId: THREAD, draftId: expect.any(String), text: 'echo $HOME' }])
  })

  it('shows catalog failures without touching the draft and reloads on request', async () => {
    const failing: AgentSkillCatalog = { ...CATALOG, status: 'error', skills: [], error: 'Codex could not read skills in C:/workshop.' }
    const { live, prompt } = mount(manualState({ capabilities: { skills: true } }))
    type(prompt(), 'Keep this draft $')
    act(() => live.publishCatalog(failing))
    expect(await screen.findByRole('alert')).toHaveTextContent('Codex could not read skills in C:/workshop.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(requests(live, 'refresh-thread-skills').at(-1)).toEqual({ type: 'refresh-thread-skills', threadId: THREAD, forceReload: true })
    act(() => live.publishCatalog(null))
    expect(await screen.findByRole('alert')).toHaveTextContent('Sotto couldn’t load skills.')
    expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    act(() => live.publishCatalog({ ...CATALOG, errors: [{ path: 'C:/workshop/.agents/skills/broken/SKILL.md', message: 'invalid front matter' }] }))
    expect(await screen.findByRole('listbox', { name: 'Skills' })).toBeInTheDocument()
    expect(screen.getByText('1 skill file couldn’t be read')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled()
    expect(prompt()).toHaveValue('Keep this draft $')
  })

  it('says an empty native catalog is empty, which is not a failure', async () => {
    const { prompt } = mount(manualState({ capabilities: { skills: true } }), { catalog: () => ({ ...CATALOG, skills: [] }) })
    type(prompt(), '$')
    expect(await screen.findByText('No skills are available in this thread’s folder.')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not open for a provider without a skills catalog, so / and $ stay plain text', () => {
    const { live, prompt } = mount(manualState())
    type(prompt(), '/compact')
    type(prompt(), '$deploy')
    expect(screen.queryByText('Skills')).not.toBeInTheDocument()
    expect(prompt()).not.toHaveAttribute('aria-expanded')
    expect(requests(live, 'refresh-thread-skills')).toHaveLength(0)
  })
})

describe('skills with queue and steer', () => {
  it('derives every composer and skills list ID from composerId so split panes stay unique', async () => {
    const state = manualState({ capabilities: { skills: true } })
    const live = liveAgentState(state, { catalog: () => CATALOG })
    function Pane({ id }: { readonly id: string }) {
      const connection = live.useLive()
      const row = describeThreads(connection.state!, NOW).find(item => item.thread.id === THREAD)!
      return <ThreadComposer row={row} state={connection.state!} command={connection.command} store={connection.threadDrafts} onSend={vi.fn()} composerId={id} />
    }
    render(<><Pane id="pane-a" /><Pane id="pane-b" /></>)
    const [a, b] = screen.getAllByRole('textbox', { name: 'Prompt', exact: true }) as HTMLTextAreaElement[]
    expect([a!.id, b!.id]).toEqual(['pane-a', 'pane-b'])
    expect(a!.closest('form')).toHaveAttribute('data-thread-id', THREAD)
    type(a!, '$')
    await waitFor(() => expect(a).toHaveAttribute('aria-controls', 'pane-a-skills'))
    const ids = [...document.querySelectorAll('[id]')].map(element => element.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('carries selected skills through queueing, a reload of the draft store, and steering', async () => {
    const { live, prompt } = mount(manualState({ running: true, capabilities: { skills: true, steer: true } }), { catalog: () => CATALOG })
    type(prompt(), 'Queue $dep')
    await screen.findByRole('listbox', { name: 'Skills' })
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    expect(prompt()).toHaveValue('Queue $deploy ')
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    const deploy = { name: 'deploy', path: CATALOG.skills[1]!.path }
    expect(requests(live, 'queue-followup')).toEqual([{ type: 'queue-followup', threadId: THREAD, draftId: expect.any(String), text: 'Queue $deploy ', skills: [deploy] }])
    await waitFor(() => expect(live.state.followups?.[0]?.skills).toEqual([deploy]))

    // A draft with a selected skill survives a renderer reload with its reference.
    type(prompt(), 'Steer $imagegen')
    const imagegen = { name: 'imagegen', path: CATALOG.skills[2]!.path }
    act(() => { live.threadDrafts.edit(THREAD, { text: 'Steer $imagegen', skills: [imagegen] }); live.threadDrafts.flushAll() })
    const saved = requests(live, 'save-thread-draft').at(-1)!
    expect(saved.skills).toEqual([imagegen])
    const reloaded = new ThreadDraftStore(vi.fn(async () => null))
    reloaded.receive(live.state)
    expect(reloaded.draft(THREAD)).toMatchObject({ draftId: saved.draftId, text: 'Steer $imagegen', skills: [imagegen] })

    fireEvent.click(screen.getByRole('button', { name: 'Steer now' }))
    expect(requests(live, 'steer')).toEqual([{ type: 'steer', threadId: THREAD, draftId: saved.draftId, text: 'Steer $imagegen', skills: [imagegen] }])
  })
})
