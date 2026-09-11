import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultAgentConfiguration, type AgentState } from '../../../src/shared/agents'
import { designThreadsFixture, E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { AgentView } from '../../../src/renderer/src/agents/AgentView'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { clockLabel, describeThreads, groupThreads, startedLabel, threadCounts } from '../../../src/renderer/src/agents/threadFacts'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const NOW = E2E_THREADS_NOW

/** The design fixture as the coordinator would publish it: the permission request already sits in the attention queue. */
function stateFixture(): AgentState {
  const fixture = designThreadsFixture()
  return {
    configuration: { ...defaultAgentConfiguration(), enabled: true, defaultModelId: 'claude:sonnet' },
    connection: 'connected',
    host: {
      connected: true, name: 'T3 Code', version: 'test',
      capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true },
      models: [...fixture.models], projects: [...fixture.projects], threads: structuredClone(fixture.threads) as AgentState['host']['threads'],
    },
    assignments: fixture.assignments.map(assignment => ({ ...assignment, contextUpdatedAt: NOW })),
    queue: [{ id: 'visual-gate:visual-gate-permission:permission', threadId: 'visual-gate', kind: 'permission', text: 'Run a command in workshop\nnpm test -- --run tests/unit/agents', requestId: 'visual-gate-permission', createdAt: new Date(NOW).toISOString(), deferred: false }],
    activeThreadId: 'visual-gate', activeProjectId: 'workshop',
    draft: '', draftThreadId: null, draftRequestId: null, composing: false,
    pendingRequest: '', busy: false, notice: '', error: null,
    speech: { id: 0, text: '' }, voice: { status: 'off', error: null, action: 'none', revision: 0 },
    credentials: { t3: true, reasoning: false, grokSpeech: false, secure: true },
    reasoningAccounts: [],
    membership: { status: 'beta', label: 'Development beta', expiresAt: null },
  }
}

function connection(state: AgentState | null, command = vi.fn(async () => state)): ReturnType<typeof useAgents> {
  return { state, command, error: null, voice: { status: 'off' }, muteVoice: vi.fn(), stopSpeech: vi.fn(), retryVoice: vi.fn() }
}

function renderThreads(state: AgentState | null, command = vi.fn(async () => state)) {
  const onOpenAgents = vi.fn()
  vi.mocked(useAgents).mockReturnValue(connection(state, command))
  const view = render(<ThreadsView onOpenAgents={onOpenAgents} now={NOW} />)
  return { ...view, command, onOpenAgents }
}

const row = (title: string): HTMLElement => {
  const article = screen.getByRole('button', { name: title }).closest('article')
  if (article === null) throw new Error(`No row for ${title}`)
  return article
}

beforeEach(() => { vi.mocked(useAgents).mockReset() })
afterEach(cleanup)

describe('thread grouping and states from Sotto state', () => {
  it('groups by needs you, running, finished today and earlier days, newest first', () => {
    const state = stateFixture()
    const groups = groupThreads(describeThreads(state, NOW), NOW)
    expect(groups.map(group => [group.label, group.rows.map(entry => entry.thread.title)])).toEqual([
      ['Needs you', ['Visual gate flake']],
      ['Running', ['Footer links', 'Weekly note']],
      ['Finished today', ['Release notes 1.4', 'Grok voice previews']],
      ['Yesterday', ['Streaming WAV stall', 'Thread routing']],
      [new Date(Date.UTC(2026, 6, 9, 15, 24)).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }), ['Notes cleanup']],
      [new Date(Date.UTC(2026, 6, 8, 17, 44)).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }), ['Benchmark rerun']],
    ])
    expect(threadCounts(describeThreads(state, NOW), NOW)).toEqual({ active: 3, week: 9 })
  })

  it('derives the state of a row from the queue, the assignment and the thread status, never from the provider', () => {
    const state = stateFixture()
    const rows = describeThreads(state, NOW)
    const byTitle = (title: string) => rows.find(entry => entry.thread.title === title)!
    expect(byTitle('Visual gate flake')).toMatchObject({ state: 'needs', stateLabel: 'Waiting on you', provider: 'Claude', management: 'managed' })
    expect(byTitle('Visual gate flake').request?.requestId).toBe('visual-gate-permission')
    expect(byTitle('Footer links')).toMatchObject({ state: 'working', stateLabel: 'Working', provider: 'Codex' })
    expect(byTitle('Streaming WAV stall')).toMatchObject({ state: 'stopped', stateLabel: 'Stopped', management: 'stopped' })
    expect(byTitle('Streaming WAV stall').sentence).toMatch(/^Stopped after 5 follow-ups without finishing\./u)
    expect(byTitle('Release notes 1.4')).toMatchObject({ state: 'done', stateLabel: 'Done' })
    expect(byTitle('Notes cleanup')).toMatchObject({ state: 'done', management: 'none', assignment: undefined })
    expect(byTitle('Weekly note').lastMessage?.who).toBe('Grok')
    // A Sotto-sent prompt is attributed to Sotto, a typed or spoken one to you.
    const weekly = state.host.threads.find(entry => entry.id === 'weekly-note')!
    weekly.messages = weekly.messages.slice(0, 1)
    expect(describeThreads(state, NOW).find(entry => entry.thread.id === 'weekly-note')?.lastMessage?.who).toBe('Sotto')
    expect(byTitle('Footer links').lastMessage?.who).toBe('Codex')
  })

  it('treats a blocked queue item as needing you and a user pause as paused, and a manual assignment as yours', () => {
    const state = stateFixture()
    state.queue.push({ id: 'release-notes:release-notes-2:blocked', threadId: 'release-notes', kind: 'blocked', text: 'Scope changed. Decide whether to keep going.', createdAt: new Date(NOW).toISOString(), deferred: false })
    const paused = state.assignments.find(entry => entry.threadId === 'grok-previews')!
    paused.paused = true
    const manual = state.assignments.find(entry => entry.threadId === 'thread-routing')!
    manual.mode = 'manual'
    const rows = describeThreads(state, NOW)
    expect(rows.find(entry => entry.thread.id === 'release-notes')).toMatchObject({ state: 'needs', sentence: 'Scope changed. Decide whether to keep going.', request: undefined })
    expect(rows.find(entry => entry.thread.id === 'grok-previews')).toMatchObject({ state: 'done', stateLabel: 'Paused', management: 'paused' })
    expect(rows.find(entry => entry.thread.id === 'thread-routing')).toMatchObject({ management: 'manual' })
  })
})

describe('ThreadsView', () => {
  it('renders the groups, rows and header counts from the mockup', () => {
    renderThreads(stateFixture())
    expect(screen.getByRole('heading', { name: 'Threads' })).toBeInTheDocument()
    expect(screen.getByText('3 active, 9 this week')).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { level: 2 }).map(heading => heading.textContent)).toEqual(expect.arrayContaining(['Needs you', 'Running', 'Finished today', 'Yesterday']))
    const visual = row('Visual gate flake')
    expect(within(visual).getByText('Claude, in workshop')).toBeInTheDocument()
    expect(within(visual).getByText('Waiting on you')).toBeInTheDocument()
    expect(within(visual).getByText(clockLabel(Date.UTC(2026, 6, 12, 19, 41)))).toBeInTheDocument()
    expect(within(visual).getByText(/Found the cause\./u)).toBeInTheDocument()
    expect(within(row('Footer links')).getByText('2 min')).toBeInTheDocument()
    expect(within(row('Streaming WAV stall')).getByText('Stopped')).toBeInTheDocument()
  })

  it('shows the empty state with a way to start a thread when Sotto knows no threads', () => {
    const state = stateFixture()
    state.host.threads = []
    state.assignments = []
    state.queue = []
    const { onOpenAgents } = renderThreads(state)
    expect(screen.getByRole('heading', { name: 'No threads yet.' })).toBeInTheDocument()
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New thread' }))
    expect(onOpenAgents).toHaveBeenCalledTimes(1)
  })

  it('searches by thread title, project and provider, and explains when nothing matches', () => {
    const { command } = renderThreads(stateFixture())
    const search = screen.getByRole('searchbox', { name: 'Search threads' })
    fireEvent.change(search, { target: { value: 'sotto-site' } })
    expect(screen.getByRole('button', { name: 'Footer links' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Visual gate flake' })).not.toBeInTheDocument()
    expect(screen.getByText('1 of 9')).toBeInTheDocument()
    expect(screen.queryByText('Needs you')).not.toBeInTheDocument()
    fireEvent.change(search, { target: { value: '  GROK ' } })
    expect(screen.getByRole('button', { name: 'Weekly note' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Grok voice previews' })).toBeInTheDocument()
    fireEvent.change(search, { target: { value: 'deploy' } })
    expect(screen.getByRole('heading', { name: 'Nothing matches “deploy”.' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(search).toHaveValue('')
    expect(screen.getByText('3 active, 9 this week')).toBeInTheDocument()
    expect(command).not.toHaveBeenCalled()
  })

  it('answers the queue item inline: Allow approves, Deny declines, nothing else ever answers', () => {
    const { command } = renderThreads(stateFixture())
    const ask = screen.getByLabelText('Permission request for Visual gate flake')
    expect(within(ask).getByText('Run a command in workshop')).toBeInTheDocument()
    expect(within(ask).getByText('npm test -- --run tests/unit/agents')).toBeInTheDocument()
    expect(within(ask).getByText('Say “allow” or “deny”, or choose here.')).toBeInTheDocument()
    // Opening, closing and searching around the request are not answers.
    fireEvent.click(row('Visual gate flake'))
    fireEvent.click(row('Visual gate flake'))
    fireEvent.click(screen.getByRole('button', { name: 'Visual gate flake' }))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search threads' }), { target: { value: 'visual' } })
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search threads' }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Footer links' }))
    expect(command).not.toHaveBeenCalled()
    fireEvent.click(within(ask).getByRole('button', { name: 'Deny' }))
    expect(command).toHaveBeenLastCalledWith({ type: 'answer', threadId: 'visual-gate', requestId: 'visual-gate-permission', answer: 'Denied', approved: false })
    fireEvent.click(within(ask).getByRole('button', { name: 'Allow' }))
    expect(command).toHaveBeenLastCalledWith({ type: 'answer', threadId: 'visual-gate', requestId: 'visual-gate-permission', answer: 'Approved', approved: true })
    expect(command.mock.calls.every(([call]) => call.type === 'answer' && call.approved !== undefined)).toBe(true)
  })

  it('sends a question to the Agents room for a typed or spoken answer instead of approving anything', () => {
    const state = stateFixture()
    state.queue = [{ id: 'footer-links:q:question', threadId: 'footer-links', kind: 'question', text: 'Keep the old docs path as a redirect?', requestId: 'footer-question', createdAt: new Date(NOW).toISOString(), deferred: false }]
    const { command, onOpenAgents } = renderThreads(state)
    const ask = screen.getByLabelText('Question from Footer links')
    expect(within(ask).getByText('Keep the old docs path as a redirect?')).toBeInTheDocument()
    expect(within(ask).queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument()
    fireEvent.click(within(ask).getByRole('button', { name: 'Answer in Agents' }))
    expect(command).toHaveBeenCalledWith({ type: 'select-thread', threadId: 'footer-links' })
    expect(onOpenAgents).toHaveBeenCalledTimes(1)
    expect(command.mock.calls.some(([call]) => call.type === 'answer')).toBe(false)
  })

  it('opens a row in place with how it started, who is managing, follow-ups, the last message and its controls', () => {
    const { command, onOpenAgents } = renderThreads(stateFixture())
    fireEvent.click(screen.getByRole('button', { name: 'Visual gate flake' }))
    const open = row('Visual gate flake')
    expect(open).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('button', { name: 'Visual gate flake' })).toHaveAttribute('aria-expanded', 'true')
    expect(within(open).getByText(`Started ${clockLabel(Date.UTC(2026, 6, 12, 19, 32))} from a voice prompt.`)).toBeInTheDocument()
    expect(within(open).getByText(/Sotto is managing it, 2 of 5 follow-ups used\. Sonnet 4\.5 from Claude\./u)).toBeInTheDocument()
    expect(within(open).getByText(`Claude, ${clockLabel(Date.UTC(2026, 6, 12, 19, 41))}`)).toBeInTheDocument()
    expect(within(open.querySelector('.thread-row__recent') as HTMLElement).getByText(/I want to run the unit suite/u)).toBeInTheDocument()
    fireEvent.click(within(open).getByRole('button', { name: 'Pause managing' }))
    expect(command).toHaveBeenLastCalledWith({ type: 'pause', threadId: 'visual-gate' })
    fireEvent.click(within(open).getByRole('button', { name: 'Stop managing' }))
    expect(command).toHaveBeenLastCalledWith({ type: 'unassign', threadId: 'visual-gate' })
    fireEvent.click(within(open).getByRole('button', { name: 'Open transcript' }))
    expect(command).toHaveBeenLastCalledWith({ type: 'select-thread', threadId: 'visual-gate' })
    expect(onOpenAgents).toHaveBeenCalledTimes(1)
    // Only one row is open at a time; clicking the open row's body closes it.
    fireEvent.click(screen.getByRole('button', { name: 'Footer links' }))
    expect(row('Visual gate flake')).not.toHaveAttribute('aria-current')
    expect(row('Footer links')).toHaveAttribute('aria-current', 'true')
    fireEvent.click(row('Footer links').querySelector('.thread-row__now') as HTMLElement)
    expect(row('Footer links')).not.toHaveAttribute('aria-current')
  })

  it('says plainly when Sotto stopped at the follow-up limit and offers Resume managing', () => {
    const { command } = renderThreads(stateFixture())
    fireEvent.click(screen.getByRole('button', { name: 'Streaming WAV stall' }))
    const open = row('Streaming WAV stall')
    expect(within(open).getByText(`Started ${startedLabel(Date.UTC(2026, 6, 11, 15, 40), NOW)} from a voice prompt.`)).toBeInTheDocument()
    expect(within(open).getByText(/Sotto stopped it at the follow-up limit, 5 of 5 follow-ups used\./u)).toBeInTheDocument()
    expect(within(open).queryByRole('button', { name: 'Pause managing' })).not.toBeInTheDocument()
    fireEvent.click(within(open).getByRole('button', { name: 'Resume managing' }))
    expect(command).toHaveBeenLastCalledWith({ type: 'resume', threadId: 'wav-stall' })
  })

  it('offers Manage for a thread Sotto is not managing and no Stop managing', () => {
    const { command } = renderThreads(stateFixture())
    fireEvent.click(screen.getByRole('button', { name: 'Notes cleanup' }))
    const open = row('Notes cleanup')
    expect(within(open).getByText(/Sotto is not managing this thread\./u)).toBeInTheDocument()
    expect(within(open).queryByRole('button', { name: 'Stop managing' })).not.toBeInTheDocument()
    fireEvent.click(within(open).getByRole('button', { name: 'Manage' }))
    expect(command).toHaveBeenLastCalledWith({ type: 'assign', threadId: 'notes-cleanup' })
  })

  it('disables the decision and management controls while a command is in flight', () => {
    const state = stateFixture()
    state.busy = true
    renderThreads(state)
    expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Footer links' }))
    expect(screen.getByRole('button', { name: 'Pause managing' })).toBeDisabled()
  })
})

describe('Agents room link', () => {
  it('offers All threads beside the room controls', () => {
    const state = stateFixture()
    const onOpenThreads = vi.fn()
    vi.mocked(useAgents).mockReturnValue(connection(state))
    render(<AgentView onOpenThreads={onOpenThreads} />)
    fireEvent.click(screen.getByRole('button', { name: 'All threads' }))
    expect(onOpenThreads).toHaveBeenCalledTimes(1)
  })
})
